import { Hash28ByteBase16 } from '@lace-lib/cardano-crypto';
import { HexBlob } from '@lace-lib/cardano-util';

import * as Cardano from '../../../src/Cardano';
import {
  AccountBalanceInterval,
  SubTransactionBody,
  Transaction,
  TransactionBody,
  TxCBOR,
} from '../../../src/Serialization';
import { dijkstraVectors, vectorsForRule } from '../dijkstraVectors';

const KEY_HASH_A = '13cf55d175ea848b87deb3e914febd7e028e2bf6534475d52fb9c3d0';
const KEY_HASH_B = '404b5a4088ae9abcf486a7e7b8f82069e6fcfe1bf226f1851ce72570';
const SCRIPT_HASH = 'aabbccddeeff00112233445566778899aabbccddeeff001122334455';
const MUSASHI_KEY_HASH =
  '844a3464993ab60bec111511a3ae5cae644d144725387fcde7d4cf18';

const accountABytes = `581de0${KEY_HASH_A}`;
const accountBBytes = `581de0${KEY_HASH_B}`;
const accountSBytes = `581df0${SCRIPT_HASH}`;
const musashiAccountBytes = `581de0${MUSASHI_KEY_HASH}`;

const bothBoundsHex = '821864191388';
const lowerOnlyHex = '821901f4f6';
const upperOnlyHex = '82f6192710';

const bodyPrefix =
  'a400d90102818258200f3abbc8fc19c2e61bab6059bf8a466e6e754833a08a62a6c56fe0e78f19d9d5000180020a';
const noIntervalsBodyCbor = HexBlob(
  'a300d90102818258200f3abbc8fc19c2e61bab6059bf8a466e6e754833a08a62a6c56fe0e78f19d9d5000180020a',
);

const canonicalBodyCbor = HexBlob(
  `${bodyPrefix}181aa3${accountABytes}${bothBoundsHex}${accountBBytes}${lowerOnlyHex}${accountSBytes}${upperOnlyHex}`,
);
const reversedBodyCbor = HexBlob(
  `${bodyPrefix}181aa2${accountBBytes}${lowerOnlyHex}${accountABytes}${bothBoundsHex}`,
);
const emptyIntervalsBodyCbor = HexBlob(`${bodyPrefix}181aa0`);
const credentialKeyedBodyCbor = HexBlob(
  `${bodyPrefix}181aa18200581c${KEY_HASH_A}${bothBoundsHex}`,
);
const paymentKeyedBodyCbor = HexBlob(
  `${bodyPrefix}181aa1583900${KEY_HASH_A}${KEY_HASH_B}${bothBoundsHex}`,
);
const exactBodyCbor = HexBlob(`${bodyPrefix}181aa1${accountABytes}1903e8`);

const startingIntervalsBodyCbor = HexBlob(
  `a5${bodyPrefix.slice(
    2,
  )}181aa3${accountABytes}${bothBoundsHex}${accountBBytes}${lowerOnlyHex}${accountSBytes}${upperOnlyHex}181ba2${accountBBytes}${upperOnlyHex}${accountSBytes}182a`,
);
const startingIntervalsBodyHash =
  'c288cb652fa76b2ee1d098940f18df94cbbbf19e6c0e05d5238a54aada6cdad2';

const startingOnlyBodyCbor = HexBlob(
  `${bodyPrefix}181ba2${accountBBytes}${upperOnlyHex}${accountSBytes}182a`,
);
const startingOnlyBodyHash =
  'd86973a094d26e1af4796e34832e4367f58becce2732a345baa5c98efc2f76a4';
const reversedStartingBodyCbor = HexBlob(
  `${bodyPrefix}181ba2${accountSBytes}182a${accountBBytes}${upperOnlyHex}`,
);
const emptyStartingBodyCbor = HexBlob(`${bodyPrefix}181ba0`);
const paymentKeyedStartingBodyCbor = HexBlob(
  `${bodyPrefix}181ba1583900${KEY_HASH_A}${KEY_HASH_B}${bothBoundsHex}`,
);

const allKeysBodyCbor = HexBlob(
  'b81900d90102818258200f3abbc8fc19c2e61bab6059bf8a466e6e754833a08a62a6c56fe0e78f19d9d5000180020a03' +
    '1903e804d90102828304581c26b17b78de4f035dc0bfce60d1d3c3a8085c38dcce5fb8767e518bed1901f48405581c0d' +
    '94e174732ef9aae73f395ab44507bfa983d65023c11a951f0c32e4581ca646474b8f5431261506b6c273d307c7569a4e' +
    'b6c96b42dd4a29520a582003170a2e7597b7b7e3d84c05391d139a62b157e78786d8c082f29dcf4c11131405a2581de0' +
    '13cf55d175ea848b87deb3e914febd7e028e2bf6534475d52fb9c3d005581de0404b5a4088ae9abcf486a7e7b8f82069' +
    'e6fcfe1bf226f1851ce72570030758202ceb364d93225b4a0f004a0975a13eb50c3cc6348474b4fe9121f8dc72ca0cfa' +
    '08186409a3581c2a286ad895d091f2b3d168a6091ad2627d30a72761a5bc36eef00740a14014581c659f2917fb63f12b' +
    '33667463ee575eeac1845bbc736b9c0bbc40ba82a14454534c413831581c7eae28af2208be856f7a119668ae52a49b73' +
    '725e326dc16579dcc373a240182846504154415445181e0b58206199186adb51974690d7247d2646097d2c62763b16fb' +
    '7ed3f9f55d38abc123de0dd90102818258200f3abbc8fc19c2e61bab6059bf8a466e6e754833a08a62a6c56fe0e78f19' +
    'd9d5010e828200581c6199186adb51974690d7247d2646097d2c62763b16fb7ed3f9f55d398201581c966e394a544f24' +
    '2081e41d1965137b1bb412ac230d40ed5407821c370f0110a2005839009493315cd92eb5d8c4304e67b7e16ae36d61d3' +
    '4502694657811a2c8e32c728d3861e164cab28cb8f006448139c8f1740ffb8e7aa9e5232dc01820aa3581c2a286ad895' +
    'd091f2b3d168a6091ad2627d30a72761a5bc36eef00740a14014581c659f2917fb63f12b33667463ee575eeac1845bbc' +
    '736b9c0bbc40ba82a14454534c411832581c7eae28af2208be856f7a119668ae52a49b73725e326dc16579dcc373a240' +
    '182846504154415445181e11186412d90102818258200f3abbc8fc19c2e61bab6059bf8a466e6e754833a08a62a6c56f' +
    'e0e78f19d9d50013a28202581c10000000000000000000000000000000000000000000000000000000a3825820100000' +
    '0000000000000000000000000000000000000000000000000000000000038200827668747470733a2f2f7777772e736f' +
    '6d6575726c2e696f58200000000000000000000000000000000000000000000000000000000000000000825820200000' +
    '0000000000000000000000000000000000000000000000000000000000038200827668747470733a2f2f7777772e736f' +
    '6d6575726c2e696f58200000000000000000000000000000000000000000000000000000000000000000825820300000' +
    '0000000000000000000000000000000000000000000000000000000000038200827668747470733a2f2f7777772e736f' +
    '6d6575726c2e696f582000000000000000000000000000000000000000000000000000000000000000008203581c2000' +
    '0000000000000000000000000000000000000000000000000000a2825820100000000000000000000000000000000000' +
    '0000000000000000000000000000038200827668747470733a2f2f7777772e736f6d6575726c2e696f58200000000000' +
    '000000000000000000000000000000000000000000000000000000825820300000000000000000000000000000000000' +
    '0000000000000000000000000000038200827668747470733a2f2f7777772e736f6d6575726c2e696f58200000000000' +
    '00000000000000000000000000000000000000000000000000000014d9010281841a000f4240581de1cb0ec2692497b4' +
    '58e46812c8a5bfa2931d1a2d965a99893828ec810f830582582000000000000000000000000000000000000000000000' +
    '000000000000000000000382827668747470733a2f2f7777772e736f6d6575726c2e696f582000000000000000000000' +
    '00000000000000000000000000000000000000000000f6827668747470733a2f2f7777772e736f6d6575726c2e696f58' +
    '200000000000000000000000000000000000000000000000000000000000000000151907d0161903e817d901028283a3' +
    '00d90102800180031864a0a101647465737483a200d90102800180a0f61818a18200581c00112233445566778899aabb' +
    'ccddeeff00112233445566778899aabbf61819a2581de013cf55d175ea848b87deb3e914febd7e028e2bf6534475d52f' +
    'b9c3d01903e8581de0404b5a4088ae9abcf486a7e7b8f82069e6fcfe1bf226f1851ce725701907d0181aa3581de013cf' +
    '55d175ea848b87deb3e914febd7e028e2bf6534475d52fb9c3d0821864191388581de0404b5a4088ae9abcf486a7e7b8' +
    'f82069e6fcfe1bf226f1851ce72570821901f4f6581df0aabbccddeeff00112233445566778899aabbccddeeff001122' +
    '33445582f6192710181ba2581de0404b5a4088ae9abcf486a7e7b8f82069e6fcfe1bf226f1851ce7257082f619271058' +
    '1df0aabbccddeeff00112233445566778899aabbccddeeff001122334455182a',
);
const allKeysBodyHash =
  '26881095e973a5abd14b0ac6b5934e37ce4c3a982f3760dfb71850a62b2f8d8a';

const bothNilMessage = 'Both interval bounds cannot be nil.';
const exactWithBoundsMessage =
  'An exact balance cannot be combined with interval bounds.';
const [
  lowerOnlyVector,
  upperOnlyVector,
  bothBoundsVector,
  exactVector,
  exactWideVector,
  indefiniteVector,
] = vectorsForRule('account_balance_interval');
const [intervalsVector] = vectorsForRule('account_balance_intervals');
const sharedVectorBodyCbor = HexBlob(`${bodyPrefix}181a${intervalsVector.hex}`);
const musashiVector = dijkstraVectors.find(
  vector => vector.name === 'musashi-account-balance-intervals',
)!;

const rewardAccountFor = (
  hash: string,
  type: Cardano.CredentialType = Cardano.CredentialType.KeyHash,
) =>
  Cardano.RewardAccount.fromCredential(
    { hash: Hash28ByteBase16(hash), type },
    Cardano.NetworkId.Testnet,
  );

const accountA = rewardAccountFor(KEY_HASH_A);
const accountB = rewardAccountFor(KEY_HASH_B);
const accountS = rewardAccountFor(
  SCRIPT_HASH,
  Cardano.CredentialType.ScriptHash,
);
const musashiAccount = rewardAccountFor(MUSASHI_KEY_HASH);

const txIn: Cardano.TxIn = {
  index: 0,
  txId: Cardano.TransactionId(
    '0f3abbc8fc19c2e61bab6059bf8a466e6e754833a08a62a6c56fe0e78f19d9d5',
  ),
};

const baseCore: Cardano.TxBody = {
  fee: 10n,
  inputs: [txIn],
  outputs: [],
};

const startingIntervalsCore: Cardano.TxBody = {
  ...baseCore,
  startingAccountBalanceIntervals: [
    { interval: { exclusiveUpperBound: 10_000n }, rewardAccount: accountB },
    { interval: { exactBalance: 42n }, rewardAccount: accountS },
  ],
};

const intervalsCore: Cardano.TxBody = {
  ...baseCore,
  accountBalanceIntervals: [
    {
      interval: { exclusiveUpperBound: 5000n, inclusiveLowerBound: 100n },
      rewardAccount: accountA,
    },
    { interval: { inclusiveLowerBound: 500n }, rewardAccount: accountB },
    { interval: { exclusiveUpperBound: 10_000n }, rewardAccount: accountS },
  ],
};

describe('AccountBalanceInterval', () => {
  describe('round trip', () => {
    it('round trips the both-bounds shape byte-exact', () => {
      const interval = AccountBalanceInterval.fromCbor(
        HexBlob(bothBoundsVector.hex),
      );

      expect(interval.inclusiveLowerBound()).toEqual(100n);
      expect(interval.exclusiveUpperBound()).toEqual(5000n);
      expect(interval.exactBalance()).toBeUndefined();
      expect(interval.toCbor()).toEqual(bothBoundsVector.hex);
      expect(
        AccountBalanceInterval.fromCore(interval.toCore()).toCbor(),
      ).toEqual(bothBoundsVector.hex);
    });

    it('round trips the lower-bound-only shape byte-exact', () => {
      const interval = AccountBalanceInterval.fromCbor(
        HexBlob(lowerOnlyVector.hex),
      );

      expect(interval.inclusiveLowerBound()).toEqual(500n);
      expect(interval.exclusiveUpperBound()).toBeUndefined();
      expect(interval.toCbor()).toEqual(lowerOnlyVector.hex);
      expect(
        AccountBalanceInterval.fromCore(interval.toCore()).toCbor(),
      ).toEqual(lowerOnlyVector.hex);
    });

    it('round trips the upper-bound-only shape byte-exact', () => {
      const interval = AccountBalanceInterval.fromCbor(
        HexBlob(upperOnlyVector.hex),
      );

      expect(interval.inclusiveLowerBound()).toBeUndefined();
      expect(interval.exclusiveUpperBound()).toEqual(10_000n);
      expect(interval.toCbor()).toEqual(upperOnlyVector.hex);
      expect(
        AccountBalanceInterval.fromCore(interval.toCore()).toCbor(),
      ).toEqual(upperOnlyVector.hex);
    });
  });

  describe('exact balance', () => {
    it('decodes a bare coin as an exact balance and writes it back as a bare coin', () => {
      const interval = AccountBalanceInterval.fromCbor(
        HexBlob(exactVector.hex),
      );

      expect(interval.exactBalance()).toEqual(1000n);
      expect(interval.inclusiveLowerBound()).toBeUndefined();
      expect(interval.exclusiveUpperBound()).toBeUndefined();
      expect(interval.toCore()).toEqual({ exactBalance: 1000n });
      expect(interval.toCbor()).toEqual(exactVector.hex);
      expect(
        AccountBalanceInterval.fromCore(interval.toCore()).toCbor(),
      ).toEqual(exactVector.hex);
    });

    it('keeps an exact balance wider than 32 bits when rebuilt from its core form', () => {
      const interval = AccountBalanceInterval.fromCbor(
        HexBlob(exactWideVector.hex),
      );

      expect(interval.exactBalance()).toEqual(4_294_967_296n);
      expect(interval.toCbor()).toEqual(exactWideVector.hex);
      expect(
        AccountBalanceInterval.fromCore(interval.toCore()).toCbor(),
      ).toEqual(exactWideVector.hex);
    });

    it('writes an exact balance built in code as a bare coin', () => {
      expect(AccountBalanceInterval.newExact(0n).toCbor()).toEqual('00');
      expect(
        AccountBalanceInterval.fromCore({ exactBalance: 5_000_000n }).toCbor(),
      ).toEqual('1a004c4b40');
    });

    it('replaces the bounds when an exact balance is set', () => {
      const interval = AccountBalanceInterval.fromCbor(
        HexBlob(bothBoundsVector.hex),
      );
      interval.setExactBalance(1000n);

      expect(interval.inclusiveLowerBound()).toBeUndefined();
      expect(interval.exclusiveUpperBound()).toBeUndefined();
      expect(interval.toCbor()).toEqual('1903e8');
    });

    it('turns an exact balance into a range when a bound is set', () => {
      const interval = AccountBalanceInterval.fromCbor(
        HexBlob(exactVector.hex),
      );
      interval.setExclusiveUpperBound(10_000n);

      expect(interval.exactBalance()).toBeUndefined();
      expect(interval.toCbor()).toEqual('82f6192710');
    });

    it('rejects an exact balance combined with a bound in fromCore', () => {
      expect(() =>
        AccountBalanceInterval.fromCore({
          exactBalance: 1000n,
          inclusiveLowerBound: 100n,
        }),
      ).toThrowError(exactWithBoundsMessage);
    });

    it('rejects a negative integer', () => {
      expect(() => AccountBalanceInterval.fromCbor(HexBlob('20'))).toThrow(
        'Major type mismatch, expected type 4 but got 1',
      );
    });
  });

  describe('indefinite length arrays', () => {
    it('keeps an indefinite length array when re-encoded and writes a definite one when rebuilt', () => {
      const interval = AccountBalanceInterval.fromCbor(
        HexBlob(indefiniteVector.hex),
      );

      expect(interval.inclusiveLowerBound()).toEqual(
        0x94_64_e1_31_29_94_77_48n,
      );
      expect(interval.exclusiveUpperBound()).toEqual(
        0xc2_10_93_29_f2_9c_99_3dn,
      );
      expect(interval.toCbor()).toEqual(indefiniteVector.hex);
      expect(
        AccountBalanceInterval.fromCore(interval.toCore()).toCbor(),
      ).toEqual(`82${indefiniteVector.hex.slice(2, -2)}`);
    });

    it('accepts an indefinite length array with a nil bound', () => {
      const interval = AccountBalanceInterval.fromCbor(HexBlob('9ff6192710ff'));

      expect(interval.toCore()).toEqual({ exclusiveUpperBound: 10_000n });
      expect(interval.toCbor()).toEqual('9ff6192710ff');
    });

    it('rejects an indefinite length array with more than two elements', () => {
      expect(() =>
        AccountBalanceInterval.fromCbor(HexBlob('9f010203ff')),
      ).toThrow('Not at end of indefinite length data item');
    });

    it('rejects an indefinite length array with both bounds nil', () => {
      expect(() =>
        AccountBalanceInterval.fromCbor(HexBlob('9ff6f6ff')),
      ).toThrowError(bothNilMessage);
    });
  });

  describe('both-nil rejection', () => {
    it('rejects [null, null] on decode', () => {
      expect(() =>
        AccountBalanceInterval.fromCbor(HexBlob('82f6f6')),
      ).toThrowError(bothNilMessage);
    });

    it('rejects encoding an interval with no bounds', () => {
      expect(() => new AccountBalanceInterval().toCbor()).toThrowError(
        bothNilMessage,
      );
    });
  });

  describe('bound of zero', () => {
    it('decodes a zero lower bound as 0 rather than nil', () => {
      const interval = AccountBalanceInterval.fromCbor(HexBlob('8200f6'));

      expect(interval.inclusiveLowerBound()).toEqual(0n);
      expect(interval.exclusiveUpperBound()).toBeUndefined();
      expect(interval.toCbor()).toEqual('8200f6');
    });

    it('encodes a zero bound distinctly from an absent bound', () => {
      expect(new AccountBalanceInterval(0n, 10_000n).toCbor()).toEqual(
        '8200192710',
      );
      expect(new AccountBalanceInterval(undefined, 10_000n).toCbor()).toEqual(
        '82f6192710',
      );
    });
  });

  describe('setters', () => {
    it('invalidates cached original bytes on update', () => {
      const interval = AccountBalanceInterval.fromCbor(
        HexBlob(upperOnlyVector.hex),
      );
      interval.setInclusiveLowerBound(100n);

      expect(interval.toCbor()).toEqual('821864192710');
    });

    it('rejects a both-nil interval in fromCore', () => {
      expect(() => AccountBalanceInterval.fromCore({})).toThrowError(
        bothNilMessage,
      );
    });

    it('rejects encoding after clearing the only bound', () => {
      const interval = AccountBalanceInterval.fromCbor(
        HexBlob(lowerOnlyVector.hex),
      );
      interval.setInclusiveLowerBound();

      expect(() => interval.toCbor()).toThrowError(bothNilMessage);
    });
  });
});

describe('TransactionBody account balance intervals (key 26)', () => {
  describe('round trip', () => {
    it('round trips a body with all three interval shapes byte-exact', () => {
      const body = TransactionBody.fromCbor(canonicalBodyCbor);
      const intervals = body.accountBalanceIntervals();

      expect(intervals?.size).toEqual(3);
      expect(
        [...intervals!].map(([rewardAccount, interval]) => [
          rewardAccount,
          interval.toCore(),
        ]),
      ).toEqual([
        [accountA, { exclusiveUpperBound: 5000n, inclusiveLowerBound: 100n }],
        [accountB, { inclusiveLowerBound: 500n }],
        [accountS, { exclusiveUpperBound: 10_000n }],
      ]);
      expect(body.toCbor()).toEqual(canonicalBodyCbor);
      expect(TransactionBody.fromCore(body.toCore()).toCbor()).toEqual(
        canonicalBodyCbor,
      );
    });

    it('round trips an exact balance byte-exact', () => {
      const body = TransactionBody.fromCbor(exactBodyCbor);

      expect(body.toCore().accountBalanceIntervals).toEqual([
        { interval: { exactBalance: 1000n }, rewardAccount: accountA },
      ]);
      expect(body.toCbor()).toEqual(exactBodyCbor);
      expect(TransactionBody.fromCore(body.toCore()).toCbor()).toEqual(
        exactBodyCbor,
      );
    });

    it('preserves a non-canonical decoded map order on re-encode via original bytes', () => {
      const body = TransactionBody.fromCbor(reversedBodyCbor);

      expect([...body.accountBalanceIntervals()!.keys()]).toEqual([
        accountB,
        accountA,
      ]);
      expect(body.toCbor()).toEqual(reversedBodyCbor);
    });

    it('sorts account balance intervals canonically when rebuilt from core', () => {
      const body = TransactionBody.fromCbor(reversedBodyCbor);

      expect(TransactionBody.fromCore(body.toCore()).toCbor()).toEqual(
        `${bodyPrefix}181aa2${accountABytes}${bothBoundsHex}${accountBBytes}${lowerOnlyHex}`,
      );
    });

    it('round trips a body embedding the shared single-entry dijkstra vector', () => {
      const body = TransactionBody.fromCbor(sharedVectorBodyCbor);

      expect(body.toCbor()).toEqual(sharedVectorBodyCbor);
      expect(TransactionBody.fromCore(body.toCore()).toCbor()).toEqual(
        sharedVectorBodyCbor,
      );
    });

    it('keeps the body hash of a body that also asserts starting balances', () => {
      const body = TransactionBody.fromCbor(startingIntervalsBodyCbor);

      expect(body.toCbor()).toEqual(startingIntervalsBodyCbor);
      expect(body.hash()).toEqual(startingIntervalsBodyHash);
      expect(body.toCore().accountBalanceIntervals).toEqual(
        intervalsCore.accountBalanceIntervals,
      );
    });

    it('keeps the body hash of a body carrying every top level key', () => {
      const body = TransactionBody.fromCbor(allKeysBodyCbor);

      expect(body.toCbor()).toEqual(allKeysBodyCbor);
      expect(body.hash()).toEqual(allKeysBodyHash);
      expect(body.toCore().accountBalanceIntervals).toEqual(
        intervalsCore.accountBalanceIntervals,
      );
    });
  });

  describe('reward account keys', () => {
    it('rejects a map keyed by credential', () => {
      expect(() => TransactionBody.fromCbor(credentialKeyedBodyCbor)).toThrow(
        'Major type mismatch, expected type 2 but got 4',
      );
    });

    it('rejects a map keyed by an address that is not a reward account', () => {
      expect(() => TransactionBody.fromCbor(paymentKeyedBodyCbor)).toThrowError(
        'account_balance_intervals (transaction body key 26) must be keyed by reward accounts',
      );
    });

    it('rejects a map with a repeated reward account', () => {
      expect(() =>
        TransactionBody.fromCbor(
          HexBlob(
            `${bodyPrefix}181aa2${accountABytes}${bothBoundsHex}${accountABytes}${lowerOnlyHex}`,
          ),
        ),
      ).toThrowError(
        `Duplicate reward account in account_balance_intervals (transaction body key 26): ${accountA}`,
      );
    });
  });

  describe('non-empty enforcement', () => {
    it('rejects an empty map at key 26 on decode', () => {
      expect(() =>
        TransactionBody.fromCbor(emptyIntervalsBodyCbor),
      ).toThrowError(
        'account_balance_intervals (transaction body key 26) must be a non-empty map',
      );
    });
  });

  describe('omission when unset', () => {
    it('leaves bodies without key 26 unaffected', () => {
      const body = TransactionBody.fromCbor(noIntervalsBodyCbor);

      expect(body.accountBalanceIntervals()).toBeUndefined();
      expect(body.toCore().accountBalanceIntervals).toBeUndefined();
      expect(body.toCbor()).toEqual(noIntervalsBodyCbor);
    });

    it('omits key 26 when the core field is absent', () => {
      expect(TransactionBody.fromCore(baseCore).toCbor()).toEqual(
        noIntervalsBodyCbor,
      );
    });

    it('omits key 26 when the map is set but empty', () => {
      const body = TransactionBody.fromCore(baseCore);
      body.setAccountBalanceIntervals(new Map());

      expect(body.toCbor()).toEqual(noIntervalsBodyCbor);
    });
  });

  describe('toCore/fromCore symmetry', () => {
    it('maps key 26 to the accountBalanceIntervals core field', () => {
      expect(
        TransactionBody.fromCbor(canonicalBodyCbor).toCore()
          .accountBalanceIntervals,
      ).toEqual(intervalsCore.accountBalanceIntervals);
    });

    it('encodes the accountBalanceIntervals core field as key 26', () => {
      expect(TransactionBody.fromCore(intervalsCore).toCbor()).toEqual(
        canonicalBodyCbor,
      );
    });

    it('is symmetric through fromCore -> toCore', () => {
      expect(
        TransactionBody.fromCore(intervalsCore).toCore()
          .accountBalanceIntervals,
      ).toEqual(intervalsCore.accountBalanceIntervals);
    });
  });

  describe('setter', () => {
    it('setAccountBalanceIntervals invalidates cached original bytes', () => {
      const body = TransactionBody.fromCbor(reversedBodyCbor);
      body.setAccountBalanceIntervals(body.accountBalanceIntervals()!);

      expect(body.toCbor()).toEqual(
        `${bodyPrefix}181aa2${accountABytes}${bothBoundsHex}${accountBBytes}${lowerOnlyHex}`,
      );
    });
  });
});

describe('TransactionBody starting account balance intervals (key 27)', () => {
  describe('round trip', () => {
    it('decodes a range and an exact balance and keeps the body hash', () => {
      const body = TransactionBody.fromCbor(startingOnlyBodyCbor);

      expect(body.accountBalanceIntervals()).toBeUndefined();
      expect(body.toCore().startingAccountBalanceIntervals).toEqual(
        startingIntervalsCore.startingAccountBalanceIntervals,
      );
      expect(body.toCbor()).toEqual(startingOnlyBodyCbor);
      expect(body.hash()).toEqual(startingOnlyBodyHash);
    });

    it('keeps the starting balances and the body hash when rebuilt from its core form', () => {
      const rebuilt = TransactionBody.fromCore(
        TransactionBody.fromCbor(startingOnlyBodyCbor).toCore(),
      );

      expect(rebuilt.toCbor()).toEqual(startingOnlyBodyCbor);
      expect(rebuilt.hash()).toEqual(startingOnlyBodyHash);
    });

    it('keeps key 26 and key 27 apart when rebuilt from its core form', () => {
      const body = TransactionBody.fromCbor(startingIntervalsBodyCbor);
      const core = body.toCore();

      expect(core.startingAccountBalanceIntervals).toEqual([
        { interval: { exclusiveUpperBound: 10_000n }, rewardAccount: accountB },
        { interval: { exactBalance: 42n }, rewardAccount: accountS },
      ]);
      expect(TransactionBody.fromCore(core).toCbor()).toEqual(
        startingIntervalsBodyCbor,
      );
      expect(TransactionBody.fromCore(core).hash()).toEqual(
        startingIntervalsBodyHash,
      );
    });

    it('accepts key 27 in strict mode', () => {
      const body = TransactionBody.fromCbor(startingOnlyBodyCbor, {
        strict: true,
      });

      expect(body.startingAccountBalanceIntervals()?.size).toEqual(2);
    });

    it('preserves a non-canonical decoded map order on re-encode via original bytes', () => {
      expect(
        TransactionBody.fromCbor(reversedStartingBodyCbor).toCbor(),
      ).toEqual(reversedStartingBodyCbor);
    });

    it('sorts starting account balance intervals canonically when rebuilt from core', () => {
      const body = TransactionBody.fromCbor(reversedStartingBodyCbor);

      expect(TransactionBody.fromCore(body.toCore()).toCbor()).toEqual(
        startingOnlyBodyCbor,
      );
    });
  });

  describe('decode rejections', () => {
    it('rejects an empty map', () => {
      expect(() =>
        TransactionBody.fromCbor(emptyStartingBodyCbor),
      ).toThrowError(
        'starting_account_balance_intervals (transaction body key 27) must be a non-empty map',
      );
    });

    it('rejects a map keyed by an address that is not a reward account', () => {
      expect(() =>
        TransactionBody.fromCbor(paymentKeyedStartingBodyCbor),
      ).toThrowError(
        'starting_account_balance_intervals (transaction body key 27) must be keyed by reward accounts',
      );
    });

    it('rejects a map with a repeated reward account', () => {
      expect(() =>
        TransactionBody.fromCbor(
          HexBlob(
            `${bodyPrefix}181ba2${accountBBytes}${upperOnlyHex}${accountBBytes}182a`,
          ),
        ),
      ).toThrowError(
        `Duplicate reward account in starting_account_balance_intervals (transaction body key 27): ${accountB}`,
      );
    });

    it('does not admit key 27 on a sub transaction body', () => {
      expect(() =>
        SubTransactionBody.fromCbor(
          HexBlob(`a300d90102800180181ba1${accountBBytes}${upperOnlyHex}`),
        ),
      ).toThrowError(
        'Top-level-only transaction body map key not allowed in sub transaction body: 27',
      );
    });
  });

  describe('building in code', () => {
    it('encodes the startingAccountBalanceIntervals core field as key 27', () => {
      const body = TransactionBody.fromCore(startingIntervalsCore);

      expect(body.toCbor()).toEqual(startingOnlyBodyCbor);
      expect(body.toCore().startingAccountBalanceIntervals).toEqual(
        startingIntervalsCore.startingAccountBalanceIntervals,
      );
    });

    it('writes key 27 when set on a decoded body', () => {
      const body = TransactionBody.fromCbor(noIntervalsBodyCbor);
      body.setStartingAccountBalanceIntervals(
        new Map([
          [accountS, AccountBalanceInterval.newExact(42n)],
          [accountB, new AccountBalanceInterval(undefined, 10_000n)],
        ]),
      );

      expect(body.toCbor()).toEqual(startingOnlyBodyCbor);
    });

    it('omits key 27 when the core field is absent', () => {
      const body = TransactionBody.fromCore(baseCore);

      expect(body.toCbor()).toEqual(noIntervalsBodyCbor);
      expect('startingAccountBalanceIntervals' in body.toCore()).toBe(false);
    });

    it('omits key 27 when the map is set but empty', () => {
      const body = TransactionBody.fromCore(baseCore);
      body.setStartingAccountBalanceIntervals(new Map());

      expect(body.toCbor()).toEqual(noIntervalsBodyCbor);
    });
  });
});

describe('Musashi transaction with account balance intervals', () => {
  const tx = Transaction.fromCbor(TxCBOR(musashiVector.hex));
  const subTransactions = tx.body().subTransactions()!.values();

  it('re-encodes byte-exact and keeps its ids', () => {
    expect(tx.toCbor()).toEqual(musashiVector.hex);
    expect(tx.getId()).toEqual(
      '17c61dcf86b74a9dcbdd9a6d6a1fc8e64b435a17c520e10b72463a41fdd4969e',
    );
    expect(
      subTransactions.map(subTransaction => subTransaction.getId()),
    ).toEqual([
      '48f98f8c525dc50b78e93b3d4bf393b5e60d35779e9be47f2dfce5e6b9bf8a17',
      '9b4f3d97fd7a98814d72241f05953004bfc48e2ab4943976b78bb9cad1ccd5c7',
    ]);
  });

  it('decodes an exact balance on the top level body', () => {
    expect(tx.toCore().body.accountBalanceIntervals).toEqual([
      { interval: { exactBalance: 5_000_000n }, rewardAccount: musashiAccount },
    ]);
  });

  it('decodes an exact balance and a range on its sub transaction bodies', () => {
    expect(
      subTransactions.map(
        subTransaction =>
          subTransaction.body().toCore().accountBalanceIntervals,
      ),
    ).toEqual([
      [
        {
          interval: { exactBalance: 5_000_000n },
          rewardAccount: musashiAccount,
        },
      ],
      [
        {
          interval: { inclusiveLowerBound: 8_000_000n },
          rewardAccount: musashiAccount,
        },
      ],
    ]);
  });

  it('writes the same intervals when its sub transaction bodies are rebuilt from core', () => {
    expect(
      subTransactions.map(subTransaction => {
        const body = subTransaction.body();
        const rebuilt = SubTransactionBody.fromCore(body.toCore()).toCbor();

        expect(SubTransactionBody.fromCbor(rebuilt).toCore()).toEqual(
          body.toCore(),
        );

        return rebuilt.slice(rebuilt.lastIndexOf('181aa1'));
      }),
    ).toEqual([
      `181aa1${musashiAccountBytes}1a004c4b40`,
      `181aa1${musashiAccountBytes}821a007a1200f6`,
    ]);
  });
});
