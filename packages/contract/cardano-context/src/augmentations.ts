import type { ActivityExtensionMetadata } from './extensions';
import type { cardanoContextReducers } from './store/slice';
import type {
  CardanoInMemorySigningDependencies,
  CardanoProviderDependencies,
  CardanoProviderConfig,
  CardanoSpecificInMemoryWalletData,
  CardanoSideEffectsDependencies,
  MakeBuildDelegationTx,
  MakeBuildDeregistrationTx,
  MakeBuildVoteDelegationTx,
  MakeBuildEarnRewardsTx,
} from './types';
import type { Cardano } from '@cardano-sdk/core';
import type { DynamicallyLoadedInit } from '@lace-contract/module';
import type {
  HydraDepositStatus,
  HydraTxClassification,
  HydraTxProtocol,
} from '@lace-lib/hydra-head';
import type { StateFromReducersMapObject } from '@reduxjs/toolkit';

type CardanoDependencies = CardanoInMemorySigningDependencies &
  CardanoProviderDependencies &
  CardanoSideEffectsDependencies;

export type CardanoActivitySecurityMetadata = {
  exploits?: {
    /**
     * SecondFi/Yoroi June 2026 wallet compromise — Ed25519 private-key
     * disclosure via deterministic public nonce. See
     * src/security/exploits/deterministicNonce202606/.
     */
    deterministicNonce202606?: boolean;
  };
};

/**
 * UTxO-shaped metadata carried on a Cardano activity. Some fields are
 * populated on PENDING activities only and some on CONFIRMED ones only —
 * each field's doc says which. (Named for the data, not a lifecycle stage:
 * `slot`, `security` and the confirmed outpoints below are not in-flight
 * information.)
 */
export type CardanoActivityUtxoMetadata = {
  /**
   * Every outpoint the transaction spent, NOT only the ones this account owned:
   * on a confirmed activity these come straight off the tx body, with no
   * ownership resolution. Consumers that need "ours" intersect this with the
   * account's own UTxO set, which filters it for free — see
   * `canTrustFetchAsSettled` in cardano-sync, which reads an overlap as proof a
   * provider has not yet applied the transaction.
   *
   * Empty means UNKNOWN, never "spent nothing": activities persisted before
   * confirmed transactions carried this, and Pending activities derived without
   * a resolvable body, both leave it empty. Treat an empty list as no
   * information rather than as evidence.
   */
  consumedInputs: Cardano.TxIn[];
  /** Every output of the signed tx, unfiltered — populated on PENDING
   * activities only; consumers intersect with own addresses at read (see
   * `applyInFlightUtxoAdjustments`). */
  producedOutputs: Cardano.Utxo[];
  /**
   * Every reward withdrawal of the signed tx, unfiltered — PENDING activities
   * only, so the rewards it moves into `producedOutputs` are not also counted
   * as still withdrawable (see `pendingRewardWithdrawals`). Absent means no
   * withdrawal, or an activity persisted before this field existed.
   */
  withdrawals?: Cardano.Withdrawal[];
  /**
   * Outpoints of the confirmed tx's outputs paying addresses the account
   * owned at map time. Outpoints, not full outputs: the one consumer
   * (cardano-sync's missing-output staleness proof) tests membership only,
   * and a dApp batch's datum-carrying outputs are storage it never reads.
   * Empty carries no evidence — legacy activity, or nothing paid to us.
   */
  producedOwnOutpoints?: Cardano.TxIn[];
  /**
   * Slot of the block that included the on-chain tx behind this activity.
   * Absent on Pending activities and on activities persisted before this
   * field was introduced.
   */
  slot?: Cardano.Slot;
  security?: CardanoActivitySecurityMetadata;
};

/**
 * Extra metadata for activities classified as
 * `ActivityType.NightDesignation`. Surfaced on both pending and
 * confirmed activities so the UI can render the operation variant
 * (designate / update / deregister) and the target dust pubkey
 * without re-parsing the tx CBOR.
 *
 * `dustPubkeyHex` is the hex of the variable-length (≤33-byte)
 * dust-address payload when the action is `designate` or
 * `update` (the bytes written into the new
 * `DustMappingDatum`). Absent for `deregister` — there's no new
 * datum, the existing one is burned with the NFT.
 */
export type CardanoNightDesignationActivityMetadata = {
  action: 'deregister' | 'designate' | 'update';
  dustPubkeyHex?: string;
};

/**
 * What a Cardano activity carries when its transaction is a Hydra Head layer 1
 * step: a deposit into a head, a recover, an increment, a fanout or another
 * head transaction. The activity keeps its Send or Receive type; this only
 * labels it.
 */
export type CardanoHydraActivityMetadata = {
  /**
   * The Hydra protocol generation from the transaction's Hydra marker. Absent
   * when the transaction carries no marker and was recognised by its script
   * addresses alone.
   */
  protocol?: HydraTxProtocol;
  /**
   * The Hydra transaction name, for example `DepositTx`, inferred from the
   * script addresses the transaction spends and pays. `HeadTx` is a head step
   * the addresses could not tell apart and the marker did not name.
   */
  txName: HydraTxClassification;
  /** Hex policy id of the head state token, when the transaction reveals it. */
  headId?: string;
  /**
   * ISO 8601 instant up to and including which the head may absorb the
   * deposit; set on deposits only. A string so the activity stays
   * serializable.
   */
  depositDeadline?: string;
};

/**
 * The live state of a Cardano activity whose transaction created a Hydra
 * deposit that still sits at the deposit validator. It comes from the indexed
 * deposit UTxO and the current time and is never stored on the activity: once
 * the head absorbs the deposit or its owner recovers it, the activity has no
 * state.
 */
export type CardanoHydraDepositActivityState = {
  /** Whether the head may still absorb the deposit or it can only be recovered. */
  status: HydraDepositStatus;
  /**
   * ISO 8601 instant up to and including which the head may absorb the
   * deposit, read from the indexed deposit datum.
   */
  deadline: string;
};

export type CardanoActivityBlockchainSpecific = ActivityExtensionMetadata &
  CardanoActivityUtxoMetadata;

declare module '@lace-contract/activities' {
  interface BlockchainSpecificActivityMetadata {
    Cardano?: CardanoActivityBlockchainSpecific;
  }
}

declare module '@lace-contract/module' {
  interface AppConfig {
    defaultTestnetChainId: Cardano.ChainId;
    cardanoProvider: CardanoProviderConfig;
  }

  interface State
    extends StateFromReducersMapObject<typeof cardanoContextReducers> {}

  interface SideEffectDependencies extends CardanoDependencies {}

  interface LaceAddons {
    readonly loadDelegationTxBuilder: DynamicallyLoadedInit<MakeBuildDelegationTx>;
    readonly loadDeregistrationTxBuilder: DynamicallyLoadedInit<MakeBuildDeregistrationTx>;
    readonly loadVoteDelegationTxBuilder: DynamicallyLoadedInit<MakeBuildVoteDelegationTx>;
    readonly loadEarnRewardsTxBuilder: DynamicallyLoadedInit<MakeBuildEarnRewardsTx>;
  }
}

declare module '@lace-contract/wallet-repo' {
  interface BlockchainSpecificInMemoryWalletData {
    Cardano?: CardanoSpecificInMemoryWalletData;
  }
}
