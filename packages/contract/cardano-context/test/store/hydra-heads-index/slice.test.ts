import { walletsActions } from '@lace-contract/wallet-repo';
import { BigNumber } from '@lace-lib/util';
import { describe, expect, it } from 'vitest';

import {
  fromHydraHeadsIndexHistory,
  fromHydraHeadsIndexValue,
  hydraHeadsIndexActions,
  hydraHeadsIndexReducers,
  hydraHeadsIndexSelectors,
} from '../../../src/store/hydra-heads-index';

import type {
  HydraHeadsIndexSliceState,
  HydraHeadsIndexValue,
} from '../../../src/store/hydra-heads-index';
import type { AccountId, WalletId } from '@lace-contract/wallet-repo';
import type {
  HydraAccountDeposit,
  HydraAccountHead,
  HydraHeadFunds,
  HydraHeadHistoryTx,
} from '@lace-lib/hydra-head';

const accountId = 'test-account' as AccountId;
const otherAccountId = 'other-account' as AccountId;
const walletId = 'test-wallet' as WalletId;

const headId = '324c8b8198c4c9db7526d6dccb79e992c4863b24b56453bb16995bdc';
const assetId = `${headId}4879647261486561645632`;
const syncedAt = new Date('2026-10-01T12:00:00.000Z');
const laterSyncedAt = new Date('2026-10-01T12:05:00.000Z');

const deposit: HydraAccountDeposit = {
  outpoint: { txId: 'c1'.repeat(32), index: 0 },
  headId,
  deadline: Date.parse('2026-10-02T00:00:00.000Z'),
  value: { coins: 4_626_931n, assets: new Map([[assetId, 3n]]) },
  status: 'pending',
};

const head: HydraAccountHead = {
  headId,
  version: '2.3.0',
  outpoint: { txId: '99'.repeat(32), index: 0 },
  state: 'closed',
  contestationDeadline: Date.parse('2026-10-03T00:00:00.000Z'),
  headValue: { coins: 2_094_660n, assets: new Map([[assetId, 1n]]) },
  participantCount: 1,
  isParticipant: true,
  isSoleParticipant: true,
};

const indexedDeposit = {
  outpoint: { txId: 'c1'.repeat(32), index: 0 },
  headId,
  deadline: '2026-10-02T00:00:00.000Z',
  value: { coins: '4626931', assets: { [assetId]: '3' } },
  status: 'pending',
};

const indexedHead = {
  headId,
  version: '2.3.0',
  outpoint: { txId: '99'.repeat(32), index: 0 },
  state: 'closed',
  contestationDeadline: '2026-10-03T00:00:00.000Z',
  headValue: { coins: '2094660', assets: { [assetId]: '1' } },
  participantCount: 1,
  isParticipant: true,
  isSoleParticipant: true,
};

const historyTx: HydraHeadHistoryTx = {
  txId: '99'.repeat(32),
  inputs: [
    {
      txId: 'c1'.repeat(32),
      index: 0,
      address:
        'addr_test1wrrcaryjq4epavl0gsg08kuuv95l5md5jlpyvswjnss998qyu7lhm',
      value: { coins: 4_626_931n, assets: new Map() },
      inlineDatum: 'd87980',
    },
  ],
  outputs: [
    {
      txId: '99'.repeat(32),
      index: 0,
      address:
        'addr_test1wq4erflxvet45fr9hrrldflevr2cwr83x622vlejzhspf3gn6jry8',
      value: { coins: 2_094_660n, assets: new Map([[assetId, 1n]]) },
    },
  ],
};

const indexedHistoryTx = {
  txId: '99'.repeat(32),
  inputs: [
    {
      txId: 'c1'.repeat(32),
      index: 0,
      address:
        'addr_test1wrrcaryjq4epavl0gsg08kuuv95l5md5jlpyvswjnss998qyu7lhm',
      value: { coins: '4626931', assets: {} },
      inlineDatum: 'd87980',
    },
  ],
  outputs: [
    {
      txId: '99'.repeat(32),
      index: 0,
      address:
        'addr_test1wq4erflxvet45fr9hrrldflevr2cwr83x622vlejzhspf3gn6jry8',
      value: { coins: '2094660', assets: { [assetId]: '1' } },
    },
  ],
};

const reducer = hydraHeadsIndexReducers.hydraHeadsIndex;
const {
  activitiesTagged,
  activitiesUntagged,
  headFundsResolved,
  sweepCompleted,
  sweepFailed,
} = hydraHeadsIndexActions.hydraHeadsIndex;
const {
  selectActivitiesTaggedByAccount,
  selectDepositedHeadIdsByAccount,
  selectGenuineByHeadId,
  selectHistoryByHeadId,
  selectHydraDepositsByAccount,
  selectHydraHeadsByAccount,
  selectIndexByAccount,
} = hydraHeadsIndexSelectors.hydraHeadsIndex;

const completed = (at = syncedAt) =>
  sweepCompleted({
    syncedAt: at,
    accounts: [
      { accountId, deposits: [deposit], heads: [head], candidateHeads: [] },
      {
        accountId: otherAccountId,
        deposits: [],
        heads: [],
        candidateHeads: [],
      },
    ],
  });

const funds: HydraHeadFunds = {
  deposited: { coins: 15_000_000n, assets: new Map([[assetId, 2n]]) },
  withdrawn: { coins: 7_000_000n, assets: new Map() },
};

const indexedFunds = {
  depositedValue: { coins: '15000000', assets: { [assetId]: '2' } },
  withdrawnValue: { coins: '7000000', assets: {} },
};

const resolved = (headFunds: HydraHeadFunds | undefined) =>
  headFundsResolved({
    accounts: [
      {
        accountId,
        heads: [head],
        fundsByHeadId: { [headId]: headFunds },
        candidateHeads: [],
      },
    ],
    headHistories: {},
    genuineByHeadId: { [headId]: true },
  });

const rootOf = (hydraHeadsIndex: HydraHeadsIndexSliceState) => ({
  hydraHeadsIndex,
});

describe('hydraHeadsIndex slice', () => {
  it('starts with no accounts indexed', () => {
    expect(reducer(undefined, { type: '@@init' })).toEqual({
      byAccount: {},
      historyByHeadId: {},
      genuineByHeadId: {},
      depositedHeadIdsByAccount: {},
      activitiesTaggedByAccount: {},
    });
  });

  describe('accounts whose activities carry the Hydra Head tags', () => {
    it('marks the tagged accounts, keeping the others', () => {
      const state = reducer(
        reducer(undefined, activitiesTagged({ accountIds: [accountId] })),
        activitiesTagged({ accountIds: [otherAccountId] }),
      );

      expect(state.activitiesTaggedByAccount).toEqual({
        [accountId]: true,
        [otherAccountId]: true,
      });
    });

    it('forgets every mark once activities are untagged', () => {
      const state = reducer(
        reducer(
          undefined,
          activitiesTagged({ accountIds: [accountId, otherAccountId] }),
        ),
        activitiesUntagged(),
      );

      expect(state.activitiesTaggedByAccount).toEqual({});
    });

    it('keeps the marks when a sweep completes or fails', () => {
      const tagged = reducer(
        undefined,
        activitiesTagged({ accountIds: [accountId] }),
      );

      expect(reducer(tagged, completed()).activitiesTaggedByAccount).toBe(
        tagged.activitiesTaggedByAccount,
      );
      expect(
        reducer(tagged, sweepFailed({ accountIds: [accountId] }))
          .activitiesTaggedByAccount,
      ).toBe(tagged.activitiesTaggedByAccount);
    });

    it('drops the mark of a removed account and of a removed wallet', () => {
      const tagged = reducer(
        undefined,
        activitiesTagged({ accountIds: [accountId, otherAccountId] }),
      );

      expect(
        reducer(
          tagged,
          walletsActions.wallets.removeAccount(walletId, accountId),
        ).activitiesTaggedByAccount,
      ).toEqual({ [otherAccountId]: true });
      expect(
        reducer(
          tagged,
          walletsActions.wallets.removeWallet(walletId, [
            accountId,
            otherAccountId,
          ]),
        ).activitiesTaggedByAccount,
      ).toEqual({});
    });
  });

  it('stores what a sweep found per account in plain JSON', () => {
    const state = reducer(undefined, completed());

    expect(state.byAccount[accountId]).toEqual({
      snapshot: {
        deposits: [indexedDeposit],
        heads: [indexedHead],
        lastSyncedAt: '2026-10-01T12:00:00.000Z',
      },
      failed: false,
    });
    expect(state.byAccount[otherAccountId]).toEqual({
      snapshot: {
        deposits: [],
        heads: [],
        lastSyncedAt: '2026-10-01T12:00:00.000Z',
      },
      failed: false,
    });
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
  });

  it('omits the contestation deadline of a head that has none', () => {
    const state = reducer(
      undefined,
      sweepCompleted({
        syncedAt,
        accounts: [
          {
            accountId,
            deposits: [],
            heads: [
              { ...head, state: 'open', contestationDeadline: undefined },
            ],
            candidateHeads: [],
          },
        ],
      }),
    );

    expect(state.byAccount[accountId]?.snapshot?.heads[0]).not.toHaveProperty(
      'contestationDeadline',
    );
  });

  it('stores what the account moved through a head in plain JSON', () => {
    const state = reducer(reducer(undefined, completed()), resolved(funds));

    expect(state.byAccount[accountId]?.snapshot?.heads).toEqual([
      { ...indexedHead, ...indexedFunds },
    ]);
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
  });

  it('stores no figures before the head histories are read', () => {
    const state = reducer(undefined, completed());

    expect(state.byAccount[accountId]?.snapshot?.heads[0]).not.toHaveProperty(
      'depositedValue',
    );
    expect(state.byAccount[accountId]?.snapshot?.heads[0]).not.toHaveProperty(
      'withdrawnValue',
    );
  });

  it('removes the figures of a head whose history could not be read', () => {
    const state = reducer(
      reducer(reducer(undefined, completed()), resolved(funds)),
      resolved(undefined),
    );

    expect(state.byAccount[accountId]?.snapshot?.heads).toEqual([indexedHead]);
  });

  it('keeps the figures of a head through the next sweep while its head UTxO is unchanged', () => {
    const state = reducer(
      reducer(reducer(undefined, completed()), resolved(funds)),
      completed(laterSyncedAt),
    );

    expect(state.byAccount[accountId]?.snapshot?.heads).toEqual([
      { ...indexedHead, ...indexedFunds },
    ]);
  });

  it('drops the figures of a head whose head UTxO moved with the next sweep', () => {
    const state = reducer(
      reducer(reducer(undefined, completed()), resolved(funds)),
      sweepCompleted({
        syncedAt: laterSyncedAt,
        accounts: [
          {
            accountId,
            deposits: [],
            heads: [{ ...head, outpoint: { txId: 'aa'.repeat(32), index: 0 } }],
            candidateHeads: [],
          },
        ],
      }),
    );

    expect(state.byAccount[accountId]?.snapshot?.heads[0]).not.toHaveProperty(
      'depositedValue',
    );
  });

  describe('heads the account only deposited into', () => {
    const depositedHeadId = 'd7'.repeat(28);
    const depositedHead: HydraAccountHead = {
      ...head,
      headId: depositedHeadId,
      outpoint: { txId: 'd7'.repeat(32), index: 0 },
      participantCount: 2,
      isParticipant: false,
      isSoleParticipant: false,
    };
    const indexedDepositedHead = {
      ...indexedHead,
      headId: depositedHeadId,
      outpoint: { txId: 'd7'.repeat(32), index: 0 },
      participantCount: 2,
      isParticipant: false,
      isSoleParticipant: false,
    };

    const sweptWithCandidate = (
      candidate: HydraAccountHead = depositedHead,
      at = syncedAt,
    ) =>
      sweepCompleted({
        syncedAt: at,
        accounts: [
          {
            accountId,
            deposits: [],
            heads: [head],
            candidateHeads: [candidate],
          },
        ],
      });

    const resolvedDeposit = (
      depositedFunds: HydraHeadFunds | undefined,
      candidateHeads = [depositedHead],
    ) =>
      headFundsResolved({
        accounts: [
          {
            accountId,
            heads: [head],
            fundsByHeadId: {
              [headId]: funds,
              [depositedHeadId]: depositedFunds,
            },
            candidateHeads,
          },
        ],
        headHistories: {},
        genuineByHeadId: { [headId]: true, [depositedHeadId]: true },
      });

    const headsOf = (state: HydraHeadsIndexSliceState) =>
      state.byAccount[accountId]?.snapshot?.heads;

    it('leaves a candidate out until its history confirms the deposit', () => {
      const swept = reducer(undefined, sweptWithCandidate());

      expect(headsOf(swept)).toEqual([indexedHead]);
      expect(headsOf(reducer(swept, resolvedDeposit(funds)))).toEqual([
        { ...indexedHead, ...indexedFunds },
        { ...indexedDepositedHead, ...indexedFunds },
      ]);
    });

    describe('with a deposit of the account waiting for the candidate', () => {
      const waitingDeposit: HydraAccountDeposit = {
        ...deposit,
        headId: depositedHeadId,
      };
      const sweptWithWaitingDeposit = sweepCompleted({
        syncedAt,
        accounts: [
          {
            accountId,
            deposits: [waitingDeposit],
            heads: [head],
            candidateHeads: [depositedHead],
          },
        ],
      });

      it('lists the candidate as soon as the sweep stores the deposit', () => {
        expect(headsOf(reducer(undefined, sweptWithWaitingDeposit))).toEqual([
          indexedHead,
          indexedDepositedHead,
        ]);
      });

      /**
       * A sweep that stores the deposit before the candidate is verified,
       * then a resolution with the candidate's verdict and no figures.
       */
      const resolvedUnverified = (isGenuine: boolean) =>
        reducer(
          reducer(
            undefined,
            sweepCompleted({
              syncedAt,
              accounts: [
                {
                  accountId,
                  deposits: [waitingDeposit],
                  heads: [head],
                  candidateHeads: [],
                },
              ],
            }),
          ),
          headFundsResolved({
            accounts: [
              {
                accountId,
                heads: [head],
                fundsByHeadId: { [headId]: funds },
                candidateHeads: [depositedHead],
              },
            ],
            headHistories: {},
            genuineByHeadId: isGenuine
              ? { [headId]: true, [depositedHeadId]: true }
              : { [headId]: true },
          }),
        );

      it('lists a candidate found genuine without figures while its history cannot be read', () => {
        const state = resolvedUnverified(true);

        expect(headsOf(state)).toEqual([
          { ...indexedHead, ...indexedFunds },
          indexedDepositedHead,
        ]);
        expect(state.depositedHeadIdsByAccount).toEqual({
          [accountId]: [depositedHeadId],
        });
      });

      it('lists no candidate the resolution has not found genuine', () => {
        expect(headsOf(resolvedUnverified(false))).toEqual([
          { ...indexedHead, ...indexedFunds },
        ]);
      });
    });

    it('never lists a candidate whose history cannot be read', () => {
      const state = reducer(
        reducer(undefined, sweptWithCandidate()),
        resolvedDeposit(undefined),
      );

      expect(headsOf(state)).toEqual([{ ...indexedHead, ...indexedFunds }]);
    });

    it('keeps a confirmed head with its figures through the next sweep', () => {
      const state = reducer(
        reducer(
          reducer(undefined, sweptWithCandidate()),
          resolvedDeposit(funds),
        ),
        sweptWithCandidate(depositedHead, laterSyncedAt),
      );

      expect(headsOf(state)).toEqual([
        { ...indexedHead, ...indexedFunds },
        { ...indexedDepositedHead, ...indexedFunds },
      ]);
    });

    it('keeps a confirmed head without figures while its history cannot be read', () => {
      const state = reducer(
        reducer(
          reducer(undefined, sweptWithCandidate()),
          resolvedDeposit(funds),
        ),
        resolvedDeposit(undefined),
      );

      expect(headsOf(state)).toEqual([
        { ...indexedHead, ...indexedFunds },
        indexedDepositedHead,
      ]);
    });

    it('drops a confirmed head the next sweep no longer finds', () => {
      const state = reducer(
        reducer(
          reducer(undefined, sweptWithCandidate()),
          resolvedDeposit(funds),
        ),
        completed(laterSyncedAt),
      );

      expect(headsOf(state)).toEqual([{ ...indexedHead, ...indexedFunds }]);
    });

    it('keeps the id of a head the history attributes a deposit to', () => {
      const state = reducer(
        reducer(undefined, sweptWithCandidate()),
        resolvedDeposit(funds),
      );

      expect(state.depositedHeadIdsByAccount).toEqual({
        [accountId]: [depositedHeadId],
      });
      expect(JSON.parse(JSON.stringify(state))).toEqual(state);
    });

    it('keeps the id of a head whose history cannot be read yet', () => {
      const state = reducer(
        reducer(undefined, sweptWithCandidate()),
        resolvedDeposit(undefined),
      );

      expect(state.depositedHeadIdsByAccount).toEqual({
        [accountId]: [depositedHeadId],
      });
    });

    it('forgets the id of a head the next sweep no longer finds or confirms', () => {
      const kept = reducer(
        reducer(undefined, sweptWithCandidate()),
        resolvedDeposit(funds),
      );

      expect(
        reducer(kept, resolvedDeposit(undefined, [])).depositedHeadIdsByAccount,
      ).toEqual({});
    });

    it('keeps the ids when a sweep completes or fails', () => {
      const kept = reducer(
        reducer(undefined, sweptWithCandidate()),
        resolvedDeposit(funds),
      );

      expect(
        reducer(kept, completed(laterSyncedAt)).depositedHeadIdsByAccount,
      ).toBe(kept.depositedHeadIdsByAccount);
      expect(
        reducer(kept, sweepFailed({ accountIds: [accountId] }))
          .depositedHeadIdsByAccount,
      ).toBe(kept.depositedHeadIdsByAccount);
    });

    it('drops the ids of a removed account and of a removed wallet', () => {
      const kept = reducer(
        reducer(undefined, sweptWithCandidate()),
        resolvedDeposit(funds),
      );

      expect(
        reducer(kept, walletsActions.wallets.removeAccount(walletId, accountId))
          .depositedHeadIdsByAccount,
      ).toEqual({});
      expect(
        reducer(
          kept,
          walletsActions.wallets.removeWallet(walletId, [accountId]),
        ).depositedHeadIdsByAccount,
      ).toEqual({});
    });

    it('drops a confirmed head whose history no longer shows a deposit', () => {
      const state = reducer(
        reducer(
          reducer(undefined, sweptWithCandidate()),
          resolvedDeposit(funds),
        ),
        resolvedDeposit(undefined, []),
      );

      expect(headsOf(state)).toEqual([{ ...indexedHead, ...indexedFunds }]);
    });
  });

  it('ignores figures for an account without a snapshot', () => {
    expect(reducer(undefined, resolved(funds)).byAccount).toEqual({});
  });

  it('keeps the head histories of the sweep in plain JSON', () => {
    const state = reducer(
      undefined,
      headFundsResolved({
        accounts: [],
        headHistories: { [headId]: [historyTx] },
        genuineByHeadId: { [headId]: true },
      }),
    );

    expect(state.historyByHeadId).toEqual({ [headId]: [indexedHistoryTx] });
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
  });

  it('reads a kept value back into its plain form', () => {
    expect(
      fromHydraHeadsIndexValue({
        coins: BigNumber(4_626_931n),
        assets: { [assetId]: BigNumber(3n) },
      } as HydraHeadsIndexValue),
    ).toEqual(deposit.value);
  });

  it('reads a kept head history back into its plain form', () => {
    const state = reducer(
      undefined,
      headFundsResolved({
        accounts: [],
        headHistories: { [headId]: [historyTx] },
        genuineByHeadId: { [headId]: true },
      }),
    );

    expect(
      fromHydraHeadsIndexHistory(state.historyByHeadId[headId] ?? []),
    ).toEqual([historyTx]);
  });

  it('drops the history of every head the next sweep leaves out', () => {
    const state = reducer(
      reducer(
        undefined,
        headFundsResolved({
          accounts: [],
          headHistories: { [headId]: [historyTx] },
          genuineByHeadId: { [headId]: true },
        }),
      ),
      headFundsResolved({
        accounts: [],
        headHistories: {},
        genuineByHeadId: {},
      }),
    );

    expect(state.historyByHeadId).toEqual({});
  });

  it('replaces the head verdicts with those of each resolution', () => {
    const verdicts = { [headId]: true, ['cd'.repeat(28)]: false };
    const state = reducer(
      undefined,
      headFundsResolved({
        accounts: [],
        headHistories: {},
        genuineByHeadId: verdicts,
      }),
    );

    expect(state.genuineByHeadId).toEqual(verdicts);
    expect(
      reducer(
        state,
        headFundsResolved({
          accounts: [],
          headHistories: {},
          genuineByHeadId: { [headId]: true },
        }),
      ).genuineByHeadId,
    ).toEqual({ [headId]: true });
  });

  it('keeps the head verdicts when a sweep completes or fails', () => {
    const withVerdict = reducer(undefined, resolved(funds));

    expect(reducer(withVerdict, completed()).genuineByHeadId).toBe(
      withVerdict.genuineByHeadId,
    );
    expect(
      reducer(withVerdict, sweepFailed({ accountIds: [accountId] }))
        .genuineByHeadId,
    ).toBe(withVerdict.genuineByHeadId);
  });

  it('lists only the participant heads the resolution gives', () => {
    const state = reducer(
      reducer(undefined, completed()),
      headFundsResolved({
        accounts: [
          { accountId, heads: [], fundsByHeadId: {}, candidateHeads: [] },
        ],
        headHistories: {},
        genuineByHeadId: { [headId]: false },
      }),
    );

    expect(state.byAccount[accountId]?.snapshot?.heads).toEqual([]);
  });

  it('keeps the head histories when a sweep completes or fails', () => {
    const withHistory = reducer(
      undefined,
      headFundsResolved({
        accounts: [],
        headHistories: { [headId]: [historyTx] },
        genuineByHeadId: { [headId]: true },
      }),
    );

    expect(reducer(withHistory, completed()).historyByHeadId).toBe(
      withHistory.historyByHeadId,
    );
    expect(
      reducer(withHistory, sweepFailed({ accountIds: [accountId] }))
        .historyByHeadId,
    ).toBe(withHistory.historyByHeadId);
  });

  describe('a partial sweep, which could not read some validator address', () => {
    const unreadAddress =
      'addr_test1wrrcaryjq4epavl0gsg08kuuv95l5md5jlpyvswjnss998qyu7lhm';
    const partial = sweepCompleted({
      syncedAt: laterSyncedAt,
      unreadAddresses: [unreadAddress],
      accounts: [{ accountId, deposits: [], heads: [], candidateHeads: [] }],
    });

    it('keeps the deposits and heads the sweep did not find and names the unread addresses', () => {
      const snapshot = reducer(reducer(undefined, completed()), partial)
        .byAccount[accountId]?.snapshot;

      expect(snapshot).toMatchObject({
        deposits: [indexedDeposit],
        heads: [indexedHead],
        lastSyncedAt: laterSyncedAt.toISOString(),
        unreadAddresses: [unreadAddress],
      });
    });

    it('keeps the kept head ids, histories and verdicts it did not settle', () => {
      const kept = reducer(
        reducer(undefined, completed()),
        headFundsResolved({
          accounts: [
            {
              accountId,
              heads: [head],
              fundsByHeadId: { [headId]: funds },
              candidateHeads: [],
            },
          ],
          headHistories: { [headId]: [historyTx] },
          genuineByHeadId: { [headId]: true },
        }),
      );
      const withIds = {
        ...kept,
        depositedHeadIdsByAccount: { [accountId]: ['cd'.repeat(28)] },
      };

      const state = reducer(
        reducer(withIds, partial),
        headFundsResolved({
          accounts: [
            { accountId, heads: [], fundsByHeadId: {}, candidateHeads: [] },
          ],
          headHistories: {},
          genuineByHeadId: {},
          isPartial: true,
        }),
      );

      expect(state.byAccount[accountId]?.snapshot?.heads).toEqual([
        { ...indexedHead, ...indexedFunds },
      ]);
      expect(state.depositedHeadIdsByAccount).toEqual({
        [accountId]: ['cd'.repeat(28)],
      });
      expect(Object.keys(state.historyByHeadId)).toEqual([headId]);
      expect(state.genuineByHeadId).toEqual({ [headId]: true });
    });

    it('drops what a complete sweep no longer finds', () => {
      const snapshot = reducer(
        reducer(reducer(undefined, completed()), partial),
        sweepCompleted({
          syncedAt: laterSyncedAt,
          accounts: [
            { accountId, deposits: [], heads: [], candidateHeads: [] },
          ],
        }),
      ).byAccount[accountId]?.snapshot;

      expect(snapshot).toEqual({
        deposits: [],
        heads: [],
        lastSyncedAt: laterSyncedAt.toISOString(),
      });
    });
  });

  it('replaces the previous snapshot with the next sweep', () => {
    const state = reducer(
      reducer(undefined, completed()),
      sweepCompleted({
        syncedAt: laterSyncedAt,
        accounts: [{ accountId, deposits: [], heads: [], candidateHeads: [] }],
      }),
    );

    expect(state.byAccount[accountId]?.snapshot).toEqual({
      deposits: [],
      heads: [],
      lastSyncedAt: '2026-10-01T12:05:00.000Z',
    });
  });

  it('keeps the previous snapshot and flags the entry when a sweep fails', () => {
    const state = reducer(
      reducer(undefined, completed()),
      sweepFailed({ accountIds: [accountId] }),
    );

    expect(state.byAccount[accountId]).toEqual({
      snapshot: {
        deposits: [indexedDeposit],
        heads: [indexedHead],
        lastSyncedAt: '2026-10-01T12:00:00.000Z',
      },
      failed: true,
    });
  });

  it('flags an account that has never been swept without a snapshot', () => {
    const state = reducer(undefined, sweepFailed({ accountIds: [accountId] }));

    expect(state.byAccount[accountId]).toEqual({ failed: true });
    expect(state.byAccount[accountId]).not.toHaveProperty('snapshot');
  });

  it('clears the failure when the next sweep succeeds', () => {
    const state = reducer(
      reducer(undefined, sweepFailed({ accountIds: [accountId] })),
      completed(),
    );

    expect(state.byAccount[accountId]?.failed).toBe(false);
  });

  it('drops the entry of a removed account', () => {
    const state = reducer(
      reducer(undefined, completed()),
      walletsActions.wallets.removeAccount(walletId, accountId),
    );

    expect(state.byAccount[accountId]).toBeUndefined();
    expect(state.byAccount[otherAccountId]).toBeDefined();
  });

  it('drops the entries of every account of a removed wallet', () => {
    const state = reducer(
      reducer(undefined, completed()),
      walletsActions.wallets.removeWallet(walletId, [
        accountId,
        otherAccountId,
      ]),
    );

    expect(state.byAccount).toEqual({});
  });

  describe('selectors', () => {
    const root = rootOf(reducer(undefined, completed()));

    it('selects the entries by account', () => {
      expect(selectIndexByAccount(root)).toBe(root.hydraHeadsIndex.byAccount);
    });

    it('selects the head histories by head id', () => {
      expect(selectHistoryByHeadId(root)).toBe(
        root.hydraHeadsIndex.historyByHeadId,
      );
    });

    it('selects the head verdicts by head id', () => {
      expect(selectGenuineByHeadId(root)).toBe(
        root.hydraHeadsIndex.genuineByHeadId,
      );
    });

    it('selects the deposited head ids by account', () => {
      expect(selectDepositedHeadIdsByAccount(root)).toBe(
        root.hydraHeadsIndex.depositedHeadIdsByAccount,
      );
    });

    it('selects the accounts whose activities carry the Hydra Head tags', () => {
      expect(selectActivitiesTaggedByAccount(root)).toBe(
        root.hydraHeadsIndex.activitiesTaggedByAccount,
      );
    });

    it('selects the deposits and heads of an account', () => {
      expect(selectHydraDepositsByAccount(root, accountId)).toEqual([
        indexedDeposit,
      ]);
      expect(selectHydraHeadsByAccount(root, accountId)).toEqual([indexedHead]);
    });

    it('selects the same empty lists for an account that was never swept', () => {
      const empty = rootOf(reducer(undefined, { type: '@@init' }));

      expect(selectHydraDepositsByAccount(empty, accountId)).toEqual([]);
      expect(selectHydraDepositsByAccount(empty, accountId)).toBe(
        selectHydraDepositsByAccount(root, 'unknown' as AccountId),
      );
      expect(selectHydraHeadsByAccount(empty, accountId)).toEqual([]);
      expect(selectHydraHeadsByAccount(empty, accountId)).toBe(
        selectHydraHeadsByAccount(root, 'unknown' as AccountId),
      );
    });

    it('selects the last snapshot of an account whose latest sweep failed', () => {
      const failed = rootOf(
        reducer(root.hydraHeadsIndex, sweepFailed({ accountIds: [accountId] })),
      );

      expect(selectHydraHeadsByAccount(failed, accountId)).toEqual([
        indexedHead,
      ]);
    });
  });
});
