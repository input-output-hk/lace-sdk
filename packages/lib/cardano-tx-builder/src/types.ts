import type { CoinSelector } from './input-selection/types';
import type { Cardano, Serialization } from '@lace-lib/cardano-core';

/**
 * The protocol parameters the transaction builder prices and checks a
 * transaction with: the fee coefficients and execution unit prices for the
 * fee, `coinsPerUtxoByte` and `maxValueSize` for each output's minimum value
 * and size, `maxTxSize` for the transaction size, the stake key and pool
 * deposits for certificates that carry none, and the collateral parameters
 * for transactions that run Plutus scripts. The optional `protocolVersion`
 * decides whether a transaction may spend an input it also references. The
 * optional `refScriptCostStride` and `refScriptCostMultiplier` set the tiers
 * reference scripts are priced in; without them the builder prices Conway's
 * tiers of 25600 bytes growing by 1.2.
 */
export type TransactionBuilderProtocolParameters = Partial<
  Pick<
    Cardano.ProtocolParameters,
    'protocolVersion' | 'refScriptCostMultiplier' | 'refScriptCostStride'
  >
> &
  Pick<
    Cardano.ProtocolParameters,
    | 'coinsPerUtxoByte'
    | 'collateralPercentage'
    | 'maxCollateralInputs'
    | 'maxTxSize'
    | 'maxValueSize'
    | 'minFeeCoefficient'
    | 'minFeeConstant'
    | 'minFeeRefScriptCostPerByte'
    | 'poolDeposit'
    | 'prices'
    | 'stakeKeyDeposit'
  >;

/**
 * The execution budget an evaluator found for each redeemer of a transaction,
 * identified by its purpose and index.
 */
export type TxEvaluationResult = Array<{
  purpose: Cardano.RedeemerPurpose;
  index: number;
  budget: Cardano.ExUnits;
}>;

/**
 * Evaluates the scripts a transaction runs and reports the execution budget
 * each redeemer needs.
 */
export interface TxEvaluator {
  /**
   * Evaluates `tx` against the outputs its inputs spend.
   *
   * @param tx - The transaction to evaluate. For a batch its body omits the
   *   sub transactions, which only `serializedTx` carries intact.
   * @param resolvedInputs - The UTxOs the transaction's inputs and
   *   reference inputs resolve to and, for a batch, the UTxOs its sub
   *   transactions spend and reference.
   * @param serializedTx - The transaction exactly as the builder writes it,
   *   sub transactions byte for byte. Writing `tx` again would lose them and
   *   change their ids, so an evaluator that submits CBOR sends this one.
   * @returns The budget of each redeemer `tx` carries. For a batch, it holds
   *   only the redeemers of the transaction itself, as the ledger's
   *   evaluation reports them, and none of its sub transactions, whose
   *   execution units are final: results are matched by purpose and index,
   *   which a sub transaction redeemer can share with one of `tx`. Only the
   *   carrier a `SubTransactionPlutusContext` evaluator receives asks for sub
   *   transaction redeemers.
   */
  evaluate(
    tx: Cardano.Tx,
    resolvedInputs: Cardano.Utxo[],
    serializedTx?: Serialization.Transaction,
  ): Promise<TxEvaluationResult>;
}

/**
 * Parameters for isTransactionBalanced.
 *
 * - `transaction`: The transaction to verify.
 * - `resolvedInputs`: The resolved UTxOs referenced by `transaction.body.inputs`, and by the
 *   inputs of `subTransactions`.
 * - `protocolParameters`: Protocol parameters used to compute implicit coin and fee semantics.
 * - `subTransactions`: Sub transactions the body carries, whose imbalance the body balances
 *   with the rest of the batch.
 * - `registeredPools`: Pools already registered on chain, whose registration in the batch
 *   updates their parameters and takes no pool deposit.
 */
export type IsTransactionBalancedParams = {
  transaction: Cardano.Tx;
  resolvedInputs: Cardano.Utxo[];
  protocolParameters: TransactionBuilderProtocolParameters;
  subTransactions?: readonly Serialization.SubTransaction[];
  registeredPools?: ReadonlySet<Cardano.PoolId>;
};

/**
 * Parameters for balanceTransaction.
 *
 * - `unbalancedTx`: The starting transaction (may contain outputs, mint, donation, metadata...).
 * - `availableUtxo`: UTxOs available for selection.
 * - `preSelectedUtxo`: Optional UTxOs that must be included first.
 * - `collateralUtxos`: Full collateral UTxOs, used to resolve collateral signer key hashes
 *   for the VK-witness count estimate. Not selected by the coin selector.
 * - `referenceUtxos`: Resolved reference inputs, so the fee prices the reference scripts
 *   they carry. Not selected by the coin selector.
 * - `subTransactions`: Sub transactions the body carries, as encoded, so the fee prices
 *   the bytes they keep, the execution units of their redeemers and the reference scripts
 *   their inputs carry, and the balance funds what they take from the batch and returns
 *   what they leave to it.
 * - `subTransactionUtxos`: The resolved UTxOs the sub transactions spend and reference.
 *   Not selected by the coin selector.
 * - `registeredPools`: Pools already registered on chain, whose registration in the batch
 *   updates their parameters and takes no pool deposit.
 * - `protocolParameters`: Protocol parameters.
 * - `coinSelector`: Strategy used to pick inputs (e.g. Large-First).
 * - `fallbackCoinSelector`: Optional strategy the balancing is retried
 *   with, from scratch, when the `coinSelector` path fails. Ignored when it is
 *   the same instance as `coinSelector`.
 * - `changeAddress`: Address where change will be returned.
 */
export type BalanceTransactionParams = {
  unbalancedTx: Cardano.Tx;
  availableUtxo: Cardano.Utxo[];
  preSelectedUtxo?: Cardano.Utxo[];
  collateralUtxos?: Cardano.Utxo[];
  referenceUtxos?: Cardano.Utxo[];
  subTransactions?: readonly Serialization.SubTransaction[];
  subTransactionUtxos?: Cardano.Utxo[];
  registeredPools?: ReadonlySet<Cardano.PoolId>;
  protocolParameters: TransactionBuilderProtocolParameters;
  coinSelector: CoinSelector;
  fallbackCoinSelector?: CoinSelector;
  changeAddress: Cardano.PaymentAddress;
};
