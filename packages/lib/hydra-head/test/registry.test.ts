import { Cardano } from '@cardano-sdk/core';
import { describe, expect, it } from 'vitest';

import {
  findHydraHeadVersion,
  getHydraScriptRegistry,
  isHydraDepositAddress,
  isHydraHeadAddress,
} from '../src';
import {
  findHydraHeadMintingScriptTemplate,
  getHydraHeadGeneration,
} from '../src/registry';

const networks = [
  { name: 'testnet', networkId: Cardano.NetworkId.Testnet },
  { name: 'mainnet', networkId: Cardano.NetworkId.Mainnet },
];

const parse = (address: string) => Cardano.Address.fromBech32(address);

describe('Hydra script registry', () => {
  it.each(networks)(
    'lists $name versions in ascending order',
    ({ networkId }) => {
      const versions = getHydraScriptRegistry(networkId).map(
        ({ version }) => version,
      );
      expect(versions).toEqual([
        '0.13.0',
        '0.14.0',
        '0.15.0',
        '0.16.0',
        '0.18.0',
        '0.19.0',
        '0.20.0',
        '0.22.0',
        '1.0.0',
        '1.3.0',
        '2.0.0',
        '2.1.0',
        '2.2.0',
        '2.3.0',
      ]);
    },
  );

  it.each(networks)(
    'holds only script enterprise addresses of the $name network',
    ({ networkId }) => {
      for (const { headAddress, depositAddress } of getHydraScriptRegistry(
        networkId,
      )) {
        for (const address of [headAddress, depositAddress]) {
          if (address === undefined) continue;
          const parsed = parse(address);
          expect(parsed.getProps().type).toBe(
            Cardano.AddressType.EnterpriseScript,
          );
          expect(parsed.getNetworkId()).toBe(networkId);
          expect(parsed.getProps().paymentPart?.type).toBe(
            Cardano.CredentialType.ScriptHash,
          );
        }
      }
    },
  );

  it.each(networks)(
    'has deposit addresses only from 0.20.0 on $name',
    ({ networkId }) => {
      for (const { version, depositAddress } of getHydraScriptRegistry(
        networkId,
      )) {
        const [major, minor] = version.split('.').map(Number);
        expect(depositAddress !== undefined).toBe(
          major > 0 || (minor ?? 0) >= 20,
        );
      }
    },
  );

  it('shares the script hashes between testnet and mainnet', () => {
    const hashes = (networkId: Cardano.NetworkId) =>
      getHydraScriptRegistry(networkId).map(
        ({ headAddress }) => parse(headAddress).getProps().paymentPart?.hash,
      );
    expect(hashes(Cardano.NetworkId.Mainnet)).toEqual(
      hashes(Cardano.NetworkId.Testnet),
    );
  });

  it('pins the 2.3.0 testnet addresses', () => {
    const entry = getHydraScriptRegistry(Cardano.NetworkId.Testnet).find(
      ({ version }) => version === '2.3.0',
    );
    expect(entry).toEqual({
      version: '2.3.0',
      headAddress:
        'addr_test1wq4erflxvet45fr9hrrldflevr2cwr83x622vlejzhspf3gn6jry8',
      depositAddress:
        'addr_test1wrrcaryjq4epavl0gsg08kuuv95l5md5jlpyvswjnss998qyu7lhm',
      headMintingScript: {
        language: Cardano.PlutusLanguageVersion.V3,
        prefixLength: 4817,
        prefixDigest:
          'c485e0959fbdeb29c76f920e1e5dd397bf5ab9f07efe724f032afe8ab553ae90',
        seedEncoding: 'constrFields',
      },
    });
  });

  it('shares the head minting script templates between testnet and mainnet', () => {
    const templates = (networkId: Cardano.NetworkId) =>
      getHydraScriptRegistry(networkId).map(
        ({ headMintingScript }) => headMintingScript,
      );
    expect(templates(Cardano.NetworkId.Mainnet)).toEqual(
      templates(Cardano.NetworkId.Testnet),
    );
  });

  it('resolves every head address to the minting script template of its release', () => {
    for (const { headAddress, depositAddress, headMintingScript } of [
      ...getHydraScriptRegistry(Cardano.NetworkId.Testnet),
      ...getHydraScriptRegistry(Cardano.NetworkId.Mainnet),
    ]) {
      expect(findHydraHeadMintingScriptTemplate(headAddress)).toBe(
        headMintingScript,
      );
      if (depositAddress !== undefined) {
        expect(
          findHydraHeadMintingScriptTemplate(depositAddress),
        ).toBeUndefined();
      }
    }
  });
});

describe('Hydra address lookups', () => {
  const head230 =
    'addr_test1wq4erflxvet45fr9hrrldflevr2cwr83x622vlejzhspf3gn6jry8';
  const deposit230 =
    'addr_test1wrrcaryjq4epavl0gsg08kuuv95l5md5jlpyvswjnss998qyu7lhm';
  const mainnetHead130 =
    'addr1w9tc3k5fdxcphvwel4ah3vxumxyw72cag5v7ph4wv4kw75c5nnwn0';
  const unrelated =
    'addr_test1vz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer5jnk4lk';

  it('recognises head addresses and their version', () => {
    expect(isHydraHeadAddress(head230)).toBe(true);
    expect(findHydraHeadVersion(head230)).toBe('2.3.0');
    expect(isHydraHeadAddress(mainnetHead130)).toBe(true);
    expect(findHydraHeadVersion(mainnetHead130)).toBe('1.3.0');
  });

  it('recognises deposit addresses without treating them as heads', () => {
    expect(isHydraDepositAddress(deposit230)).toBe(true);
    expect(isHydraHeadAddress(deposit230)).toBe(false);
    expect(findHydraHeadVersion(deposit230)).toBeUndefined();
  });

  it('does not recognise head addresses as deposits', () => {
    expect(isHydraDepositAddress(head230)).toBe(false);
  });

  it.each(networks)(
    'resolves every $name head address to its own version',
    ({ networkId }) => {
      for (const { version, headAddress } of getHydraScriptRegistry(
        networkId,
      )) {
        expect(findHydraHeadVersion(headAddress)).toBe(version);
      }
    },
  );

  it('ignores unrelated addresses', () => {
    expect(isHydraHeadAddress(unrelated)).toBe(false);
    expect(isHydraDepositAddress(unrelated)).toBe(false);
    expect(findHydraHeadVersion(unrelated)).toBeUndefined();
  });
});

describe('getHydraHeadGeneration', () => {
  it.each([
    ['0.13.0', 'v1'],
    ['1.3.0', 'v1'],
    ['2.0.0', 'v2'],
    ['2.3.0', 'v2'],
  ])('maps %s to %s', (version, generation) => {
    expect(getHydraHeadGeneration(version)).toBe(generation);
  });
});
