import { Cardano } from '@cardano-sdk/core';
import { blake2b } from '@cardano-sdk/crypto';
import { HexBlob } from '@cardano-sdk/util';
import { describe, expect, it } from 'vitest';

import { getHydraScriptRegistry, isHydraHeadMintingScript } from '../src';
import { encodeSeedIndexTail } from '../src/minting-script';

import { preprodMintingScripts } from './fixtures/minting-scripts';

import type { HydraScriptRegistryEntry } from '../src';
import type { RecordedMintingScript } from './fixtures/minting-scripts';

/** Returns the registry entry of a release on a network. */
const entryOf = (
  version: string,
  networkId = Cardano.NetworkId.Testnet,
): HydraScriptRegistryEntry => {
  const entry = getHydraScriptRegistry(networkId).find(
    candidate => candidate.version === version,
  );
  if (!entry) throw new Error(`No registry entry for ${version}`);
  return entry;
};

/** Hex byte hashed in front of a script of the release's language. */
const languageTagOf = (version: string) =>
  entryOf(version).headMintingScript.language ===
  Cardano.PlutusLanguageVersion.V2
    ? '02'
    : '03';

/** Policy id of a script under a language tag. */
const policyIdOf = (languageTag: string, cbor: string): string =>
  blake2b.hash(HexBlob(languageTag + cbor), 28);

/** Wraps a payload of 256 to 65535 bytes in a CBOR byte string. */
const byteString = (payload: string) =>
  '59' + (payload.length / 2).toString(16).padStart(4, '0') + payload;

/** Splits a real script into its template prefix, seed transaction id and tail. */
const partsOf = ({ version, cbor }: RecordedMintingScript) => {
  const prefixEnd = entryOf(version).headMintingScript.prefixLength * 2;
  const payload = cbor.slice(6);
  return {
    prefix: payload.slice(0, prefixEnd),
    seedTxId: payload.slice(prefixEnd, prefixEnd + 64),
    tail: payload.slice(prefixEnd + 64),
  };
};

/** Script and matching head id of the release, built from its parts. */
const forge = (version: string, payload: string) => {
  const cbor = byteString(payload);
  return { cbor, headId: policyIdOf(languageTagOf(version), cbor) };
};

const v2Head = preprodMintingScripts.find(
  ({ version }) => version === '0.19.0',
);
const v3Head = preprodMintingScripts.find(({ version }) => version === '2.3.0');
if (!v2Head || !v3Head) throw new Error('Missing minting script fixtures');
const v3Address = entryOf(v3Head.version).headAddress;

describe('isHydraHeadMintingScript', () => {
  it('covers every registered release', () => {
    expect(preprodMintingScripts.map(({ version }) => version)).toEqual(
      getHydraScriptRegistry(Cardano.NetworkId.Testnet).map(
        ({ version }) => version,
      ),
    );
  });

  it.each(preprodMintingScripts)(
    'accepts the real minting script of a $version head',
    head => {
      const { seedTxId, tail } = partsOf(head);
      const { seedEncoding } = entryOf(head.version).headMintingScript;
      expect(seedTxId).toBe(head.seed.txId);
      expect(tail).toBe(encodeSeedIndexTail(seedEncoding, head.seed.index));
      expect(
        isHydraHeadMintingScript(
          head.headId,
          entryOf(head.version).headAddress,
          head.cbor,
        ),
      ).toBe(true);
      expect(
        isHydraHeadMintingScript(
          head.headId,
          entryOf(head.version, Cardano.NetworkId.Mainnet).headAddress,
          head.cbor,
        ),
      ).toBe(true);
    },
  );

  it('rejects the script of another release at a head address', () => {
    for (const head of preprodMintingScripts) {
      for (const { version, headAddress } of getHydraScriptRegistry(
        Cardano.NetworkId.Testnet,
      )) {
        if (version === head.version) continue;
        expect(
          isHydraHeadMintingScript(head.headId, headAddress, head.cbor),
        ).toBe(false);
      }
    }
  });

  it('rejects a head id hashed under another language', () => {
    const headId = policyIdOf('02', v3Head.cbor);
    expect(isHydraHeadMintingScript(headId, v3Address, v3Head.cbor)).toBe(
      false,
    );
  });

  it('rejects a script whose prefix differs by one byte', () => {
    const { prefix, seedTxId, tail } = partsOf(v3Head);
    const flipped =
      prefix.slice(0, 200) +
      (Number.parseInt(prefix.slice(200, 202), 16) ^ 0xff)
        .toString(16)
        .padStart(2, '0') +
      prefix.slice(202);
    const { cbor, headId } = forge(v3Head.version, flipped + seedTxId + tail);
    expect(isHydraHeadMintingScript(headId, v3Address, cbor)).toBe(false);
  });

  it('accepts another seed only under the head id it hashes to', () => {
    const { prefix, tail } = partsOf(v3Head);
    const { cbor, headId } = forge(
      v3Head.version,
      prefix + 'ab'.repeat(32) + tail,
    );
    expect(isHydraHeadMintingScript(v3Head.headId, v3Address, cbor)).toBe(
      false,
    );
    expect(isHydraHeadMintingScript(headId, v3Address, cbor)).toBe(true);
  });

  it('rejects a script with bytes after the tail', () => {
    const { prefix, seedTxId, tail } = partsOf(v3Head);
    const { cbor, headId } = forge(
      v3Head.version,
      prefix + seedTxId + tail + '00',
    );
    expect(isHydraHeadMintingScript(headId, v3Address, cbor)).toBe(false);
  });

  it('rejects a tail holding an odd integer, which is no seed index', () => {
    const { prefix, seedTxId } = partsOf(v3Head);
    const { cbor, headId } = forge(
      v3Head.version,
      prefix + seedTxId + '00a40021',
    );
    expect(isHydraHeadMintingScript(headId, v3Address, cbor)).toBe(false);
  });

  it('rejects the script wrapped in an indefinite-length byte string', () => {
    const cbor = '5f' + v3Head.cbor + 'ff';
    const headId = policyIdOf('03', cbor);
    expect(isHydraHeadMintingScript(headId, v3Address, cbor)).toBe(false);
  });

  it('rejects a wrong head id', () => {
    expect(
      isHydraHeadMintingScript(v2Head.headId, v3Address, v3Head.cbor),
    ).toBe(false);
    expect(
      isHydraHeadMintingScript(
        v3Head.headId.toUpperCase(),
        v3Address,
        v3Head.cbor,
      ),
    ).toBe(false);
  });

  it('rejects a native script', () => {
    const nativeScript = '8200581c' + v3Head.headId;
    expect(
      isHydraHeadMintingScript(
        policyIdOf('00', nativeScript),
        v3Address,
        nativeScript,
      ),
    ).toBe(false);
  });

  it('rejects malformed hex and empty scripts', () => {
    expect(
      isHydraHeadMintingScript(v3Head.headId, v3Address, v3Head.cbor + '0'),
    ).toBe(false);
    expect(
      isHydraHeadMintingScript(
        v3Head.headId,
        v3Address,
        v3Head.cbor.toUpperCase(),
      ),
    ).toBe(false);
    expect(isHydraHeadMintingScript(v3Head.headId, v3Address, '')).toBe(false);
  });

  it('rejects byte strings that are too short or whose length is wrong', () => {
    const shortScript = '43010203';
    expect(
      isHydraHeadMintingScript(
        policyIdOf('03', shortScript),
        v3Address,
        shortScript,
      ),
    ).toBe(false);
    const misstated = '5900ff' + v3Head.cbor.slice(6);
    expect(
      isHydraHeadMintingScript(
        policyIdOf('03', misstated),
        v3Address,
        misstated,
      ),
    ).toBe(false);
  });

  it('rejects a real script at an address that is not a head validator', () => {
    const { depositAddress } = entryOf(v3Head.version);
    expect(depositAddress).toBeDefined();
    expect(
      isHydraHeadMintingScript(
        v3Head.headId,
        depositAddress ?? '',
        v3Head.cbor,
      ),
    ).toBe(false);
  });
});

describe('encodeSeedIndexTail', () => {
  it.each([
    { index: 0, tail: '00480001' },
    { index: 1, tail: '00480081' },
    { index: 3, tail: '00480181' },
  ])(
    'encodes index $index as constants like real scripts',
    ({ index, tail }) => {
      expect(encodeSeedIndexTail('constants', index)).toBe(tail);
    },
  );

  it.each([
    { index: 0, tail: '00a40001' },
    { index: 1, tail: '00a40041' },
    { index: 6, tail: '00a40181' },
    { index: 11, tail: '00a402c1' },
  ])(
    'encodes index $index as constructor fields like real scripts',
    ({ index, tail }) => {
      expect(encodeSeedIndexTail('constrFields', index)).toBe(tail);
    },
  );

  it.each([0, 1, 63, 64, 127, 128, 300])(
    'round trips seed index %i through the check in both encodings',
    index => {
      for (const head of [v2Head, v3Head]) {
        const { seedEncoding } = entryOf(head.version).headMintingScript;
        const { prefix, seedTxId } = partsOf(head);
        const { cbor, headId } = forge(
          head.version,
          prefix + seedTxId + encodeSeedIndexTail(seedEncoding, index),
        );
        expect(
          isHydraHeadMintingScript(
            headId,
            entryOf(head.version).headAddress,
            cbor,
          ),
        ).toBe(true);
      }
    },
  );
});
