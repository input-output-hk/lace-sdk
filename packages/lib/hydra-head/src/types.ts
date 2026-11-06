import type { Cardano } from '@lace-lib/cardano-core';

/**
 * Hydra node release whose on-chain validators a registry entry describes,
 * for example `2.3.0`.
 */
export type HydraProtocolVersion = string;

/**
 * How the seed output reference is applied to the head minting script of a
 * release: as two constants, or as the fields of a constructor.
 */
export type HydraSeedEncoding = 'constants' | 'constrFields';

/**
 * Template of a release's head minting script. Every head of the release is
 * minted by the same script applied to the output reference its init spends,
 * so the script is a fixed prefix, the seed transaction id and a short tail
 * encoding the seed output index.
 */
export interface HydraHeadMintingScriptTemplate {
  /** Plutus language the script is written in. */
  readonly language:
    | Cardano.PlutusLanguageVersion.V2
    | Cardano.PlutusLanguageVersion.V3;
  /** Length in bytes of the script code before the seed transaction id. */
  readonly prefixLength: number;
  /** Hex blake2b-256 digest of that prefix. */
  readonly prefixDigest: string;
  readonly seedEncoding: HydraSeedEncoding;
}

/** Validator addresses of one Hydra protocol version on one network family. */
export interface HydraScriptRegistryEntry {
  /** Hydra node release these validators belong to. */
  readonly version: HydraProtocolVersion;
  /** Address holding head UTxOs, which carry the head state token. */
  readonly headAddress: string;
  /** Address holding pending deposits. Absent before version 0.20.0. */
  readonly depositAddress?: string;
  /** Script whose policy id is the id of every head of the release. */
  readonly headMintingScript: HydraHeadMintingScriptTemplate;
}

/** Transaction names a Hydra node is known to submit to the base layer. */
export type HydraTxName =
  | 'AbortTx'
  | 'CloseTx'
  | 'CollectComTx'
  | 'CommitTx'
  | 'ContestTx'
  | 'DecrementTx'
  | 'DepositTx'
  | 'FanoutTx'
  | 'FinalPartialFanoutTx'
  | 'IncrementTx'
  | 'InitTx'
  | 'PartialFanoutTx'
  | 'RecoverTx';

/** Metadata prefix a Hydra node puts in front of the transaction name. */
export type HydraTxProtocol = 'HydraV1' | 'HydraV2';

/**
 * Hydra marker read from transaction metadata. Names this library does not
 * know are preserved as plain strings.
 */
export interface HydraTxTag {
  readonly protocol: HydraTxProtocol;
  readonly txName: HydraTxName | (string & {});
}

/**
 * Hydra action read from where a transaction's inputs and outputs sit.
 * `HeadTx` means the transaction spends a head UTxO but its step could not be
 * told apart because a head datum was missing or undecodable.
 */
export type HydraTxClassification = HydraTxName | 'HeadTx';

/** Generation of the head validator, which fixes the name of the head state token. */
export type HydraHeadGeneration = 'v1' | 'v2';

/** Reference to a transaction output. */
export interface HydraOutRef {
  /** Hex transaction id. */
  readonly txId: string;
  readonly index: number;
}

/** Lovelace and native assets held by an output. */
export interface HydraValue {
  readonly coins: bigint;
  /** Quantities keyed by asset unit: hex policy id followed by hex asset name. */
  readonly assets: ReadonlyMap<string, bigint>;
}

/**
 * Minimal UTxO shape the matchers read. Build it with `fromCardanoUtxo` or
 * `fromBlockfrostUtxo`.
 */
export interface HydraUtxo extends HydraOutRef {
  /** Bech32 address. */
  readonly address: string;
  readonly value: HydraValue;
  /** CBOR hex of the inline datum, absent when the output has none. */
  readonly inlineDatum?: string;
}

/** UTxO as returned by the Blockfrost API, reduced to the fields read here. */
export interface HydraBlockfrostUtxo {
  readonly tx_hash: string;
  readonly output_index: number;
  readonly address: string;
  readonly amount: readonly {
    readonly unit: string;
    readonly quantity: string;
  }[];
  readonly inline_datum?: string | null;
}

/**
 * Transaction input or output as seen by `classifyHydraTxByAddresses`.
 * Inputs are resolved to the output they spend.
 */
export interface HydraTxEndpoint {
  /** Bech32 address. */
  readonly address: string;
  /** CBOR hex of the inline datum, absent when the output has none. */
  readonly inlineDatum?: string;
}

/** Output a deposit commits to a head, recovered from the deposit datum. */
export interface HydraCommittedOutput {
  /** Layer 1 output the deposit transaction spent to create this commit. */
  readonly input: HydraOutRef;
  /** Bech32 address the output is restored to on recover or fanout. */
  readonly address: string;
  /**
   * Hex payment key hash of the address, absent when the payment part is a
   * script.
   */
  readonly paymentKeyHash?: string;
  readonly value: HydraValue;
}

/** Decoded inline datum of a deposit UTxO. */
export interface HydraDepositDatum {
  /** Hex policy id of the head state token of the target head. */
  readonly headId: string;
  /**
   * Last instant the head may absorb the deposit, in epoch milliseconds.
   * Recover is possible only strictly after it.
   */
  readonly deadline: number;
  readonly committed: readonly HydraCommittedOutput[];
}

/** Decoded inline datum of a commit UTxO, used by releases up to 1.3.0. */
export interface HydraCommitDatum {
  /** Hex policy id of the head state token of the target head. */
  readonly headId: string;
  readonly committed: readonly HydraCommittedOutput[];
}

/**
 * Transaction of a head's history: one that moves the head state token.
 * Build its UTxOs with `fromCardanoUtxo` or `fromBlockfrostUtxo`.
 */
export interface HydraHeadHistoryTx {
  /** Hex transaction id. */
  readonly txId: string;
  /**
   * Spent inputs, resolved to the outputs they consume. Leave out collateral
   * and reference inputs. Inputs locked by a payment key may be left out too,
   * since they only pay fees.
   */
  readonly inputs: readonly HydraUtxo[];
  /** Outputs in transaction order. */
  readonly outputs: readonly HydraUtxo[];
}

/**
 * What a head absorbed that was committed to an account's keys, and what it
 * paid back to them while it kept running. Kept apart rather than netted,
 * since the account's current share inside the head is not visible on
 * layer 1.
 */
export interface HydraHeadFunds {
  /** Deposits and commits the head absorbed, committed to the account's keys. */
  readonly deposited: HydraValue;
  /** Decommits and partial fanouts the head paid to the account's keys. */
  readonly withdrawn: HydraValue;
}

/**
 * Whether a deposit can still be absorbed by its head (`pending`) or only
 * returned to its owner (`recoverable`).
 */
export type HydraDepositStatus = 'pending' | 'recoverable';

/** Deposit UTxO that commits outputs to an account's keys. */
export interface HydraAccountDeposit {
  readonly outpoint: HydraOutRef;
  readonly headId: string;
  /** Last instant the head may absorb the deposit, in epoch milliseconds. */
  readonly deadline: number;
  /**
   * Sum of the committed outputs paid to the account's keys. Only deposits
   * whose committed outputs add up exactly to the value of the deposit UTxO
   * are reported, so this never exceeds what the UTxO holds.
   */
  readonly value: HydraValue;
  readonly status: HydraDepositStatus;
}

/**
 * Head state machine state. `initial` exists only in the first generation,
 * where heads are opened by a collect step. `fanningOut` is a second
 * generation head distributing its funds over several transactions.
 */
export type HydraHeadStateName =
  | 'closed'
  | 'fanningOut'
  | 'final'
  | 'initial'
  | 'open';

/** Decoded inline datum of a head UTxO. */
export interface HydraHeadState {
  readonly state: HydraHeadStateName;
  /**
   * End of the contestation period in epoch milliseconds, present for
   * `closed` and `fanningOut`. Fanout is possible only after it.
   */
  readonly contestationDeadline?: number;
}

/**
 * Head UTxO as seen by an account, which may or may not hold a participation
 * token in it.
 */
export interface HydraAccountHead extends HydraHeadState {
  /** Hex policy id of the head state token. */
  readonly headId: string;
  /** Hydra release whose head validator holds the UTxO. */
  readonly version: HydraProtocolVersion;
  readonly outpoint: HydraOutRef;
  /** Everything the head UTxO holds, including the head tokens. */
  readonly headValue: HydraValue;
  /** Number of participation tokens on the head UTxO. */
  readonly participantCount: number;
  /** True when the account holds at least one participation token. */
  readonly isParticipant: boolean;
  /** True when every participation token belongs to the account. */
  readonly isSoleParticipant: boolean;
}

/**
 * State of a head that still holds funds: open, or closed or fanning out
 * and not paid out completely yet.
 */
export type HydraLiveHeadStateName = Exclude<
  HydraHeadStateName,
  'final' | 'initial'
>;

/** Head as `toHydraHeadPositions` reads it: one account's view of the head. */
export interface HydraPositionHead
  extends Pick<
    HydraAccountHead,
    | 'contestationDeadline'
    | 'headId'
    | 'headValue'
    | 'isParticipant'
    | 'isSoleParticipant'
    | 'participantCount'
    | 'state'
  > {
  /**
   * What the head absorbed for the account's keys and paid back to them,
   * absent when its history could not be read or explained.
   */
  readonly funds?: HydraHeadFunds;
}

/**
 * Deposit as `toHydraHeadPositions` reads it. Its status is derived from the
 * deadline, so a status stored when the deposit was found is not needed.
 */
export type HydraPositionDeposit = Pick<
  HydraAccountDeposit,
  'deadline' | 'headId' | 'value'
>;

/**
 * Account's deposits for a head that still wait at the deposit validator,
 * summed by their status. Both are empty values when there are none.
 */
export interface HydraWaitingDeposits {
  readonly pending: HydraValue;
  readonly recoverable: HydraValue;
}

/**
 * Where one account stands in one head that still holds funds, as of an
 * instant. Instants in a position are epoch milliseconds, like the instant
 * it is computed for.
 */
export interface HydraHeadPosition {
  readonly headId: string;
  readonly state: HydraLiveHeadStateName;
  /**
   * End of the contestation period in epoch milliseconds, present for closed
   * and fanning out heads.
   */
  readonly contestationDeadline?: number;
  /** Everything the head UTxO holds, including the head tokens. */
  readonly headValue: HydraValue;
  /** True when the account holds at least one participation token. */
  readonly isParticipant: boolean;
  /** Number of participants of the head other than the account. */
  readonly otherParticipantCount: number;
  /**
   * What was committed to the account's keys into the head and paid back to
   * them, kept apart rather than netted. Absent when the head's history
   * could not be read or explained.
   */
  readonly funds?: HydraHeadFunds;
  /** The account's deposits for the head that the head has not absorbed. */
  readonly waitingDeposits: HydraWaitingDeposits;
}

/** The heads one account has funds in, as of one instant. */
export interface HydraHeadPositions {
  readonly heads: readonly HydraHeadPosition[];
  /**
   * The next instant, in epoch milliseconds, at which a position changes
   * with the passage of time alone, absent when none will.
   */
  readonly nextChangeAt?: number;
}

/**
 * Time left until an instant, in whole days, hours and minutes. A partial
 * minute counts as a whole one, so it never reads zero while time is left.
 */
export interface HydraRemainingTime {
  readonly days: number;
  readonly hours: number;
  readonly minutes: number;
}

/**
 * What a head card says the head is doing. A closed head is `closing` while
 * its contestation period runs and `closed`, waiting for its payout, after;
 * a head fanning out is `payingOut`.
 */
export type HydraHeadCardState =
  | { readonly kind: 'closed' }
  | { readonly kind: 'closing'; readonly remaining: HydraRemainingTime }
  | { readonly kind: 'open' }
  | { readonly kind: 'payingOut' };

/**
 * One account's card for one head, as of an instant: what the card says,
 * before any wording or number formatting. Only lovelace is given, since
 * that is what the layer 1 records vouch for, and nothing is netted.
 */
export interface HydraHeadCard {
  readonly headId: string;
  readonly state: HydraHeadCardState;
  /** Lovelace the head UTxO holds, the ada its operators put up included. */
  readonly total: bigint;
  /**
   * Lovelace the head absorbed for the account and, when more than zero,
   * paid back to it. Absent when the head's history could not be read, so
   * no figure is guessed, and when nothing went in or came out, so no zero
   * figure is shown.
   */
  readonly funds?: {
    readonly deposited: bigint;
    readonly withdrawn?: bigint;
  };
  /**
   * Lovelace of the account's deposits still waiting for the head, by their
   * status as of the instant, each present when more than zero. Absent when
   * none waits.
   */
  readonly waiting?: {
    readonly pending?: bigint;
    readonly recoverable?: bigint;
  };
  /**
   * Who else is in the head: the participants other than the account of a
   * head it shares (`isShared`), or every participant of a head it only
   * deposited into. Absent when nobody else is.
   */
  readonly participants?: {
    readonly count: number;
    readonly isShared: boolean;
  };
  /**
   * True when the account's own figures, `funds` or `waiting`, lead the card
   * and `total` moves to its detail line with the participants; false when
   * the card leads with `total` and the participants alone make the detail.
   */
  readonly leadsWithFunds: boolean;
}

/** The cards of the heads one account has funds in, as of one instant. */
export interface HydraHeadCards {
  readonly cards: readonly HydraHeadCard[];
  /**
   * The next instant, in epoch milliseconds, at which a card changes with
   * the passage of time alone: a closing head's countdown dropping by a
   * whole minute, its contestation period ending, or a pending deposit
   * becoming recoverable. Absent when none will.
   */
  readonly nextChangeAt?: number;
}
