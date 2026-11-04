import type { ComponentType } from 'react';

import type { ActivityType } from './const';
import type { AnyAddress } from '@lace-contract/addresses';
import type { AppConfig, State } from '@lace-contract/module';
import type {
  MetadataByTokenId,
  StoredTokenMetadata,
  TokenId,
} from '@lace-contract/tokens';
import type { AccountId } from '@lace-contract/wallet-repo';
import type { BigNumber, Timestamp } from '@lace-lib/util';
import type { UICustomisation } from '@lace-lib/util-render';
import type { BlockchainName } from '@lace-lib/util-store';

type BlockchainSpecificPart<BlockchainSpecificMetadata = unknown> = {
  blockchainSpecific?: BlockchainSpecificMetadata;
};

/**
 * An entry in an account's transaction history: when it happened, its type,
 * and the token balance changes it made, with chain-specific metadata.
 */
export type Activity<BlockchainSpecificMetadata = unknown> =
  BlockchainSpecificPart<BlockchainSpecificMetadata> & {
    accountId: AccountId;
    activityId: string;
    timestamp: Timestamp;
    tokenBalanceChanges: Array<{ tokenId: TokenId; amount: BigNumber }>;
    type: ActivityType;
  };

/** An activity recording staking rewards received by the account. */
export type RewardActivity<BlockchainSpecificMetadata = unknown> = Omit<
  Activity<BlockchainSpecificMetadata>,
  'type'
> & {
  type: ActivityType.Rewards;
};

/** An activity with the fee it paid and the address it concerns, for its detail view. */
export type ActivityDetail<BlockchainSpecificMetadata = unknown> =
  Activity<BlockchainSpecificMetadata> & {
    /**
     * The fee in the chain's base unit, as a decimal string. An empty string
     * means the loader settled without a fee, so consumers must not show it
     * as a zero-cost transaction.
     */
    fee: string;
    /** The address the chain's loader picked; an empty string means none. */
    address: string;
  };

/**
 * States of an account's activities that change after the activities were
 * stored, such as funds still waiting at a script address. A list joins them
 * to the stored activities when it renders instead of rewriting them. Each
 * value is chain-specific: only code that knows the activity's chain reads it.
 */
export type ActivityStates = {
  /** The state of each affected activity, keyed by activity id. */
  byActivityId: Readonly<Partial<Record<string, unknown>>>;
  /**
   * Epoch milliseconds at which a state changes with the passage of time
   * alone, if any, so a list knows when to select the states again.
   */
  nextChangeAt?: number;
  /**
   * Whether rows may show tags derived from the chain-specific metadata
   * stored with the activities. Absent means no tags, so turning a feature
   * off also hides what was stored while it was on. The blockchain that owns
   * the metadata decides it; other blockchains may leave it unset.
   */
  isTaggingEnabled?: boolean;
};

export type ActivityDetailsSheetUICustomisation = UICustomisation<
  {
    ActivityDetailsContent: ComponentType<ActivityDetailsContentProps>;
  },
  { blockchainName: BlockchainName }
>;

/**
 * Props a blockchain passes to its activity detail content component: the
 * activity and its detail (`undefined` while loading), the block explorer
 * link, the account and address it concerns, and token metadata for display.
 */
export type ActivityDetailsContentProps = {
  activityDetail: ActivityDetail | undefined;
  activityId: string;
  explorerUrl: string;
  address: AnyAddress | undefined;
  accountId: AccountId;
  getMainTokenBalanceChange?: GetActivityTokenBalanceChange;
  tokensMetadataByTokenId: MetadataByTokenId;
  /** The activity's entry of the blockchain's `ActivityStates`, if any. */
  activityState?: unknown;
};

export type ActivitiesListUICustomisation = UICustomisation<{
  ActivitiesList: ComponentType<{
    items: Activity[];
    tokensMetadataByTokenId: MetadataByTokenId;
  }>;
}>;

/**
 * The data required to represent a token balance change in a transaction bundle
 */
export type ActivityTokenBalanceChange = {
  tokenId: TokenId;
  token: StoredTokenMetadata | undefined;
  amount: BigNumber;
};

/**
 * A display-ready summary of an activity's token balance changes: a title of
 * formatted amount and label (for example a ticker or "NFTs"), and an
 * optional subtitle.
 */
export type TokensInfoSummary = {
  title: {
    amount: string;
    label: string;
  };
  subtitle?: string;
};

/**
 * Picks the balance change to show as an activity's headline amount from all
 * its token balance changes, or returns `undefined` when there is none.
 */
export type GetActivityTokenBalanceChange = (
  tokenBalanceChanges: Array<ActivityTokenBalanceChange>,
) => ActivityTokenBalanceChange | undefined;

/**
 * Summarises an activity's token balance changes for the activity list, using
 * the given translated labels for NFTs, tokens, mixed assets and unknown tokens.
 */
export type GetActivityTokensInfoSummary = (
  tokenBalanceChanges: Array<ActivityTokenBalanceChange>,
  translations: {
    nfts: string;
    tokens: string;
    mixed: string;
    unknownToken: string;
  },
) => TokensInfoSummary;

export type ActivitiesItemUICustomisation<AddressData = unknown> =
  UICustomisation<
    {
      getExplorerUrl: (params: {
        config?: AppConfig;
        address: AnyAddress<AddressData>;
        activityId: Activity['activityId'];
      }) => string;
      /**
       * Some blockchains allow for transaction bundles including various tokens.
       * Returns the "main" token balance change that should be displayed in the
       * activity history (e.g: ADA for Cardano).
       */
      getMainTokenBalanceChange?: GetActivityTokenBalanceChange;
      /**
       * Some blockchains allow for transaction bundles including various tokens.
       * Returns the tokens info summary that should be displayed in the
       * activity history (e.g: NFTs for Cardano).
       */
      getTokensInfoSummary?: GetActivityTokensInfoSummary;

      /**
       * Some blockchains track activity states that change after the activity
       * was stored (e.g: a Cardano Hydra deposit waiting to enter its head).
       * Selects those states of the account's activities as of `now`, in
       * epoch milliseconds, and whether rows may show tags from the
       * activities' stored metadata. Returns the same object for the same
       * account and time until the data it reads changes, even when other
       * callers select other times in between.
       */
      selectActivityStates?: (
        state: State,
        accountId: AccountId,
        now: number,
      ) => ActivityStates;

      /**
       * Some blockchains require a specific action when an activity is clicked
       * (e.g: navigate to transaction explorer)
       */
      onActivityClick?: (params: {
        config?: AppConfig;
        address: AnyAddress<AddressData>;
        activityId: Activity['activityId'];
      }) => void;
    },
    {
      blockchainName: BlockchainName;
    }
  >;

export type ActivityOfTokenUICustomisation = UICustomisation<{
  activityPagePath: string;
}>;
