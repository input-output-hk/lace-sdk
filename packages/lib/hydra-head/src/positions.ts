import { getHydraDepositStatus } from './deposits';
import { EMPTY_HYDRA_VALUE, addHydraValues } from './utxo';

import type {
  HydraHeadPosition,
  HydraHeadPositions,
  HydraHeadStateName,
  HydraLiveHeadStateName,
  HydraPositionDeposit,
  HydraPositionHead,
  HydraWaitingDeposits,
} from './types';

/** True for a state in which the head still holds funds. */
const isLiveState = (
  state: HydraHeadStateName,
): state is HydraLiveHeadStateName =>
  state === 'open' || state === 'closed' || state === 'fanningOut';

/**
 * Participants of the head other than the account. An account may hold
 * every participation token of a head, so holding one does not by itself
 * leave the others at one less than the total.
 */
const otherParticipantCountOf = ({
  isParticipant,
  isSoleParticipant,
  participantCount,
}: HydraPositionHead): number => {
  if (isSoleParticipant) return 0;
  return isParticipant ? participantCount - 1 : participantCount;
};

/** Sums the deposits by their status at `now`, in epoch milliseconds. */
const sumWaitingDeposits = (
  deposits: readonly HydraPositionDeposit[],
  now: number,
): HydraWaitingDeposits => {
  let pending = EMPTY_HYDRA_VALUE;
  let recoverable = EMPTY_HYDRA_VALUE;
  for (const { deadline, value } of deposits) {
    if (getHydraDepositStatus(deadline, now) === 'pending') {
      pending = addHydraValues(pending, value);
    } else {
      recoverable = addHydraValues(recoverable, value);
    }
  }
  return { pending, recoverable };
};

/**
 * The instants after `now` at which a position changes: when a closed head's
 * contestation period ends, and when a pending deposit becomes recoverable,
 * which is strictly after its deadline.
 */
const changesAfter = (
  heads: readonly HydraHeadPosition[],
  deposits: readonly HydraPositionDeposit[],
  now: number,
): number[] =>
  [
    ...heads.flatMap(({ state, contestationDeadline }) =>
      state === 'closed' && contestationDeadline !== undefined
        ? [contestationDeadline]
        : [],
    ),
    ...deposits.map(({ deadline }) => deadline + 1),
  ].filter(change => change > now);

/**
 * Tells where one account stands in each head it has funds in, as of `now`.
 *
 * A head is listed while it still holds funds: open, closed, or fanning out.
 * Every such head given is listed, so a head the account only deposited
 * into, whose deposit the head has not absorbed yet, is listed too, even
 * when nothing has been credited to the account so far. Heads not yet opened
 * or already paid out are left out. So are the deposits for heads not listed:
 * anyone can lock a deposit naming any head id, so a deposit is shown only
 * beside a live head the caller has proven genuine and passed in.
 *
 * The deposits are summed by their status at `now` rather than the status
 * stored when they were found, which goes stale once the deadline passes.
 * The instants in a position are epoch milliseconds, like `now`. Formatting,
 * such as the remaining time of a closing head, is left to the caller; see
 * `toHydraHeadCards` for what a card of each position says.
 *
 * @param heads - The account's heads, each with its funds when known.
 * @param deposits - The account's deposits still at the deposit validator.
 * @param now - Instant the positions are computed for, in epoch milliseconds.
 */
export const toHydraHeadPositions = ({
  heads,
  deposits,
  now,
}: {
  heads: readonly HydraPositionHead[];
  deposits: readonly HydraPositionDeposit[];
  now: number;
}): HydraHeadPositions => {
  const depositsByHeadId = new Map<string, HydraPositionDeposit[]>();
  for (const deposit of deposits) {
    depositsByHeadId.set(deposit.headId, [
      ...(depositsByHeadId.get(deposit.headId) ?? []),
      deposit,
    ]);
  }
  const positions = heads.flatMap((head): HydraHeadPosition[] => {
    const { headId, state, contestationDeadline, headValue, funds } = head;
    if (!isLiveState(state)) return [];
    return [
      {
        headId,
        state,
        ...(contestationDeadline === undefined ? {} : { contestationDeadline }),
        headValue,
        isParticipant: head.isParticipant,
        otherParticipantCount: otherParticipantCountOf(head),
        ...(funds === undefined ? {} : { funds }),
        waitingDeposits: sumWaitingDeposits(
          depositsByHeadId.get(headId) ?? [],
          now,
        ),
      },
    ];
  });
  const shownHeadIds = new Set(positions.map(({ headId }) => headId));
  const changes = changesAfter(
    positions,
    deposits.filter(({ headId }) => shownHeadIds.has(headId)),
    now,
  );
  return changes.length > 0
    ? { heads: positions, nextChangeAt: Math.min(...changes) }
    : { heads: positions };
};
