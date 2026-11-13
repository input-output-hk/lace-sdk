/**
 * The `blockchainSpecific` fragment for the pending activity a flow upserts
 * after `submitTx` succeeds, spread onto the activity it builds:
 *
 * ```ts
 * const pendingActivity = {
 *   accountId,
 *   activityId: result.txId,
 *   timestamp: Timestamp(Date.now()),
 *   tokenBalanceChanges,
 *   type: ActivityType.Pending,
 *   ...pendingActivityMetadata(result),
 * };
 * ```
 *
 * It serves blockchains whose `submitTx` returns row metadata derived from the
 * signed transaction: for Bitcoin, the outpoints it consumes and the outputs it
 * produces. Without it the in-flight view cannot subtract what the transaction
 * spends, so its inputs stay offered as spendable until it confirms and a
 * transaction built in that window can be rejected by the node. Cardano's
 * `submitTx` returns none: its spend is recorded in
 * `cardanoContext.inFlightTransactions` instead (see
 * `packages/module/cardano-sync/docs/in-flight-transactions.md`).
 *
 * Absent metadata yields no key rather than an empty one: consumers read a
 * missing `blockchainSpecific` as "unknown", never as "spent nothing".
 */
export const pendingActivityMetadata = (result: {
  blockchainSpecificActivityMetadata?: unknown;
}): { blockchainSpecific?: unknown } =>
  result.blockchainSpecificActivityMetadata === undefined
    ? {}
    : { blockchainSpecific: result.blockchainSpecificActivityMetadata };
