import type { InFlightTransactionKey } from '@lace-contract/cardano-context';
import type { Cardano } from '@lace-lib/cardano-core';

/** A transaction due a question to the provider of its network. */
export type TipCandidate = {
  key: InFlightTransactionKey;
  /** The stored tip slot of the transaction's network. */
  tipSlot: Cardano.Slot;
};

export type Attempts<Candidate extends TipCandidate> = {
  /** The tip slot each candidate was last asked at. */
  attempted: ReadonlyMap<InFlightTransactionKey, Cardano.Slot>;
  due: Candidate[];
};

/**
 * Asks a candidate once per stored tip slot of its network: the `scan` step
 * of a side effect that asks the provider, so a request the provider could
 * not answer is asked again only once the tip moves.
 */
export const nextAttempts = <Candidate extends TipCandidate>(
  { attempted }: Attempts<Candidate>,
  candidates: Candidate[],
): Attempts<Candidate> => {
  const next = new Map<InFlightTransactionKey, Cardano.Slot>();
  const due: Candidate[] = [];
  for (const candidate of candidates) {
    const lastSlot = attempted.get(candidate.key);
    if (lastSlot === undefined || lastSlot < candidate.tipSlot) {
      due.push(candidate);
      next.set(candidate.key, candidate.tipSlot);
    } else {
      next.set(candidate.key, lastSlot);
    }
  }
  return { attempted: next, due };
};
