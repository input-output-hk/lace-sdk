/** Transaction metadata label under which every Hydra node transaction is tagged. */
export const HYDRA_METADATA_LABEL = 55_555n;

/**
 * Hex asset names of the head state token, keyed by the first protocol
 * generation that uses them. The policy id of this token is the head id.
 */
export const HYDRA_HEAD_STATE_TOKEN_NAMES = {
  /** hex of `HydraHeadV1`, used by Hydra up to 1.3.0. */
  v1: '4879647261486561645631',
  /** hex of `HydraHeadV2`, used by Hydra from 2.0.0. */
  v2: '4879647261486561645632',
} as const;

/**
 * Bounds on the layer 1 reads a consumer makes to reconstruct what its
 * heads absorbed for an account's keys and paid back to them. Each bound is counted per head or per
 * account, never per transaction, so the reads a head costs add up rather
 * than multiply.
 */
export type HydraHeadHistoryLimits = Readonly<{
  /**
   * Transactions of a head's history read at most. A history that reaches
   * this length is not read any further, now or on later reads.
   */
  maxTransactionsPerHead: number;
  /**
   * Spent inputs of a head's history that were produced outside it, such as
   * deposits and commits, that are read at most. Each costs one read where
   * the transaction read does not include the spent output. Reading stops
   * before the transaction that would go past it.
   */
  maxResolvedInputsPerHead: number;
  /**
   * Genuine heads of one account whose history is read in one sweep. Further
   * genuine heads the account participates in are listed without figures.
   */
  maxHeadsPerAccount: number;
  /**
   * Heads of one account without a kept verdict whose minting script is
   * checked in one sweep. A head whose verdict is kept, genuine or not,
   * costs no check.
   */
  maxHeadChecksPerAccount: number;
}>;

/**
 * The bounds every consumer applies. Anyone can place a lookalike head that
 * names an account's key hash, with a history as long as they like, so each
 * read stops at these bounds and the heads past them get no figures. Real
 * heads stay far below them.
 */
export const HYDRA_HEAD_HISTORY_LIMITS: HydraHeadHistoryLimits = {
  maxTransactionsPerHead: 200,
  maxResolvedInputsPerHead: 100,
  maxHeadsPerAccount: 10,
  maxHeadChecksPerAccount: 30,
};
