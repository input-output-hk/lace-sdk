import { BigNumber } from '@lace-lib/util';
import { describe, expect, it } from 'vitest';

import { toHydraHeadCards } from '../../src/components/hydra-head-cards';

import type {
  HydraHeadsIndexDeposit,
  HydraHeadsIndexHead,
} from '@lace-contract/cardano-context';

const HEAD_ID = '324c8b8198c4c9db7526d6dccb79e992c4863b24b56453bb16995bdc';
const NOW = Date.parse('2026-09-01T12:00:00.000Z');
const MINUTE = 60_000;

const currency = { decimals: 6, ticker: 'tADA' };

const t: Parameters<typeof toHydraHeadCards>[0]['t'] = (key, params) =>
  `${key}${params ? JSON.stringify(params) : ''}`;

const lovelace = (coins: bigint) => ({ coins: BigNumber(coins), assets: {} });

const head = (
  overrides: Partial<HydraHeadsIndexHead>,
): HydraHeadsIndexHead => ({
  headId: HEAD_ID,
  version: '2.0.0',
  outpoint: { txId: 'aa'.repeat(32), index: 0 },
  state: 'open',
  headValue: lovelace(12_000_000n),
  participantCount: 1,
  isParticipant: true,
  isSoleParticipant: true,
  depositedValue: lovelace(10_000_000n),
  withdrawnValue: lovelace(0n),
  ...overrides,
});

const deposit = (
  overrides: Partial<HydraHeadsIndexDeposit>,
): HydraHeadsIndexDeposit => ({
  outpoint: { txId: 'bb'.repeat(32), index: 0 },
  headId: HEAD_ID,
  deadline: new Date(NOW + 60 * MINUTE).toISOString(),
  value: lovelace(4_630_000n),
  status: 'pending',
  ...overrides,
});

const first = (
  heads: HydraHeadsIndexHead[],
  now = NOW,
  deposits: HydraHeadsIndexDeposit[] = [],
) => toHydraHeadCards({ heads, deposits, now, currency, t });

describe('toHydraHeadCards', () => {
  it('shows an open head with its deposited amount and its total', () => {
    const { cards, nextChangeAt } = first([head({})]);

    expect(cards).toEqual([
      {
        headId: HEAD_ID,
        title: 'v2.portfolio.hydra-heads.head{"id":"324c8b81...5bdc"}',
        stateLabel: 'v2.portfolio.hydra-heads.state.open',
        stateTone: 'open',
        amount: 'v2.portfolio.hydra-heads.deposited{"amount":"10 tADA"}',
        amountDetail: 'v2.portfolio.hydra-heads.total{"amount":"12 tADA"}',
        footnote: 'v2.portfolio.hydra-heads.footnote',
        testID: `hydra-head-${HEAD_ID}`,
      },
    ]);
    expect(nextChangeAt).toBeUndefined();
  });

  it('shows the withdrawn amount beside the deposited one, not netted', () => {
    const [card] = first([
      head({ withdrawnValue: lovelace(4_000_000n) }),
    ]).cards;

    expect(card.amount).toBe(
      'v2.portfolio.hydra-heads.amounts{"deposited":"v2.portfolio.hydra-heads.deposited{\\"amount\\":\\"10 tADA\\"}","withdrawn":"v2.portfolio.hydra-heads.withdrawn{\\"amount\\":\\"4 tADA\\"}"}',
    );
  });

  it('adds the other participants of a shared head', () => {
    const [card] = first([
      head({ participantCount: 3, isSoleParticipant: false }),
    ]).cards;

    expect(card.amountDetail).toBe(
      'v2.portfolio.hydra-heads.details{"total":"v2.portfolio.hydra-heads.total{\\"amount\\":\\"12 tADA\\"}","shared":"v2.portfolio.hydra-heads.shared{\\"count\\":2}"}',
    );
  });

  it('names the one other participant of a head shared by two', () => {
    const [card] = first([
      head({ participantCount: 2, isSoleParticipant: false }),
    ]).cards;

    expect(card.amountDetail).toContain(
      'v2.portfolio.hydra-heads.shared{\\"count\\":1}',
    );
  });

  it('names no one else in a head whose every token the account holds', () => {
    const [card] = first([head({ participantCount: 2 })]).cards;

    expect(card.amountDetail).toBe(
      'v2.portfolio.hydra-heads.total{"amount":"12 tADA"}',
    );
  });

  it('shows only the head total when the deposited amount is unknown', () => {
    const [card] = first([
      head({ depositedValue: undefined, withdrawnValue: undefined }),
    ]).cards;

    expect(card.amount).toBe(
      'v2.portfolio.hydra-heads.total{"amount":"12 tADA"}',
    );
    expect(card.amountDetail).toBeUndefined();
  });

  it('leaves out a deposited amount of zero when nothing was withdrawn', () => {
    const [card] = first([
      head({ depositedValue: lovelace(0n), withdrawnValue: lovelace(0n) }),
    ]).cards;

    expect(card.amount).toBe(
      'v2.portfolio.hydra-heads.total{"amount":"12 tADA"}',
    );
    expect(card.amountDetail).toBeUndefined();
  });

  it('still shows a zero deposited amount beside what was withdrawn', () => {
    const [card] = first([
      head({
        depositedValue: lovelace(0n),
        withdrawnValue: lovelace(4_000_000n),
      }),
    ]).cards;

    expect(card.amount).toBe(
      'v2.portfolio.hydra-heads.amounts{"deposited":"v2.portfolio.hydra-heads.deposited{\\"amount\\":\\"0 tADA\\"}","withdrawn":"v2.portfolio.hydra-heads.withdrawn{\\"amount\\":\\"4 tADA\\"}"}',
    );
    expect(card.amountDetail).toBe(
      'v2.portfolio.hydra-heads.total{"amount":"12 tADA"}',
    );
  });

  it('shows a head the account only deposited into the same way', () => {
    const [card] = first([
      head({
        isParticipant: false,
        isSoleParticipant: false,
        participantCount: 2,
      }),
    ]).cards;

    expect(card.amount).toBe(
      'v2.portfolio.hydra-heads.deposited{"amount":"10 tADA"}',
    );
    expect(card.amountDetail).toContain('hydra-heads.participants');
    expect(card.amountDetail).not.toContain('hydra-heads.shared');
  });

  it('counts down to the end of the contestation period of a closed head', () => {
    const deadline = new Date(NOW + 42 * MINUTE).toISOString();
    const { cards, nextChangeAt } = first([
      head({ state: 'closed', contestationDeadline: deadline }),
    ]);

    expect(cards[0].stateTone).toBe('closing');
    expect(cards[0].stateLabel).toBe(
      'v2.portfolio.hydra-heads.state.closing{"time":"v2.portfolio.hydra-heads.duration.minutes{\\"value\\":\\"42\\"}"}',
    );
    expect(nextChangeAt).toBe(NOW + MINUTE);
  });

  it('waits for the payout once the contestation period has ended', () => {
    const deadline = new Date(NOW - MINUTE).toISOString();
    const { cards, nextChangeAt } = first([
      head({ state: 'closed', contestationDeadline: deadline }),
    ]);

    expect(cards[0].stateLabel).toBe('v2.portfolio.hydra-heads.state.closed');
    expect(cards[0].stateTone).toBe('closing');
    expect(nextChangeAt).toBeUndefined();
  });

  it('flips to awaiting payout exactly at the deadline', () => {
    const deadline = new Date(NOW + MINUTE).toISOString();
    const heads = [head({ state: 'closed', contestationDeadline: deadline })];

    expect(first(heads, NOW + MINUTE).cards[0].stateLabel).toBe(
      'v2.portfolio.hydra-heads.state.closed',
    );
  });

  it('shows a head being paid out', () => {
    const [card] = first([
      head({
        state: 'fanningOut',
        contestationDeadline: new Date(NOW - MINUTE).toISOString(),
      }),
    ]).cards;

    expect(card.stateLabel).toBe('v2.portfolio.hydra-heads.state.paying-out');
    expect(card.stateTone).toBe('closing');
  });

  it('leaves out heads that hold no funds any more', () => {
    expect(
      first([head({ state: 'final' }), head({ state: 'initial' })]).cards,
    ).toEqual([]);
  });

  it('schedules the earliest change of several closing heads', () => {
    const { nextChangeAt } = first([
      head({
        headId: 'a'.repeat(56),
        state: 'closed',
        contestationDeadline: new Date(NOW + 90 * MINUTE).toISOString(),
      }),
      head({
        headId: 'b'.repeat(56),
        state: 'closed',
        contestationDeadline: new Date(NOW + 30 * MINUTE + 5_000).toISOString(),
      }),
    ]);

    expect(nextChangeAt).toBe(NOW + 5_000);
  });
});

describe('deposits waiting for a head', () => {
  const pendingLine = (amount: string) => ({
    label: `v2.portfolio.hydra-heads.waiting{"amount":"${amount}"}`,
    tone: 'pending',
  });
  const recoverableLine = (amount: string) => ({
    label: `v2.portfolio.hydra-heads.recoverable{"amount":"${amount}"}`,
    tone: 'recoverable',
  });

  it('sums the pending deposits into one line under nothing absorbed yet', () => {
    const { cards } = first([head({ depositedValue: lovelace(0n) })], NOW, [
      deposit({ value: lovelace(4_630_000n) }),
      deposit({
        outpoint: { txId: 'cc'.repeat(32), index: 1 },
        value: lovelace(1_000_000n),
      }),
    ]);

    expect(cards[0].amount).toBeUndefined();
    expect(cards[0].deposits).toEqual([pendingLine('5.63 tADA')]);
    expect(cards[0].amountDetail).toBe(
      'v2.portfolio.hydra-heads.total{"amount":"12 tADA"}',
    );
  });

  it('sums the deposits past their deadline into a recoverable line', () => {
    const { cards } = first([head({})], NOW, [
      deposit({ deadline: new Date(NOW - MINUTE).toISOString() }),
      deposit({
        deadline: new Date(NOW - 1).toISOString(),
        value: lovelace(2_000_000n),
      }),
    ]);

    expect(cards[0].deposits).toEqual([recoverableLine('6.63 tADA')]);
  });

  it('splits pending and recoverable deposits beside the deposited amount', () => {
    const { cards } = first([head({})], NOW, [
      deposit({ deadline: new Date(NOW).toISOString() }),
      deposit({
        deadline: new Date(NOW - MINUTE).toISOString(),
        value: lovelace(2_000_000n),
      }),
    ]);

    expect(cards[0].amount).toBe(
      'v2.portfolio.hydra-heads.deposited{"amount":"10 tADA"}',
    );
    expect(cards[0].deposits).toEqual([
      pendingLine('4.63 tADA'),
      recoverableLine('2 tADA'),
    ]);
  });

  it('shows a deposit into a head the account does not participate in', () => {
    const { cards, nextChangeAt } = first(
      [
        head({
          isParticipant: false,
          isSoleParticipant: false,
          participantCount: 2,
          depositedValue: lovelace(0n),
          withdrawnValue: lovelace(0n),
        }),
      ],
      NOW,
      [deposit({ value: lovelace(4_630_000n) })],
    );

    expect(cards).toHaveLength(1);
    expect(cards[0].amount).toBeUndefined();
    expect(cards[0].deposits).toEqual([pendingLine('4.63 tADA')]);
    expect(cards[0].amountDetail).toContain(
      'v2.portfolio.hydra-heads.participants{\\"count\\":2}',
    );
    expect(nextChangeAt).toBe(NOW + 60 * MINUTE + 1);
  });

  it('ignores deposits for heads without a card', () => {
    const { cards, nextChangeAt } = first([head({})], NOW, [
      deposit({ headId: 'f'.repeat(56) }),
    ]);

    expect(cards[0].deposits).toBeUndefined();
    expect(nextChangeAt).toBeUndefined();
  });

  it('changes right after the deadline of a pending deposit', () => {
    const deadline = NOW + 90 * MINUTE;
    const deposits = [deposit({ deadline: new Date(deadline).toISOString() })];

    expect(first([head({})], NOW, deposits).nextChangeAt).toBe(deadline + 1);
    expect(first([head({})], deadline + 1, deposits).cards[0].deposits).toEqual(
      [recoverableLine('4.63 tADA')],
    );
    expect(
      first([head({})], deadline + 1, deposits).nextChangeAt,
    ).toBeUndefined();
  });

  it('schedules the earlier of a countdown and a deposit deadline', () => {
    const { nextChangeAt } = first(
      [
        head({
          state: 'closed',
          contestationDeadline: new Date(NOW + 90 * MINUTE).toISOString(),
        }),
      ],
      NOW,
      [deposit({ deadline: new Date(NOW + 10_000).toISOString() })],
    );

    expect(nextChangeAt).toBe(NOW + 10_001);
  });
});

describe('remaining time of a closing head', () => {
  const format = (ms: number) =>
    first([
      head({
        state: 'closed',
        contestationDeadline: new Date(NOW + ms).toISOString(),
      }),
    ]).cards[0].stateLabel;
  const closing = (time: string) =>
    `v2.portfolio.hydra-heads.state.closing${JSON.stringify({ time })}`;
  const unit = (name: string, value: number) =>
    `v2.portfolio.hydra-heads.duration.${name}{"value":"${value}"}`;
  const pair = (major: string, minor: string) =>
    `v2.portfolio.hydra-heads.duration.pair${JSON.stringify({ major, minor })}`;

  it('rounds a partial minute up', () => {
    expect(format(1)).toBe(closing(unit('minutes', 1)));
    expect(format(61 * 1000)).toBe(closing(unit('minutes', 2)));
  });

  it('shows hours with the minutes left over', () => {
    expect(format(65 * MINUTE)).toBe(
      closing(pair(unit('hours', 1), unit('minutes', 5))),
    );
    expect(format(120 * MINUTE)).toBe(closing(unit('hours', 2)));
  });

  it('shows days with the hours left over', () => {
    expect(format((26 * 60 + 10) * MINUTE)).toBe(
      closing(pair(unit('days', 1), unit('hours', 2))),
    );
    expect(format(48 * 60 * MINUTE)).toBe(closing(unit('days', 2)));
  });
});
