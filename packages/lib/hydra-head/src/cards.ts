import { toHydraHeadPositions } from './positions';

import type {
  HydraHeadCard,
  HydraHeadCardState,
  HydraHeadCards,
  HydraHeadPosition,
  HydraPositionDeposit,
  HydraPositionHead,
  HydraRemainingTime,
} from './types';

const MS_PER_MINUTE = 60_000;
const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 24 * MINUTES_PER_HOUR;

/** Splits the time left into whole days, hours and minutes, at least one minute. */
const remainingTimeOf = (remainingMs: number): HydraRemainingTime => {
  const totalMinutes = Math.max(1, Math.ceil(remainingMs / MS_PER_MINUTE));
  return {
    days: Math.floor(totalMinutes / MINUTES_PER_DAY),
    hours: Math.floor((totalMinutes % MINUTES_PER_DAY) / MINUTES_PER_HOUR),
    minutes: totalMinutes % MINUTES_PER_HOUR,
  };
};

/**
 * What the head is doing. A closed head counts down to the end of its
 * contestation period, after which it waits for its funds to be paid out. A
 * head paying out has no time left to show.
 */
const stateOf = (
  { state, contestationDeadline }: HydraHeadPosition,
  now: number,
): HydraHeadCardState => {
  if (state === 'open') return { kind: 'open' };
  if (state === 'closed') {
    return contestationDeadline !== undefined && now < contestationDeadline
      ? {
          kind: 'closing',
          remaining: remainingTimeOf(contestationDeadline - now),
        }
      : { kind: 'closed' };
  }
  return { kind: 'payingOut' };
};

/**
 * The lovelace put into the head for the account and, when some was taken
 * out again, what was withdrawn, side by side rather than netted. Undefined
 * when the head's history could not be read, so no figure is guessed, and
 * when nothing went in or came out, so no zero figure is shown.
 */
const fundsOf = ({ funds }: HydraHeadPosition): HydraHeadCard['funds'] => {
  if (funds === undefined) return undefined;
  const { deposited, withdrawn } = funds;
  if (deposited.coins === 0n && withdrawn.coins === 0n) return undefined;
  return withdrawn.coins > 0n
    ? { deposited: deposited.coins, withdrawn: withdrawn.coins }
    : { deposited: deposited.coins };
};

/**
 * The lovelace of the deposits waiting for the head, by status, each when
 * there is any. Undefined when none waits.
 */
const waitingOf = ({
  waitingDeposits: { pending, recoverable },
}: HydraHeadPosition): HydraHeadCard['waiting'] => {
  if (pending.coins === 0n && recoverable.coins === 0n) return undefined;
  return {
    ...(pending.coins > 0n ? { pending: pending.coins } : {}),
    ...(recoverable.coins > 0n ? { recoverable: recoverable.coins } : {}),
  };
};

/**
 * Who else is in the head: the other participants of a head the account
 * shares, or every participant of a head it only deposited into. Undefined
 * when nobody else is.
 */
const participantsOf = ({
  isParticipant,
  otherParticipantCount,
}: HydraHeadPosition): HydraHeadCard['participants'] =>
  otherParticipantCount === 0
    ? undefined
    : { count: otherParticipantCount, isShared: isParticipant };

/**
 * The instant a closing head's countdown next drops by a whole minute, which
 * at the last minute is the end of its contestation period.
 */
const nextCountdownChange = (
  { state, contestationDeadline }: HydraHeadPosition,
  now: number,
): number | undefined => {
  if (state !== 'closed' || contestationDeadline === undefined) return;
  if (now >= contestationDeadline) return;
  const remainingMinutes = Math.ceil(
    (contestationDeadline - now) / MS_PER_MINUTE,
  );
  return contestationDeadline - (remainingMinutes - 1) * MS_PER_MINUTE;
};

/** The card of one position, as of `now`. */
const toCard = (position: HydraHeadPosition, now: number): HydraHeadCard => {
  const funds = fundsOf(position);
  const waiting = waitingOf(position);
  const participants = participantsOf(position);
  return {
    headId: position.headId,
    state: stateOf(position, now),
    total: position.headValue.coins,
    ...(funds === undefined ? {} : { funds }),
    ...(waiting === undefined ? {} : { waiting }),
    ...(participants === undefined ? {} : { participants }),
    leadsWithFunds: funds !== undefined || waiting !== undefined,
  };
};

/**
 * Tells what the card of each head the account has funds in says, as of
 * `now`, from the positions `toHydraHeadPositions` gives for the same heads
 * and deposits. A card leads with the account's own figures, what the head
 * absorbed for it and its deposits still waiting, when it has any, and with
 * the head total otherwise. Wording and number formatting are left to the
 * caller, which gives both wallet stacks and SDK consumers the same figures.
 *
 * @param heads - The account's heads, each with its funds when known.
 * @param deposits - The account's deposits still at the deposit validator.
 * @param now - Instant the cards are computed for, in epoch milliseconds.
 */
export const toHydraHeadCards = ({
  heads,
  deposits,
  now,
}: {
  heads: readonly HydraPositionHead[];
  deposits: readonly HydraPositionDeposit[];
  now: number;
}): HydraHeadCards => {
  const positions = toHydraHeadPositions({ heads, deposits, now });
  const changes = positions.heads
    .map(position => nextCountdownChange(position, now))
    .filter((change): change is number => change !== undefined);
  if (positions.nextChangeAt !== undefined)
    changes.push(positions.nextChangeAt);
  const cards = positions.heads.map(position => toCard(position, now));
  return changes.length > 0
    ? { cards, nextChangeAt: Math.min(...changes) }
    : { cards };
};
