import { Cardano, Serialization } from '@lace-lib/cardano-core';
import { HexBlob } from '@lace-lib/cardano-util';

import { decodeHydraDepositDatum } from './deposit-datum';
import { HYDRA_DEPOSIT_VALIDATOR_SCRIPTS } from './deposit-scripts';
import { findAccountHydraDeposits } from './deposits';
import {
  parsePlutusData,
  readConstr,
  readLedgerTxOut,
  readListData,
  readOutRef,
} from './plutus-data';
import { constr, toPlutusTxOutData } from './tx-out-data';
import { fromCardanoUtxo } from './utxo';

import type { HydraDepositRecovery, HydraOutRef } from './types';

/** Field of the deposit datum that lists the commits. */
const COMMITS_FIELD = 2;

/** Constructor of the `Recover` redeemer of every deposit validator. */
const RECOVER_ALTERNATIVE = 1n;

/** One commit of a deposit: the output reference and the committed output. */
interface Commit {
  readonly input: HydraOutRef;
  readonly serialized: Uint8Array;
}

/** Orders output references as Aiken's `output_reference.compare` does. */
const compareOutputReferences = (a: HydraOutRef, b: HydraOutRef): number => {
  if (a.txId !== b.txId) return a.txId < b.txId ? -1 : 1;
  return a.index - b.index;
};

/**
 * Reads the commits of a deposit datum the library already decoded, with
 * each committed output as the bytes the validator hashes.
 */
const readCommits = (datum: string): Commit[] => {
  const fields = readConstr(parsePlutusData(datum), 0n, 3);
  const commits = fields && readListData(fields[COMMITS_FIELD]);
  if (!commits) throw new Error('The deposit datum lists no commits');
  return commits.map(commit => {
    const [input, serialized] = readConstr(commit, 0n, 2) ?? [];
    const outRef = input && readOutRef(input);
    const bytes = serialized?.asBoundedBytes();
    if (!outRef || !bytes) throw new Error('The deposit datum is malformed');
    return { input: outRef, serialized: bytes };
  });
};

/**
 * Rebuilds the ledger output a commit names, refusing one a recover cannot
 * pay back exactly as committed.
 */
const restoreOutput = (
  { input, serialized }: Commit,
  networkId: Cardano.NetworkId,
): Cardano.TxOut => {
  const committed = HexBlob.fromBytes(serialized);
  const restored = readLedgerTxOut(parsePlutusData(committed), networkId);
  const name = `${input.txId}#${input.index}`;
  if (!restored) {
    throw new Error(`The deposit commits output ${name} in a form not read`);
  }
  if (restored.referenceScriptHash !== undefined) {
    throw new Error(
      `The deposit commits output ${name} with a reference script, which a recover cannot restore`,
    );
  }
  if (toPlutusTxOutData(restored.output).toCbor() !== committed) {
    throw new Error(
      `The deposit commits output ${name} in an encoding a recover cannot reproduce`,
    );
  }
  return restored.output;
};

/**
 * Tells what the recover transaction of a deposit holds, for an account
 * whose payment keys the deposit commits to, once its deadline has passed.
 *
 * The deposit validator of every release accepts the `Recover` redeemer
 * when the transaction validity starts strictly after the deadline and its
 * first outputs, serialized as Plutus data, are the committed outputs in the
 * order of their output references. The recovery lists those outputs in that
 * order, rebuilt from the datum and checked to serialize to the bytes it
 * commits, the redeemer naming how many there are, and the release's deposit
 * validator script to attach. Anyone may submit a recover, as the validator
 * checks no signature, but the funds go back only to the committed outputs.
 *
 * @param deposit - The deposit UTxO, with its inline datum.
 * @param ownedPaymentKeyHashes - Hex payment key hashes of the account.
 * @param now - Instant the recovery is prepared at, in epoch milliseconds.
 * @returns the recovery.
 * @throws When the UTxO is not a deposit at a known deposit validator, its
 * datum does not decode, it commits other than what it holds or nothing to
 * the account's keys, its deadline has not passed at `now`, or it commits an
 * output a recover cannot restore exactly: one with a reference script, or
 * one serialized other than the ledger serializes it.
 */
export const toHydraDepositRecovery = (
  deposit: Cardano.Utxo,
  ownedPaymentKeyHashes: Iterable<string>,
  now: number,
): HydraDepositRecovery => {
  const [, { address }] = deposit;
  const parsed = Cardano.Address.fromString(address);
  const scriptHash = parsed?.getProps().paymentPart?.hash;
  const script =
    scriptHash === undefined
      ? undefined
      : HYDRA_DEPOSIT_VALIDATOR_SCRIPTS[scriptHash];
  if (!parsed || script === undefined) {
    throw new Error(`${address} is not a Hydra deposit validator address`);
  }

  const utxo = fromCardanoUtxo(deposit);
  const networkId = parsed.getNetworkId();
  const datum =
    utxo.inlineDatum === undefined
      ? undefined
      : decodeHydraDepositDatum(utxo.inlineDatum, networkId);
  if (utxo.inlineDatum === undefined || !datum) {
    throw new Error('The deposit carries no Hydra deposit datum');
  }
  const [owned] = findAccountHydraDeposits([utxo], ownedPaymentKeyHashes, now);
  if (!owned) {
    throw new Error(
      'The deposit commits nothing to the account, or other than it holds',
    );
  }
  if (owned.status !== 'recoverable') {
    throw new Error(
      `The deposit can be recovered only after its deadline, ${new Date(
        datum.deadline,
      ).toISOString()}`,
    );
  }

  const outputs = readCommits(utxo.inlineDatum)
    .sort((a, b) => compareOutputReferences(a.input, b.input))
    .map(commit => restoreOutput(commit, networkId));
  return {
    deposit,
    headId: datum.headId,
    deadline: datum.deadline,
    script: {
      __type: Cardano.ScriptType.Plutus,
      version: Cardano.PlutusLanguageVersion.V3,
      bytes: HexBlob(script),
    },
    redeemer: constr(
      RECOVER_ALTERNATIVE,
      Serialization.PlutusData.newInteger(BigInt(outputs.length)),
    ).toCore(),
    outputs,
  };
};
