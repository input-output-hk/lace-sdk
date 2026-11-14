import type { CardanoCustodyStoredIdentity } from './identity';
import type { AccountId } from '@lace-contract/wallet-repo';
import type { Cardano, Serialization } from '@lace-lib/cardano-core';
import type {
  Bip32PublicKeyHex,
  Ed25519KeyHashHex,
} from '@lace-lib/cardano-crypto';
import type {
  CustodyAccountRecord,
  CustodyGrantLiveness,
  CustodyRefusal,
  CustodyRequestedGrantScope,
  CustodyScopeViolation,
  CustodySponsorRuleViolation,
  CustodyStateTransitionError,
} from '@lace-lib/cardano-custody';
import type {
  ExceededTransactionLimit,
  TransactionLimitsUsage,
} from '@lace-lib/cardano-tx-builder';

/**
 * The most lovelace a grant spend's fee may take when the operation names
 * no `feeBound`: 1,500,000 lovelace. The spend lowers the grant's remaining caps by its outputs
 * and fee before the fee is final, so the bound is what the caps must leave
 * room for.
 */
export const CARDANO_CUSTODY_DEFAULT_GRANT_FEE_BOUND = 1_500_000n;

/**
 * What the fee sponsor service contributes to one custody transaction.
 *
 * - `fee`: creation only. The leased fee UTxO pays the fee, the stake
 *   deposit and the control output, and the change returns to the sponsor.
 *   The control output's lovelace above its minimum is the owner's fee
 *   reserve.
 * - `collateral`: every operation on an existing account. The account pays
 *   its own fee, and the sponsor declares its shared collateral UTxO and
 *   nothing else. An owner operation pays from plain funds and reserves
 *   first, then from the control output's headroom; a grant spend pays from
 *   plain funds.
 *
 * `validUntil` is the latest instant, in POSIX milliseconds, the service
 * accepts as the transaction's upper validity bound under the mode.
 */
export type CardanoCustodyFundingContext =
  | {
      mode: 'collateral';
      collateralUtxo: Cardano.Utxo;
      sponsorAddress: Cardano.PaymentAddress;
      validUntil: number;
    }
  | {
      mode: 'fee';
      feeUtxo: Cardano.Utxo;
      collateralUtxo: Cardano.Utxo;
      sponsorAddress: Cardano.PaymentAddress;
      maxSponsoredLovelace: bigint;
      validUntil: number;
    };

export type CardanoCustodyFeeFunding = Extract<
  CardanoCustodyFundingContext,
  { mode: 'fee' }
>;
export type CardanoCustodyCollateralFunding = Extract<
  CardanoCustodyFundingContext,
  { mode: 'collateral' }
>;

/**
 * A grant an owner asks to issue: the grantee and its scope. Recipients are
 * payment addresses on the account's network; caps and the expiry (POSIX
 * milliseconds) are integers. The slot and generation are the account's to
 * assign.
 */
export type CardanoCustodyGrantScopeRequest = Pick<
  CustodyRequestedGrantScope,
  | 'asset'
  | 'cap'
  | 'expiresAt'
  | 'grantee'
  | 'lovelaceCap'
  | 'lovelacePerCallCap'
  | 'perCallCap'
  | 'recipients'
>;

/**
 * Other contracts a grant spend or an owner spend calls. The outputs that
 * pay a called contract, such as its continuing output or an order, are
 * ordinary requested outputs of the spend, so a grant must list the
 * contract's address when it lists recipients. Every script the call runs
 * must be attached in `scripts` or carried by a UTxO of `referenceInputs`.
 *
 * The value the call's inputs bring in and what it mints count against what
 * leaves the account, and what it burns counts with it: the account's
 * funds pay, and a grant's caps fall by, the net value leaving the account,
 * never below zero.
 */
export type CardanoCustodyContractCall = {
  /**
   * Script UTxOs of other contracts the call spends, each with the spend
   * redeemer its validator reads. `datum` is the datum of a UTxO that
   * carries only its hash; a UTxO with an inline datum takes none.
   */
  inputs?: {
    utxo: Cardano.Utxo;
    redeemer: Cardano.PlutusData;
    datum?: Cardano.PlutusData;
  }[];
  /**
   * Tokens minted (positive) or burned (negative) under Plutus policies of
   * other contracts, one entry per policy with the mint redeemer it reads.
   */
  mint?: {
    policyId: Cardano.PolicyId;
    assets: Map<Cardano.AssetName, bigint>;
    redeemer: Cardano.PlutusData;
  }[];
  /** Plutus scripts the witness set attaches: validators and policies the call runs. */
  scripts?: Cardano.PlutusScript[];
  /**
   * UTxOs the call reads without spending: reference inputs a validator
   * inspects and UTxOs carrying the reference scripts the call runs. One
   * the spend already reads, such as the account's control UTxO, is read
   * once.
   */
  referenceInputs?: Cardano.Utxo[];
};

/**
 * Creates the account of the first usable creator key of a device. The
 * device keys are `m/1854'/1815'/a'/0/i`, derived from
 * `deviceAccountPublicKey`: the CIP-1854 account key of account
 * `custodyDeviceAccountIndex` for the current network. The scan starts at
 * `startIndex`, 0 when absent: a non-negative integer that leaves the whole
 * scan among the soft (non-hardened) indices.
 */
export type CardanoCustodyCreateOperation = {
  type: 'create';
  deviceAccountPublicKey: Bip32PublicKeyHex;
  startIndex?: number;
};

/**
 * An operation on an existing account, which the account pays for. Every
 * one but `grant-spend` is an owner operation: a listed device signs it.
 *
 * - `add-device`, `remove-device`: list or delist a device key.
 * - `delegate`: delegates the account's stake to `poolId`.
 * - `grant-spend`: the grantee pays `outputs` from the account's plain
 *   funds under its grant: the single current, unexpired grant of
 *   `grantee`, or the grant in `slot` when given. The recreated grant's
 *   remaining caps fall by the outputs and the fee, and the fee may not
 *   exceed `feeBound` (`CARDANO_CUSTODY_DEFAULT_GRANT_FEE_BOUND` when
 *   absent). The build selects no fund UTxO in `excludedInputs`: the inputs
 *   of other spends built and not yet seen settle. With `contract`, the
 *   spend also calls other contracts, and the caps fall by the net value
 *   leaving the account.
 * - `issue-grant`: issues a grant in the account's next slot, and tops the
 *   control output's headroom up to the owner fee reserve target from plain
 *   funds.
 * - `owner-spend`: pays `outputs` from plain funds and reserves. With
 *   `metadata`, the transaction carries it as auxiliary data, by label, and
 *   the signer's consent shows it: a payment reference for the service
 *   paid, such as a subscription's payment intent. Text and bytes hold at
 *   most 64 bytes each, as the ledger requires. No other operation carries
 *   metadata: one named on it is refused as `invalid-metadata`, never
 *   dropped. With `contract`, the spend also calls other contracts, and
 *   the funds pay the net value leaving the account, while the control
 *   state stays as it was. No other owner operation calls a contract: one
 *   named on it is refused as `invalid-contract-call`.
 * - `replace-grant`: revokes the grant in `slot` and issues `scope` in the
 *   next slot in one transaction, topping the headroom up as an issue does.
 * - `revoke-all-grants`: raises the grant generation, which kills every
 *   grant, and empties the revoked list.
 * - `revoke-grant`: adds the slot of a current grant to the revoked list.
 * - `sweep-grants`: burns the tokens of 1 to 8 dead grants in `slots`,
 *   which removes them from the outstanding count and their slots from the
 *   revoked list, and moves their lovelace into the control output's
 *   headroom. A grant is dead when revoked, superseded, or expired before
 *   the transaction's validity starts.
 * - `withdraw-rewards`: withdraws the whole reward balance, read from the
 *   chain at build time.
 */
export type CardanoCustodyAccountOperation =
  | {
      type: 'grant-spend';
      grantee: Ed25519KeyHashHex;
      outputs: Cardano.TxOut[];
      slot?: bigint;
      feeBound?: bigint;
      excludedInputs?: Cardano.TxIn[];
      contract?: CardanoCustodyContractCall;
    }
  | {
      type: 'owner-spend';
      outputs: Cardano.TxOut[];
      metadata?: Cardano.TxMetadata;
      contract?: CardanoCustodyContractCall;
    }
  | {
      type: 'replace-grant';
      slot: bigint;
      scope: CardanoCustodyGrantScopeRequest;
    }
  | { type: 'add-device'; keyHash: Ed25519KeyHashHex }
  | { type: 'delegate'; poolId: Cardano.PoolId }
  | { type: 'issue-grant'; scope: CardanoCustodyGrantScopeRequest }
  | { type: 'remove-device'; keyHash: Ed25519KeyHashHex }
  | { type: 'revoke-all-grants' }
  | { type: 'revoke-grant'; slot: bigint }
  | { type: 'sweep-grants'; slots: bigint[] }
  | { type: 'withdraw-rewards' };

/**
 * A request to build one custody transaction. `requestId` correlates the
 * completion or failure with the request. Creation runs in fee mode on the
 * current network. An operation on the custody account `accountId` names
 * runs in collateral mode.
 */
export type CardanoCustodyBuildRequest =
  | {
      requestId: string;
      accountId: AccountId;
      operation: CardanoCustodyAccountOperation;
      funding: CardanoCustodyCollateralFunding;
    }
  | {
      requestId: string;
      operation: CardanoCustodyCreateOperation;
      funding: CardanoCustodyFeeFunding;
    };

/** An unsigned custody transaction, checked and ready for its signers. */
export type CardanoCustodyBuildResult = {
  /** Unsigned transaction CBOR. */
  transaction: Serialization.TxCBOR;
  /** The body hash every witness signs: the transaction id. */
  bodyHash: Cardano.TransactionId;
  /**
   * The output of every input, reference input and collateral input, as
   * signers need them.
   */
  resolvedInputs: Cardano.Utxo[];
  accountRecord: CustodyAccountRecord;
  fee: bigint;
  invalidHereafter: Cardano.Slot;
  /**
   * The protocol's cost models the build ran under, which a device signer
   * needs to check the script data hash the body declares.
   */
  costModels?: Cardano.CostModels;
  /** Present for a creation: the creator key index and the new account. */
  creation?: {
    creatorIndex: number;
    identity: CardanoCustodyStoredIdentity;
  };
};

/**
 * Why a custody transaction was not built. Most codes name a condition the
 * caller can act on. `build-failed` is a defect or an unexpected provider
 * answer. `inspection-refused` and `sponsor-rules` mean the builder made a
 * transaction its own checks refuse, which is also a defect, except where
 * the logic run draws a balance someone paid to the logic's reward account:
 * the sponsor refuses any draw (`sponsor-rules`, `logic-draw`), and
 * inspection refuses a draw the account gives up (`inspection-refused`,
 * `logic-draw-leaves-account`).
 *
 * - `account-exists`: creation found an existing account at a creator
 *   index; reopen it from the record.
 * - `account-not-live`: the control state is not usable yet or is
 *   ambiguous.
 * - `collateral-fee-ceiling`: the fee is above `maxFee`, the most the
 *   sponsor's collateral UTxO covers at the ledger's collateral
 *   percentage. The sponsor would refuse the transaction.
 * - `collateral-insufficient`: the collateral UTxOs cannot cover the
 *   required collateral.
 * - `device-not-listed`: the bound device key is not in the current state.
 * - `grant-limit`: the account holds `limit` outstanding grants, dead ones
 *   included; sweep dead grants first.
 * - `grant-spend`: the grant spend cannot be built:
 *   - `unknown-grant`: `grantee` holds no grant UTxO (in `slot`, when
 *     named);
 *   - `ambiguous-grant`: `grantee` holds more than one current, unexpired
 *     grant, in `slots`; name the slot;
 *   - `dead-grant`: the grant in `slot` is not current, as `liveness`
 *     says;
 *   - `fee-above-bound`: the fee is above the spend's fee bound;
 *   - `fund-input-cap`: paying needs more fund inputs than one spend's
 *     execution budget fits;
 *   - `recipient-not-allowed`: an output pays an address the grant does
 *     not list;
 *   - `scope`: the outputs, with the fee, break the grant's caps.
 * - `index-exhausted`: the creation scan met only unusable creator
 *   indices within its bound.
 * - `inspection-refused`: the shared custody inspection, the check the
 *   hosted signer runs before consent, refuses the finished transaction.
 * - `insufficient-funds`: the account cannot pay the outputs, the grant
 *   lovelace and the fee.
 * - `invalid-operation`: the operation's input is invalid, and `reason`
 *   names what is wrong. With `reason: 'state-transition'`, the state rules
 *   refuse the new account state; with `reason: 'invalid-metadata'`, the
 *   metadata is not a map of labels to metadata the ledger accepts, or
 *   rides on a grant spend; with `reason: 'invalid-contract-call'`, the
 *   contract call of a grant spend or an owner spend cannot run, or rides
 *   on another owner operation, as `message` says, for example a call that
 *   names nothing, spends a UTxO no script locks, a
 *   custody account's UTxO or one of the account's own, lacks the datum its
 *   UTxO's hash names, mints the account's own tokens or a zero quantity,
 *   names a UTxO, policy or script twice, attaches a script that no input
 *   or mint needs, or attaches or references a script that is not PlutusV3.
 * - `logic-not-registered`: the stake credential of the logic the
 *   transaction runs (the current logic at creation, the logic the control
 *   state names otherwise), whose reward account is `rewardAccount`, is not
 *   registered on the network, so the withdrawal that runs the logic would
 *   fail. It is registered once per network, outside Lace.
 * - `observer-account`: an owner operation on an account opened without a
 *   device binding.
 * - `operation-in-progress`: a submitted operation on the account, or on
 *   the spent grant, has not settled.
 * - `owner-reserve-required`: an issue would leave the control output's
 *   headroom below `target`, the owner fee reserve that keeps a revoke
 *   payable, and the plain funds lack `shortfall` lovelace to top it up.
 *   Deposit first.
 * - `revoked-list-full`: the revoked list holds `limit` slots; sweep
 *   revoked grants first.
 * - `script-evaluation-failed`: the provider could not evaluate a
 *   redeemer.
 * - `sponsor-limit`: the fee mode draw is above what the lease sponsors.
 * - `sponsor-rules`: the finished transaction breaks a rule of the fee
 *   sponsor service's policy.
 * - `stale-control`: the chain's control UTxO is not the synced one.
 * - `sweep-not-dead`: the grant in `slot` is not dead against the state
 *   before the sweep, as `liveness` says.
 * - `transaction-limits`: the finished transaction exceeds a protocol size
 *   or execution limit.
 * - `unknown-account`: no custody account on the current network, or its
 *   stored identity is not the derived one.
 * - `unavailable`: chain data the build needs could not be read.
 * - `validity-window`: the funding window leaves no slot after the
 *   current one.
 */
export type CardanoCustodyBuildError =
  | {
      code: 'account-exists';
      creatorIndex: number;
      record: CustodyAccountRecord;
    }
  | {
      code: 'account-not-live';
      status: 'invalid' | 'notCreated' | 'unsynced';
    }
  | {
      code: 'build-failed';
      message: string;
    }
  | {
      code: 'collateral-fee-ceiling';
      fee: bigint;
      maxFee: bigint;
    }
  | {
      code: 'collateral-insufficient';
      message: string;
    }
  | {
      code: 'device-not-listed';
      keyHash: Ed25519KeyHashHex;
    }
  | {
      code: 'grant-limit';
      limit: number;
    }
  | {
      code: 'grant-spend';
      reason: 'ambiguous-grant';
      grantee: Ed25519KeyHashHex;
      slots: bigint[];
    }
  | {
      code: 'grant-spend';
      reason: 'dead-grant';
      slot: bigint;
      liveness: Exclude<CustodyGrantLiveness, 'current'>;
    }
  | {
      code: 'grant-spend';
      reason: 'fee-above-bound';
      fee: bigint;
      feeBound: bigint;
    }
  | {
      code: 'grant-spend';
      reason: 'fund-input-cap';
      maxFundInputs: number;
      requiredFundInputs: number;
    }
  | {
      code: 'grant-spend';
      reason: 'recipient-not-allowed';
      outputIndex: number;
    }
  | {
      code: 'grant-spend';
      reason: 'scope';
      violations: CustodyScopeViolation[];
    }
  | {
      code: 'grant-spend';
      reason: 'unknown-grant';
      grantee: Ed25519KeyHashHex;
      slot?: bigint;
    }
  | {
      code: 'index-exhausted';
      startIndex: number;
      scanned: number;
    }
  | {
      code: 'inspection-refused';
      refusals: CustodyRefusal[];
    }
  | {
      code: 'insufficient-funds';
      message: string;
    }
  | {
      code: 'invalid-operation';
      reason:
        | 'funding-mode'
        | 'grant-scope'
        | 'invalid-contract-call'
        | 'invalid-device-key'
        | 'invalid-fee-bound'
        | 'invalid-metadata'
        | 'invalid-output'
        | 'invalid-pool-id'
        | 'invalid-start-index'
        | 'no-rewards'
        | 'unknown-operation';
      message: string;
    }
  | {
      code: 'invalid-operation';
      reason: 'state-transition';
      error: CustodyStateTransitionError;
    }
  | {
      code: 'logic-not-registered';
      rewardAccount: Cardano.RewardAccount;
    }
  | {
      code: 'owner-reserve-required';
      target: bigint;
      shortfall: bigint;
    }
  | {
      code: 'revoked-list-full';
      limit: number;
    }
  | {
      code: 'script-evaluation-failed';
      message: string;
    }
  | {
      code: 'sponsor-limit';
      sponsoredLovelace: bigint;
      maxSponsoredLovelace: bigint;
    }
  | {
      code: 'sponsor-rules';
      violations: CustodySponsorRuleViolation[];
    }
  | {
      code: 'sweep-not-dead';
      slot: bigint;
      liveness: CustodyGrantLiveness;
    }
  | {
      code: 'transaction-limits';
      usage: TransactionLimitsUsage;
      exceeded: ExceededTransactionLimit[];
    }
  | {
      code: 'unavailable';
      message: string;
    }
  | {
      code: 'validity-window';
      validUntil: number;
    }
  | { code: 'observer-account' }
  | { code: 'operation-in-progress' }
  | { code: 'stale-control' }
  | { code: 'unknown-account' };
