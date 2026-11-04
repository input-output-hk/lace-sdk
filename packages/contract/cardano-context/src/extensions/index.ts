// How the custody account, cNIGHT designation and Hydra Head features hook
// into the Cardano context: the account kind, the activity mapping and the
// store. The stable SDK build resolves index.stable.ts instead, which hooks
// none of them, so the stable SDK carries no feature's state, code or types.
// Keep the two files' exports in step, apart from the names the variant
// declares on stable-omits lines; the SDK's stable variant parity check
// enforces it.
import { ActivityType } from '@lace-contract/activities';

import { isCardanoCustodyAccount } from '../custody/account';
import { isCardanoCustodyAccountTokenOf } from '../custody/account-token';
import { FEATURE_FLAG_HYDRA_HEADS } from '../hydra-heads-feature-flag';
import { FEATURE_FLAG_CNIGHT_DESIGNATION } from '../night-designation-feature-flag';
import { classifyTxAsHydra } from '../store/helpers/hydra-activity';
import { classifyTxAsNightDesignation } from '../store/helpers/night-designation-script-addresses';
import {
  hydraHeadsIndexActions,
  hydraHeadsIndexReducers,
  hydraHeadsIndexSelectors,
} from '../store/hydra-heads-index';
import {
  nightDesignationFlowActions,
  nightDesignationFlowReducers,
  nightDesignationFlowSelectors,
} from '../store/night-designation-flow';
import {
  nightDesignationIndexActions,
  nightDesignationIndexReducers,
  nightDesignationIndexSelectors,
} from '../store/night-designation-index';

import { selectCustodyAccountIds } from './custody-account-ids';
import { isOwnCustodyAccountToken } from './custody-account-tokens-of-addresses';

import type {
  CardanoHydraActivityMetadata,
  CardanoNightDesignationActivityMetadata,
} from '../augmentations';
import type { CardanoCustodyActivityMetadata } from '../custody/pending-operation';
import type { CardanoCustodyAccountProps, ExtensionActivityTx } from '../types';
import type { CardanoWalletAccount } from '../util';
import type { FeatureFlag } from '@lace-contract/feature';
import type { LacePersistConfigMap } from '@lace-contract/module';

/** The account data of the account kinds the features add: custody accounts. */
export type ExtensionAccountProps = CardanoCustodyAccountProps;

/** The Cardano activity metadata the features add. */
export type ActivityExtensionMetadata = {
  nightDesignation?: CardanoNightDesignationActivityMetadata;
  custody?: CardanoCustodyActivityMetadata;
  hydra?: CardanoHydraActivityMetadata;
};

/**
 * The Cardano transaction details the features add. Like the activity
 * metadata it is a hint that anyone can produce by shaping a transaction, so
 * it describes the transaction and never proves anything about it.
 */
export type TransactionExtensionMetadata = Pick<
  ActivityExtensionMetadata,
  'hydra'
>;

/** What a feature's operation adds to the pending activity it derives. */
export type PendingActivityExtensionProps = {
  /** Set for a custody operation, so a stale activity can be dropped. */
  custody?: CardanoCustodyActivityMetadata;
};

/** The activity metadata a pending activity carries for its feature. */
export const pendingActivityExtensionMetadata = ({
  custody,
}: PendingActivityExtensionProps): ActivityExtensionMetadata =>
  custody ? { custody } : {};

/**
 * A test for the account tokens of the custody accounts among the addresses:
 * tokens that only mark an account's own UTxOs and are no holding.
 */
export const isOwnAccountToken = isOwnCustodyAccountToken;

/** A test for the account tokens of the account that owns `rewardAccount`. */
export const isAccountTokenOf = isCardanoCustodyAccountTokenOf;

/** Which of the activity classifications the features add are turned on. */
export type EnabledExtensionActivities = {
  nightDesignation: boolean;
  hydra: boolean;
};

/**
 * Which activity classifications apply: each while its feature flag is on,
 * so the cNIGHT designation and Hydra Head features gate independently.
 */
export const getEnabledExtensionActivities = (
  featureFlags: readonly FeatureFlag[],
): EnabledExtensionActivities => ({
  nightDesignation: featureFlags.some(
    flag => flag.key === FEATURE_FLAG_CNIGHT_DESIGNATION,
  ),
  hydra: featureFlags.some(flag => flag.key === FEATURE_FLAG_HYDRA_HEADS),
});

/** The cNIGHT designation activity of the transaction, if it is one. */
const classifyNightDesignation = ({
  body,
}: Pick<ExtensionActivityTx, 'body'>):
  | { type: ActivityType; metadata: ActivityExtensionMetadata }
  | undefined => {
  const nightDesignation = classifyTxAsNightDesignation(
    body.inputs,
    body.outputs,
    body.mint,
  );
  return nightDesignation
    ? {
        type: ActivityType.NightDesignation,
        metadata: { nightDesignation: { action: nightDesignation.action } },
      }
    : undefined;
};

/**
 * The type and metadata of an activity the enabled features classify from
 * the transaction: a cNIGHT designation, matched by its script addresses,
 * which sets the type, and a Hydra Head step, which keeps the Send or Receive
 * type and adds its Hydra metadata. Undefined when no enabled feature
 * recognises the transaction.
 */
export const classifyExtensionActivity = (
  tx: ExtensionActivityTx,
  enabled: EnabledExtensionActivities,
): { type?: ActivityType; metadata: ActivityExtensionMetadata } | undefined => {
  const nightDesignation = enabled.nightDesignation
    ? classifyNightDesignation(tx)
    : undefined;
  const hydra = enabled.hydra ? classifyTxAsHydra(tx) : undefined;
  if (!hydra) return nightDesignation;
  return {
    type: nightDesignation?.type,
    metadata: { ...nightDesignation?.metadata, hydra },
  };
};

/**
 * The details metadata the features add to a transaction, from the same
 * classification the activity list uses and gated by the same feature flags.
 * Empty when no feature is on or the transaction is none of their steps.
 */
export const classifyExtensionTransaction = (
  tx: ExtensionActivityTx,
  enabled: EnabledExtensionActivities,
): TransactionExtensionMetadata => {
  const hydra = enabled.hydra ? classifyTxAsHydra(tx) : undefined;
  return hydra ? { hydra } : {};
};

/** The reducers the features add to the store. */
export const extensionReducers = {
  ...nightDesignationFlowReducers,
  ...nightDesignationIndexReducers,
  ...hydraHeadsIndexReducers,
};

/**
 * The persist configurations of the slices the features add. Of the Hydra
 * Head index only the deposited head ids are kept, which the next sweep
 * checks against the live heads before listing anything, and the accounts
 * whose activities were loaded with Hydra tags, so they are reloaded once
 * rather than on every start.
 */
export const extensionPersistConfig: LacePersistConfigMap = {
  hydraHeadsIndex: {
    version: 1,
    whitelist: ['depositedHeadIdsByAccount', 'activitiesTaggedByAccount'],
  },
};

/** The action creators the features add to the store, by scope. */
export const extensionActions = {
  ...nightDesignationFlowActions,
  ...nightDesignationIndexActions,
  ...hydraHeadsIndexActions,
};

/** The selectors the features add to the store, by scope. */
export const extensionSelectors = {
  ...nightDesignationFlowSelectors,
  ...nightDesignationIndexSelectors,
  ...hydraHeadsIndexSelectors,
};

/**
 * The ids of the accounts whose UTxOs only their own builders may spend:
 * custody accounts, whose UTxOs the custody script locks.
 */
export const selectAccountIdsExcludedFromSpending = selectCustodyAccountIds;

/**
 * Whether a feature's own store tracks the account's tokens: a custody
 * account's, which the custody store derives from its account state.
 */
export const isExtensionTokenAccount = (
  account: CardanoWalletAccount,
): boolean => isCardanoCustodyAccount(account);
