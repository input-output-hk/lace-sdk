import { BigNumber } from '@lace-lib/util';
import { describe, expect, it } from 'vitest';

import { fromHydraHeadsIndexSnapshot } from '../../../src/store/hydra-heads-index';

import type {
  HydraHeadsIndexDeposit,
  HydraHeadsIndexHead,
} from '../../../src/store/hydra-heads-index';

const HEAD_ID = '324c8b8198c4c9db7526d6dccb79e992c4863b24b56453bb16995bdc';
const ASSET = `${HEAD_ID}4879647261486561645632`;
const DEADLINE = '2026-09-01T13:10:29.599Z';

const indexValue = (coins: bigint, assets: Record<string, bigint> = {}) => ({
  coins: BigNumber(coins),
  assets: Object.fromEntries(
    Object.entries(assets).map(([unit, quantity]) => [
      unit,
      BigNumber(quantity),
    ]),
  ),
});

const value = (coins: bigint, assets: [string, bigint][] = []) => ({
  coins,
  assets: new Map(assets),
});

const head: HydraHeadsIndexHead = {
  headId: HEAD_ID,
  version: '2.3.0',
  outpoint: { txId: 'aa'.repeat(32), index: 0 },
  state: 'closed',
  contestationDeadline: DEADLINE,
  headValue: indexValue(12_000_000n, { [ASSET]: 1n }),
  participantCount: 2,
  isParticipant: true,
  isSoleParticipant: false,
  depositedValue: indexValue(10_000_000n),
  withdrawnValue: indexValue(4_000_000n),
};

const deposit: HydraHeadsIndexDeposit = {
  outpoint: { txId: 'bb'.repeat(32), index: 1 },
  headId: HEAD_ID,
  deadline: DEADLINE,
  value: indexValue(4_630_000n),
  status: 'pending',
};

describe('fromHydraHeadsIndexSnapshot', () => {
  it('reads the heads and deposits of a snapshot into what positions read', () => {
    expect(
      fromHydraHeadsIndexSnapshot({ heads: [head], deposits: [deposit] }),
    ).toEqual({
      heads: [
        {
          headId: HEAD_ID,
          version: '2.3.0',
          outpoint: { txId: 'aa'.repeat(32), index: 0 },
          state: 'closed',
          contestationDeadline: Date.parse(DEADLINE),
          headValue: value(12_000_000n, [[ASSET, 1n]]),
          participantCount: 2,
          isParticipant: true,
          isSoleParticipant: false,
          funds: {
            deposited: value(10_000_000n),
            withdrawn: value(4_000_000n),
          },
        },
      ],
      deposits: [
        {
          headId: HEAD_ID,
          deadline: Date.parse(DEADLINE),
          value: value(4_630_000n),
        },
      ],
    });
  });

  it('leaves the funds and the contestation deadline out when the snapshot has none', () => {
    const {
      contestationDeadline: _,
      depositedValue: __,
      withdrawnValue: ___,
      ...open
    } = head;

    const [read] = fromHydraHeadsIndexSnapshot({
      heads: [{ ...open, state: 'open' }],
      deposits: [],
    }).heads;

    expect(read).not.toHaveProperty('funds');
    expect(read).not.toHaveProperty('contestationDeadline');
  });

  it('leaves the funds out when only one of the two figures is kept', () => {
    const { withdrawnValue: _, ...depositedOnly } = head;

    expect(
      fromHydraHeadsIndexSnapshot({ heads: [depositedOnly], deposits: [] })
        .heads[0],
    ).not.toHaveProperty('funds');
  });
});
