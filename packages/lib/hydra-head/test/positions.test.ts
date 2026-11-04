import { describe, expect, it } from 'vitest';

import { toHydraHeadPositions } from '../src';

import type {
  HydraPositionDeposit,
  HydraPositionHead,
  HydraValue,
} from '../src';

const HEAD_ID = '324c8b8198c4c9db7526d6dccb79e992c4863b24b56453bb16995bdc';
const OTHER_HEAD_ID =
  'd7f3a349772cb36206c2005f108b77bdad46da96b1a6378702feed00';
const ASSET = `${'ab'.repeat(28)}746f6b656e`;
const NOW = Date.parse('2026-09-01T12:00:00.000Z');
const MINUTE = 60_000;

const at = (offsetMs: number) => NOW + offsetMs;

const lovelace = (coins: bigint): HydraValue => ({ coins, assets: new Map() });

const EMPTY = lovelace(0n);

const head = (
  overrides: Partial<HydraPositionHead> = {},
): HydraPositionHead => ({
  headId: HEAD_ID,
  state: 'open',
  headValue: lovelace(12_000_000n),
  participantCount: 1,
  isParticipant: true,
  isSoleParticipant: true,
  funds: { deposited: lovelace(10_000_000n), withdrawn: EMPTY },
  ...overrides,
});

const deposit = (
  overrides: Partial<HydraPositionDeposit> = {},
): HydraPositionDeposit => ({
  headId: HEAD_ID,
  deadline: at(60 * MINUTE),
  value: lovelace(4_630_000n),
  ...overrides,
});

describe('toHydraHeadPositions', () => {
  it('lists an open head with its funds and no waiting deposits', () => {
    const positions = toHydraHeadPositions({
      heads: [head()],
      deposits: [],
      now: NOW,
    });

    expect(positions).toEqual({
      heads: [
        {
          headId: HEAD_ID,
          state: 'open',
          headValue: lovelace(12_000_000n),
          isParticipant: true,
          otherParticipantCount: 0,
          funds: { deposited: lovelace(10_000_000n), withdrawn: EMPTY },
          waitingDeposits: { pending: EMPTY, recoverable: EMPTY },
        },
      ],
    });
  });

  it('lists closed and fanning out heads and leaves out the others', () => {
    const { heads } = toHydraHeadPositions({
      heads: [
        head({ headId: 'aa', state: 'initial' }),
        head({ headId: 'bb', state: 'closed', contestationDeadline: at(1) }),
        head({
          headId: 'cc',
          state: 'fanningOut',
          contestationDeadline: at(-1),
        }),
        head({ headId: 'dd', state: 'final' }),
      ],
      deposits: [],
      now: NOW,
    });

    expect(heads.map(({ headId, state }) => [headId, state])).toEqual([
      ['bb', 'closed'],
      ['cc', 'fanningOut'],
    ]);
    expect(heads[0].contestationDeadline).toBe(NOW + 1);
  });

  it('leaves the funds out when the history could not be read', () => {
    const { heads } = toHydraHeadPositions({
      heads: [head({ funds: undefined })],
      deposits: [],
      now: NOW,
    });

    expect(heads[0]).not.toHaveProperty('funds');
  });

  it('keeps what was deposited and withdrawn apart', () => {
    const funds = {
      deposited: lovelace(10_000_000n),
      withdrawn: lovelace(4_000_000n),
    };

    const { heads } = toHydraHeadPositions({
      heads: [head({ funds })],
      deposits: [],
      now: NOW,
    });

    expect(heads[0].funds).toEqual(funds);
  });

  it('lists a deposit into a head the account does not participate in', () => {
    const { heads } = toHydraHeadPositions({
      heads: [
        head({
          participantCount: 2,
          isParticipant: false,
          isSoleParticipant: false,
          funds: { deposited: EMPTY, withdrawn: EMPTY },
        }),
      ],
      deposits: [deposit()],
      now: NOW,
    });

    expect(heads).toEqual([
      expect.objectContaining({
        headId: HEAD_ID,
        isParticipant: false,
        otherParticipantCount: 2,
        waitingDeposits: { pending: lovelace(4_630_000n), recoverable: EMPTY },
      }),
    ]);
  });

  it('counts the participants other than the account', () => {
    const counts = toHydraHeadPositions({
      heads: [
        head({ headId: 'aa' }),
        head({
          headId: 'bb',
          participantCount: 2,
          isSoleParticipant: false,
        }),
        head({
          headId: 'cc',
          participantCount: 3,
          isParticipant: false,
          isSoleParticipant: false,
        }),
        head({ headId: 'dd', participantCount: 2 }),
      ],
      deposits: [],
      now: NOW,
    }).heads.map(({ otherParticipantCount }) => otherParticipantCount);

    expect(counts).toEqual([0, 1, 3, 0]);
  });

  it('sums the deposits as pending up to and including their deadline', () => {
    const deadline = at(0);
    const deposits = [
      deposit({ deadline, value: lovelace(1_000_000n) }),
      deposit({ deadline, value: lovelace(2_000_000n) }),
    ];

    const waitingAt = (now: number) =>
      toHydraHeadPositions({ heads: [head()], deposits, now }).heads[0]
        .waitingDeposits;

    expect(waitingAt(NOW)).toEqual({
      pending: lovelace(3_000_000n),
      recoverable: EMPTY,
    });
    expect(waitingAt(NOW + 1)).toEqual({
      pending: EMPTY,
      recoverable: lovelace(3_000_000n),
    });
  });

  it('keeps pending and recoverable deposits apart, assets included', () => {
    const withAsset: HydraValue = {
      coins: 2_000_000n,
      assets: new Map([[ASSET, 5n]]),
    };

    const { heads } = toHydraHeadPositions({
      heads: [head()],
      deposits: [
        deposit({ value: withAsset }),
        deposit({ value: withAsset }),
        deposit({ deadline: at(-1), value: lovelace(1_000_000n) }),
      ],
      now: NOW,
    });

    expect(heads[0].waitingDeposits).toEqual({
      pending: { coins: 4_000_000n, assets: new Map([[ASSET, 10n]]) },
      recoverable: lovelace(1_000_000n),
    });
  });

  it('leaves out the deposits for heads that are not listed', () => {
    const positions = toHydraHeadPositions({
      heads: [head(), head({ headId: OTHER_HEAD_ID, state: 'final' })],
      deposits: [
        deposit({ headId: OTHER_HEAD_ID, deadline: at(MINUTE) }),
        deposit({ headId: 'cc'.repeat(28), deadline: at(MINUTE) }),
      ],
      now: NOW,
    });

    expect(positions).toEqual({
      heads: [
        expect.objectContaining({
          headId: HEAD_ID,
          waitingDeposits: { pending: EMPTY, recoverable: EMPTY },
        }),
      ],
    });
  });

  it('changes next when the first pending deposit becomes recoverable', () => {
    const { nextChangeAt } = toHydraHeadPositions({
      heads: [head()],
      deposits: [
        deposit({ deadline: at(2 * MINUTE) }),
        deposit({ deadline: at(MINUTE) }),
        deposit({ deadline: at(-MINUTE) }),
      ],
      now: NOW,
    });

    expect(nextChangeAt).toBe(NOW + MINUTE + 1);
  });

  it('changes next when a closed head reaches its contestation deadline', () => {
    const { nextChangeAt } = toHydraHeadPositions({
      heads: [
        head({ state: 'closed', contestationDeadline: at(5 * MINUTE) }),
        head({
          headId: OTHER_HEAD_ID,
          state: 'fanningOut',
          contestationDeadline: at(MINUTE),
        }),
      ],
      deposits: [deposit({ deadline: at(10 * MINUTE) })],
      now: NOW,
    });

    expect(nextChangeAt).toBe(NOW + 5 * MINUTE);
  });

  it('has no next change once every deadline has passed', () => {
    const positions = toHydraHeadPositions({
      heads: [head({ state: 'closed', contestationDeadline: at(0) })],
      deposits: [deposit({ deadline: at(-1) })],
      now: NOW,
    });

    expect(positions).not.toHaveProperty('nextChangeAt');
  });

  it('ignores the deadlines of deposits for heads that are not listed', () => {
    const positions = toHydraHeadPositions({
      heads: [head()],
      deposits: [deposit({ headId: OTHER_HEAD_ID })],
      now: NOW,
    });

    expect(positions).not.toHaveProperty('nextChangeAt');
  });
});
