import { HexBlob } from '@lace-lib/cardano-util';

import {
  AccountBalanceInterval,
  Credential,
  Guards,
  NativeScript,
  ProtocolVersion,
  Redeemers,
  Script,
  SubTransaction,
  Transaction,
  TransactionBody,
  TxCBOR,
} from '../../src/Serialization';

import { dijkstraVectors, vectorsForRule } from './dijkstraVectors';

import type * as Cardano from '../../src/Cardano';

type RoundTrip = (hex: string) => string;

const txRoundTrip: RoundTrip = hex =>
  Transaction.fromCbor(TxCBOR(hex)).toCbor();

const RULE_ROUND_TRIPS: Record<string, RoundTrip> = {
  account_balance_interval: hex =>
    AccountBalanceInterval.fromCbor(HexBlob(hex)).toCbor(),
  credential: hex => Credential.fromCbor(HexBlob(hex)).toCbor(),
  guards: hex => Guards.fromCbor(HexBlob(hex)).toCbor(),
  native_script: hex => NativeScript.fromCbor(HexBlob(hex)).toCbor(),
  protocol_version: hex => ProtocolVersion.fromCbor(HexBlob(hex)).toCbor(),
  redeemers: hex => Redeemers.fromCbor(HexBlob(hex)).toCbor(),
  script: hex => Script.fromCbor(HexBlob(hex)).toCbor(),
  block_transaction: txRoundTrip,
  sub_transaction: hex => SubTransaction.fromCbor(HexBlob(hex)).toCbor(),
  transaction: txRoundTrip,
  transaction_body: hex => TransactionBody.fromCbor(HexBlob(hex)).toCbor(),
  transaction_mempool: txRoundTrip,
};

const UNMAPPED_RULES = new Set([
  'account_balance_intervals',
  'direct_deposits',
  'required_top_level_guards',
  'sub_transactions',
]);

const GOLDEN_TX_ID =
  '07c5071e17b0c34ac0402f4a18a7c4a1acf897e6b1e8aeb5e8d279994a05a164';

const GOLDEN_BYRON_ADDRESS =
  '82d818583d83581c239e480f0260bfe927d69166886a0315eee294eec1098977656f8e10a20157566120636f6d70726573736564206c656e6e612e706e67024100001a359e595f';

/**
 * Returns a copy of the entries ordered by the given key, so map-backed fields compare equal
 * regardless of the key order they were encoded in.
 *
 * @param entries The entries to order.
 * @param key Gets the map key of an entry.
 */
const sortedBy = <T>(entries: T[] | undefined, key: (entry: T) => string) =>
  entries && [...entries].sort((a, b) => key(a).localeCompare(key(b)));

/**
 * Orders the map-backed fields of a body by key.
 *
 * @param body The body to normalize.
 */
const withSortedMaps = <T extends Cardano.SubTransactionBody>(body: T): T => ({
  ...body,
  accountBalanceIntervals: sortedBy(
    body.accountBalanceIntervals,
    entry => entry.rewardAccount,
  ),
  requiredTopLevelGuards: sortedBy(
    body.requiredTopLevelGuards,
    entry => `${entry.credential.type}${entry.credential.hash}`,
  ),
});

/**
 * Gets the content of a core transaction without its id and with its map-backed fields, and
 * those of its sub transactions, ordered by key.
 *
 * @param tx The core transaction.
 */
const withoutIdAndSortedMaps = ({ id: _id, ...tx }: Cardano.Tx) => ({
  ...tx,
  body: {
    ...withSortedMaps(tx.body),
    subTransactions: tx.body.subTransactions?.map(sub => ({
      ...sub,
      body: withSortedMaps(sub.body),
    })),
  },
});

const REQUIRED_RULES = [
  'account_balance_interval',
  'credential',
  'guards',
  'protocol_version',
  'sub_transaction',
  'transaction',
];

describe('dijkstraVectors', () => {
  it('is not empty', () => {
    expect(dijkstraVectors.length).toBeGreaterThan(0);
  });

  it('has at least one vector for every required rule', () => {
    for (const rule of REQUIRED_RULES) {
      expect(vectorsForRule(rule).length).toBeGreaterThan(0);
    }
  });

  it('covers both guards forms', () => {
    const names = vectorsForRule('guards').map(vector => vector.name);
    expect(names).toContain('key-hash-set-tagged');
    expect(names).toContain('credential-oset-tagged');
  });

  describe.each(dijkstraVectors)('$rule/$name', vector => {
    it('has non-empty lowercase hex of even length', () => {
      expect(vector.hex.length).toBeGreaterThan(0);
      expect(vector.hex).toMatch(/^(?:[\da-f]{2})+$/);
    });

    it('states its provenance', () => {
      expect(vector.provenance.length).toBeGreaterThan(0);
      expect(vector.provenance).toMatch(
        /cardano-ledger (9b81d994|efba661f|f04e7c0c)|constructed|Musashi/,
      );
    });
  });

  it('has unique rule/name pairs', () => {
    const keys = dijkstraVectors.map(vector => `${vector.rule}/${vector.name}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('maps every rule to a round trip or lists it as unmapped', () => {
    for (const vector of dijkstraVectors) {
      expect(
        RULE_ROUND_TRIPS[vector.rule] !== undefined ||
          UNMAPPED_RULES.has(vector.rule),
      ).toBe(true);
    }
  });

  describe.each(dijkstraVectors.filter(v => RULE_ROUND_TRIPS[v.rule]))(
    'round trips $rule/$name',
    vector => {
      it('decodes and re-encodes byte-exact', () => {
        expect(RULE_ROUND_TRIPS[vector.rule](vector.hex)).toEqual(vector.hex);
      });
    },
  );

  describe('ledger golden transaction', () => {
    const golden = vectorsForRule('transaction').find(
      vector => vector.name === 'ledger-golden-full',
    )!;

    it('decodes, re-encodes byte for byte and keeps its id', () => {
      const tx = Transaction.fromCbor(TxCBOR(golden.hex));

      expect(tx.toCbor()).toEqual(golden.hex);
      expect(tx.getId()).toEqual(GOLDEN_TX_ID);
      expect(tx.toCore().id).toEqual(GOLDEN_TX_ID);
    });

    it('keeps its content when rebuilt from its core form', () => {
      const core = Transaction.fromCbor(TxCBOR(golden.hex)).toCore();
      const rebuilt = Transaction.fromCbor(
        Transaction.fromCore(core).toCbor(),
      ).toCore();

      expect(withoutIdAndSortedMaps(rebuilt)).toEqual(
        withoutIdAndSortedMaps(core),
      );
    });

    it('keeps a Byron output address with a network magic of 0 when rebuilt from its core form', () => {
      const core = Transaction.fromCbor(TxCBOR(golden.hex)).toCore();

      expect(golden.hex).toContain(GOLDEN_BYRON_ADDRESS);
      expect(Transaction.fromCore(core).toCbor()).toContain(
        GOLDEN_BYRON_ADDRESS,
      );
    });

    it('writes reward account and credential keyed maps in bytewise key order when rebuilt from its core form', () => {
      const core = Transaction.fromCbor(TxCBOR(golden.hex)).toCore();
      const rebuilt = Transaction.fromCbor(
        Transaction.fromCore(core).toCbor(),
      ).toCore();
      const accounts = (intervals?: Cardano.AccountBalanceIntervalEntry[]) =>
        intervals?.map(entry => entry.rewardAccount);
      const guards = (tx: Cardano.Tx) =>
        tx.body.subTransactions?.[0].body.requiredTopLevelGuards?.map(
          entry => entry.credential.hash,
        );

      expect(accounts(core.body.accountBalanceIntervals)).toEqual([
        'stake17x5mlmjchz76rg7l9pshxka2evgmt9x9rh87fxj09fh2r3qt8x42p',
        'stake1uyq6r5u44wcm4geu20fx3zw5s3phxqwthf2gcraq6295h4crrgwu3',
        'stake1u9q4pq4y67jq0wecx772y9unxmv0n7j3l38wew53r6kcgpcwese5q',
      ]);
      expect(accounts(rebuilt.body.accountBalanceIntervals)).toEqual([
        'stake1uyq6r5u44wcm4geu20fx3zw5s3phxqwthf2gcraq6295h4crrgwu3',
        'stake1u9q4pq4y67jq0wecx772y9unxmv0n7j3l38wew53r6kcgpcwese5q',
        'stake17x5mlmjchz76rg7l9pshxka2evgmt9x9rh87fxj09fh2r3qt8x42p',
      ]);
      expect(guards(core)).toEqual([
        'c28625280779716c698cc343cb9f247fe8f466fdfcd17274e61aeae9',
        'f81ce66e0f52da5ca48193386e7511fde5b030a307b4c3681736c6f0',
      ]);
      expect(guards(rebuilt)).toEqual([
        'f81ce66e0f52da5ca48193386e7511fde5b030a307b4c3681736c6f0',
        'c28625280779716c698cc343cb9f247fe8f466fdfcd17274e61aeae9',
      ]);
    });
  });
});
