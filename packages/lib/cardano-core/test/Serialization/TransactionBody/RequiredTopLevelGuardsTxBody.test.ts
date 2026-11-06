import * as Crypto from '@lace-lib/cardano-crypto';
import { HexBlob } from '@lace-lib/cardano-util';

import * as Cardano from '../../../src/Cardano';
import {
  Credential,
  PlutusData,
  SubTransactionBody,
  TransactionBody,
} from '../../../src/Serialization';
import { vectorsForRule } from '../dijkstraVectors';

import { txIn } from './testData';

const KEY_HASH = '00112233445566778899aabbccddeeff00112233445566778899aabb';
const SCRIPT_HASH = 'aabbccddeeff00112233445566778899aabbccddeeff001122334455';

const keyHashCredential: Cardano.Credential = {
  hash: Crypto.Hash28ByteBase16(KEY_HASH),
  type: Cardano.CredentialType.KeyHash,
};

const scriptHashCredential: Cardano.Credential = {
  hash: Crypto.Hash28ByteBase16(SCRIPT_HASH),
  type: Cardano.CredentialType.ScriptHash,
};

const constrDatum: Cardano.PlutusData = {
  constructor: 0n,
  fields: { items: [] },
};

const [requiredGuardsVector] = vectorsForRule('required_top_level_guards');

const bodyPrefix =
  'a400d90102818258200f3abbc8fc19c2e61bab6059bf8a466e6e754833a08a62a6c56fe0e78f19d9d5000180020a';
const noGuardsBodyCbor = HexBlob(
  'a300d90102818258200f3abbc8fc19c2e61bab6059bf8a466e6e754833a08a62a6c56fe0e78f19d9d5000180020a',
);

const keyHashGuardBodyCbor = HexBlob(
  `${bodyPrefix}1818a18200581c${KEY_HASH}f6`,
);
const keyHashGuardBodyHash =
  'ff13982b1c5eee8bca57d14033ea06756e024f59f219b67077191d945fef7a5b';

const zeroFeeKeyHashGuardBodyCbor = HexBlob(
  `a400d9010281825820ee155ace9c40292074cb6aff8c9ccdd273c81648ff1149ef36bcea6ebb8a3e2500018002001818a18200581c${KEY_HASH}f6`,
);
const zeroFeeKeyHashGuardBodyHash =
  'f86d895bd187e04292d4448408adbb871a847836c3cdccdf9bc30b57b4b303a4';

const datumGuardsBodyCbor = HexBlob(
  `${bodyPrefix}1818${requiredGuardsVector.hex}`,
);
const reversedGuardsBodyCbor = HexBlob(
  `${bodyPrefix}1818a28201581c${SCRIPT_HASH}d879808200581c${KEY_HASH}f6`,
);
const emptyGuardsBodyCbor = HexBlob(`${bodyPrefix}1818a0`);

const baseCore: Cardano.TxBody = {
  fee: 10n,
  inputs: [txIn],
  outputs: [],
};

const guardsCore: Cardano.TxBody = {
  ...baseCore,
  requiredTopLevelGuards: [
    { credential: scriptHashCredential, datum: constrDatum },
    { credential: keyHashCredential, datum: null },
  ],
};

describe('TransactionBody required top level guards (body key 24)', () => {
  describe('decoding', () => {
    it('decodes a key hash guard without a datum and keeps the body hash', () => {
      const body = TransactionBody.fromCbor(keyHashGuardBodyCbor);
      const entries = [...body.requiredTopLevelGuards()!];

      expect(entries).toHaveLength(1);
      expect(entries[0][0].toCore()).toEqual(keyHashCredential);
      expect(entries[0][1]).toBeNull();
      expect(body.toCbor()).toEqual(keyHashGuardBodyCbor);
      expect(body.hash()).toEqual(keyHashGuardBodyHash);
    });

    it('decodes a plutus datum alongside a guard without one', () => {
      const body = TransactionBody.fromCbor(datumGuardsBodyCbor);

      expect(body.toCore().requiredTopLevelGuards).toEqual([
        { credential: keyHashCredential, datum: null },
        {
          credential: scriptHashCredential,
          datum: expect.objectContaining({ constructor: 0n }),
        },
      ]);
      expect(body.toCbor()).toEqual(datumGuardsBodyCbor);
    });

    it('accepts key 24 in strict mode', () => {
      const body = TransactionBody.fromCbor(keyHashGuardBodyCbor, {
        strict: true,
      });

      expect(body.requiredTopLevelGuards()?.size).toEqual(1);
    });

    it('rejects an empty map', () => {
      expect(() => TransactionBody.fromCbor(emptyGuardsBodyCbor)).toThrowError(
        'required_top_level_guards (transaction body key 24) must be a non-empty map',
      );
    });

    it('leaves bodies without key 24 unaffected', () => {
      const body = TransactionBody.fromCbor(noGuardsBodyCbor);

      expect(body.requiredTopLevelGuards()).toBeUndefined();
      expect('requiredTopLevelGuards' in body.toCore()).toBe(false);
      expect(body.toCbor()).toEqual(noGuardsBodyCbor);
    });
  });

  describe('rebuilding from core', () => {
    it('keeps a key hash guard without a datum when rebuilt from its core form', () => {
      const body = TransactionBody.fromCbor(keyHashGuardBodyCbor);
      const rebuilt = TransactionBody.fromCore(body.toCore());

      expect(rebuilt.toCbor()).toEqual(keyHashGuardBodyCbor);
      expect(rebuilt.hash()).toEqual(keyHashGuardBodyHash);
    });

    it('keeps the body hash of a zero fee body when rebuilt from its core form', () => {
      const body = TransactionBody.fromCbor(zeroFeeKeyHashGuardBodyCbor);
      const rebuilt = TransactionBody.fromCore(body.toCore());

      expect(body.toCbor()).toEqual(zeroFeeKeyHashGuardBodyCbor);
      expect(body.hash()).toEqual(zeroFeeKeyHashGuardBodyHash);
      expect(rebuilt.toCbor()).toEqual(zeroFeeKeyHashGuardBodyCbor);
      expect(rebuilt.hash()).toEqual(zeroFeeKeyHashGuardBodyHash);
    });

    it('keeps a plutus datum when rebuilt from its core form', () => {
      const body = TransactionBody.fromCbor(datumGuardsBodyCbor);

      expect(TransactionBody.fromCore(body.toCore()).toCbor()).toEqual(
        datumGuardsBodyCbor,
      );
    });

    it('preserves a non-canonical decoded map order on re-encode via original bytes', () => {
      expect(TransactionBody.fromCbor(reversedGuardsBodyCbor).toCbor()).toEqual(
        reversedGuardsBodyCbor,
      );
    });

    it('sorts the guards by credential when rebuilt', () => {
      const body = TransactionBody.fromCbor(reversedGuardsBodyCbor);

      expect(TransactionBody.fromCore(body.toCore()).toCbor()).toEqual(
        datumGuardsBodyCbor,
      );
    });
  });

  describe('building in code', () => {
    it('encodes the requiredTopLevelGuards core field as key 24', () => {
      const body = TransactionBody.fromCore(guardsCore);

      expect(body.toCbor()).toEqual(datumGuardsBodyCbor);
      expect(body.toCore().requiredTopLevelGuards).toEqual([
        {
          credential: scriptHashCredential,
          datum: expect.objectContaining({ constructor: 0n }),
        },
        { credential: keyHashCredential, datum: null },
      ]);
    });

    it('writes key 24 when set on a decoded body', () => {
      const body = TransactionBody.fromCbor(noGuardsBodyCbor);
      body.setRequiredTopLevelGuards(
        new Map([[Credential.fromCore(keyHashCredential), null]]),
      );

      expect(body.toCbor()).toEqual(keyHashGuardBodyCbor);
    });

    it('writes the same key 24 bytes as a sub transaction body', () => {
      const guards = new Map<Credential, PlutusData | null>([
        [
          Credential.fromCore(scriptHashCredential),
          PlutusData.fromCore(constrDatum),
        ],
        [Credential.fromCore(keyHashCredential), null],
      ]);
      const body = TransactionBody.fromCore(baseCore);
      const subBody = SubTransactionBody.fromCore({ inputs: [], outputs: [] });
      body.setRequiredTopLevelGuards(guards);
      subBody.setRequiredTopLevelGuards(guards);

      expect(body.toCbor().endsWith(requiredGuardsVector.hex)).toBe(true);
      expect(subBody.toCbor().endsWith(requiredGuardsVector.hex)).toBe(true);
    });

    it('omits key 24 when the core field is absent', () => {
      expect(TransactionBody.fromCore(baseCore).toCbor()).toEqual(
        noGuardsBodyCbor,
      );
    });

    it('omits key 24 when the map is set but empty', () => {
      const body = TransactionBody.fromCore(baseCore);
      body.setRequiredTopLevelGuards(new Map());

      expect(body.toCbor()).toEqual(noGuardsBodyCbor);
    });
  });
});
