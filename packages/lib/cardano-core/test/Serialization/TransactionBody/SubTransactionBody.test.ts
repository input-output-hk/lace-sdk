import * as Crypto from '@lace-lib/cardano-crypto';
import { HexBlob } from '@lace-lib/cardano-util';

import * as Cardano from '../../../src/Cardano';
import {
  CborReader,
  CborReaderState,
  SubTransactionBody,
  TransactionBody,
  TransactionOutput,
} from '../../../src/Serialization';
import { vectorsForRule } from '../dijkstraVectors';

import { mintTokenMap, rewardAccount, txIn, txOut } from './testData';

const KEY_HASH = '00112233445566778899aabbccddeeff00112233445566778899aabb';
const SCRIPT_HASH = 'aabbccddeeff00112233445566778899aabbccddeeff001122334455';
const TX_ID =
  '0f3abbc8fc19c2e61bab6059bf8a466e6e754833a08a62a6c56fe0e78f19d9d5';

const keyHashCredential: Cardano.Credential = {
  hash: Crypto.Hash28ByteBase16(KEY_HASH),
  type: Cardano.CredentialType.KeyHash,
};

const scriptHashCredential: Cardano.Credential = {
  hash: Crypto.Hash28ByteBase16(SCRIPT_HASH),
  type: Cardano.CredentialType.ScriptHash,
};

const scriptRewardAccount = Cardano.RewardAccount.fromCredential(
  scriptHashCredential,
  Cardano.NetworkId.Mainnet,
);

const constrDatum: Cardano.PlutusData = {
  constructor: 0n,
  fields: { items: [] },
};

const [subTransactionVector] = vectorsForRule('sub_transaction');
const [topLevelBodyVector] = vectorsForRule('transaction_body');
const [requiredGuardsVector] = vectorsForRule('required_top_level_guards');

const minimalBodyCbor = HexBlob('a200d90102800180');
const guardedBodyCbor = HexBlob(
  `a300d901028001801818${requiredGuardsVector.hex}`,
);
const emptyGuardsBodyCbor = HexBlob('a300d901028001801818a0');
const intervalsBodyCbor = HexBlob(
  `a300d90102800180181aa2581de1cb0ec2692497b458e46812c8a5bfa2931d1a2d965a99893828ec810f1903e8581df1${SCRIPT_HASH}821901f4f6`,
);
const feeBodyCbor = HexBlob(topLevelBodyVector.hex);

const maximalBodyCbor = HexBlob(
  'b300d90102818258200f3abbc8fc19c2e61bab6059bf8a466e6e754833a08a62a6c56fe0e78f19d9d500018182583900' +
    '9493315cd92eb5d8c4304e67b7e16ae36d61d34502694657811a2c8e32c728d3861e164cab28cb8f006448139c8f1740' +
    'ffb8e7aa9e5232dc820aa3581c2a286ad895d091f2b3d168a6091ad2627d30a72761a5bc36eef00740a14014581c659f' +
    '2917fb63f12b33667463ee575eeac1845bbc736b9c0bbc40ba82a14454534c411832581c7eae28af2208be856f7a1196' +
    '68ae52a49b73725e326dc16579dcc373a240182846504154415445181e031903e804d90102818304581c26b17b78de4f' +
    '035dc0bfce60d1d3c3a8085c38dcce5fb8767e518bed1901f405a1581de1cb0ec2692497b458e46812c8a5bfa2931d1a' +
    '2d965a99893828ec810f050758200f3abbc8fc19c2e61bab6059bf8a466e6e754833a08a62a6c56fe0e78f19d9d50818' +
    '6409a3581c2a286ad895d091f2b3d168a6091ad2627d30a72761a5bc36eef00740a14014581c659f2917fb63f12b3366' +
    '7463ee575eeac1845bbc736b9c0bbc40ba82a14454534c413831581c7eae28af2208be856f7a119668ae52a49b73725e' +
    '326dc16579dcc373a240182846504154415445181e0b58200f3abbc8fc19c2e61bab6059bf8a466e6e754833a08a62a6' +
    'c56fe0e78f19d9d50ed90102828200581c00112233445566778899aabbccddeeff00112233445566778899aabb820158' +
    '1caabbccddeeff00112233445566778899aabbccddeeff0011223344550f0112d90102818258200f3abbc8fc19c2e61b' +
    'ab6059bf8a466e6e754833a08a62a6c56fe0e78f19d9d50013a18202581c00112233445566778899aabbccddeeff0011' +
    '2233445566778899aabba18258200f3abbc8fc19c2e61bab6059bf8a466e6e754833a08a62a6c56fe0e78f19d9d50382' +
    '01f614d9010281841a000f4240581de1cb0ec2692497b458e46812c8a5bfa2931d1a2d965a99893828ec810f81068276' +
    '68747470733a2f2f7777772e736f6d6575726c2e696f582000000000000000000000000000000000000000000000000' +
    '00000000000000000151907d0161903e81818a28200581c00112233445566778899aabbccddeeff00112233445566778' +
    '899aabbf68201581caabbccddeeff00112233445566778899aabbccddeeff001122334455d879801819a1581de1cb0ec' +
    '2692497b458e46812c8a5bfa2931d1a2d965a99893828ec810f1a000f4240181aa1581de1cb0ec2692497b458e46812' +
    'c8a5bfa2931d1a2d965a99893828ec810f821864191388',
);

const minimalCore: Cardano.SubTransactionBody = {
  inputs: [],
  outputs: [],
};

const maximalCore: Cardano.SubTransactionBody = {
  accountBalanceIntervals: [
    {
      interval: { exclusiveUpperBound: 5000n, inclusiveLowerBound: 100n },
      rewardAccount,
    },
  ],
  auxiliaryDataHash: Crypto.Hash32ByteBase16(TX_ID),
  certificates: [
    {
      __typename: Cardano.CertificateType.PoolRetirement,
      epoch: Cardano.EpochNo(500),
      poolId: Cardano.PoolId(
        'pool1y6chk7x7fup4ms9leesdr57r4qy9cwxuee0msan72x976a6u0nc',
      ),
    },
  ],
  directDeposits: [{ quantity: 1_000_000n, stakeAddress: rewardAccount }],
  donation: 1000n,
  guards: [keyHashCredential, scriptHashCredential],
  inputs: [txIn],
  mint: mintTokenMap,
  networkId: Cardano.NetworkId.Mainnet,
  outputs: [txOut],
  proposalProcedures: [
    {
      anchor: {
        dataHash: Crypto.Hash32ByteBase16(
          '0000000000000000000000000000000000000000000000000000000000000000',
        ),
        url: 'https://www.someurl.io',
      },
      deposit: 1_000_000n,
      governanceAction: {
        __typename: Cardano.GovernanceActionType.info_action,
      },
      rewardAccount,
    },
  ],
  referenceInputs: [txIn],
  requiredTopLevelGuards: [
    { credential: keyHashCredential, datum: null },
    { credential: scriptHashCredential, datum: constrDatum },
  ],
  scriptIntegrityHash: Crypto.Hash32ByteBase16(TX_ID),
  treasuryValue: 2000n,
  validityInterval: {
    invalidBefore: Cardano.Slot(100),
    invalidHereafter: Cardano.Slot(1000),
  },
  votingProcedures: [
    {
      voter: {
        __typename: Cardano.VoterType.dRepKeyHash,
        credential: {
          hash: Crypto.Hash28ByteBase16(KEY_HASH),
          type: Cardano.CredentialType.KeyHash,
        },
      },
      votes: [
        {
          actionId: { actionIndex: 3, id: Cardano.TransactionId(TX_ID) },
          votingProcedure: { anchor: null, vote: Cardano.Vote.yes },
        },
      ],
    },
  ],
  withdrawals: [{ quantity: 5n, stakeAddress: rewardAccount }],
};

const readMapEntries = (cbor: HexBlob): Map<bigint, string> => {
  const reader = new CborReader(cbor);
  const entries = new Map<bigint, string>();
  reader.readStartMap();
  while (reader.peekState() !== CborReaderState.EndMap) {
    entries.set(
      reader.readInt(),
      Buffer.from(reader.readEncodedValue()).toString('hex'),
    );
  }
  return entries;
};

describe('SubTransactionBody', () => {
  describe('minimal body (keys 0 and 1 only)', () => {
    it('matches the body element of the shared ledger sub_transaction vector', () => {
      expect(subTransactionVector.hex).toContain(minimalBodyCbor);
    });

    it('round trips byte-exact', () => {
      const body = SubTransactionBody.fromCbor(minimalBodyCbor);

      expect(body.inputs().size()).toEqual(0);
      expect(body.outputs()).toEqual([]);
      expect(body.toCbor()).toEqual(minimalBodyCbor);
      expect(SubTransactionBody.fromCore(body.toCore()).toCbor()).toEqual(
        minimalBodyCbor,
      );
    });

    it('encodes the minimal core body byte-identically to the ledger token stream', () => {
      expect(SubTransactionBody.fromCore(minimalCore).toCbor()).toEqual(
        minimalBodyCbor,
      );
    });
  });

  describe('maximal body (every admitted key)', () => {
    it('round trips byte-exact through decode and re-encode', () => {
      expect(SubTransactionBody.fromCbor(maximalBodyCbor).toCbor()).toEqual(
        maximalBodyCbor,
      );
    });

    it('round trips byte-exact through toCore and fromCore', () => {
      const body = SubTransactionBody.fromCbor(maximalBodyCbor);

      expect(SubTransactionBody.fromCore(body.toCore()).toCbor()).toEqual(
        maximalBodyCbor,
      );
    });

    it('encodes the maximal core body to the pinned vector', () => {
      expect(SubTransactionBody.fromCore(maximalCore).toCbor()).toEqual(
        maximalBodyCbor,
      );
    });
  });

  describe('shared field encoding parity with TransactionBody', () => {
    it('encodes every shared field byte-identically to TransactionBody from the same core input', () => {
      const sharedKeys = [
        0n,
        1n,
        3n,
        4n,
        5n,
        7n,
        8n,
        9n,
        11n,
        14n,
        15n,
        18n,
        19n,
        20n,
        21n,
        22n,
        24n,
        25n,
        26n,
      ];
      const topOnlyKeys = new Set([2n, 6n, 13n, 16n, 17n, 23n, 27n]);

      const subCore = SubTransactionBody.fromCbor(maximalBodyCbor).toCore();
      const topCore: Cardano.TxBody = { ...subCore, fee: 0n };

      const subEntries = readMapEntries(
        SubTransactionBody.fromCore(subCore).toCbor(),
      );
      const topEntries = readMapEntries(
        TransactionBody.fromCore(topCore).toCbor(),
      );

      expect(subCore.requiredTopLevelGuards).toBeDefined();
      for (const key of sharedKeys) {
        expect(subEntries.has(key)).toBe(true);
        expect(`${key}:${topEntries.get(key)}`).toEqual(
          `${key}:${subEntries.get(key)}`,
        );
      }
      for (const key of subEntries.keys()) {
        expect(sharedKeys.includes(key)).toBe(true);
      }
      for (const key of topEntries.keys()) {
        expect(sharedKeys.includes(key) || topOnlyKeys.has(key)).toBe(true);
      }
    });
  });

  describe('strict key admission', () => {
    it('rejects fee key 2 (the shared minimal top-level body vector)', () => {
      expect(() => SubTransactionBody.fromCbor(feeBodyCbor)).toThrowError(
        'Top-level-only transaction body map key not allowed in sub transaction body: 2',
      );
    });

    it('rejects collateral inputs key 13', () => {
      const cbor = HexBlob(`a300d901028001800dd9010281825820${TX_ID}00`);

      expect(() => SubTransactionBody.fromCbor(cbor)).toThrowError(
        'Top-level-only transaction body map key not allowed in sub transaction body: 13',
      );
    });

    it('rejects collateral return key 16', () => {
      const cbor = HexBlob(
        `a300d9010280018010${TransactionOutput.fromCore(txOut).toCbor()}`,
      );

      expect(() => SubTransactionBody.fromCbor(cbor)).toThrowError(
        'Top-level-only transaction body map key not allowed in sub transaction body: 16',
      );
    });

    it('rejects total collateral key 17', () => {
      const cbor = HexBlob('a300d90102800180110a');

      expect(() => SubTransactionBody.fromCbor(cbor)).toThrowError(
        'Top-level-only transaction body map key not allowed in sub transaction body: 17',
      );
    });

    it('rejects nested sub transactions key 23', () => {
      const cbor = HexBlob(`a300d901028001801781${subTransactionVector.hex}`);

      expect(() => SubTransactionBody.fromCbor(cbor)).toThrowError(
        'Top-level-only transaction body map key not allowed in sub transaction body: 23',
      );
    });

    it('rejects an unknown key 99', () => {
      const cbor = HexBlob('a300d90102800180186300');

      expect(() => SubTransactionBody.fromCbor(cbor)).toThrowError(
        'Unknown sub transaction body map key: 99',
      );
    });

    it('rejects a body missing required inputs key 0', () => {
      expect(() => SubTransactionBody.fromCbor(HexBlob('a10180'))).toThrowError(
        'Sub transaction body missing required key: 0',
      );
    });

    it('rejects a body missing required outputs key 1', () => {
      expect(() =>
        SubTransactionBody.fromCbor(HexBlob('a100d9010280')),
      ).toThrowError('Sub transaction body missing required key: 1');
    });

    it('rejects a key that appears twice', () => {
      expect(() =>
        SubTransactionBody.fromCbor(HexBlob('a300d9010280018000d9010280')),
      ).toThrowError('Duplicate sub transaction body map key: 0');
    });
  });

  describe('non-empty fields', () => {
    it.each([
      [
        'certificates',
        HexBlob('a300d901028001800480'),
        'certificates (sub transaction body key 4) must be a non-empty set',
      ],
      [
        'withdrawals',
        HexBlob('a300d9010280018005a0'),
        'withdrawals (sub transaction body key 5) must be a non-empty map',
      ],
      [
        'mint',
        HexBlob('a300d9010280018009a0'),
        'mint (sub transaction body key 9) must be a non-empty map',
      ],
      [
        'reference inputs',
        HexBlob('a300d901028001801280'),
        'reference_inputs (sub transaction body key 18) must be a non-empty set',
      ],
      [
        'voting procedures',
        HexBlob('a300d9010280018013a0'),
        'voting_procedures (sub transaction body key 19) must be a non-empty map',
      ],
      [
        'proposal procedures',
        HexBlob('a300d901028001801480'),
        'proposal_procedures (sub transaction body key 20) must be a non-empty set',
      ],
    ])('rejects empty %s', (_, cbor, message) => {
      expect(() => SubTransactionBody.fromCbor(cbor)).toThrowError(message);
    });

    it('rejects a zero donation', () => {
      expect(() =>
        SubTransactionBody.fromCbor(HexBlob('a300d901028001801600')),
      ).toThrowError(
        'donation (sub transaction body key 22) must be greater than zero',
      );
    });

    it('leaves a zero donation out of the encoding', () => {
      const body = SubTransactionBody.fromCbor(minimalBodyCbor);

      body.setDonation(0n);

      expect(body.toCbor()).toEqual(minimalBodyCbor);
    });

    it('rejects guards that repeat a key hash', () => {
      expect(() =>
        SubTransactionBody.fromCbor(
          HexBlob(`a300d901028001800e82581c${KEY_HASH}581c${KEY_HASH}`),
        ),
      ).toThrowError(
        'guards (sub transaction body key 14) must not contain duplicate key hashes',
      );
    });

    it('keeps empty guards and re-encodes byte-exact', () => {
      const cbor = HexBlob('a300d901028001800e80');
      const body = SubTransactionBody.fromCbor(cbor);

      expect(body.guards()?.size()).toEqual(0);
      expect(body.toCbor()).toEqual(cbor);
    });
  });

  describe('required top level guards (key 24)', () => {
    it('decodes a null datum as null and a plutus_data datum as PlutusData', () => {
      const body = SubTransactionBody.fromCbor(guardedBodyCbor);
      const entries = [...body.requiredTopLevelGuards()!];

      expect(entries).toHaveLength(2);
      expect(entries[0][0].toCore()).toEqual(keyHashCredential);
      expect(entries[0][1]).toBeNull();
      expect(entries[1][0].toCore()).toEqual(scriptHashCredential);
      expect(entries[1][1]!.toCbor()).toEqual('d87980');
    });

    it('round trips a body with key 24 byte-exact', () => {
      const body = SubTransactionBody.fromCbor(guardedBodyCbor);

      expect(body.toCbor()).toEqual(guardedBodyCbor);
      expect(SubTransactionBody.fromCore(body.toCore()).toCbor()).toEqual(
        guardedBodyCbor,
      );
    });

    it('rejects an empty map at key 24 on decode', () => {
      expect(() =>
        SubTransactionBody.fromCbor(emptyGuardsBodyCbor),
      ).toThrowError(
        'required_top_level_guards (sub transaction body key 24) must be a non-empty map',
      );
    });

    it('omits key 24 when the map is set but empty', () => {
      const body = SubTransactionBody.fromCore(minimalCore);
      body.setRequiredTopLevelGuards(new Map());

      expect(body.toCbor()).toEqual(minimalBodyCbor);
    });
  });

  describe('account balance intervals (key 26)', () => {
    it('keeps an exact balance and a range keyed by reward account byte-exact', () => {
      const body = SubTransactionBody.fromCbor(intervalsBodyCbor);

      expect(body.toCore().accountBalanceIntervals).toEqual([
        { interval: { exactBalance: 1000n }, rewardAccount },
        {
          interval: { inclusiveLowerBound: 500n },
          rewardAccount: scriptRewardAccount,
        },
      ]);
      expect(body.toCbor()).toEqual(intervalsBodyCbor);
      expect(SubTransactionBody.fromCore(body.toCore()).toCbor()).toEqual(
        intervalsBodyCbor,
      );
    });

    it('rejects a map keyed by credential', () => {
      expect(() =>
        SubTransactionBody.fromCbor(
          HexBlob(`a300d90102800180181aa18200581c${KEY_HASH}1903e8`),
        ),
      ).toThrow('Major type mismatch, expected type 2 but got 4');
    });

    it('rejects a map with a repeated reward account', () => {
      expect(() =>
        SubTransactionBody.fromCbor(
          HexBlob(
            'a300d90102800180181aa2581de1cb0ec2692497b458e46812c8a5bfa2931d1a2d965a99893828ec810f1903e8581de1cb0ec2692497b458e46812c8a5bfa2931d1a2d965a99893828ec810f1907d0',
          ),
        ),
      ).toThrowError(
        `Duplicate reward account in account_balance_intervals (sub transaction body key 26): ${rewardAccount}`,
      );
    });

    it('rejects an empty map at key 26 on decode', () => {
      expect(() =>
        SubTransactionBody.fromCbor(HexBlob('a300d90102800180181aa0')),
      ).toThrowError(
        'account_balance_intervals (sub transaction body key 26) must be a non-empty map',
      );
    });
  });

  describe('toCore/fromCore symmetry', () => {
    it('maps key 24 nullability into core requiredTopLevelGuards entries', () => {
      const core = SubTransactionBody.fromCbor(guardedBodyCbor).toCore();

      expect(core.requiredTopLevelGuards).toEqual([
        { credential: keyHashCredential, datum: null },
        {
          credential: scriptHashCredential,
          datum: expect.objectContaining({ constructor: 0n }),
        },
      ]);
    });

    it('is symmetric for the maximal body', () => {
      const core = SubTransactionBody.fromCbor(maximalBodyCbor).toCore();

      expect(SubTransactionBody.fromCore(core).toCore()).toEqual(core);
    });

    it('has no fee field on the class or on core', () => {
      const core = SubTransactionBody.fromCbor(maximalBodyCbor).toCore();

      expect('fee' in core).toBe(false);
      expect(
        (SubTransactionBody.prototype as unknown as Record<string, unknown>)
          .fee,
      ).toBeUndefined();
    });
  });

  describe('setters', () => {
    it('setRequiredTopLevelGuards invalidates cached original bytes', () => {
      const body = SubTransactionBody.fromCbor(minimalBodyCbor);
      const guarded = SubTransactionBody.fromCbor(guardedBodyCbor);
      body.setRequiredTopLevelGuards(guarded.requiredTopLevelGuards()!);

      expect(body.toCbor()).toEqual(guardedBodyCbor);
    });
  });
});
