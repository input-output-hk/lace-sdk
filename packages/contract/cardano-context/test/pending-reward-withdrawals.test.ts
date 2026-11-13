// Pending withdrawals (LW-15725): a submitted transaction's rewards already
// sit in its pending outputs, so the balance must not also count them as
// withdrawable, and builders must know they are spoken for.
import { AccountId } from '@lace-contract/wallet-repo';
import { Cardano } from '@lace-lib/cardano-core';
import { BigNumber } from '@lace-lib/util';
import { describe, expect, it } from 'vitest';

import {
  applyPendingRewardWithdrawals,
  pendingRewardWithdrawalKey,
  pendingRewardWithdrawals,
} from '../src/apply-in-flight-utxo-adjustments';

import type { AccountRewardAccountDetailsMap } from '../src/types';
import type { AnyAddress } from '@lace-contract/addresses';

const ACCOUNT_A = AccountId('account-a');
const ACCOUNT_B = AccountId('account-b');
// Same wallet keys on Preview: Preview and Preprod share reward addresses.
const ACCOUNT_A_PREVIEW = AccountId('account-a-preview');
const PREPROD = Cardano.NetworkMagics.Preprod;
const PREVIEW = Cardano.NetworkMagics.Preview;
const KEY_A = Cardano.RewardAccount(
  'stake_test1up7pvfq8zn4quy45r2g572290p9vf99mr9tn7r9xrgy2l2qdsf58d',
);
const KEY_B = Cardano.RewardAccount(
  'stake_test1upjghly04re6yrr3nh3ntp9en3p5flnxh2yf6camc3vfhwg6dhc5w',
);

const inFlight = (
  withdrawals?: Cardano.Withdrawal[],
  chainId: Cardano.ChainId = Cardano.ChainIds.Preprod,
) => ({
  chainId,
  effects: {
    consumedInputs: [],
    producedOutputs: [],
    ...(withdrawals && { withdrawals }),
  },
});

const address = ({
  accountId,
  name,
  networkMagic,
  rewardAccount,
}: {
  accountId: AccountId;
  name: string;
  networkMagic: Cardano.NetworkMagic;
  rewardAccount?: Cardano.RewardAccount;
}) =>
  ({
    accountId,
    address: name,
    blockchainName: 'Cardano',
    data: { networkMagic, ...(rewardAccount && { rewardAccount }) },
  } as unknown as AnyAddress);

const addresses = [
  address({ accountId: ACCOUNT_A, name: 'addr-a0', networkMagic: PREPROD }),
  address({
    accountId: ACCOUNT_A,
    name: 'addr-a1',
    networkMagic: PREPROD,
    rewardAccount: KEY_A,
  }),
  address({
    accountId: ACCOUNT_A,
    name: 'addr-a2',
    networkMagic: PREPROD,
    rewardAccount: KEY_B,
  }),
  address({
    accountId: ACCOUNT_B,
    name: 'addr-b0',
    networkMagic: PREPROD,
    rewardAccount: KEY_B,
  }),
  address({
    accountId: ACCOUNT_A_PREVIEW,
    name: 'addr-ap0',
    networkMagic: PREVIEW,
    rewardAccount: KEY_A,
  }),
];

const key = (rewardAccount: Cardano.RewardAccount, networkMagic = PREPROD) =>
  pendingRewardWithdrawalKey(networkMagic, rewardAccount);

describe('pendingRewardWithdrawals', () => {
  it('sums withdrawals per reward account across every in-flight transaction of a network', () => {
    // Whichever account pays for a transaction, its withdrawal of B's rewards
    // counts for B.
    const totals = pendingRewardWithdrawals([
      inFlight([
        { stakeAddress: KEY_A, quantity: 3n },
        { stakeAddress: KEY_B, quantity: 5n },
      ]),
      inFlight([{ stakeAddress: KEY_A, quantity: 4n }]),
    ]);

    expect(totals).toEqual(
      new Map([
        [key(KEY_A), 7n],
        [key(KEY_B), 5n],
      ]),
    );
  });

  it("keys each withdrawal by its transaction's network even when the reward address is the same", () => {
    const totals = pendingRewardWithdrawals([
      inFlight(
        [{ stakeAddress: KEY_A, quantity: 3n }],
        Cardano.ChainIds.Preview,
      ),
    ]);

    expect(totals.get(key(KEY_A, PREVIEW))).toBe(3n);
    expect(totals.has(key(KEY_A))).toBe(false);
  });

  it('ignores in-flight transactions without withdrawals', () => {
    expect(pendingRewardWithdrawals([inFlight(), inFlight([])]).size).toBe(0);
  });
});

describe('applyPendingRewardWithdrawals', () => {
  const details = (
    withdrawableA: bigint,
    withdrawableB = 20n,
  ): AccountRewardAccountDetailsMap =>
    ({
      [ACCOUNT_A]: {
        rewardAccountInfo: {
          isRegistered: true,
          withdrawableAmount: BigNumber(withdrawableA),
        },
      },
      [ACCOUNT_B]: {
        rewardAccountInfo: {
          isRegistered: true,
          withdrawableAmount: BigNumber(withdrawableB),
        },
      },
      [ACCOUNT_A_PREVIEW]: {
        rewardAccountInfo: {
          isRegistered: true,
          withdrawableAmount: BigNumber(30n),
        },
      },
    } as unknown as AccountRewardAccountDetailsMap);

  const withdrawableOf = (
    map: AccountRewardAccountDetailsMap,
    accountId: AccountId,
  ) => map[accountId]?.rewardAccountInfo.withdrawableAmount;

  it.each([
    {
      label: 'above the pending withdrawal',
      withdrawable: 10n,
      reserved: 4n,
      expected: '6',
    },
    {
      label: 'equal to the pending withdrawal',
      withdrawable: 10n,
      reserved: 10n,
      expected: '0',
    },
    {
      label: 'below the pending withdrawal (never negative)',
      withdrawable: 3n,
      reserved: 10n,
      expected: '0',
    },
  ])(
    'subtracts pending withdrawals from a balance $label',
    ({ withdrawable, reserved, expected }) => {
      const result = applyPendingRewardWithdrawals(
        details(withdrawable),
        new Map([[key(KEY_A), reserved]]),
        addresses,
      );

      expect(withdrawableOf(result, ACCOUNT_A)).toBe(expected);
    },
  );

  it("matches the account's first stake key only", () => {
    // KEY_B is account A's second key, so it does not reduce A's details.
    const input = details(10n);
    const result = applyPendingRewardWithdrawals(
      input,
      new Map([[key(KEY_B), 4n]]),
      addresses,
    );

    expect(withdrawableOf(result, ACCOUNT_A)).toBe('10');
    expect(withdrawableOf(result, ACCOUNT_B)).toBe('16');
    expect(result[ACCOUNT_A]).toBe(input[ACCOUNT_A]);
  });

  it("only reduces the account on the withdrawal's network", () => {
    const input = details(10n);
    const result = applyPendingRewardWithdrawals(
      input,
      new Map([[key(KEY_A, PREVIEW), 4n]]),
      addresses,
    );

    expect(withdrawableOf(result, ACCOUNT_A_PREVIEW)).toBe('26');
    expect(withdrawableOf(result, ACCOUNT_A)).toBe('10');
  });

  it('keeps every other field of the reward details', () => {
    const input = details(10n);
    const result = applyPendingRewardWithdrawals(
      input,
      new Map([[key(KEY_A), 4n]]),
      addresses,
    );

    expect(result[ACCOUNT_A]?.rewardAccountInfo).toEqual({
      ...input[ACCOUNT_A]?.rewardAccountInfo,
      withdrawableAmount: BigNumber(6n),
    });
  });

  it('returns the same object when nothing changes', () => {
    const input = details(10n);

    expect(applyPendingRewardWithdrawals(input, new Map(), addresses)).toBe(
      input,
    );
    expect(
      applyPendingRewardWithdrawals(
        input,
        new Map([['1:stake_test-unrelated', 4n]]),
        addresses,
      ),
    ).toBe(input);
  });

  it('leaves an account with no reward account on its addresses unchanged', () => {
    const input = details(10n);
    const result = applyPendingRewardWithdrawals(
      input,
      new Map([[key(KEY_A), 4n]]),
      addresses.filter(entry => entry.accountId !== ACCOUNT_A),
    );

    expect(result).toBe(input);
  });
});
