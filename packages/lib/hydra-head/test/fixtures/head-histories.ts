import { fromBlockfrostUtxo } from '../../src';

import recorded from './preprod-head-histories.blockfrost.json';

import type { HydraBlockfrostUtxo, HydraHeadHistoryTx } from '../../src';

/** Input of a Blockfrost `txs/{hash}/utxos` response. */
type RecordedInput = HydraBlockfrostUtxo & {
  collateral?: boolean;
  reference?: boolean;
};

/** Output of a Blockfrost `txs/{hash}/utxos` response. */
type RecordedOutput = Omit<HydraBlockfrostUtxo, 'tx_hash'> & {
  collateral?: boolean;
};

/** Blockfrost `txs/{hash}/utxos` response, reduced to the fields read here. */
export type RecordedTx = {
  hash: string;
  inputs: RecordedInput[];
  outputs: RecordedOutput[];
};

/** A head and the transactions listed for its state token, oldest first. */
export type RecordedHeadHistory = {
  headId: string;
  transactions: RecordedTx[];
};

/**
 * Head histories recorded from the Preprod Blockfrost API. Datums of outputs
 * outside the Hydra validators and of collateral and reference inputs are
 * dropped, since nothing reads them.
 */
export const preprodHeadHistories: {
  /** Hydra 2.3.0, one participant: init, increment, decrement, close. */
  closedAfterDecommitV2: RecordedHeadHistory;
  /**
   * Hydra 2.3.0, one participant whose deposits all expired and were
   * recovered: init, close.
   */
  recoveredDepositsV2: RecordedHeadHistory;
  /**
   * Hydra 2.3.0, two participants: init, three increments, close, three
   * partial fanouts.
   */
  partialFanoutV2: RecordedHeadHistory;
  /**
   * Hydra 1.3.0, two participants: init, collect, six increments, decrement.
   */
  incrementsV1: RecordedHeadHistory;
  /**
   * Hydra 0.18.0, two participants whose commits use Plutus V2 output
   * references: init, collect, close.
   */
  collectV1Plutus2: RecordedHeadHistory;
  /**
   * Hydra 1.0.0, four participants, some committing script outputs: init,
   * collect, close.
   */
  collectV1Scripts: RecordedHeadHistory;
  /**
   * Hydra 2.0.0, one participant and one depositor: init, two increments of
   * 0.77 and 20 ada.
   */
  v20Increments: RecordedHeadHistory;
  /**
   * Hydra 2.1.0, one participant and two depositors: init, two increments of
   * 10 and 9.53931934 ada, decrements of 49 and 9 ada.
   */
  v21Decrements: RecordedHeadHistory;
  /**
   * Hydra 2.2.0, one participant and one depositor: init, two increments of 1
   * and 10 ada, decrements of 9, 199, 9 and 49 ada.
   */
  v22Decrements: RecordedHeadHistory;
} = recorded.heads;

/** Recover of an expired deposit into head 324c8b81; it never touches the head. */
export const preprodRecoverTx: RecordedTx = recorded.recoverTx;

/**
 * Converts a recorded transaction into a history transaction, leaving out
 * collateral and reference inputs and the collateral return.
 */
export const toHistoryTx = ({
  hash,
  inputs,
  outputs,
}: RecordedTx): HydraHeadHistoryTx => ({
  txId: hash,
  inputs: inputs
    .filter(({ collateral, reference }) => !collateral && !reference)
    .map(fromBlockfrostUtxo),
  outputs: outputs
    .filter(({ collateral }) => !collateral)
    .map(output => fromBlockfrostUtxo({ ...output, tx_hash: hash })),
});

/** Converts every transaction of a recorded head history. */
export const historyOf = ({ transactions }: RecordedHeadHistory) =>
  transactions.map(toHistoryTx);
