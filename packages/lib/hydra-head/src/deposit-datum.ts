import { HexBlob } from '@lace-lib/cardano-util';

import {
  parsePlutusData,
  readConstr,
  readHash28,
  readListData,
  readOutRef,
  readPosixTime,
  readTxOut,
} from './plutus-data';

import type { HydraCommittedOutput, HydraDepositDatum } from './types';
import type { Cardano, Serialization } from '@lace-lib/cardano-core';

/**
 * Reads one `Commit`: the spent output reference and the output itself,
 * serialized as CBOR of its Plutus ledger API encoding. Deposits and the
 * commits of releases up to 1.3.0 share this record.
 */
export const readCommit = (
  commit: Serialization.PlutusData,
  networkId: Cardano.NetworkId,
): HydraCommittedOutput | undefined => {
  const fields = readConstr(commit, 0n, 2);
  if (!fields) return undefined;
  const input = readOutRef(fields[0]);
  const serialized = fields[1].asBoundedBytes();
  if (!input || !serialized) return undefined;
  const output = readTxOut(
    parsePlutusData(HexBlob.fromBytes(serialized)),
    networkId,
  );
  return output && { input, ...output };
};

/**
 * Decodes the inline datum of a deposit UTxO, the tuple
 * `(headId, deadline, [Commit])`. Committed addresses are rebuilt for the
 * given network, which is the network of the deposit address.
 *
 * @param datum - CBOR hex of the inline datum.
 * @param networkId - Network the committed outputs belong to.
 * @returns the decoded datum, or undefined when the datum is malformed or of
 * another shape. Never throws.
 */
export const decodeHydraDepositDatum = (
  datum: string,
  networkId: Cardano.NetworkId,
): HydraDepositDatum | undefined => {
  try {
    const fields = readConstr(parsePlutusData(datum), 0n, 3);
    if (!fields) return undefined;
    const headId = readHash28(fields[0]);
    const deadline = readPosixTime(fields[1]);
    const commits = readListData(fields[2]);
    if (headId === undefined || deadline === undefined || !commits) {
      return undefined;
    }

    const committed: HydraCommittedOutput[] = [];
    for (const commit of commits) {
      const output = readCommit(commit, networkId);
      if (!output) return undefined;
      committed.push(output);
    }
    return { headId, deadline, committed };
  } catch {
    return undefined;
  }
};
