import { HYDRA_HEAD_HISTORY_LIMITS } from './constants';
import { findAccountHydraDeposits } from './deposits';
import { findAccountHydraHeads, findHydraHeadsById } from './heads';
import { getHydraScriptRegistry } from './registry';

import type { HydraHeadHistoryLimits } from './constants';
import type {
  HydraAccountDeposit,
  HydraAccountHead,
  HydraHeadFunds,
  HydraUtxo,
} from './types';
import type { Cardano } from '@lace-lib/cardano-core';

/**
 * How a validator address is read: pages of `pageSize` UTxOs, at most
 * `maxPages` of them. Unspendable outputs pile up at script addresses, so
 * this bounds a sweep at one request per page, at most 17 x 20 = 340
 * requests over the 17 distinct addresses of a network, whatever the
 * network-wide Hydra usage.
 */
export const HYDRA_VALIDATOR_READ_LIMITS = {
  pageSize: 100,
  maxPages: 20,
} as const;

/**
 * Every distinct head and deposit validator address of a network. Several
 * releases share a deposit validator, so it is listed once.
 */
export const getHydraValidatorAddresses = (
  networkId: Cardano.NetworkId,
): string[] => [
  ...new Set(
    getHydraScriptRegistry(networkId).flatMap(
      ({ headAddress, depositAddress }) =>
        depositAddress === undefined
          ? [headAddress]
          : [headAddress, depositAddress],
    ),
  ),
];

/** One read of a validator address; `utxos` is absent when it failed. */
export interface HydraValidatorRead<U> {
  readonly address: string;
  readonly utxos?: readonly U[];
}

/** What a sweep goes on from once every validator address was read. */
export interface HydraValidatorReads<U> {
  /**
   * The UTxOs of every address read now, or standing in with what its
   * last successful read found.
   */
  readonly utxosByAddress: ReadonlyMap<string, readonly U[]>;
  /**
   * The addresses whose read failed with nothing to stand in for them. The
   * sweep is partial while any is left: the deposits and heads there are
   * unknown, not gone.
   */
  readonly unreadAddresses: readonly string[];
}

/**
 * Settles the reads of every validator address of a sweep. A read that
 * fails, or fills its last allowed page and so may hold more, stands in
 * with `keptReadOf(address)`, so only the deposits and heads there go stale
 * and no figure is built from a partial listing. An address with nothing
 * kept is unread.
 *
 * @param reads - One read per validator address.
 * @param keptReadOf - The UTxOs the last successful read of an address
 * found, or undefined when it was never read.
 * @returns undefined when every address failed, since nothing is current
 */
export const settleHydraValidatorReads = <U>(
  reads: readonly HydraValidatorRead<U>[],
  keptReadOf: (address: string) => readonly U[] | undefined,
): HydraValidatorReads<U> | undefined => {
  const { pageSize, maxPages } = HYDRA_VALIDATOR_READ_LIMITS;
  const isComplete = (utxos: readonly U[] | undefined): utxos is readonly U[] =>
    utxos !== undefined && utxos.length < pageSize * maxPages;
  if (!reads.some(({ utxos }) => isComplete(utxos))) return undefined;
  const utxosByAddress = new Map<string, readonly U[]>();
  const unreadAddresses: string[] = [];
  for (const { address, utxos } of reads) {
    const read = isComplete(utxos) ? utxos : keptReadOf(address);
    if (read) {
      utxosByAddress.set(address, read);
    } else {
      unreadAddresses.push(address);
    }
  }
  return { utxosByAddress, unreadAddresses };
};

/** The deposits and heads one account has at the Hydra validators. */
export interface HydraAccountMatch {
  readonly deposits: readonly HydraAccountDeposit[];
  /** Heads the account holds a participation token in. */
  readonly heads: readonly HydraAccountHead[];
  /**
   * Live heads the account deposited into without a participation token,
   * named by its own deposits or by earlier sweeps. Only hints until a head
   * history confirms a deposit for the account.
   */
  readonly candidateHeads: readonly HydraAccountHead[];
}

/**
 * Matches the UTxOs at the Hydra validators of a network to one account.
 *
 * @param utxos - UTxOs read from every Hydra validator address.
 * @param paymentKeyHashes - Hex payment key hashes of the account.
 * @param candidateHeadIds - Heads the account may have deposited into
 * without a participation token. Ids naming no live head find nothing.
 * @param now - Instant the deposit status is computed for, in epoch
 * milliseconds.
 */
export const matchAccountHydra = ({
  utxos,
  paymentKeyHashes,
  candidateHeadIds,
  now,
}: {
  utxos: readonly HydraUtxo[];
  paymentKeyHashes: readonly string[];
  candidateHeadIds: Iterable<string>;
  now: number;
}): HydraAccountMatch => {
  const heads = findAccountHydraHeads(utxos, paymentKeyHashes);
  const participated = new Set(heads.map(({ headId }) => headId));
  return {
    deposits: findAccountHydraDeposits(utxos, paymentKeyHashes, now),
    heads,
    candidateHeads: findHydraHeadsById(
      utxos,
      [...candidateHeadIds].filter(headId => !participated.has(headId)),
      paymentKeyHashes,
    ),
  };
};

/** An activity of the account, as far as its deposit hint goes. */
export interface HydraDepositHint {
  /** True when the account's own coin went down. */
  readonly isSent: boolean;
  readonly txName?: string;
  readonly headId?: string;
}

/**
 * The ids of the heads named by deposits the account sent itself. Only
 * activities where the account's own coin went down count, which needs
 * inputs of its own, so a third party cannot make the account read a head
 * by paying it a transaction that also deposits into that head. The head id
 * is still a hint, used only to pick which live heads to check.
 */
export const findHydraDepositedHeadIds = (
  hints: Iterable<HydraDepositHint>,
): string[] => [
  ...new Set(
    [...hints].flatMap(({ isSent, txName, headId }) =>
      isSent && txName === 'DepositTx' && headId ? [headId] : [],
    ),
  ),
];

/** What a sweep knows of the heads of one account when it picks some. */
export interface HydraHeadPick {
  /** Heads named by the account's own deposits. */
  readonly depositedHeadIds: ReadonlySet<string>;
  /**
   * The verdict of each head checked so far: genuine (true) or a lookalike
   * (false).
   */
  readonly genuineByHeadId: ReadonlyMap<string, boolean>;
  /** `HYDRA_HEAD_HISTORY_LIMITS` unless given. */
  readonly limits?: HydraHeadHistoryLimits;
}

/**
 * The heads of one account in the order they are preferred, without the
 * known lookalikes: heads named by the account's own deposits first, whether
 * or not it also participates in them, since anyone can place a head naming
 * the account's key hash. Each group is taken in head id order, so the order
 * the validator addresses were read in does not change which heads are
 * picked.
 */
const inPreferredOrder = (
  { heads, candidateHeads }: HydraAccountMatch,
  { depositedHeadIds, genuineByHeadId }: HydraHeadPick,
): HydraAccountHead[] => {
  const found = [...heads, ...candidateHeads]
    .filter(({ headId }) => genuineByHeadId.get(headId) !== false)
    .sort((a, b) => a.headId.localeCompare(b.headId));
  return [
    ...found.filter(({ headId }) => depositedHeadIds.has(headId)),
    ...found.filter(({ headId }) => !depositedHeadIds.has(headId)),
  ];
};

/**
 * The heads of one account whose minting script is checked: the first
 * `maxHeadChecksPerAccount` heads without a verdict, in the preferred order.
 * A head with a verdict, genuine or lookalike, costs no check and takes no
 * place, so each head is checked once and many heads can only delay the
 * first check of a later one.
 */
export const selectHydraHeadsToCheck = (
  match: HydraAccountMatch,
  pick: HydraHeadPick,
): HydraAccountHead[] =>
  inPreferredOrder(match, pick)
    .filter(({ headId }) => !pick.genuineByHeadId.has(headId))
    .slice(
      0,
      (pick.limits ?? HYDRA_HEAD_HISTORY_LIMITS).maxHeadChecksPerAccount,
    );

/**
 * The heads of one account whose history is read: the first
 * `maxHeadsPerAccount` genuine heads in the preferred order. Lookalikes and
 * heads not verified yet take no place.
 */
export const selectHydraHeadsToRead = (
  match: HydraAccountMatch,
  pick: HydraHeadPick,
): HydraAccountHead[] =>
  inPreferredOrder(match, pick)
    .filter(({ headId }) => pick.genuineByHeadId.get(headId) === true)
    .slice(0, (pick.limits ?? HYDRA_HEAD_HISTORY_LIMITS).maxHeadsPerAccount);

/** True when the figures show the head absorbed something for the account. */
const hasDeposit = ({ deposited }: HydraHeadFunds): boolean =>
  deposited.coins > 0n ||
  [...deposited.assets.values()].some(quantity => quantity > 0n);

/**
 * Settles which heads of one account are listed once the minting scripts
 * are checked and the head histories read.
 *
 * Only genuine heads are listed: a lookalike is listed nowhere and a head
 * not verified yet waits for its verdict. Every genuine head the account
 * participates in is listed. A genuine head it only deposited into is
 * listed while a deposit of the account waits for it, once its figures
 * attribute a deposit to the account, and, without figures, while the
 * previous settle listed it, so it does not flicker while a new head step
 * is being indexed. Its id is kept while a deposit waits for it, or its
 * figures are missing or attribute a deposit to the account, and it is not
 * a lookalike.
 *
 * @param match - The heads matched to the account and its deposits.
 * @param genuineByHeadId - The verdict of each head checked so far.
 * @param fundsByHeadId - The figures of each head whose history was read
 * and ends at the head UTxO found, from `getHydraHeadAccountFunds`.
 * @param listedHeadIds - The deposit-only heads the previous settle listed.
 * @returns the heads to list, the participated ones first, and the ids of
 * the deposit-only heads to keep
 */
export const settleHydraAccountHeads = <
  H extends Pick<HydraAccountHead, 'headId'>,
>({
  heads,
  candidateHeads,
  waitingHeadIds,
  genuineByHeadId,
  fundsByHeadId,
  listedHeadIds,
}: {
  heads: readonly H[];
  candidateHeads: readonly H[];
  /** The heads a deposit of the account waits for. */
  waitingHeadIds: ReadonlySet<string>;
  genuineByHeadId: ReadonlyMap<string, boolean>;
  fundsByHeadId: ReadonlyMap<string, HydraHeadFunds | undefined>;
  listedHeadIds: ReadonlySet<string>;
}): { heads: H[]; depositedHeadIds: string[] } => {
  const isGenuine = ({ headId }: H) => genuineByHeadId.get(headId) === true;
  const deposited = candidateHeads
    .filter(({ headId }) => genuineByHeadId.get(headId) !== false)
    .map(head => ({
      head,
      funds: fundsByHeadId.get(head.headId),
      isWaiting: waitingHeadIds.has(head.headId),
    }));
  return {
    heads: [
      ...heads.filter(isGenuine),
      ...deposited
        .filter(
          ({ head, funds, isWaiting }) =>
            isGenuine(head) &&
            (isWaiting ||
              (funds ? hasDeposit(funds) : listedHeadIds.has(head.headId))),
        )
        .map(({ head }) => head),
    ],
    depositedHeadIds: deposited
      .filter(
        ({ funds, isWaiting }) => isWaiting || !funds || hasDeposit(funds),
      )
      .map(({ head }) => head.headId),
  };
};
