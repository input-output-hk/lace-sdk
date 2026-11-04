import type { Cardano } from '@cardano-sdk/core';
import type { AccountId } from '@lace-contract/wallet-repo';
import type {
  HydraDepositStatus,
  HydraHeadStateName,
  HydraProtocolVersion,
} from '@lace-lib/hydra-head';
import type { BigNumber } from '@lace-lib/util';

/**
 * Lovelace and native assets held at a Hydra validator, with every quantity
 * kept as a decimal string so the read model stays plain JSON.
 */
export type HydraHeadsIndexValue = {
  coins: BigNumber;
  /** Quantities keyed by asset id: hex policy id followed by hex asset name. */
  assets: Partial<Record<Cardano.AssetId, BigNumber>>;
};

/** Reference to the UTxO a deposit or head sits in. */
export type HydraHeadsIndexOutRef = {
  /** Hex transaction id. */
  txId: string;
  index: number;
};

/**
 * A deposit at a Hydra deposit validator that commits outputs paid to the
 * account's payment keys.
 */
export type HydraHeadsIndexDeposit = {
  outpoint: HydraHeadsIndexOutRef;
  /** Hex policy id of the head state token of the target head. */
  headId: string;
  /**
   * ISO 8601 instant up to and including which the head may absorb the
   * deposit. Recover is possible only strictly after it.
   */
  deadline: string;
  /** Sum of the committed outputs paid to the account's keys. */
  value: HydraHeadsIndexValue;
  /** Status at the time of the sweep that found the deposit. */
  status: HydraDepositStatus;
};

/**
 * The UTxO of a genuine head in which the account holds a participation
 * token, or into which the account deposited without holding one.
 */
export type HydraHeadsIndexHead = {
  /** Hex policy id of the head state token. */
  headId: string;
  /** Hydra release whose head validator holds the UTxO. */
  version: HydraProtocolVersion;
  outpoint: HydraHeadsIndexOutRef;
  state: HydraHeadStateName;
  /**
   * ISO 8601 end of the contestation period, set for closed heads and heads
   * being fanned out.
   */
  contestationDeadline?: string;
  /** Everything the head UTxO holds, including the head tokens. */
  headValue: HydraHeadsIndexValue;
  /** Number of participation tokens on the head UTxO. */
  participantCount: number;
  /**
   * True when the account holds a participation token. A head the account
   * only deposited into is listed once its history shows the head absorbed
   * a deposit for the account.
   */
  isParticipant: boolean;
  /** True when every participation token belongs to the account. */
  isSoleParticipant: boolean;
  /**
   * Deposits and commits the head absorbed from the account's keys, read
   * from the head's history. Absent, together with `withdrawnValue`, when
   * the history could not be read or explained, rather than a wrong figure.
   */
  depositedValue?: HydraHeadsIndexValue;
  /**
   * Decommits and partial fanouts the head paid to the account's keys while
   * it kept running. Kept apart from `depositedValue`, since the account's
   * current share inside the head is not visible on layer 1.
   */
  withdrawnValue?: HydraHeadsIndexValue;
};

/** A UTxO spent or produced by a transaction of a head's history. */
export type HydraHeadsIndexUtxo = HydraHeadsIndexOutRef & {
  /** Bech32 address. */
  address: string;
  value: HydraHeadsIndexValue;
  /** CBOR hex of the inline datum, absent when the output has none. */
  inlineDatum?: string;
};

/**
 * A transaction that moved a head's state token, with the script inputs it
 * spent resolved. Inputs locked by a payment key only pay fees and are left
 * out.
 */
export type HydraHeadsIndexHistoryTx = {
  /** Hex transaction id. */
  txId: string;
  inputs: HydraHeadsIndexUtxo[];
  outputs: HydraHeadsIndexUtxo[];
};

/** What the last successful sweep found for one account. */
export type HydraHeadsSnapshot = {
  deposits: HydraHeadsIndexDeposit[];
  heads: HydraHeadsIndexHead[];
  /** ISO 8601 instant of the sweep. */
  lastSyncedAt: string;
  /**
   * The validator addresses the sweep could not read, with nothing to stand
   * in for them. The deposits and heads there are unknown rather than gone,
   * so the snapshot keeps the ones it held. Absent for a complete sweep.
   */
  unreadAddresses?: string[];
};

/** The index entry of one account. */
export type HydraHeadsIndexEntry = {
  /** The last completed sweep; absent until the first one succeeds. */
  snapshot?: HydraHeadsSnapshot;
  /** Set when the last sweep failed; cleared by the next success. */
  failed: boolean;
};

/**
 * The Hydra deposits and heads of each account, read from the Hydra deposit
 * and head validator addresses rather than from the account's own UTxOs, which
 * exclude every script address.
 *
 * Values here are locked in Hydra and never count towards an account balance.
 * Anyone can pay to a validator address with a lookalike token and datum, so
 * a head is listed only once the init of its history proves it genuine. A
 * deposit is strong evidence of Hydra activity rather than proof of one. The
 * index is transient and not persisted, apart from the deposited head ids and
 * the accounts whose activities carry the Hydra Head tags: a snapshot restored
 * from disk could not tell how far behind the chain it is.
 */
export type HydraHeadsIndexSliceState = {
  /**
   * Keyed by account, which is network-specific (ADR 11), so an entry never
   * describes another network.
   */
  byAccount: Partial<Record<AccountId, HydraHeadsIndexEntry>>;
  /**
   * The history read so far of each genuine head some account participates
   * in or names in its own deposit activities, oldest first, keyed by head
   * id. History on chain does not change, so a later sweep only reads the
   * transactions after the last one kept here.
   */
  historyByHeadId: Partial<Record<string, HydraHeadsIndexHistoryTx[]>>;
  /**
   * Whether each head some account found is genuine, keyed by head id: true
   * when the init of its history was minted by the Hydra head minting script
   * of the head id, false for a lookalike. A head without an entry has not
   * been checked yet. A verdict never changes, so a later sweep checks only
   * the heads without one.
   */
  genuineByHeadId: Partial<Record<string, boolean>>;
  /**
   * The ids of the heads each account deposited into without holding a
   * participation token, as the last sweep found them: live, and with a
   * history that attributes a deposit to the account or could not be read.
   * Persisted, so a head stays found after a restart once the deposit that
   * named it has left the loaded activities. Each id is only a hint that the
   * next sweep checks against the live heads like any other candidate.
   */
  depositedHeadIdsByAccount: Partial<Record<AccountId, string[]>>;
  /**
   * True for each account whose loaded activities carry the Hydra Head tags,
   * since they were loaded while the Hydra Head feature flag was on.
   * Activities loaded while it was off carry none, so the deposits they
   * record name no head. Persisted, so they are loaded again only once.
   */
  activitiesTaggedByAccount: Partial<Record<AccountId, boolean>>;
};
