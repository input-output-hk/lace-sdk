import { describe, expect, it } from 'vitest';

import { toHydraHeadCards } from '../src';

import type {
  HydraPositionDeposit,
  HydraPositionHead,
  HydraValue,
} from '../src';

const HEAD_ID = '324c8b8198c4c9db7526d6dccb79e992c4863b24b56453bb16995bdc';
const NOW = Date.parse('2026-09-01T12:00:00.000Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const at = (offsetMs: number) => NOW + offsetMs;

const lovelace = (coins: bigint): HydraValue => ({ coins, assets: new Map() });

const funds = (deposited: bigint, withdrawn = 0n) => ({
  deposited: lovelace(deposited),
  withdrawn: lovelace(withdrawn),
});

const head = (
  overrides: Partial<HydraPositionHead> = {},
): HydraPositionHead => ({
  headId: HEAD_ID,
  state: 'open',
  headValue: lovelace(12_000_000n),
  participantCount: 1,
  isParticipant: true,
  isSoleParticipant: true,
  funds: funds(10_000_000n),
  ...overrides,
});

const deposit = (
  overrides: Partial<HydraPositionDeposit> = {},
): HydraPositionDeposit => ({
  headId: HEAD_ID,
  deadline: at(HOUR),
  value: lovelace(4_630_000n),
  ...overrides,
});

const cardsOf = (
  heads: HydraPositionHead[],
  deposits: HydraPositionDeposit[] = [],
  now = NOW,
) => toHydraHeadCards({ heads, deposits, now });

describe('toHydraHeadCards', () => {
  it('leads an open head with what was deposited and demotes the total', () => {
    expect(cardsOf([head()])).toEqual({
      cards: [
        {
          headId: HEAD_ID,
          state: { kind: 'open' },
          total: 12_000_000n,
          funds: { deposited: 10_000_000n },
          leadsWithFunds: true,
        },
      ],
    });
  });

  it('shows the withdrawn lovelace beside the deposited, not netted', () => {
    const [card] = cardsOf([
      head({ funds: funds(10_000_000n, 4_000_000n) }),
    ]).cards;

    expect(card.funds).toEqual({
      deposited: 10_000_000n,
      withdrawn: 4_000_000n,
    });
  });

  it('leads with the total when the history could not be read', () => {
    const [card] = cardsOf([head({ funds: undefined })]).cards;

    expect(card).not.toHaveProperty('funds');
    expect(card.leadsWithFunds).toBe(false);
  });

  it('leaves out a deposited figure of zero unless something was withdrawn', () => {
    const [nothing, withdrawn] = cardsOf([
      head({ funds: funds(0n) }),
      head({ headId: 'bb', funds: funds(0n, 4_000_000n) }),
    ]).cards;

    expect(nothing).not.toHaveProperty('funds');
    expect(nothing.leadsWithFunds).toBe(false);
    expect(withdrawn.funds).toEqual({ deposited: 0n, withdrawn: 4_000_000n });
    expect(withdrawn.leadsWithFunds).toBe(true);
  });

  it('counts the other participants of a shared head', () => {
    const [shared, sole] = cardsOf([
      head({ participantCount: 3, isSoleParticipant: false }),
      head({ headId: 'bb', participantCount: 2 }),
    ]).cards;

    expect(shared.participants).toEqual({ count: 2, isShared: true });
    expect(sole).not.toHaveProperty('participants');
  });

  it('counts every participant of a head the account only deposited into', () => {
    const [card] = cardsOf([
      head({
        participantCount: 2,
        isParticipant: false,
        isSoleParticipant: false,
      }),
    ]).cards;

    expect(card.participants).toEqual({ count: 2, isShared: false });
  });

  it('counts down to the end of the contestation period of a closed head', () => {
    const { cards, nextChangeAt } = cardsOf([
      head({ state: 'closed', contestationDeadline: at(42 * MINUTE) }),
    ]);

    expect(cards[0].state).toEqual({
      kind: 'closing',
      remaining: { days: 0, hours: 0, minutes: 42 },
    });
    expect(nextChangeAt).toBe(NOW + MINUTE);
  });

  it.each([
    [30_000, { days: 0, hours: 0, minutes: 1 }],
    [65 * MINUTE, { days: 0, hours: 1, minutes: 5 }],
    [HOUR, { days: 0, hours: 1, minutes: 0 }],
    [27 * HOUR, { days: 1, hours: 3, minutes: 0 }],
    [48 * HOUR + 1, { days: 2, hours: 0, minutes: 1 }],
  ])(
    'splits %i ms left into whole units, rounding a partial minute up',
    (remainingMs, remaining) => {
      const [card] = cardsOf([
        head({ state: 'closed', contestationDeadline: at(remainingMs) }),
      ]).cards;

      expect(card.state).toEqual({ kind: 'closing', remaining });
    },
  );

  it('waits for the payout from the end of the contestation period on', () => {
    const closed = head({ state: 'closed', contestationDeadline: at(MINUTE) });

    expect(cardsOf([closed], [], NOW + MINUTE).cards[0].state).toEqual({
      kind: 'closed',
    });
    expect(cardsOf([closed], [], NOW + MINUTE)).not.toHaveProperty(
      'nextChangeAt',
    );
  });

  it('shows a head being paid out', () => {
    const [card] = cardsOf([
      head({ state: 'fanningOut', contestationDeadline: at(-MINUTE) }),
    ]).cards;

    expect(card.state).toEqual({ kind: 'payingOut' });
  });

  it('leaves out heads that hold no funds', () => {
    expect(
      cardsOf([head({ state: 'final' }), head({ state: 'initial' })]).cards,
    ).toEqual([]);
  });

  it('changes next when the earliest closing head drops a whole minute', () => {
    const { nextChangeAt } = cardsOf([
      head({
        headId: 'aa',
        state: 'closed',
        contestationDeadline: at(90 * MINUTE),
      }),
      head({
        headId: 'bb',
        state: 'closed',
        contestationDeadline: at(30 * MINUTE + 5_000),
      }),
    ]);

    expect(nextChangeAt).toBe(NOW + 5_000);
  });

  describe('deposits waiting for a head', () => {
    it('sums the pending deposits and leads with them when nothing was absorbed yet', () => {
      const [card] = cardsOf(
        [head({ funds: funds(0n) })],
        [deposit(), deposit({ value: lovelace(1_000_000n) })],
      ).cards;

      expect(card).not.toHaveProperty('funds');
      expect(card.waiting).toEqual({ pending: 5_630_000n });
      expect(card.leadsWithFunds).toBe(true);
    });

    it('sums the deposits past their deadline as recoverable', () => {
      const [card] = cardsOf(
        [head()],
        [
          deposit({ deadline: at(-MINUTE) }),
          deposit({ deadline: at(-1), value: lovelace(2_000_000n) }),
        ],
      ).cards;

      expect(card.waiting).toEqual({ recoverable: 6_630_000n });
    });

    it('keeps pending and recoverable deposits apart beside the deposited figure', () => {
      const [card] = cardsOf(
        [head({ funds: funds(40_000_000n) })],
        [
          deposit({ deadline: at(0) }),
          deposit({ deadline: at(-MINUTE), value: lovelace(2_000_000n) }),
        ],
      ).cards;

      expect(card.funds).toEqual({ deposited: 40_000_000n });
      expect(card.waiting).toEqual({
        pending: 4_630_000n,
        recoverable: 2_000_000n,
      });
    });

    it('shows a deposit into a head the account does not participate in', () => {
      const [card] = cardsOf(
        [
          head({
            funds: funds(0n),
            participantCount: 1,
            isParticipant: false,
            isSoleParticipant: false,
          }),
        ],
        [deposit()],
      ).cards;

      expect(card).toMatchObject({
        waiting: { pending: 4_630_000n },
        participants: { count: 1, isShared: false },
        leadsWithFunds: true,
      });
    });

    it('ignores deposits for heads without a card', () => {
      const { cards, nextChangeAt } = cardsOf(
        [head(), head({ headId: 'ee', state: 'final' })],
        [deposit({ headId: 'ff' }), deposit({ headId: 'ee' })],
      );

      expect(cards).toHaveLength(1);
      expect(cards[0]).not.toHaveProperty('waiting');
      expect(nextChangeAt).toBeUndefined();
    });

    it('changes next right after a pending deposit deadline', () => {
      const deadline = NOW + 90 * MINUTE;
      const deposits = [deposit({ deadline })];

      expect(cardsOf([head()], deposits).nextChangeAt).toBe(deadline + 1);
      expect(cardsOf([head()], deposits, deadline).nextChangeAt).toBe(
        deadline + 1,
      );
      expect(cardsOf([head()], deposits, deadline + 1)).not.toHaveProperty(
        'nextChangeAt',
      );
    });

    it('changes next at the earlier of a countdown step and a deposit deadline', () => {
      const closing = head({
        state: 'closed',
        contestationDeadline: at(90 * MINUTE),
      });

      expect(
        cardsOf([closing], [deposit({ deadline: at(10_000) })]).nextChangeAt,
      ).toBe(NOW + 10_001);
    });
  });
});
