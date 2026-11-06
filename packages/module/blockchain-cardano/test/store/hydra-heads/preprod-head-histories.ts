import { Cardano } from '@lace-lib/cardano-core';
import { HexBlob } from '@lace-lib/cardano-util';
import { Timestamp } from '@lace-lib/util';

import recorded from './preprod-head-histories.blockfrost.json';
import mintingScripts from './preprod-head-minting-scripts.json';
import { toCardanoUtxo } from './preprod-utxos';

import type {
  CardanoTransactionHistoryItem,
  ExtendedTxDetails,
} from '@lace-contract/cardano-context';

/** Input of a Blockfrost `txs/{hash}/utxos` response. */
type RecordedInput = {
  tx_hash: string;
  output_index: number;
  address: string;
  amount: { unit: string; quantity: string }[];
  inline_datum?: string;
  collateral?: boolean;
  reference?: boolean;
};

/** Output of a Blockfrost `txs/{hash}/utxos` response. */
type RecordedOutput = Omit<RecordedInput, 'reference' | 'tx_hash'>;

/** Blockfrost `txs/{hash}/utxos` response, reduced to the fields read here. */
type RecordedTx = {
  hash: string;
  inputs: RecordedInput[];
  outputs: RecordedOutput[];
};

/** A head, the listing of its state token and the listed transactions. */
export type RecordedHeadHistory = {
  headId: string;
  stateToken: string;
  /** Blockfrost `assets/{unit}/transactions`, oldest first. */
  listing: {
    tx_hash: string;
    tx_index: number;
    block_height: number;
    block_time: number;
  }[];
  transactions: RecordedTx[];
};

/**
 * Head histories recorded from the Preprod Blockfrost API. Datums of outputs
 * outside the Hydra validators and of collateral and reference inputs are
 * dropped, since nothing reads them.
 */
export const preprodHeadHistories: {
  /**
   * Hydra 2.3.0 head of payment key 4d688562, which deposited 15 ada and
   * decommitted 7 ada: init, increment, decrement, close.
   */
  decommitted: RecordedHeadHistory;
  /**
   * Hydra 2.3.0 head of two participants up to its close, before its partial
   * fanouts: init, three increments by two depositors, close.
   */
  sharedBeforeFanout: RecordedHeadHistory;
  /** Hydra 2.3.0 head of one participant, right after its init. */
  openedSoleParticipant: RecordedHeadHistory;
  /** Hydra 2.3.0 head of three participants, right after its init. */
  openedThreeParticipants: RecordedHeadHistory;
} = recorded;

/**
 * The head minting script of each recorded head, by head id: the Plutus
 * language (2 for V2, 3 for V3) and the CBOR byte string of the script.
 */
const recordedMintingScripts: Partial<
  Record<string, { language: number; cbor: string }>
> = mintingScripts;

/** The Plutus script a recorded minting script is witnessed as. */
const toPlutusScript = ({
  language,
  cbor,
}: {
  language: number;
  cbor: string;
}): Cardano.PlutusScript => ({
  __type: Cardano.ScriptType.Plutus,
  bytes: HexBlob(cbor),
  version:
    language === 2
      ? Cardano.PlutusLanguageVersion.V2
      : Cardano.PlutusLanguageVersion.V3,
});

/**
 * The scripts witnessing each init transaction of the recorded heads, by
 * transaction id: the head minting script of its head.
 */
const initWitnessScripts = new Map<string, Cardano.Script[]>(
  Object.values(preprodHeadHistories).flatMap(({ headId, listing }) => {
    const script = recordedMintingScripts[headId];
    const init = listing[0];
    return script && init ? [[init.tx_hash, [toPlutusScript(script)]]] : [];
  }),
);

/** The listing of a head as `getAssetTransactionHistory` returns it. */
export const toHistoryItems = (
  history: RecordedHeadHistory,
): CardanoTransactionHistoryItem[] =>
  history.listing.map(item => ({
    txId: Cardano.TransactionId(item.tx_hash),
    txIndex: Cardano.TxIndex(item.tx_index),
    blockNumber: Cardano.BlockNo(item.block_height),
    blockTime: Timestamp(item.block_time * 1000),
  }));

/**
 * The parts of `getTransactionDetails` the index reads: spent inputs without
 * collateral and reference inputs, outputs without the collateral return,
 * and the witness scripts, which are `scripts` when given and otherwise the
 * head minting script for the init of a recorded head.
 */
export const toTransactionDetails = (
  { hash, inputs, outputs }: RecordedTx,
  scripts: Cardano.Script[] = initWitnessScripts.get(hash) ?? [],
): ExtendedTxDetails =>
  ({
    id: Cardano.TransactionId(hash),
    witness: { signatures: new Map(), scripts },
    body: {
      inputs: inputs
        .filter(({ collateral, reference }) => !collateral && !reference)
        .map(input => toCardanoUtxo(input)[0]),
      outputs: outputs
        .filter(({ collateral }) => !collateral)
        .map(output => toCardanoUtxo({ ...output, tx_hash: hash })[1]),
    },
  } as unknown as ExtendedTxDetails);

/** The head UTxO the last transaction of a history produced. */
export const headUtxoOf = ({ headId, transactions }: RecordedHeadHistory) => {
  const last = transactions.at(-1);
  const output = last?.outputs.find(({ amount }) =>
    amount.some(({ unit }) => unit.startsWith(headId)),
  );
  if (!last || !output) throw new Error(`no head output for ${headId}`);
  return { ...output, tx_hash: last.hash };
};

/** Every recorded transaction, by id. */
export const recordedTransactions = new Map(
  Object.values(preprodHeadHistories).flatMap(({ transactions }) =>
    transactions.map(transaction => [transaction.hash, transaction] as const),
  ),
);

/**
 * The output an input spends, as `resolveInput` returns it, found among the
 * inputs of `transactions`, by default every recorded transaction.
 */
export const resolveRecordedInput = (
  { txId, index }: Cardano.TxIn,
  transactions: Iterable<RecordedTx> = recordedTransactions.values(),
): Cardano.TxOut | null => {
  for (const { inputs } of transactions) {
    const input = inputs.find(
      ({ tx_hash, output_index, reference, collateral }) =>
        tx_hash === txId && output_index === index && !reference && !collateral,
    );
    if (input) return toCardanoUtxo(input)[1];
  }
  return null;
};

/** A head history with the scripts witnessing its init. */
export type LookalikeHeadHistory = RecordedHeadHistory & {
  initScripts: Cardano.Script[];
};

/**
 * A lookalike of a recorded head under the policy `headId`: the same history
 * with the head id and the id of every transaction it holds or spends from
 * replaced, so it is well formed, credits the same keys and shares no output
 * with the recorded head, and with its init witnessed by the minting script
 * of the recorded head.
 */
export const lookalikeOf = (
  original: RecordedHeadHistory,
  headId: string,
): LookalikeHeadHistory => {
  let json = JSON.stringify(original).replaceAll(original.headId, headId);
  const txIds = new Set(
    original.transactions.flatMap(({ hash, inputs }) => [
      hash,
      ...inputs.map(({ tx_hash }) => tx_hash),
    ]),
  );
  for (const txId of txIds) {
    json = json.replaceAll(txId, headId + txId.slice(headId.length));
  }
  const lookalike = JSON.parse(json) as RecordedHeadHistory;
  const init = original.listing[0]?.tx_hash;
  return {
    ...lookalike,
    initScripts: init === undefined ? [] : initWitnessScripts.get(init) ?? [],
  };
};
