// The pending-withdrawal selectors (LW-15725) read in-flight transactions as
// they come back from persistence: encoded by Serializable, through JSON,
// decoded by the in-flight selector. Quantities must survive exactly.
import { AccountId } from '@lace-contract/wallet-repo';
import { Cardano } from '@lace-lib/cardano-core';
import { BigNumber, Timestamp } from '@lace-lib/util';
import { describe, expect, it } from 'vitest';

import { pendingRewardWithdrawalKey } from '../../src';
import {
  cardanoContextActions as actions,
  cardanoContextReducers as reducers,
  cardanoContextSelectors as selectors,
  initialState,
} from '../../src/store/slice';

import type { CardanoTxId } from '../../src';
import type { CardanoContextSliceState } from '../../src/store/slice';

type SelectorState = Parameters<
  typeof selectors.cardanoContext.selectRewardAccountDetailsWithInFlight
>[0];

const ACCOUNT = AccountId('account-0');
const REWARD_ACCOUNT = Cardano.RewardAccount(
  'stake_test1up7pvfq8zn4quy45r2g572290p9vf99mr9tn7r9xrgy2l2qdsf58d',
);
// Above Number.MAX_SAFE_INTEGER: a lossy number round-trip would show.
const WITHDRAWN = 9_007_199_254_740_993n;

const recordWithdrawal = (
  state: CardanoContextSliceState,
  quantity: bigint,
  txId = 'aa'.repeat(32),
) =>
  reducers.cardanoContext(
    state,
    actions.cardanoContext.recordInFlightTransaction({
      chainId: Cardano.ChainIds.Preprod,
      txId: txId as CardanoTxId,
      effects: {
        consumedInputs: [],
        producedOutputs: [],
        withdrawals: [{ stakeAddress: REWARD_ACCOUNT, quantity }],
      },
      submittedAt: Timestamp(0),
    }),
  );

const stateWith = ({
  withdrawable,
  withdrawals = [],
}: {
  withdrawable: bigint;
  /** The withdrawal of each in-flight transaction, one transaction each. */
  withdrawals?: bigint[];
}): SelectorState => {
  let cardanoContext = reducers.cardanoContext(
    initialState,
    actions.cardanoContext.setRewardAccountDetails({
      accountId: ACCOUNT,
      details: {
        rewardAccountInfo: {
          controlledAmount: BigNumber(withdrawable),
          isActive: true,
          isRegistered: true,
          rewardsSum: BigNumber(withdrawable),
          withdrawableAmount: BigNumber(withdrawable),
        },
      },
    }),
  );
  withdrawals.forEach((quantity, index) => {
    cardanoContext = recordWithdrawal(
      cardanoContext,
      quantity,
      String(index).padStart(64, '0'),
    );
  });
  const state = {
    cardanoContext,
    addresses: {
      addresses: [
        {
          accountId: ACCOUNT,
          address: 'addr_test1-account-0',
          blockchainName: 'Cardano',
          name: 'account 0',
          data: {
            networkMagic: Cardano.NetworkMagics.Preprod,
            rewardAccount: REWARD_ACCOUNT,
          },
        },
      ],
    },
  };
  // What a restart reads back from storage.
  return JSON.parse(JSON.stringify(state)) as SelectorState;
};

describe('pending reward withdrawal selectors', () => {
  it('reads pending withdrawals back from persisted in-flight transactions exactly', () => {
    const state = stateWith({
      withdrawable: WITHDRAWN,
      withdrawals: [WITHDRAWN],
    });

    expect(
      selectors.cardanoContext.selectPendingRewardWithdrawals(state),
    ).toEqual(
      new Map([
        [
          pendingRewardWithdrawalKey(
            Cardano.NetworkMagics.Preprod,
            REWARD_ACCOUNT,
          ),
          WITHDRAWN,
        ],
      ]),
    );
  });

  it('stops counting rewards a pending transaction already withdrew', () => {
    const state = stateWith({
      withdrawable: WITHDRAWN + 5n,
      withdrawals: [WITHDRAWN],
    });

    expect(
      selectors.cardanoContext.selectRewardAccountDetailsWithInFlight(state)[
        ACCOUNT
      ]?.rewardAccountInfo.withdrawableAmount,
    ).toBe('5');
    // The raw view is what the chain reports, for screens and builders.
    expect(
      selectors.cardanoContext.selectRewardAccountDetails(state)[ACCOUNT]
        ?.rewardAccountInfo.withdrawableAmount,
    ).toBe((WITHDRAWN + 5n).toString());
  });

  it('returns the raw details when nothing is pending', () => {
    const state = stateWith({ withdrawable: 10n });

    expect(
      selectors.cardanoContext.selectRewardAccountDetailsWithInFlight(state),
    ).toBe(selectors.cardanoContext.selectRewardAccountDetails(state));
  });

  it('sums the withdrawals of several in-flight transactions', () => {
    const state = stateWith({ withdrawable: 10n, withdrawals: [3n, 4n] });

    expect(
      selectors.cardanoContext.selectRewardAccountDetailsWithInFlight(state)[
        ACCOUNT
      ]?.rewardAccountInfo.withdrawableAmount,
    ).toBe('3');
  });

  it('counts a transaction recorded twice once', () => {
    const recorded = recordWithdrawal(initialState, 3n);
    const state = {
      cardanoContext: recordWithdrawal(recorded, 3n),
    } as unknown as SelectorState;

    expect(
      selectors.cardanoContext.selectPendingRewardWithdrawals(state),
    ).toEqual(
      new Map([
        [
          pendingRewardWithdrawalKey(
            Cardano.NetworkMagics.Preprod,
            REWARD_ACCOUNT,
          ),
          3n,
        ],
      ]),
    );
  });
});
