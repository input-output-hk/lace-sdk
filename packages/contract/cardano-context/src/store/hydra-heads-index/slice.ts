import { markParameterizedSelector } from '@lace-contract/module';
import { walletsActions } from '@lace-contract/wallet-repo';
import { settleHydraAccountHeads } from '@lace-lib/hydra-head';
import { BigNumber } from '@lace-lib/util';
import { createSelector, createSlice } from '@reduxjs/toolkit';

import type {
  HydraHeadsIndexDeposit,
  HydraHeadsIndexHead,
  HydraHeadsIndexHistoryTx,
  HydraHeadsIndexSliceState,
  HydraHeadsIndexUtxo,
  HydraHeadsIndexValue,
} from './types';
import type { AccountId } from '@lace-contract/wallet-repo';
import type { Cardano } from '@lace-lib/cardano-core';
import type {
  HydraAccountDeposit,
  HydraAccountHead,
  HydraHeadFunds,
  HydraHeadHistoryTx,
  HydraUtxo,
  HydraValue,
} from '@lace-lib/hydra-head';
import type {
  PayloadAction,
  StateFromReducersMapObject,
} from '@reduxjs/toolkit';

export type { HydraHeadsIndexSliceState };

/** The deposits and heads a sweep matched to one account. */
type HydraHeadsSweepAccountResult = {
  accountId: AccountId;
  deposits: readonly HydraAccountDeposit[];
  /** The heads the account holds a participation token in. */
  heads: readonly HydraAccountHead[];
  /**
   * The live genuine heads the account's own deposit activities name and in
   * which it holds no participation token. Those activities are only hints,
   * so a candidate is listed once a head history confirms the deposit, or
   * while one of `deposits` still waits for it.
   */
  candidateHeads: readonly HydraAccountHead[];
};

/**
 * What one account moved through each of its heads, by head id. A genuine
 * head maps to undefined when its history could not be read or explained.
 */
type HydraHeadsFundsAccountResult = {
  accountId: AccountId;
  /** The heads the account holds a participation token in. */
  heads: readonly HydraAccountHead[];
  /** The live heads the account's deposits name, as the sweep matched them. */
  candidateHeads: readonly HydraAccountHead[];
  fundsByHeadId: Readonly<Record<string, HydraHeadFunds | undefined>>;
};

/** The serializable form of what one account moved through one head. */
type HydraHeadsIndexFunds = Required<
  Pick<HydraHeadsIndexHead, 'depositedValue' | 'withdrawnValue'>
>;

/** The serializable form of the deposits and heads of one account. */
type HydraHeadsSweepAccountPayload = {
  accountId: AccountId;
  deposits: HydraHeadsIndexDeposit[];
  heads: HydraHeadsIndexHead[];
  candidateHeads: HydraHeadsIndexHead[];
};

const initialState: HydraHeadsIndexSliceState = {
  byAccount: {},
  historyByHeadId: {},
  genuineByHeadId: {},
  depositedHeadIdsByAccount: {},
  activitiesTaggedByAccount: {},
};

const EMPTY_DEPOSITS: HydraHeadsIndexDeposit[] = [];
const EMPTY_HEADS: HydraHeadsIndexHead[] = [];

/** Converts a Hydra value into its plain JSON form. */
const toIndexValue = ({ coins, assets }: HydraValue): HydraHeadsIndexValue => ({
  coins: BigNumber(coins),
  assets: Object.fromEntries(
    [...assets].map(([unit, quantity]) => [unit, BigNumber(quantity)]),
  ) as Partial<Record<Cardano.AssetId, BigNumber>>,
});

/** Reads figures kept in the Hydra heads index back into Hydra values. */
const fromIndexFunds = ({
  depositedValue,
  withdrawnValue,
}: HydraHeadsIndexFunds): HydraHeadFunds => ({
  deposited: fromHydraHeadsIndexValue(depositedValue),
  withdrawn: fromHydraHeadsIndexValue(withdrawnValue),
});

/** Reads a value kept in the Hydra heads index back into a Hydra value. */
export const fromHydraHeadsIndexValue = ({
  coins,
  assets,
}: HydraHeadsIndexValue): HydraValue => ({
  coins: BigNumber.valueOf(coins),
  assets: new Map(
    Object.entries(assets).flatMap(([unit, quantity]) =>
      quantity === undefined ? [] : [[unit, BigNumber.valueOf(quantity)]],
    ),
  ),
});

/** Converts a matched deposit into its read model form. */
const toIndexDeposit = (
  deposit: HydraAccountDeposit,
): HydraHeadsIndexDeposit => ({
  outpoint: { txId: deposit.outpoint.txId, index: deposit.outpoint.index },
  headId: deposit.headId,
  deadline: new Date(deposit.deadline).toISOString(),
  value: toIndexValue(deposit.value),
  status: deposit.status,
});

/** Converts a matched head into its read model form. */
const toIndexHead = (head: HydraAccountHead): HydraHeadsIndexHead => ({
  headId: head.headId,
  version: head.version,
  outpoint: { txId: head.outpoint.txId, index: head.outpoint.index },
  state: head.state,
  ...(head.contestationDeadline === undefined
    ? {}
    : {
        contestationDeadline: new Date(head.contestationDeadline).toISOString(),
      }),
  headValue: toIndexValue(head.headValue),
  participantCount: head.participantCount,
  isParticipant: head.isParticipant,
  isSoleParticipant: head.isSoleParticipant,
});

/** Converts what an account moved through a head into its read model form. */
const toIndexFunds = ({
  deposited,
  withdrawn,
}: HydraHeadFunds): HydraHeadsIndexFunds => ({
  depositedValue: toIndexValue(deposited),
  withdrawnValue: toIndexValue(withdrawn),
});

/** The head with the given figures, or without any when there are none. */
const withFunds = (
  { depositedValue: _, withdrawnValue: __, ...head }: HydraHeadsIndexHead,
  funds: HydraHeadsIndexFunds | undefined,
): HydraHeadsIndexHead => (funds ? { ...head, ...funds } : head);

/**
 * The figures of the same head in the previous snapshot, kept while the
 * head UTxO is unchanged: its history then ends with the same transaction.
 */
const keptFunds = (
  previous: readonly HydraHeadsIndexHead[],
  head: HydraHeadsIndexHead,
): HydraHeadsIndexFunds | undefined => {
  const same = previous.find(
    ({ headId, outpoint }) =>
      headId === head.headId &&
      outpoint.txId === head.outpoint.txId &&
      outpoint.index === head.outpoint.index,
  );
  return same?.depositedValue && same.withdrawnValue
    ? {
        depositedValue: same.depositedValue,
        withdrawnValue: same.withdrawnValue,
      }
    : undefined;
};

/**
 * The ids of the heads listed although the account holds no participation
 * token in them, which a head history confirmed earlier.
 */
const depositOnlyHeadIdsOf = (
  heads: readonly HydraHeadsIndexHead[],
): ReadonlySet<string> =>
  new Set(
    heads
      .filter(({ isParticipant }) => !isParticipant)
      .map(({ headId }) => headId),
  );

/** True when two deposits are the same UTxO. */
const isSameOutpoint = (
  a: Pick<HydraHeadsIndexDeposit, 'outpoint'>,
  b: Pick<HydraHeadsIndexDeposit, 'outpoint'>,
): boolean =>
  a.outpoint.txId === b.outpoint.txId && a.outpoint.index === b.outpoint.index;

/** The heads of `kept` whose head id none of `found` has. */
const notFoundIn = (
  kept: readonly HydraHeadsIndexHead[],
  found: readonly Pick<HydraHeadsIndexHead, 'headId'>[],
): HydraHeadsIndexHead[] =>
  kept.filter(({ headId }) => !found.some(head => head.headId === headId));

/** The ids of the heads the deposits wait for. */
const waitingHeadIdsOf = (
  deposits: readonly HydraHeadsIndexDeposit[],
): ReadonlySet<string> => new Set(deposits.map(({ headId }) => headId));

/** Converts a UTxO of a head's history into its read model form. */
const toIndexUtxo = (utxo: HydraUtxo): HydraHeadsIndexUtxo => ({
  txId: utxo.txId,
  index: utxo.index,
  address: utxo.address,
  value: toIndexValue(utxo.value),
  ...(utxo.inlineDatum === undefined ? {} : { inlineDatum: utxo.inlineDatum }),
});

/** Converts a transaction of a head's history into its read model form. */
const toIndexHistoryTx = (
  transaction: HydraHeadHistoryTx,
): HydraHeadsIndexHistoryTx => ({
  txId: transaction.txId,
  inputs: transaction.inputs.map(toIndexUtxo),
  outputs: transaction.outputs.map(toIndexUtxo),
});

/** Reads a UTxO of a head's history kept in the read model back. */
const fromIndexUtxo = ({ value, ...utxo }: HydraHeadsIndexUtxo): HydraUtxo => ({
  ...utxo,
  value: fromHydraHeadsIndexValue(value),
});

/** Reads a head history kept in the read model back into its plain form. */
export const fromHydraHeadsIndexHistory = (
  history: readonly HydraHeadsIndexHistoryTx[],
): HydraHeadHistoryTx[] =>
  history.map(({ txId, inputs, outputs }) => ({
    txId,
    inputs: inputs.map(fromIndexUtxo),
    outputs: outputs.map(fromIndexUtxo),
  }));

/** Drops the entries and deposited head ids of the removed accounts. */
const removeEntries = (
  state: HydraHeadsIndexSliceState,
  accountIds: readonly AccountId[],
) => {
  for (const accountId of accountIds) {
    delete state.byAccount[accountId];
    delete state.depositedHeadIdsByAccount[accountId];
    delete state.activitiesTaggedByAccount[accountId];
  }
};

export const slice = createSlice({
  name: 'hydraHeadsIndex',
  initialState,
  reducers: {
    /**
     * Stores the deposits and heads a sweep found. A candidate head is kept
     * when one of the account's deposits waits for it, or when the previous
     * snapshot already lists it, so it neither appears before its history
     * confirms a deposit nor flickers between sweeps. A head keeps the
     * figures of the previous snapshot while its head UTxO is unchanged,
     * until `headFundsResolved` settles them. While `unreadAddresses` names
     * a validator address, the deposits and heads of the previous snapshot
     * the sweep did not find are kept, since they may sit there.
     */
    sweepCompleted: {
      reducer: (
        state,
        {
          payload,
        }: PayloadAction<{
          lastSyncedAt: string;
          unreadAddresses: string[];
          accounts: HydraHeadsSweepAccountPayload[];
        }>,
      ) => {
        const isPartial = payload.unreadAddresses.length > 0;
        for (const {
          accountId,
          deposits,
          heads,
          candidateHeads,
        } of payload.accounts) {
          const snapshot = state.byAccount[accountId]?.snapshot;
          const previous = snapshot?.heads ?? [];
          const listed = depositOnlyHeadIdsOf(previous);
          const found = [
            ...heads,
            ...candidateHeads.filter(
              ({ headId }) =>
                listed.has(headId) || waitingHeadIdsOf(deposits).has(headId),
            ),
          ].map(head => withFunds(head, keptFunds(previous, head)));
          const foundDeposits = isPartial
            ? [
                ...deposits,
                ...(snapshot?.deposits ?? []).filter(
                  kept =>
                    !deposits.some(deposit => isSameOutpoint(deposit, kept)),
                ),
              ]
            : deposits;
          state.byAccount[accountId] = {
            snapshot: {
              deposits: foundDeposits,
              heads: isPartial
                ? [
                    ...found,
                    ...notFoundIn(previous, [...heads, ...candidateHeads]),
                  ]
                : found,
              lastSyncedAt: payload.lastSyncedAt,
              ...(isPartial
                ? { unreadAddresses: payload.unreadAddresses }
                : {}),
            },
            failed: false,
          };
        }
      },
      prepare: ({
        syncedAt,
        unreadAddresses = [],
        accounts,
      }: {
        syncedAt: Date;
        /** The validator addresses the sweep could not read. */
        unreadAddresses?: readonly string[];
        accounts: readonly HydraHeadsSweepAccountResult[];
      }) => ({
        payload: {
          lastSyncedAt: syncedAt.toISOString(),
          unreadAddresses: [...unreadAddresses],
          accounts: accounts.map(
            ({ accountId, deposits, heads, candidateHeads }) => ({
              accountId,
              deposits: deposits.map(toIndexDeposit),
              heads: heads.map(toIndexHead),
              candidateHeads: candidateHeads.map(toIndexHead),
            }),
          ),
        },
      }),
    },
    /**
     * Stores what each account moved through the heads of the last sweep,
     * read from the heads' histories once the sweep stored its snapshot.
     * Which heads are listed, and which deposited head ids are kept, is
     * settled by `settleHydraAccountHeads` against the deposits and the
     * deposit-only heads of the snapshot. A head without figures loses any
     * it kept, and a listed one left out is dropped. The kept ids replace
     * the ones kept for the account, so a head no longer live, or whose
     * history shows no deposit while none waits for it, is forgotten. A
     * partial sweep, which could not read some validator address, drops
     * nothing it did not find: the heads, kept ids, histories and verdicts
     * it did not settle stay as they were.
     * `headHistories` holds the history kept for each head the sweep found,
     * whether read by this sweep or kept from an earlier one; the history of
     * every head left out is dropped. `genuineByHeadId` replaces the kept
     * verdicts the same way.
     */
    headFundsResolved: {
      reducer: (
        state,
        {
          payload,
        }: PayloadAction<{
          accounts: {
            accountId: AccountId;
            heads: HydraHeadsIndexHead[];
            candidateHeads: HydraHeadsIndexHead[];
            fundsByHeadId: Record<string, HydraHeadsIndexFunds | undefined>;
          }[];
          historyByHeadId: Record<string, HydraHeadsIndexHistoryTx[]>;
          genuineByHeadId: Record<string, boolean>;
          isPartial: boolean;
        }>,
      ) => {
        const { isPartial } = payload;
        const genuineByHeadId = new Map(
          Object.entries(payload.genuineByHeadId),
        );
        for (const {
          accountId,
          heads,
          candidateHeads,
          fundsByHeadId,
        } of payload.accounts) {
          const snapshot = state.byAccount[accountId]?.snapshot;
          if (!snapshot) continue;
          const settled = settleHydraAccountHeads({
            heads,
            candidateHeads,
            waitingHeadIds: waitingHeadIdsOf(snapshot.deposits),
            genuineByHeadId,
            fundsByHeadId: new Map(
              Object.entries(fundsByHeadId).map(([headId, funds]) => [
                headId,
                funds && fromIndexFunds(funds),
              ]),
            ),
            listedHeadIds: depositOnlyHeadIdsOf(snapshot.heads),
          });
          const settledHeads = settled.heads.map(head =>
            withFunds(head, fundsByHeadId[head.headId]),
          );
          snapshot.heads = isPartial
            ? [
                ...settledHeads,
                ...notFoundIn(snapshot.heads, [...heads, ...candidateHeads]),
              ]
            : settledHeads;
          const depositedHeadIds = isPartial
            ? [
                ...new Set([
                  ...(state.depositedHeadIdsByAccount[accountId] ?? []),
                  ...settled.depositedHeadIds,
                ]),
              ]
            : settled.depositedHeadIds;
          if (depositedHeadIds.length > 0) {
            state.depositedHeadIdsByAccount[accountId] = depositedHeadIds;
          } else {
            delete state.depositedHeadIdsByAccount[accountId];
          }
        }
        state.historyByHeadId = isPartial
          ? { ...state.historyByHeadId, ...payload.historyByHeadId }
          : payload.historyByHeadId;
        state.genuineByHeadId = isPartial
          ? { ...state.genuineByHeadId, ...payload.genuineByHeadId }
          : payload.genuineByHeadId;
      },
      prepare: ({
        accounts,
        headHistories,
        genuineByHeadId,
        isPartial = false,
      }: {
        accounts: readonly HydraHeadsFundsAccountResult[];
        headHistories: Readonly<Record<string, readonly HydraHeadHistoryTx[]>>;
        /**
         * Whether each head the sweep found is genuine, for the heads
         * checked so far.
         */
        genuineByHeadId: Readonly<Record<string, boolean>>;
        /**
         * True when the sweep could not read some validator address, so
         * what it did not find is kept rather than dropped.
         */
        isPartial?: boolean;
      }) => ({
        payload: {
          accounts: accounts.map(
            ({ accountId, heads, candidateHeads, fundsByHeadId }) => ({
              accountId,
              heads: heads.map(toIndexHead),
              candidateHeads: candidateHeads.map(toIndexHead),
              fundsByHeadId: Object.fromEntries(
                Object.entries(fundsByHeadId).map(([headId, funds]) => [
                  headId,
                  funds && toIndexFunds(funds),
                ]),
              ),
            }),
          ),
          historyByHeadId: Object.fromEntries(
            Object.entries(headHistories).map(([headId, transactions]) => [
              headId,
              transactions.map(toIndexHistoryTx),
            ]),
          ),
          genuineByHeadId: { ...genuineByHeadId },
          isPartial,
        },
      }),
    },
    /**
     * Marks the accounts whose loaded activities carry the Hydra Head tags,
     * because they were loaded, or reset to be loaded again, with the Hydra
     * Head feature flag on.
     */
    activitiesTagged: (
      state,
      { payload }: PayloadAction<{ accountIds: AccountId[] }>,
    ) => {
      for (const accountId of payload.accountIds) {
        state.activitiesTaggedByAccount[accountId] = true;
      }
    },
    /**
     * Forgets every mark once the Hydra Head feature flag is off, since the
     * activities loaded from then on carry no Hydra Head tags.
     */
    activitiesUntagged: state => {
      state.activitiesTaggedByAccount = {};
    },
    sweepFailed: (
      state,
      { payload }: PayloadAction<{ accountIds: AccountId[] }>,
    ) => {
      for (const accountId of payload.accountIds) {
        state.byAccount[accountId] = {
          ...state.byAccount[accountId],
          failed: true,
        };
      }
    },
  },
  extraReducers: builder => {
    builder.addCase(walletsActions.wallets.removeAccount, (state, action) => {
      removeEntries(state, [action.payload.accountId]);
    });
    builder.addCase(walletsActions.wallets.removeWallet, (state, action) => {
      removeEntries(state, action.payload.accountIds);
    });
  },
  selectors: {
    selectIndexByAccount: (state: HydraHeadsIndexSliceState) => state.byAccount,
    selectHistoryByHeadId: (state: HydraHeadsIndexSliceState) =>
      state.historyByHeadId,
    selectGenuineByHeadId: (state: HydraHeadsIndexSliceState) =>
      state.genuineByHeadId,
    selectDepositedHeadIdsByAccount: (state: HydraHeadsIndexSliceState) =>
      state.depositedHeadIdsByAccount,
    selectActivitiesTaggedByAccount: (state: HydraHeadsIndexSliceState) =>
      state.activitiesTaggedByAccount,
  },
});

/** The Hydra deposits the last successful sweep found for the account. */
const selectHydraDepositsByAccount = markParameterizedSelector(
  createSelector(
    slice.selectors.selectIndexByAccount,
    (_: unknown, accountId: AccountId) => accountId,
    (byAccount, accountId) =>
      byAccount[accountId]?.snapshot?.deposits ?? EMPTY_DEPOSITS,
  ),
);

/** The Hydra heads the last successful sweep found for the account. */
const selectHydraHeadsByAccount = markParameterizedSelector(
  createSelector(
    slice.selectors.selectIndexByAccount,
    (_: unknown, accountId: AccountId) => accountId,
    (byAccount, accountId) =>
      byAccount[accountId]?.snapshot?.heads ?? EMPTY_HEADS,
  ),
);

export const hydraHeadsIndexReducers = {
  [slice.name]: slice.reducer,
};

export const hydraHeadsIndexActions = {
  hydraHeadsIndex: slice.actions,
};

/**
 * Selectors over the Hydra heads index: the raw per-account entries, the
 * history and the verdict by head id, the deposited head ids per account,
 * the accounts whose activities carry the Hydra Head tags, and the deposits
 * and heads the last sweep found for one account.
 */
export const hydraHeadsIndexSelectors = {
  hydraHeadsIndex: {
    ...slice.selectors,
    selectHydraDepositsByAccount,
    selectHydraHeadsByAccount,
  },
};

export type HydraHeadsIndexStoreState = StateFromReducersMapObject<
  typeof hydraHeadsIndexReducers
>;
