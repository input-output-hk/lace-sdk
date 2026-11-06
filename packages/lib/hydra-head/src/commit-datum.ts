import { readCommit } from './deposit-datum';
import {
  parsePlutusData,
  readBytesHex,
  readConstr,
  readHash28,
  readListData,
} from './plutus-data';

import type { HydraCommitDatum, HydraCommittedOutput } from './types';
import type { Cardano } from '@lace-lib/cardano-core';

/**
 * Decodes the inline datum of a commit UTxO, which releases up to 1.3.0
 * create for each participant before the collect step opens the head. The
 * datum is the tuple `(party, [Commit], headId)`, where `party` is the
 * participant's Hydra verification key.
 *
 * @param datum - CBOR hex of the inline datum.
 * @param networkId - Network the committed outputs belong to.
 * @returns the decoded datum, or undefined when the datum is malformed or of
 * another shape. Never throws.
 */
export const decodeHydraCommitDatum = (
  datum: string,
  networkId: Cardano.NetworkId,
): HydraCommitDatum | undefined => {
  try {
    const fields = readConstr(parsePlutusData(datum), 0n, 3);
    if (!fields || readBytesHex(fields[0]) === undefined) return undefined;
    const commits = readListData(fields[1]);
    const headId = readHash28(fields[2]);
    if (!commits || headId === undefined) return undefined;

    const committed: HydraCommittedOutput[] = [];
    for (const commit of commits) {
      const output = readCommit(commit, networkId);
      if (!output) return undefined;
      committed.push(output);
    }
    return { headId, committed };
  } catch {
    return undefined;
  }
};
