import { activitiesSelectors, ActivityType } from '@lace-contract/activities';
import { addressesSelectors } from '@lace-contract/addresses';
import { failuresSelectors } from '@lace-contract/failures';
import { markParameterizedSelector } from '@lace-contract/module';
import { networkSelectors } from '@lace-contract/network';
import { selectHasEverSynced, syncSelectors } from '@lace-contract/sync';
import { tokensSelectors } from '@lace-contract/tokens';
import {
  AccountId,
  walletsActions,
  walletsSelectors,
} from '@lace-contract/wallet-repo';
import { Cardano } from '@lace-lib/cardano-core';
import { Serializable } from '@lace-lib/util-store';
import { createAction, createSelector, createSlice } from '@reduxjs/toolkit';
import BigNumber from 'bignumber.js';
import flatMap from 'lodash/flatMap';
import pick from 'lodash/pick';
import uniqBy from 'lodash/uniqBy';

import {
  applyInFlightUtxoAdjustments,
  applyPendingRewardWithdrawals,
  ownPendingOutputs,
  pendingRewardWithdrawals,
} from '../apply-in-flight-utxo-adjustments';
import { UNBOUNDED_IN_FLIGHT_SLOTS } from '../const';
import {
  extensionActions,
  extensionReducers,
  extensionSelectors,
  selectAccountIdsExcludedFromSpending,
} from '../extensions';
import { EXPLOIT_DESCRIPTORS } from '../security/exploit-descriptors';
import {
  filterSpendableUtxos,
  getEligibleCollateralUtxo,
  outpointKey,
  utxoKey,
  isCardanoAccount,
} from '../util';
import { CardanoNetworkId, CardanoSyncFailureId } from '../value-objects';

import {
  collateralFlowReducers,
  collateralFlowActions,
  collateralFlowSelectors,
} from './collateral-flow/slice';
import {
  composerFlowActions,
  composerFlowReducers,
  composerFlowSelectors,
} from './composer-flow';
import { getRewardSpendableDate, mapRewardToActivity } from './helpers';
import {
  isWalletResetOperation,
  isAddressDiscoveryOperation,
  isThoroughAddressDiscoveryOperation,
} from './side-effects/sync-operation-utils';

import type { ExtensionAccountProps } from '../extensions';
import type {
  AccountRewardAccountDetailsMap,
  CardanoAccountAddressHistoryMap,
  CardanoAccountToRewardAccountsMap,
  CardanoAccountToRewardsMap,
  CardanoAccountTransactionsHistoryMap,
  CardanoInFlightEffects,
  CardanoRewardAccount,
  CardanoRewardAccountToRewardMap,
  CardanoTransactionHistoryItem,
  CardanoTransactionInclusion,
  RequiredProtocolParameters,
  Reward,
  RewardAccountDetails,
  CardanoPaymentAddress,
  AccountUtxoMap,
  AccountUnspendableUtxoMap,
  CardanoBip32AccountProps,
  CardanoMultiSigAccountProps,
  CardanoAccountToDelegationAccountsMap,
  DelegationInfo,
  RegistrationInfo,
  WithdrawalInfo,
} from '../types';
import type {
  CardanoTxId,
  RewardAccountDetailsCacheKey,
  UtxoCacheKey,
} from '../value-objects';
import type {
  Activity,
  BlockchainSpecificActivityMetadata,
} from '@lace-contract/activities';
import type { TranslationKey } from '@lace-contract/i18n';
import type { TokenId } from '@lace-contract/tokens';
import type { AnyAccount } from '@lace-contract/wallet-repo';
import type { EraSummary } from '@lace-lib/cardano-core';
import type { HexBytes, Timestamp } from '@lace-lib/util';
import type {
  PayloadAction,
  StateFromReducersMapObject,
} from '@reduxjs/toolkit';

export type CardanoNetworkInfo = {
  tip?: Cardano.Tip;
  protocolParameters?: RequiredProtocolParameters;
  eraSummaries?: Serializable<EraSummary[]>;
};

/**
 * UTxOs fetched for an account together with the cache key under which the
 * fetch is considered settled. `cacheKey` is set independently from `utxos`:
 * see `setAccountUtxos` (writes `utxos` only) and
 * `setLastFetchedUtxoCacheKey` (advances the gate). The gap lets the natural
 * trigger keep polling while indexer lag could still be hiding UTxOs from a
 * just-confirmed tx.
 */
export type AccountUtxoEntry = {
  utxos: Serializable<Cardano.Utxo[]>;
  cacheKey?: UtxoCacheKey;
};

/**
 * Identifies an in-flight transaction on one Cardano network:
 * `${CardanoNetworkId}:${txId}`. Preview and Preprod share address encodings,
 * so the same body can be valid on both, and each network keeps its own entry
 * (ADR 11).
 */
export type InFlightTransactionKey = `${CardanoNetworkId}:${string}`;

/**
 * A Cardano transaction a provider accepted that has not settled or expired
 * yet. It names no account: every UTxO, balance, collateral-ownership and
 * reward-withdrawal view applies the entries of the account's network and
 * resolves at read time which effects are the account's own.
 */
export type InFlightTransaction = {
  /** The network the transaction was submitted to. */
  chainId: Cardano.ChainId;
  txId: CardanoTxId;
  effects: Serializable<CardanoInFlightEffects>;
  /**
   * Slot past which the transaction can no longer be included: the body's
   * upper validity bound, else the first network tip the wallet receives
   * after the entry was recorded plus `UNBOUNDED_IN_FLIGHT_SLOTS`. Absent
   * only for a body without a bound until that tip arrives.
   */
  invalidHereafter?: Cardano.Slot;
  /** Epoch milliseconds when the provider accepted the transaction. */
  submittedAt: Timestamp;
  /**
   * The provider's answer whether the chain holds the transaction, asked
   * once its network's stored tip is past `invalidHereafter` by
   * `UTXO_SYNC_CONFIRMATION_DEPTH`. The reconcile reads it as proof that the
   * transaction landed or can no longer settle.
   */
  lookup?: InFlightTransactionLookup;
};

/** What the provider answered about an in-flight transaction. */
export type InFlightTransactionLookup = {
  /**
   * The stored tip slot of the transaction's network, read before the
   * request, so the provider answered from an index that had reached it, less
   * the lag the wallet allows its provider.
   */
  tipSlot: Cardano.Slot;
  /** Where the chain included the transaction, `null` when it does not hold it. */
  inclusion: CardanoTransactionInclusion | null;
};

/** An {@link InFlightTransaction} with its effects decoded. */
export type DecodedInFlightTransaction = Omit<
  InFlightTransaction,
  'effects'
> & {
  effects: CardanoInFlightEffects;
};

export type CardanoContextSliceState = {
  /**
   * Every accepted Cardano transaction that has not settled or expired yet
   * (persisted): the one record of an in-flight spend. Pending activities are
   * display rows; no in-flight view reads a row's metadata.
   */
  inFlightTransactions: Partial<
    Record<InFlightTransactionKey, InFlightTransaction>
  >;
  accountTransactionHistory: CardanoAccountAddressHistoryMap;
  accountRewardsHistory: CardanoAccountToRewardAccountsMap;
  accountDelegationsHistory: CardanoAccountToDelegationAccountsMap;
  networkInfo: Partial<Record<CardanoNetworkId, CardanoNetworkInfo>>;
  accountUtxos: Partial<Record<AccountId, AccountUtxoEntry>>;
  accountUnspendableUtxos: Partial<
    Record<AccountId, Serializable<Cardano.Utxo[]>>
  >;
  rewardAccountDetails: Partial<
    Record<AccountId, Serializable<RewardAccountDetails>>
  >;
  /**
   * Cache key per account identifying the on-chain state under which the
   * stored `rewardAccountDetails[accountId]` is considered settled. Advanced
   * by `setLastFetchedRewardAccountDetailsCacheKey` independently from the
   * details write, so the natural trigger can keep re-fetching while
   * indexer lag could still hide a just-confirmed cert's effect.
   */
  lastFetchedRewardAccountDetailsCacheKey: Partial<
    Record<AccountId, RewardAccountDetailsCacheKey>
  >;
  delegationActivities: Record<
    AccountId,
    Record<CardanoRewardAccount, Activity[]>
  >;
  /**
   * Result of the opt-in proactive security re-scan per account (persisted).
   * `scannedAt` is the epoch-ms timestamp of the last completed scan;
   * `exploits` holds the ids of compromises found on-chain. A present entry
   * (even with an empty `exploits`) marks the account as already scanned, so
   * the proactive prompt is not shown again.
   */
  securityScanByAccount: Record<
    AccountId,
    { scannedAt: number; exploits: string[] }
  >;
  /**
   * Accounts with an in-flight security re-scan (transient; not persisted).
   */
  securityScanInProgress: Record<AccountId, boolean>;
  /**
   * Accounts whose proactive re-scan banner the user dismissed (persisted).
   * Suppresses both the "Check" prompt and the clean-result note. Does not
   * affect the compromise banner, which is never dismissible.
   */
  securityRescanDismissedByAccount: Record<AccountId, boolean>;
};

export const initialState: CardanoContextSliceState = {
  inFlightTransactions: {},
  accountTransactionHistory: {},
  accountRewardsHistory: {},
  networkInfo: {},
  accountUtxos: {},
  accountUnspendableUtxos: {},
  rewardAccountDetails: {},
  lastFetchedRewardAccountDetailsCacheKey: {},
  accountDelegationsHistory: {},
  delegationActivities: {},
  securityScanByAccount: {},
  securityScanInProgress: {},
  securityRescanDismissedByAccount: {},
};

/** Stable fallbacks for slice selectors used as Reselect inputs (dev stability checks). */
const EMPTY_DELEGATION_ACTIVITIES =
  {} as CardanoContextSliceState['delegationActivities'];
const EMPTY_REWARDS: Reward[] = [];
const EMPTY_IN_FLIGHT_TRANSACTIONS: Readonly<
  Record<InFlightTransactionKey, DecodedInFlightTransaction>
> = {};
const EMPTY_IN_FLIGHT_EFFECTS: readonly CardanoInFlightEffects[] = [];
const EMPTY_IN_FLIGHT_EFFECTS_BY_ACCOUNT: Partial<
  Record<AccountId, readonly CardanoInFlightEffects[]>
> = {};

const inFlightTransactionKey = (
  chainId: Cardano.ChainId,
  txId: CardanoTxId,
): InFlightTransactionKey =>
  `${CardanoNetworkId(chainId.networkMagic)}:${txId}`;

/**
 * Returns the timestamp of a history item.
 * If the item is a transaction, returns the blockTime.
 * If the item is a reward, returns the reward spendable date.
 * @param item - The history item.
 * @param eraSummaries - The era summaries.
 * @returns The timestamp of the history item.
 */
const getHistoryItemTimestamp = (
  item: CardanoTransactionHistoryItem | Reward,
  eraSummaries: readonly EraSummary[],
): number => {
  if ('blockTime' in item) {
    return item.blockTime;
  }
  return getRewardSpendableDate(item.epoch, eraSummaries).getTime();
};

const slice = createSlice({
  name: 'cardanoContext',
  initialState,
  reducers: {
    /**
     * Records a transaction a provider accepted, so every in-flight view
     * applies its effects until it settles or can no longer settle. Dispatch
     * it only after the provider accepted the bytes, with
     * `inFlightTransactionOf`.
     *
     * Keeps the entry the store already holds for the transaction on that
     * network unchanged: a repeated acceptance or record never extends its
     * bound or moves `submittedAt`. A body without an upper validity bound is
     * stored without one; `setTip` gives it its cut-off, whoever recorded it.
     *
     * What every writer records, the readers and when an entry goes:
     * `packages/module/cardano-sync/docs/in-flight-transactions.md`.
     */
    recordInFlightTransaction: {
      reducer: (state, { payload }: PayloadAction<InFlightTransaction>) => {
        const key = inFlightTransactionKey(payload.chainId, payload.txId);
        if (state.inFlightTransactions[key]) return;
        state.inFlightTransactions[key] = payload;
      },
      prepare: ({ effects, ...entry }: DecodedInFlightTransaction) => ({
        payload: { ...entry, effects: Serializable.to(effects) },
      }),
    },
    /** Removes the entries of transactions that settled or can no longer settle. */
    removeInFlightTransactions: (
      state,
      { payload: { keys } }: PayloadAction<{ keys: InFlightTransactionKey[] }>,
    ) => {
      for (const key of keys) delete state.inFlightTransactions[key];
    },
    /**
     * Records the provider's answer whether the chain holds an in-flight
     * transaction on the entry of `key`. Changes no other field of the entry,
     * and nothing when the store holds no entry for the key, such as one
     * removed while the provider answered.
     */
    recordInFlightTransactionLookup: (
      state,
      {
        payload: { key, lookup },
      }: PayloadAction<{
        key: InFlightTransactionKey;
        lookup: InFlightTransactionLookup;
      }>,
    ) => {
      const entry = state.inFlightTransactions[key];
      if (entry) entry.lookup = lookup;
    },
    /**
     * Rebuild one Cardano account's chain-derived state without removing credentials or collateral.
     * Requires the cardano-sync module's thorough discovery, chained transaction polling,
     * and UTXO refetch handlers, in addition to the cardano-context side effects.
     */
    requestWalletSyncReset: (
      _state,
      _action: PayloadAction<{ accountId: AccountId }>,
    ) => {},
    /** Request fresh account UTXOs through cardano-sync, bypassing its cached-fetch gate. */
    refetchAccountUtxos: (
      _state,
      _action: PayloadAction<{ accountId: AccountId }>,
    ) => {},
    /** Refresh this account's current rewards and staking details, bypassing the cache. */
    refetchRewardAccountDetails: (
      _state,
      _action: PayloadAction<{ accountId: AccountId }>,
    ) => {},
    setWalletSyncResetResult: (
      _state,
      {
        payload: _payload,
      }: PayloadAction<{
        accountId: AccountId;
        status: 'Completed' | 'Failed';
        error?: TranslationKey;
      }>,
    ) => {},
    resetWalletSyncState: (
      state,
      { payload: { accountId } }: PayloadAction<{ accountId: AccountId }>,
    ) => {
      delete state.accountTransactionHistory[accountId];
      delete state.accountRewardsHistory[accountId];
      delete state.accountDelegationsHistory[accountId];
      delete state.delegationActivities[accountId];
    },
    /**
     * Stores a tip the provider reported for the network. Every in-flight
     * entry of that network without an upper validity bound gets the cut-off
     * of this tip plus `UNBOUNDED_IN_FLIGHT_SLOTS`, so a transaction recorded
     * before any tip, or after a tip restored from storage, is bounded from
     * the first fresh tip after it. A bound once set never moves.
     */
    setTip: (
      state,
      {
        payload: { tip, network },
      }: PayloadAction<{ tip: Cardano.Tip; network: CardanoNetworkId }>,
    ) => {
      state.networkInfo[network] ||= {};
      state.networkInfo[network].tip = tip;
      for (const entry of Object.values(state.inFlightTransactions)) {
        if (
          entry &&
          entry.invalidHereafter === undefined &&
          CardanoNetworkId(entry.chainId.networkMagic) === network
        ) {
          entry.invalidHereafter = Cardano.Slot(
            tip.slot + UNBOUNDED_IN_FLIGHT_SLOTS,
          );
        }
      }
    },
    setProtocolParameters: (
      state,
      {
        payload: { protocolParameters, network },
      }: PayloadAction<{
        protocolParameters: RequiredProtocolParameters;
        network: CardanoNetworkId;
      }>,
    ) => {
      state.networkInfo[network] ||= {};
      state.networkInfo[network].protocolParameters = pick(protocolParameters, [
        'coinsPerUtxoByte',
        'collateralPercentage',
        'dRepDeposit',
        'maxTxSize',
        'maxValueSize',
        'minFeeCoefficient',
        'minFeeConstant',
        'minFeeRefScriptCostPerByte',
        'poolDeposit',
        'prices',
        'stakeKeyDeposit',
        'poolInfluence',
        'maxCollateralInputs',
        'desiredNumberOfPools',
        'monetaryExpansion',
      ]);
    },
    setEraSummaries: {
      reducer: (
        state,
        {
          payload: { network, eraSummaries },
        }: PayloadAction<{
          network: CardanoNetworkId;
          eraSummaries: Serializable<EraSummary[]>;
        }>,
      ) => {
        state.networkInfo[network] ||= {};
        state.networkInfo[network].eraSummaries = eraSummaries;
      },
      prepare: ({
        network,
        eraSummaries,
      }: {
        network: CardanoNetworkId;
        eraSummaries: EraSummary[];
      }) => ({
        payload: {
          network,
          eraSummaries: Serializable.to(eraSummaries),
        },
      }),
    },
    setAccountRewardsHistory: (
      state,
      {
        payload,
      }: Readonly<
        PayloadAction<{
          accountId: AccountId;
          rewardsHistory: CardanoRewardAccountToRewardMap;
        }>
      >,
    ) => {
      const { accountId, rewardsHistory } = payload;
      if (!state.accountRewardsHistory) {
        state.accountRewardsHistory = {};
      }
      state.accountRewardsHistory[accountId] = rewardsHistory;
    },
    setAccountDelegationsHistory: (
      state,
      {
        payload,
      }: Readonly<
        PayloadAction<{
          accountId: AccountId;
          rewardAccount: CardanoRewardAccount;
          items: (DelegationInfo | RegistrationInfo | WithdrawalInfo)[];
        }>
      >,
    ) => {
      const { accountId, rewardAccount, items } = payload;
      state.accountDelegationsHistory ??= {};
      state.accountDelegationsHistory[accountId] ??= {};
      state.accountDelegationsHistory[accountId][rewardAccount] ??= [];

      state.accountDelegationsHistory[accountId][rewardAccount].push(...items);
    },
    setAccountTransactionHistory: (
      state,
      {
        payload: { accountId, addressHistories },
      }: Readonly<
        PayloadAction<{
          accountId: AccountId;
          addressHistories: {
            address: CardanoPaymentAddress;
            transactionHistory: CardanoTransactionHistoryItem[];
            hasLoadedOldestEntry: boolean;
          }[];
        }>
      >,
    ) => {
      const account = state.accountTransactionHistory[accountId] ?? {};
      for (const {
        address,
        transactionHistory,
        hasLoadedOldestEntry,
      } of addressHistories) {
        account[address] = {
          hasLoadedOldestEntry,
          transactionHistory,
        };
      }
      state.accountTransactionHistory[accountId] = account;
    },
    clearAccountTransactionHistory: (
      state,
      {
        payload: { accountId },
      }: Readonly<PayloadAction<{ accountId: AccountId }>>,
    ) => {
      delete state.accountTransactionHistory[accountId];
    },
    clearAllTransactionHistories: state => {
      state.accountTransactionHistory = {};
    },
    setAccountUtxos: {
      reducer: (
        state,
        {
          payload,
        }: Readonly<
          PayloadAction<{
            accountId: AccountId;
            utxos: Serializable<Cardano.Utxo[]>;
          }>
        >,
      ) => {
        const existing = state.accountUtxos[payload.accountId];
        state.accountUtxos[payload.accountId] = {
          utxos: payload.utxos,
          cacheKey: existing?.cacheKey,
        };
      },
      prepare: ({
        accountId,
        utxos,
      }: {
        accountId: AccountId;
        utxos: Cardano.Utxo[];
      }) => ({
        payload: {
          accountId,
          utxos: Serializable.to(utxos),
        },
      }),
    },
    setLastFetchedUtxoCacheKey: (
      state,
      {
        payload: { accountId, cacheKey },
      }: Readonly<
        PayloadAction<{ accountId: AccountId; cacheKey: UtxoCacheKey }>
      >,
    ) => {
      const existing = state.accountUtxos[accountId];
      state.accountUtxos[accountId] = {
        utxos: existing?.utxos ?? Serializable.to<Cardano.Utxo[]>([]),
        cacheKey,
      };
    },
    /**
     * Sets unspendable UTXOs for an account.
     */
    setAccountUnspendableUtxos: {
      reducer: (
        state,
        {
          payload,
        }: Readonly<
          PayloadAction<{
            accountId: AccountId;
            utxos: Serializable<Cardano.Utxo[]>;
          }>
        >,
      ) => {
        state.accountUnspendableUtxos[payload.accountId] = payload.utxos;
      },
      prepare: ({
        accountId,
        utxos,
      }: {
        accountId: AccountId;
        utxos: Cardano.Utxo[];
      }) => {
        const serialized = Serializable.to<Cardano.Utxo[]>(utxos);
        return { payload: { accountId, utxos: serialized } };
      },
    },
    /**
     * Sets the reward account details for the first stake key of an account.
     */
    setRewardAccountDetails: {
      reducer: (
        state,
        {
          payload,
        }: Readonly<
          PayloadAction<{
            accountId: AccountId;
            details: Serializable<RewardAccountDetails>;
          }>
        >,
      ) => {
        state.rewardAccountDetails[payload.accountId] = payload.details;
      },
      prepare: ({
        accountId,
        details,
      }: {
        accountId: AccountId;
        details: RewardAccountDetails;
      }) => ({
        payload: {
          accountId,
          details: Serializable.to(details),
        },
      }),
    },
    setLastFetchedRewardAccountDetailsCacheKey: (
      state,
      {
        payload: { accountId, cacheKey },
      }: Readonly<
        PayloadAction<{
          accountId: AccountId;
          cacheKey: RewardAccountDetailsCacheKey;
        }>
      >,
    ) => {
      state.lastFetchedRewardAccountDetailsCacheKey[accountId] = cacheKey;
    },
    setDelegationActivities: (
      state,
      {
        payload: { accountId, rewardAccount, activities: incomingActivities },
      }: Readonly<
        PayloadAction<{
          accountId: AccountId;
          rewardAccount: CardanoRewardAccount;
          activities: Activity[];
        }>
      >,
    ) => {
      // Initialize delegationActivities if it doesn't exist
      state.delegationActivities ??= {};
      state.delegationActivities[accountId] ??= {};
      state.delegationActivities[accountId][rewardAccount] ??= [];

      const currentActivities =
        state.delegationActivities[accountId][rewardAccount] || [];
      // Merge activities and deduplicate by activityId
      const jointActivityEntries = [
        ...currentActivities,
        ...incomingActivities,
      ].map(
        activity =>
          [`${activity.activityId}-${activity.type}`, activity] as const,
      );
      // Sort by timestamp descending (newest first)
      state.delegationActivities[accountId][rewardAccount] = [
        ...new Map(jointActivityEntries).values(),
      ].sort((a, b) => b.timestamp - a.timestamp);
    },
    clearAccountDelegationHistory: (
      state,
      {
        payload: { accountId, rewardAccount },
      }: Readonly<
        PayloadAction<{
          accountId: AccountId;
          rewardAccount: CardanoRewardAccount;
        }>
      >,
    ) => {
      // Clear account delegations history
      if (state.accountDelegationsHistory[accountId]) {
        delete state.accountDelegationsHistory[accountId][rewardAccount];
        // Clean up empty account entry
        if (
          Object.keys(state.accountDelegationsHistory[accountId]).length === 0
        ) {
          delete state.accountDelegationsHistory[accountId];
        }
      }

      // Clear delegation activities
      if (state.delegationActivities[accountId]) {
        delete state.delegationActivities[accountId][rewardAccount];
        // Clean up empty account entry
        if (Object.keys(state.delegationActivities[accountId]).length === 0) {
          delete state.delegationActivities[accountId];
        }
      }
    },
    /**
     * Trigger action to retry sync round for failed accounts.
     * This action does not modify state - it's handled by side effects.
     * Side effects will query the failures store to find failed accounts
     * and retry sync only for those accounts.
     */
    retrySyncRound: () => {
      // Trigger action only - no state changes
    },
    /**
     * Trigger action to enqueue a thorough HD address discovery for the
     * given Cardano account. Observed by the `manualAddressDiscoveryEnqueue`
     * side-effect, which builds an ADDRESS_DISCOVERY_THOROUGH operation id
     * and dispatches `actions.sync.addSyncOperation`.
     */
    requestManualAddressDiscovery: (
      _state,
      _action: PayloadAction<{ accountId: AccountId }>,
    ) => {},
    /**
     * Trigger action requesting an opt-in proactive security re-scan of the
     * account's on-chain tx history. Observed by the `securityRescan`
     * side-effect; does not mutate state directly.
     */
    requestSecurityRescan: (
      _state,
      _action: Readonly<PayloadAction<{ accountId: AccountId }>>,
    ) => {
      // Trigger action only - no state changes
    },
    setSecurityScanInProgress: (
      state,
      {
        payload: { accountId },
      }: Readonly<PayloadAction<{ accountId: AccountId }>>,
    ) => {
      state.securityScanInProgress[accountId] = true;
    },
    setSecurityScanResult: (
      state,
      {
        payload: { accountId, scannedAt, exploits },
      }: Readonly<
        PayloadAction<{
          accountId: AccountId;
          scannedAt: number;
          exploits: string[];
        }>
      >,
    ) => {
      state.securityScanByAccount[accountId] = { scannedAt, exploits };
      delete state.securityScanInProgress[accountId];
    },
    dismissSecurityRescan: (
      state,
      {
        payload: { accountId },
      }: Readonly<PayloadAction<{ accountId: AccountId }>>,
    ) => {
      state.securityRescanDismissedByAccount[accountId] = true;
    },
    setSecurityScanFailed: (
      state,
      {
        payload: { accountId },
      }: Readonly<PayloadAction<{ accountId: AccountId }>>,
    ) => {
      delete state.securityScanInProgress[accountId];
    },
  },
  extraReducers: builder => {
    /**
     * Handles the removeAccount action to remove the cardano context data for the account.
     * @param state - The current state of the cardano context slice.
     * @param action - The removeAccount action containing the payload with accountId.
     */
    builder.addCase(walletsActions.wallets.removeAccount, (state, action) => {
      const { accountId } = action.payload;
      delete state.accountTransactionHistory[accountId];
      delete state.accountRewardsHistory[accountId];
      delete state.accountUtxos[accountId];
      delete state.rewardAccountDetails[accountId];
      delete state.lastFetchedRewardAccountDetailsCacheKey[accountId];
      delete state.accountDelegationsHistory[accountId];
      delete state.delegationActivities[accountId];
      delete state.accountUnspendableUtxos[accountId];
      delete state.securityScanByAccount[accountId];
      delete state.securityScanInProgress[accountId];
      delete state.securityRescanDismissedByAccount[accountId];
    });

    /**
     * Handles the removeWallet action to remove cardano context data for all accounts of the wallet.
     * @param state - The current state of the cardano context slice.
     * @param action - The removeWallet action containing the walletId and accountIds.
     */
    builder.addCase(walletsActions.wallets.removeWallet, (state, action) => {
      const { accountIds } = action.payload;
      for (const accountId of accountIds) {
        delete state.accountTransactionHistory[accountId];
        delete state.accountRewardsHistory[accountId];
        delete state.accountUtxos[accountId];
        delete state.rewardAccountDetails[accountId];
        delete state.lastFetchedRewardAccountDetailsCacheKey[accountId];
        delete state.accountDelegationsHistory[accountId];
        delete state.delegationActivities[accountId];
        delete state.accountUnspendableUtxos[accountId];
        delete state.securityScanByAccount[accountId];
        delete state.securityScanInProgress[accountId];
        delete state.securityRescanDismissedByAccount[accountId];
      }
    });
  },
  selectors: {
    selectAccountTransactionHistory: (state: CardanoContextSliceState) => {
      return state.accountTransactionHistory;
    },
    selectTransactionHistoryGroupedByAccount: createSelector(
      (state: CardanoContextSliceState) => state.accountTransactionHistory,
      accountHistoryMap => {
        const knownAccountTxHistoryMap: CardanoAccountTransactionsHistoryMap =
          {};

        Object.entries(accountHistoryMap).forEach(
          ([accountId, addressHistoryMap]) => {
            // Flatten txs from all account addresses
            const addressHistories = Object.values(addressHistoryMap);
            const knownAccountTransactionHistory = flatMap(
              addressHistories,
              ({ transactionHistory }) => transactionHistory,
            );

            // Check if all addresses have loaded their oldest entry, which would mean
            // that the account history is fully loaded and we know its full length
            const isCompletelyLoaded = addressHistories.every(
              ({ hasLoadedOldestEntry }) => hasLoadedOldestEntry,
            );
            // Until all addresses are completely loaded, take the longest address history
            // length as a reference for "known account history"
            const longestHistory = Math.max(
              0,
              ...addressHistories.map(
                ({ transactionHistory }) => transactionHistory.length,
              ),
            );
            // Sort all txs by blockTime and limit them by known history length
            knownAccountTxHistoryMap[AccountId(accountId)] =
              // de-duplicate txs potentially present on multiple account addresses
              uniqBy(knownAccountTransactionHistory, 'txId')
                .sort(
                  (a, b) =>
                    Number(b.blockTime) - Number(a.blockTime) ||
                    Number(b.txIndex) - Number(a.txIndex),
                )
                .slice(0, isCompletelyLoaded ? undefined : longestHistory);
          },
        );

        return knownAccountTxHistoryMap;
      },
    ),
    selectRewardsHistoryGroupedByAccount: createSelector(
      (state: CardanoContextSliceState) => state.accountRewardsHistory,
      rawRewardsHistory => {
        const accountRewardsHistory: CardanoAccountToRewardsMap = {};

        Object.entries(rawRewardsHistory).forEach(([accountId, rewards]) => {
          Object.values(rewards).forEach(reward => {
            const account = accountRewardsHistory[AccountId(accountId)] ?? [];
            account.push(...reward);
            accountRewardsHistory[AccountId(accountId)] = account;
          });
        });

        // Sort rewards by epoch in descending order
        Object.keys(accountRewardsHistory).forEach(accountId => {
          accountRewardsHistory[AccountId(accountId)].sort(
            (a, b) => Number(b.epoch) - Number(a.epoch),
          );
        });

        return accountRewardsHistory;
      },
    ),
    selectInFlightTransactionsRaw: ({ inFlightTransactions }) =>
      inFlightTransactions,
    selectAllNetworkInfo: state => state.networkInfo,
    selectAccountUtxosRaw: ({ accountUtxos }) => accountUtxos,
    selectAccountUnspendableUtxosRaw: ({ accountUnspendableUtxos }) =>
      accountUnspendableUtxos,
    selectRewardAccountDetailsRaw: ({ rewardAccountDetails }) =>
      rewardAccountDetails,
    selectLastFetchedRewardAccountDetailsCacheKeyByAccount: ({
      lastFetchedRewardAccountDetailsCacheKey,
    }) => lastFetchedRewardAccountDetailsCacheKey,
    selectAccountDelegationsHistory: (state: CardanoContextSliceState) =>
      state.accountDelegationsHistory,
    selectAccountRewardsHistory: (state: CardanoContextSliceState) =>
      state.accountRewardsHistory,
    selectDelegationActivities: (state: CardanoContextSliceState) =>
      state.delegationActivities ?? EMPTY_DELEGATION_ACTIVITIES,
    selectSecurityScanByAccount: (state: CardanoContextSliceState) =>
      state.securityScanByAccount,
    selectSecurityScanInProgress: (state: CardanoContextSliceState) =>
      state.securityScanInProgress,
    selectSecurityRescanDismissedByAccount: (state: CardanoContextSliceState) =>
      state.securityRescanDismissedByAccount,
  },
});

const selectBlockchainNetworkId = createSelector(
  networkSelectors.network.selectNetworkType,
  networkSelectors.network.selectBlockchainNetworks,
  (networkType, blockchainNetworks) =>
    blockchainNetworks.Cardano?.[networkType] as CardanoNetworkId | undefined,
);

const selectChainId = createSelector(
  selectBlockchainNetworkId,
  (networkId): Cardano.ChainId | undefined =>
    networkId ? CardanoNetworkId.getChainId(networkId) : undefined,
);

const selectActiveNetworkInfo = createSelector(
  slice.selectors.selectAllNetworkInfo,
  selectBlockchainNetworkId,
  (allNetworkInfo, activeNetworkId) =>
    activeNetworkId && allNetworkInfo[activeNetworkId],
);

const selectTip = createSelector(
  selectActiveNetworkInfo,
  networkInfo => networkInfo?.tip,
);

const selectProtocolParameters = createSelector(
  selectActiveNetworkInfo,
  networkInfo => networkInfo?.protocolParameters,
);

const selectEraSummaries = createSelector(
  selectActiveNetworkInfo,
  networkInfo =>
    networkInfo?.eraSummaries
      ? Serializable.fromCached(networkInfo.eraSummaries)
      : undefined,
);
const selectDelegationActivitiesParams = createSelector(
  slice.selectors.selectAccountDelegationsHistory,
  slice.selectors.selectDelegationActivities,
  slice.selectors.selectAccountRewardsHistory,
  (accountDelegationsHistory, delegationActivities, accountRewardsHistory) => ({
    accountDelegationsHistory,
    delegationActivities,
    accountRewardsHistory,
  }),
);

const selectDelegationActivities = createSelector(
  selectDelegationActivitiesParams,
  selectEraSummaries,
  (
    _: unknown,
    params: {
      accountId: AccountId;
      rewardAccount: CardanoRewardAccount;
    },
  ) => params,
  (
    { accountDelegationsHistory, delegationActivities, accountRewardsHistory },
    eraSummaries,
    { accountId, rewardAccount },
  ) => {
    const historyEntry =
      accountDelegationsHistory[accountId]?.[rewardAccount] ?? [];
    const accountActivities =
      delegationActivities[accountId]?.[rewardAccount] ?? [];

    const isLoadingActivities =
      historyEntry.length !== accountActivities.length;

    // Merge rewards with activities similar to selectCombinedTransactionHistory
    let mergedActivities: Activity[] = [];
    if (eraSummaries && !isLoadingActivities) {
      const rewards = accountRewardsHistory[accountId]?.[rewardAccount] ?? [];

      // Filter rewards that are after the last activity (if any), similar to selectCombinedTransactionHistory
      const rewardsTillLastActivity =
        accountActivities.length > 0
          ? rewards.filter(
              reward =>
                getRewardSpendableDate(reward.epoch, eraSummaries).getTime() >
                accountActivities.at(-1)!.timestamp,
            )
          : rewards;

      const rewardActivities = rewardsTillLastActivity.map(reward =>
        mapRewardToActivity({
          reward,
          eraSummaries,
          rewardAccount,
          accountId,
        }),
      );

      mergedActivities = [...accountActivities, ...rewardActivities];

      // Sort by timestamp descending (newest first)
      mergedActivities.sort((a, b) => b.timestamp - a.timestamp);
    }

    return {
      activities: mergedActivities,
      isLoadingActivities,
    };
  },
);

/**
 * Per-account selector that flattens and sorts rewards only for the requested account.
 * Avoids the cost of processing ALL accounts when only one is needed (e.g., in the
 * StakeDelegation sheet). The full-map variant `selectRewardsHistoryGroupedByAccount`
 * remains for consumers that need all accounts (side effects, combined history).
 */
/**
 * Parameterized input selector that extracts the per-account rewards sub-map.
 * Keyed on the account's own sub-map reference (preserved by Immer across
 * unrelated account updates), so downstream selectors only invalidate when
 * THIS account's rewards actually change.
 */
const selectRewardsForAccountRaw = markParameterizedSelector(
  createSelector(
    slice.selectors.selectAccountRewardsHistory,
    (_: unknown, accountId: AccountId) => accountId,
    (rewardsHistory, accountId) => rewardsHistory[accountId],
  ),
);

const selectRewardsHistoryForAccount = markParameterizedSelector(
  createSelector(selectRewardsForAccountRaw, (rewardAccountMap): Reward[] => {
    if (!rewardAccountMap) return EMPTY_REWARDS;

    const rewards: Reward[] = [];
    for (const rewardAccount in rewardAccountMap) {
      const rewardList =
        rewardAccountMap[rewardAccount as CardanoRewardAccount];
      if (rewardList) {
        for (const reward of rewardList) {
          rewards.push(reward);
        }
      }
    }

    if (rewards.length === 0) return EMPTY_REWARDS;

    rewards.sort((a, b) => Number(b.epoch) - Number(a.epoch));
    return rewards;
  }),
);

const selectAccountUtxos = createSelector(
  slice.selectors.selectAccountUtxosRaw,
  (accountUtxosRaw): AccountUtxoMap => {
    const result: AccountUtxoMap = {};
    for (const accountId in accountUtxosRaw) {
      const entry = accountUtxosRaw[accountId as AccountId];
      if (entry) {
        result[accountId as AccountId] =
          Serializable.fromCached<Cardano.Utxo[]>(entry.utxos) ?? [];
      }
    }
    return result;
  },
);

const selectLastFetchedUtxoCacheKeyByAccount = createSelector(
  slice.selectors.selectAccountUtxosRaw,
  (accountUtxosRaw): Partial<Record<AccountId, UtxoCacheKey>> => {
    const result: Partial<Record<AccountId, UtxoCacheKey>> = {};
    for (const accountId in accountUtxosRaw) {
      const cacheKey = accountUtxosRaw[accountId as AccountId]?.cacheKey;
      if (cacheKey) {
        result[accountId as AccountId] = cacheKey;
      }
    }
    return result;
  },
);

const selectAccountUnspendableUtxos = createSelector(
  slice.selectors.selectAccountUnspendableUtxosRaw,
  (accountUnspendableUtxosRaw): AccountUnspendableUtxoMap => {
    const result: AccountUnspendableUtxoMap = {};
    for (const accountId in accountUnspendableUtxosRaw) {
      const serialized = accountUnspendableUtxosRaw[accountId as AccountId];
      if (serialized) {
        result[accountId as AccountId] =
          Serializable.fromCached<Cardano.Utxo[]>(serialized) ?? [];
      }
    }
    return result;
  },
);

const selectRewardAccountDetails = createSelector(
  slice.selectors.selectRewardAccountDetailsRaw,
  (rewardAccountDetailsRaw): AccountRewardAccountDetailsMap => {
    const result: AccountRewardAccountDetailsMap = {};
    for (const accountId in rewardAccountDetailsRaw) {
      const serialized = rewardAccountDetailsRaw[accountId as AccountId];
      if (serialized) {
        const details =
          Serializable.fromCached<RewardAccountDetails>(serialized);
        if (details) {
          result[accountId as AccountId] = details;
        }
      }
    }
    return result;
  },
);

const decodedInFlightTransactions = new WeakMap<
  InFlightTransaction,
  DecodedInFlightTransaction
>();

const decodeInFlightTransaction = (
  entry: InFlightTransaction,
): DecodedInFlightTransaction => {
  let decoded = decodedInFlightTransactions.get(entry);
  if (!decoded) {
    decoded = {
      ...entry,
      effects: Serializable.fromCached<CardanoInFlightEffects>(entry.effects),
    };
    decodedInFlightTransactions.set(entry, decoded);
  }
  return decoded;
};

/**
 * Every in-flight Cardano transaction with its effects decoded, by
 * {@link InFlightTransactionKey}, across all networks. A stored entry that
 * did not change decodes to the same object on every emission, and with no
 * entry the result is one stable empty object.
 */
const selectInFlightTransactions = createSelector(
  slice.selectors.selectInFlightTransactionsRaw,
  (
    raw,
  ): Readonly<Record<InFlightTransactionKey, DecodedInFlightTransaction>> => {
    const keys = Object.keys(raw) as InFlightTransactionKey[];
    if (keys.length === 0) return EMPTY_IN_FLIGHT_TRANSACTIONS;
    const result: Record<InFlightTransactionKey, DecodedInFlightTransaction> =
      {};
    for (const key of keys) {
      const entry = raw[key];
      if (entry) result[key] = decodeInFlightTransaction(entry);
    }
    return result;
  },
);

/** The decoded effects of every in-flight transaction, by network. */
const selectInFlightEffectsByNetwork = createSelector(
  selectInFlightTransactions,
  (inFlight): Partial<Record<CardanoNetworkId, CardanoInFlightEffects[]>> => {
    const result: Partial<Record<CardanoNetworkId, CardanoInFlightEffects[]>> =
      {};
    for (const { chainId, effects } of Object.values(inFlight)) {
      (result[CardanoNetworkId(chainId.networkMagic)] ??= []).push(effects);
    }
    return result;
  },
);

const haveSameNetworks = (
  a: Partial<Record<AccountId, CardanoNetworkId>>,
  b: Partial<Record<AccountId, CardanoNetworkId>>,
): boolean => {
  const accountIds = Object.keys(a) as AccountId[];
  return (
    accountIds.length === Object.keys(b).length &&
    accountIds.every(accountId => a[accountId] === b[accountId])
  );
};

/**
 * The network of every Cardano account of every wallet. Keeps its reference
 * until a Cardano account is added or removed, so the in-flight views do not
 * recompute on unrelated wallet updates.
 */
const selectCardanoNetworkByAccount = createSelector(
  walletsSelectors.wallets.selectAll,
  (wallets): Partial<Record<AccountId, CardanoNetworkId>> => {
    const result: Partial<Record<AccountId, CardanoNetworkId>> = {};
    for (const { accounts } of wallets) {
      for (const account of accounts) {
        if (isCardanoAccount(account)) {
          result[account.accountId] =
            account.blockchainNetworkId as CardanoNetworkId;
        }
      }
    }
    return result;
  },
  { memoizeOptions: { resultEqualityCheck: haveSameNetworks } },
);

/**
 * The in-flight effects each Cardano account applies: those of every entry of
 * the account's network, whatever recorded it. Only the accounts of a network
 * that has entries appear.
 */
const selectInFlightEffectsByAccount = createSelector(
  selectInFlightEffectsByNetwork,
  selectCardanoNetworkByAccount,
  (
    inFlightByNetwork,
    networkByAccount,
  ): Partial<Record<AccountId, readonly CardanoInFlightEffects[]>> => {
    if (Object.keys(inFlightByNetwork).length === 0)
      return EMPTY_IN_FLIGHT_EFFECTS_BY_ACCOUNT;
    const result: Partial<
      Record<AccountId, readonly CardanoInFlightEffects[]>
    > = {};
    for (const [accountId, networkId] of Object.entries(networkByAccount)) {
      const inFlight = networkId && inFlightByNetwork[networkId];
      if (inFlight) result[AccountId(accountId)] = inFlight;
    }
    return result;
  },
);

/**
 * Spend and balance adjustments, including confirmed spends after their
 * in-flight entries leave. A delayed parent acceptance must not offer change
 * a reconciled child already spent, even with an unchanged synced snapshot.
 */
const selectUtxoAdjustmentEffectsByAccount = createSelector(
  selectInFlightEffectsByAccount,
  activitiesSelectors.activities.selectAllMap,
  selectCardanoNetworkByAccount,
  (inFlightByAccount, activitiesByAccount, networkByAccount) => {
    const confirmedByNetwork = new Map<
      CardanoNetworkId,
      CardanoInFlightEffects[]
    >();
    for (const [accountId, activities] of Object.entries(activitiesByAccount)) {
      const networkId = networkByAccount[AccountId(accountId)];
      if (!networkId) continue;
      for (const activity of activities) {
        if (activity.type === ActivityType.Pending) continue;
        const consumedInputs = (
          activity.blockchainSpecific as
            | BlockchainSpecificActivityMetadata
            | undefined
        )?.Cardano?.consumedInputs;
        if (!consumedInputs?.length) continue;
        const effects = confirmedByNetwork.get(networkId) ?? [];
        effects.push({ consumedInputs, producedOutputs: [] });
        confirmedByNetwork.set(networkId, effects);
      }
    }
    if (confirmedByNetwork.size === 0) return inFlightByAccount;
    const result = { ...inFlightByAccount };
    for (const [accountId, networkId] of Object.entries(networkByAccount)) {
      const confirmed = networkId && confirmedByNetwork.get(networkId);
      if (confirmed) {
        result[AccountId(accountId)] = [
          ...(inFlightByAccount[AccountId(accountId)] ??
            EMPTY_IN_FLIGHT_EFFECTS),
          ...confirmed,
        ];
      }
    }
    return result;
  },
);

/**
 * Rewards each reward account has withdrawn in in-flight transactions, on
 * the network of each transaction. A builder reads this to avoid withdrawing
 * the same rewards twice; it must not derive a withdrawal amount from it.
 */
const selectPendingRewardWithdrawals = createSelector(
  selectInFlightTransactions,
  inFlight => pendingRewardWithdrawals(Object.values(inFlight)),
);

/**
 * The BALANCE view of the reward details: withdrawable rewards minus those an
 * in-flight transaction already moved into its outputs (see
 * `applyPendingRewardWithdrawals`). For balance accounting only; screens and
 * builders that need what the chain reports read
 * {@link selectRewardAccountDetails}.
 */
const selectRewardAccountDetailsWithInFlight = createSelector(
  selectRewardAccountDetails,
  selectPendingRewardWithdrawals,
  addressesSelectors.addresses.selectAllAddresses,
  applyPendingRewardWithdrawals,
);

const EMPTY_CARDANO_ADDRESSES: CardanoPaymentAddress[] = [];
const EMPTY_UTXOS: Cardano.Utxo[] = [];

const selectCardanoAddressesByAccount = createSelector(
  addressesSelectors.addresses.selectAllAddresses,
  (allAddresses): Record<AccountId, CardanoPaymentAddress[]> => {
    const result: Record<AccountId, CardanoPaymentAddress[]> = {};
    for (const entry of allAddresses) {
      if (entry.blockchainName !== 'Cardano') continue;
      const list = result[entry.accountId] ?? (result[entry.accountId] = []);
      list.push(entry.address as unknown as CardanoPaymentAddress);
    }
    return result;
  },
);

/**
 * The COLLATERAL-OWNERSHIP authority (LW-15390): every UTxO the
 * collateral-return rule must treat as this account's.
 *
 * The full settled set — collateral-reserved UTxOs INCLUDED — unioned with the
 * outputs the in-flight transactions of the account's network pay to its
 * addresses. Built only by union: a UTxO missing here is one the guard will
 * let a dApp send to a foreign collateral return.
 *
 * NOT {@link selectAvailableAccountUtxos}, which subtracts the reserved set,
 * and NOT {@link selectAccountUtxosWithInFlight}, which also drops the inputs
 * in-flight transactions consume — those still exist on chain until the spend
 * confirms, so someone else can still name them as collateral.
 *
 * An ordinary Send is why the in-flight half matters: its change reaches this
 * account through the in-flight store, `getUtxos` serves it to the dApp, and
 * it is absent from the settled set until the provider catches up.
 */
const selectCollateralOwnershipUtxos = createSelector(
  selectAccountUtxos,
  selectInFlightEffectsByAccount,
  selectCardanoAddressesByAccount,
  (accountUtxos, inFlightByAccount, addressesByAccount) => {
    const result: AccountUtxoMap = {};

    // Union of both key sets, as `selectAccountUtxosWithInFlight` does: a
    // freshly funded account can hold an in-flight credit before its first
    // settled fetch lands, and iterating settled alone would omit the account
    // entirely — every collateral input it holds would then read as foreign.
    const accountIds = new Set([
      ...Object.keys(accountUtxos),
      ...Object.keys(inFlightByAccount),
    ]);
    for (const accountId of accountIds) {
      const settled = accountUtxos[AccountId(accountId)];
      const pending = ownPendingOutputs(
        inFlightByAccount[AccountId(accountId)] ?? EMPTY_IN_FLIGHT_EFFECTS,
        addressesByAccount[AccountId(accountId)] ?? EMPTY_CARDANO_ADDRESSES,
      );
      // Without a settled set an account appears only once an entry credits
      // it: absent still means nothing is known of its UTxOs.
      if (!settled && pending.length === 0) continue;
      const byOutpoint = new Map(
        [...(settled ?? EMPTY_UTXOS), ...pending].map(utxo => [
          utxoKey(utxo),
          utxo,
        ]),
      );
      result[AccountId(accountId)] = [...byOutpoint.values()];
    }

    return result;
  },
);

/**
 * What each account's transactions can spend: the settled set with the
 * in-flight transactions of the account's network applied, minus confirmed
 * spent inputs and the reserved collateral.
 *
 * The reserved set is subtracted last, by outpoint, so a reserved output stays
 * out even when an in-flight transaction produces it: the chain refresh can
 * settle that output, and the collateral flow reserve it, while the
 * transaction is still in flight. A reserved outpoint known only as an
 * in-flight output stays out the same way.
 *
 * Accounts whose UTxOs a script locks are left out (see
 * `selectAccountIdsExcludedFromSpending`): only their own builders may spend
 * them, and an ordinary builder given one would build a transaction the chain
 * refuses.
 */
/* eslint-disable max-params */
const selectAvailableAccountUtxos = createSelector(
  selectAccountUtxos,
  selectAccountUnspendableUtxos,
  selectUtxoAdjustmentEffectsByAccount,
  selectCardanoAddressesByAccount,
  selectAccountIdsExcludedFromSpending,
  (
    accountUtxos,
    accountUnspendableUtxos,
    inFlightByAccount,
    addressesByAccount,
    excludedAccountIds,
  ): AccountUtxoMap => {
    const result: AccountUtxoMap = {};

    for (const [accountId, utxos] of Object.entries(accountUtxos)) {
      if (excludedAccountIds.has(accountId)) continue;
      const withInFlight = applyInFlightUtxoAdjustments(
        utxos,
        addressesByAccount[AccountId(accountId)] ?? EMPTY_CARDANO_ADDRESSES,
        inFlightByAccount[AccountId(accountId)] ?? EMPTY_IN_FLIGHT_EFFECTS,
      );
      result[AccountId(accountId)] = filterSpendableUtxos(
        withInFlight,
        accountUnspendableUtxos[AccountId(accountId)] ?? EMPTY_UTXOS,
      );
    }

    return result;
  },
);
/* eslint-enable max-params */

/**
 * The BALANCE view of each account's UTxOs: the settled set with the
 * in-flight transactions of the account's network applied — a submitted
 * transaction's consumed inputs leave the spending account and its outputs
 * credit the receiving account immediately, so value in flight between own
 * accounts (a migration sweep) is counted exactly once instead of twice while
 * providers catch up. Confirmed spent inputs remain excluded after their
 * in-flight entries leave.
 *
 * Differs from {@link selectAvailableAccountUtxos} by NOT filtering the
 * unspendable (collateral) set: that answers "what can a transaction spend",
 * this answers "what does the account hold" — collateral is still held.
 */
const selectAccountUtxosWithInFlight = createSelector(
  selectAccountUtxos,
  selectUtxoAdjustmentEffectsByAccount,
  selectCardanoAddressesByAccount,
  (accountUtxos, inFlightByAccount, addressesByAccount): AccountUtxoMap => {
    const result: AccountUtxoMap = {};

    // Union of both key sets: a freshly created receiving account can hold an
    // in-flight credit before its first settled UTxO fetch lands.
    const accountIds = new Set([
      ...Object.keys(accountUtxos),
      ...Object.keys(inFlightByAccount),
    ]);
    for (const accountId of accountIds) {
      const settled = accountUtxos[AccountId(accountId)];
      const withInFlight = applyInFlightUtxoAdjustments(
        settled ?? EMPTY_UTXOS,
        addressesByAccount[AccountId(accountId)] ?? EMPTY_CARDANO_ADDRESSES,
        inFlightByAccount[AccountId(accountId)] ?? EMPTY_IN_FLIGHT_EFFECTS,
      );
      // Without a settled set an account appears only once an entry credits
      // it: absent still means nothing is known of its UTxOs.
      if (settled || withInFlight.length > 0) {
        result[AccountId(accountId)] = withInFlight;
      }
    }

    return result;
  },
);

/**
 * The settled UTxOs that {@link selectAvailableAccountUtxos} also lists, as
 * the settled tuples: on chain and spendable now. A pick that must already
 * exist on chain, such as a new collateral reservation, reads this.
 *
 * Holds only the accounts {@link selectAvailableAccountUtxos} holds. Returns
 * an account's settled array itself when the two agree.
 */
const selectSettledAvailableAccountUtxos = createSelector(
  selectAccountUtxos,
  selectAvailableAccountUtxos,
  (accountUtxos, availableAccountUtxos): AccountUtxoMap => {
    const result: AccountUtxoMap = {};

    for (const [accountId, available] of Object.entries(
      availableAccountUtxos,
    )) {
      const settled = accountUtxos[AccountId(accountId)] ?? EMPTY_UTXOS;
      if (available === settled) {
        result[AccountId(accountId)] = settled;
        continue;
      }
      const availableKeys = new Set(available.map(utxoKey));
      result[AccountId(accountId)] = settled.filter(utxo =>
        availableKeys.has(utxoKey(utxo)),
      );
    }

    return result;
  },
);

const EMPTY_ACCOUNT_UNSPENDABLE_UTXOS: AccountUnspendableUtxoMap = {};

/**
 * The reserved collateral a transaction can name now: settled, with no known
 * in-flight or confirmed spend. {@link selectAccountUnspendableUtxos} is the whole
 * reservation, which the collateral screens show and the collateral flow
 * keeps, and which can hold an output the flow reserved while its transaction
 * was still in flight.
 *
 * Holds only the accounts with a reservation. Returns an account's reserved
 * array itself when none of it is left out, and one shared empty map when
 * nothing is reserved.
 */
const selectSettledAccountUnspendableUtxos = createSelector(
  selectAccountUnspendableUtxos,
  selectAccountUtxos,
  selectUtxoAdjustmentEffectsByAccount,
  (
    accountUnspendableUtxos,
    accountUtxos,
    inFlightByAccount,
  ): AccountUnspendableUtxoMap => {
    const result: AccountUnspendableUtxoMap = {};
    let hasReservation = false;

    for (const [accountId, reserved] of Object.entries(
      accountUnspendableUtxos,
    )) {
      if (reserved.length === 0) continue;
      hasReservation = true;
      const settledKeys = new Set(
        (accountUtxos[AccountId(accountId)] ?? EMPTY_UTXOS).map(utxoKey),
      );
      const spentKeys = new Set(
        (
          inFlightByAccount[AccountId(accountId)] ?? EMPTY_IN_FLIGHT_EFFECTS
        ).flatMap(({ consumedInputs }) => consumedInputs.map(outpointKey)),
      );
      const nameable = reserved.filter(
        utxo => settledKeys.has(utxoKey(utxo)) && !spentKeys.has(utxoKey(utxo)),
      );
      result[AccountId(accountId)] =
        nameable.length === reserved.length ? reserved : nameable;
    }

    return hasReservation ? result : EMPTY_ACCOUNT_UNSPENDABLE_UTXOS;
  },
);

/**
 * Selector that gets the eligible collateral UTXO for a specific account
 * from its available (non-unspendable) UTXOs.
 * Uses selectAvailableAccountUtxos to get filtered UTXOs and returns
 * the first eligible collateral UTXO found.
 *
 * @param accountId - The account ID to get eligible collateral UTXO for
 * @returns The first eligible collateral UTXO found, or `undefined` if none found
 */
const selectAvailableAccountUtxosWithEligibleCollateral = createSelector(
  selectAvailableAccountUtxos,
  (_: unknown, accountId: AccountId) => accountId,
  (availableAccountUtxos, accountId): Cardano.Utxo | undefined => {
    const utxos = availableAccountUtxos[accountId] ?? [];
    return getEligibleCollateralUtxo(utxos);
  },
);

const selectCombinedTransactionHistory = createSelector(
  slice.selectors.selectTransactionHistoryGroupedByAccount,
  slice.selectors.selectRewardsHistoryGroupedByAccount,
  selectEraSummaries,
  (
    transactionHistory,
    rewardsHistory,
    eraSummaries,
  ): Record<AccountId, (CardanoTransactionHistoryItem | Reward)[]> => {
    if (!eraSummaries) return {};
    const combinedHistoryMap: Record<
      AccountId,
      (CardanoTransactionHistoryItem | Reward)[]
    > = {};
    Object.entries(transactionHistory).forEach(([accountId, history]) => {
      const rewardsTillLastHistoryItem = (
        rewardsHistory[AccountId(accountId)] ?? []
      ).filter(
        reward =>
          getRewardSpendableDate(reward.epoch, eraSummaries).getTime() >
          history[history.length - 1].blockTime,
      );
      combinedHistoryMap[AccountId(accountId)] = [
        ...history,
        ...rewardsTillLastHistoryItem,
      ].sort(
        (a, b) =>
          getHistoryItemTimestamp(b, eraSummaries) -
          getHistoryItemTimestamp(a, eraSummaries),
      );
    });
    return combinedHistoryMap;
  },
);

const selectStakingStatus = createSelector(
  selectRewardAccountDetails,
  tokensSelectors.tokens.selectVisibleAccountIds,
  selectHasEverSynced,
  (
    rewardAccountDetails,
    visibleAccountIds,
    hasEverSynced,
  ): {
    totalRewardsSum: BigNumber;
    totalStakedAmount: BigNumber;
    totalUnstakedAmount: BigNumber;
    stakingStatus: 'loading' | 'staked' | 'unstaked';
  } => {
    const loadingState = {
      totalRewardsSum: new BigNumber(0),
      totalStakedAmount: new BigNumber(0),
      totalUnstakedAmount: new BigNumber(0),
      stakingStatus: 'loading' as const,
    };

    const visibleAccountIdsSet = new Set(visibleAccountIds);
    const accountEntries = Object.entries(rewardAccountDetails);

    if (visibleAccountIds.length === 0) {
      return loadingState;
    }

    // No reward account details loaded for any account.
    // If sync has never completed, data is still being fetched → loading.
    // If sync has completed but no reward details exist, this is an empty
    // wallet with no on-chain activity → show staked view with all zeros.
    if (accountEntries.length === 0) {
      if (!hasEverSynced) {
        return loadingState;
      }
      return {
        totalRewardsSum: new BigNumber(0),
        totalStakedAmount: new BigNumber(0),
        totalUnstakedAmount: new BigNumber(0),
        stakingStatus: 'staked' as const,
      };
    }

    let totalRewardsSum = new BigNumber(0);
    let totalStakedAmount = new BigNumber(0);
    let totalUnstakedAmount = new BigNumber(0);
    let hasAnyActiveAccount = false;
    let hasAnyMatchingAccount = false;

    for (const [accountId, details] of accountEntries) {
      // Filter out accounts that are not visible (not on the current network)
      if (!visibleAccountIdsSet.has(AccountId(accountId))) {
        continue;
      }

      hasAnyMatchingAccount = true;
      const { rewardsSum, isActive, controlledAmount } =
        details.rewardAccountInfo;
      totalRewardsSum = totalRewardsSum.plus(rewardsSum);
      if (isActive) {
        hasAnyActiveAccount = true;
        totalStakedAmount = totalStakedAmount.plus(controlledAmount);
      } else {
        totalUnstakedAmount = totalUnstakedAmount.plus(controlledAmount);
      }
    }

    // If no accounts matched the current network, return loading state
    if (!hasAnyMatchingAccount) {
      return loadingState;
    }

    const stakingStatus =
      hasAnyActiveAccount || totalRewardsSum.gt(0) ? 'staked' : 'unstaked';

    return {
      totalRewardsSum,
      totalStakedAmount,
      totalUnstakedAmount,
      stakingStatus,
    };
  },
);

/** Why this account cannot safely begin a reset, or undefined when it can. */
const selectWalletSyncResetBlockedReason = markParameterizedSelector(
  createSelector(
    createSelector(
      walletsSelectors.wallets.selectActiveNetworkAccounts,
      (_state: unknown, accountId: AccountId) => accountId,
      (accounts, accountId) =>
        accounts.find(candidate => candidate.accountId === accountId),
    ),
    activitiesSelectors.activities.selectPendingActivitiesByAccount,
    syncSelectors.sync.selectSyncStatusByAccount,
    (account, pending, statuses) => {
      if (!account || !isCardanoAccount(account)) return 'unavailable';
      const { accountId } = account;
      if (pending[accountId]?.length) return 'pending-transactions';
      if (
        Object.values(statuses[accountId]?.pendingSync?.operations ?? {}).some(
          operation =>
            operation.status === 'Pending' || operation.status === 'InProgress',
        )
      )
        return 'syncing';
      return undefined;
    },
  ),
);

/**
 * True while thorough discovery or a wallet reset for this account is pending or running.
 * Automatic discovery does not drive the manual-sync overlay.
 */
const selectIsManualHdSyncInProgress = markParameterizedSelector(
  createSelector(
    syncSelectors.sync.selectSyncStatusByAccount,
    (_state: unknown, accountId: AccountId) => accountId,
    (syncStatusByAccount, accountId) => {
      const pending = syncStatusByAccount[accountId]?.pendingSync;
      if (!pending) return false;
      return Object.values(pending.operations).some(
        op =>
          (isThoroughAddressDiscoveryOperation(op.operationId) ||
            isWalletResetOperation(op.operationId)) &&
          (op.status === 'Pending' || op.status === 'InProgress'),
      );
    },
  ),
);

const selectWalletSyncResetOperation = markParameterizedSelector(
  createSelector(
    syncSelectors.sync.selectSyncStatusByAccount,
    (_state: unknown, accountId: AccountId) => accountId,
    (statuses, accountId) =>
      Object.values(statuses[accountId]?.pendingSync?.operations ?? {}).find(
        op => isWalletResetOperation(op.operationId),
      ),
  ),
);

/**
 * True while ANY address discovery (standard or thorough) is Pending or
 * InProgress for this account. Used to gate the manual HD sync CTA so the
 * user can't enqueue a thorough walk while a routine discovery is already
 * running against the same xpub.
 */
const selectIsAddressDiscoveryInProgress = markParameterizedSelector(
  createSelector(
    syncSelectors.sync.selectSyncStatusByAccount,
    (_state: unknown, accountId: AccountId) => accountId,
    (syncStatusByAccount, accountId) => {
      const pending = syncStatusByAccount[accountId]?.pendingSync;
      if (!pending) return false;
      return Object.values(pending.operations).some(
        op =>
          isAddressDiscoveryOperation(op.operationId) &&
          (op.status === 'Pending' || op.status === 'InProgress'),
      );
    },
  ),
);

/**
 * AccountId of any account that currently has a thorough discovery or wallet reset
 * operation in its `pendingSync` — irrespective of operation status.
 *
 * Returns the accountId while the op is Pending/InProgress (so the overlay
 * mounts) AND for the brief window after the op transitions to
 * Completed/Failed but before the sync round clears `pendingSync` (so the
 * mounted overlay's outcome-detection effect can fire its toast). Returns
 * undefined once the slice clears the op.
 *
 * Intentionally NOT scoped to the active account context: a user can trigger
 * manual HD sync from the settings page of any account (the URL params drive
 * which account the row is bound to), so the overlay must follow whichever
 * account is syncing, not the one currently selected as active.
 */
const selectAccountIdInManualHdSync = createSelector(
  syncSelectors.sync.selectSyncStatusByAccount,
  syncStatusByAccount => {
    for (const accountId in syncStatusByAccount) {
      const pending = syncStatusByAccount[accountId as AccountId]?.pendingSync;
      if (!pending) continue;
      const hasManualSync = Object.values(pending.operations).some(
        op =>
          isThoroughAddressDiscoveryOperation(op.operationId) ||
          isWalletResetOperation(op.operationId),
      );
      if (hasManualSync) return accountId as AccountId;
    }
    return undefined;
  },
);

/**
 * Terminal status of the most recently observed thorough address discovery
 * operation for this account, while it still lives in `pendingSync`.
 * Returns 'Completed' or 'Failed' for a brief window before the sync round
 * clears `pendingSync` entirely. Used by `HdSyncOverlay` to pick a toast.
 * Suppressed while a reset owns the round; reset results notify through a side effect.
 */
const selectManualHdSyncTerminalStatus = markParameterizedSelector(
  createSelector(
    syncSelectors.sync.selectSyncStatusByAccount,
    (_state: unknown, accountId: AccountId) => accountId,
    (syncStatusByAccount, accountId) => {
      const pending = syncStatusByAccount[accountId]?.pendingSync;
      if (!pending) return undefined;
      const reset = Object.values(pending.operations).find(op =>
        isWalletResetOperation(op.operationId),
      );
      if (reset) return undefined;
      for (const op of Object.values(pending.operations)) {
        if (!isThoroughAddressDiscoveryOperation(op.operationId)) continue;
        if (op.status === 'Completed' || op.status === 'Failed') {
          return op.status;
        }
      }
      return undefined;
    },
  ),
);

const selectActiveCardanoAccounts = createSelector(
  walletsSelectors.wallets.selectActiveNetworkAccounts,
  selectBlockchainNetworkId,
  (allAccounts, blockchainNetworkId) =>
    allAccounts.filter(
      (
        account,
      ): account is AnyAccount<
        CardanoBip32AccountProps,
        CardanoBip32AccountProps,
        CardanoMultiSigAccountProps,
        ExtensionAccountProps
      > => account.blockchainNetworkId === blockchainNetworkId,
    ),
);

/**
 * Whether any active-network account has a terminal Cardano sync failure
 * (a `CardanoSyncFailureId` present in the failures store).
 *
 * A failed first sync round clears `pendingSync` without a
 * `lastSuccessfulSync`, so a "has ever synced" gate alone would keep the
 * portfolio initial-load skeleton forever. This lets that gate exit on
 * terminal failure so the portfolio and its sync-error surface render.
 */
const selectActiveNetworkHasSyncFailure = createSelector(
  [
    walletsSelectors.wallets.selectActiveNetworkAccounts,
    failuresSelectors.failures.selectAllFailures,
  ],
  (accounts, failures): boolean =>
    accounts.some(
      account => !!failures[CardanoSyncFailureId(account.accountId)],
    ),
);

const getAccountFlaggedExploits = (
  activitiesByAccount: Record<AccountId, Activity[]>,
  accountId: AccountId,
): string[] => {
  const flagged = new Set<string>();
  for (const activity of activitiesByAccount[accountId] ?? []) {
    const exploits = (
      activity.blockchainSpecific as
        | BlockchainSpecificActivityMetadata
        | undefined
    )?.Cardano?.security?.exploits;
    if (!exploits) continue;
    for (const [exploitId, isFlagged] of Object.entries(exploits)) {
      if (isFlagged === true) flagged.add(exploitId);
    }
  }
  return [...flagged];
};

/** Stable empty fallback for exploit-id lists used as Reselect inputs/outputs. */
const EMPTY_EXPLOITS: string[] = [];

/**
 * Ids of security exploits (e.g. deterministicNonce202606) flagged on an account. Unions
 * the two detection paths: exploits found on mapped activities (the #2360
 * activity-time detector) and exploits recorded by the proactive re-scan.
 */
const selectAccountFlaggedExploits = markParameterizedSelector(
  createSelector(
    activitiesSelectors.activities.selectAllMap,
    slice.selectors.selectSecurityScanByAccount,
    (_state: unknown, accountId: AccountId) => accountId,
    (activitiesByAccount, scanByAccount, accountId) => [
      ...new Set([
        ...getAccountFlaggedExploits(activitiesByAccount, accountId),
        ...(scanByAccount[accountId]?.exploits ?? EMPTY_EXPLOITS),
      ]),
    ],
  ),
);

/** True when the account has any flagged security exploit (either path). */
const selectIsAccountCompromised = markParameterizedSelector(
  createSelector(
    activitiesSelectors.activities.selectAllMap,
    slice.selectors.selectSecurityScanByAccount,
    (_state: unknown, accountId: AccountId) => accountId,
    (activitiesByAccount, scanByAccount, accountId) =>
      new Set([
        ...getAccountFlaggedExploits(activitiesByAccount, accountId),
        ...(scanByAccount[accountId]?.exploits ?? EMPTY_EXPLOITS),
      ]).size > 0,
  ),
);

/**
 * Flagged exploit ids per account, sparse (only accounts with findings). Single
 * non-parameterized read for list contexts that render many account names and
 * cannot call a per-account hook in a loop. Merges activity-time findings with
 * proactive re-scan results.
 */
const selectFlaggedExploitsByAccount = createSelector(
  activitiesSelectors.activities.selectAllMap,
  slice.selectors.selectSecurityScanByAccount,
  (activitiesByAccount, scanByAccount): Record<AccountId, string[]> => {
    const result: Record<AccountId, string[]> = {};
    const accountIds = new Set<AccountId>([
      ...(Object.keys(activitiesByAccount) as AccountId[]),
      ...(Object.keys(scanByAccount) as AccountId[]),
    ]);
    for (const accountId of accountIds) {
      const flagged = [
        ...new Set([
          ...getAccountFlaggedExploits(activitiesByAccount, accountId),
          ...(scanByAccount[accountId]?.exploits ?? EMPTY_EXPLOITS),
        ]),
      ];
      if (flagged.length > 0) result[accountId] = flagged;
    }
    return result;
  },
);

/** Bundles the per-account security scan maps into one memoized input. */
const selectSecurityScanMaps = createSelector(
  slice.selectors.selectSecurityScanByAccount,
  slice.selectors.selectSecurityScanInProgress,
  slice.selectors.selectSecurityRescanDismissedByAccount,
  (scanByAccount, inProgressByAccount, dismissedByAccount) => ({
    scanByAccount,
    inProgressByAccount,
    dismissedByAccount,
  }),
);

/** Whether the account has been scanned, is scanning, or was dismissed. */
const selectSecurityScanState = markParameterizedSelector(
  createSelector(
    selectSecurityScanMaps,
    (_state: unknown, accountId: AccountId) => accountId,
    (maps, accountId) => ({
      scanned: maps.scanByAccount[accountId] !== undefined,
      scanning: maps.inProgressByAccount[accountId] === true,
      dismissed: maps.dismissedByAccount[accountId] === true,
    }),
  ),
);

const selectRescanContext = createSelector(
  selectSecurityScanMaps,
  slice.selectors.selectTransactionHistoryGroupedByAccount,
  syncSelectors.sync.selectSyncStatusByAccount,
  (maps, historyByAccount, syncStatusByAccount) => ({
    maps,
    historyByAccount,
    syncStatusByAccount,
  }),
);

/** Bundles the inputs the proactive re-scan decision depends on. */
const selectRescanInputs = createSelector(
  walletsSelectors.wallets.selectActiveNetworkAccounts,
  selectRescanContext,
  (accounts, context) => ({ accounts, ...context }),
);

/**
 * True when the account should be offered a proactive security re-scan: it has
 * completed a full sync (so its local history is not partial) AND has on-chain
 * transaction history (the exploit only manifests through a signed transaction,
 * so accounts with no history have nothing to scan) AND an exploit applies to
 * its blockchain AND it has not already been dedicated-scanned AND either its
 * onboarding date is unknown (persisted before the field existed → assume
 * pre-detection) or that exploit's detection shipped after the account was
 * onboarded (so activity-time detection never covered it). Accounts on a
 * blockchain no exploit targets are never offered, and an account the user has
 * dismissed is never offered again.
 */
const selectNeedsSecurityRescan = markParameterizedSelector(
  createSelector(
    selectRescanInputs,
    (_state: unknown, accountId: AccountId) => accountId,
    ({ accounts, maps, historyByAccount, syncStatusByAccount }, accountId) => {
      if (maps.dismissedByAccount[accountId] === true) return false;
      if (maps.scanByAccount[accountId] !== undefined) return false;
      if (syncStatusByAccount[accountId]?.lastSuccessfulSync === undefined) {
        return false;
      }
      const history = historyByAccount[accountId];
      if (history === undefined || history.length === 0) return false;
      const account = accounts.find(a => a.accountId === accountId);
      if (account === undefined) return false;
      const applicable = Object.values(EXPLOIT_DESCRIPTORS).filter(descriptor =>
        descriptor.blockchains.includes(account.blockchainName),
      );
      if (applicable.length === 0) return false;
      const onboardedAt = account.metadata.onboardedAt;
      if (onboardedAt === undefined) return true;
      return applicable.some(
        descriptor => descriptor.detectionAvailableSince > onboardedAt,
      );
    },
  ),
);

export const cardanoContextReducers = {
  [slice.name]: slice.reducer,
  ...collateralFlowReducers,
  ...composerFlowReducers,
  ...extensionReducers,
};

/** Direct import of this is an anti-pattern. OK for tests. */
export const cardanoContextActions = {
  cardanoContext: {
    ...slice.actions,
    loadTokenMetadata: createAction<{ tokenId: TokenId }>(
      'cardanoContext/loadTokenMetadata',
    ),
    loadAccountDelegationHistory: createAction<{
      accountId: AccountId;
      rewardAccount: CardanoRewardAccount;
    }>('cardanoContext/loadAccountDelegationHistory'),
    submitTx: createAction<{ serializedTx: HexBytes }>(
      'cardanoContext/submitTx',
    ),
    submitTxCompleted: createAction<{ txId: CardanoTxId }>(
      'cardanoContext/submitTxCompleted',
    ),
    submitTxFailed: createAction<{
      txId: CardanoTxId;
      error: string;
    }>('cardanoContext/submitTxFailed'),
  },
  ...collateralFlowActions,
  ...composerFlowActions,
  ...extensionActions,
};

/** Direct import of this is an anti-pattern. OK for tests. */
export const cardanoContextSelectors = {
  cardanoContext: {
    ...slice.selectors,
    selectActiveCardanoAccounts,
    selectTip,
    selectProtocolParameters,
    selectEraSummaries,
    selectAccountUtxos,
    selectAccountUtxosWithInFlight,
    selectCollateralOwnershipUtxos,
    selectAccountUnspendableUtxos,
    selectLastFetchedUtxoCacheKeyByAccount,
    selectRewardAccountDetails,
    selectRewardAccountDetailsWithInFlight,
    selectPendingRewardWithdrawals,
    selectInFlightTransactions,
    selectAvailableAccountUtxos,
    selectSettledAvailableAccountUtxos,
    selectSettledAccountUnspendableUtxos,
    selectAvailableAccountUtxosWithEligibleCollateral,
    selectCombinedTransactionHistory,
    selectStakingStatus,
    selectBlockchainNetworkId,
    selectChainId,
    selectDelegationActivities,
    selectRewardsHistoryForAccount,
    selectIsManualHdSyncInProgress,
    selectWalletSyncResetOperation,
    selectWalletSyncResetBlockedReason,
    selectIsAddressDiscoveryInProgress,
    selectManualHdSyncTerminalStatus,
    selectAccountIdInManualHdSync,
    selectIsAccountCompromised,
    selectAccountFlaggedExploits,
    selectFlaggedExploitsByAccount,
    selectSecurityScanState,
    selectNeedsSecurityRescan,
    selectActiveNetworkHasSyncFailure,
  },
  ...collateralFlowSelectors,
  ...composerFlowSelectors,
  ...extensionSelectors,
};

export type CardanoContextStoreState = StateFromReducersMapObject<
  typeof cardanoContextReducers
>;
