import { describe, expect, it } from 'vitest';

import {
  HYDRA_HEAD_HISTORY_LIMITS,
  HYDRA_HEAD_STATE_TOKEN_NAMES,
  continuesHydraHeadHistory,
  countHydraHeadHistoryOutsideInputs,
  getHydraHeadAccountFunds,
  getHydraHeadHistoryWindow,
  getHydraHeadStateTokenUnit,
  reconstructHydraHeadFunds,
} from '../src';

import { historyOf, preprodHeadHistories } from './fixtures/head-histories';

import type { HydraOutRef } from '../src';

/** Depositor of the Hydra 2.0.0 head, which holds no participation token. */
const DEPOSITOR = 'a8817721ee8a283156d7638de0e17540b97df1e9e85c6b90fb435868';

describe('getHydraHeadStateTokenUnit', () => {
  it('names the state token of the head release generation', () => {
    expect(getHydraHeadStateTokenUnit({ headId: 'ab', version: '1.3.0' })).toBe(
      `ab${HYDRA_HEAD_STATE_TOKEN_NAMES.v1}`,
    );
    expect(getHydraHeadStateTokenUnit({ headId: 'ab', version: '2.3.0' })).toBe(
      `ab${HYDRA_HEAD_STATE_TOKEN_NAMES.v2}`,
    );
  });
});

describe('getHydraHeadHistoryWindow', () => {
  it('lists from the first page when nothing is kept', () => {
    expect(
      getHydraHeadHistoryWindow(0, 100, HYDRA_HEAD_HISTORY_LIMITS),
    ).toEqual({ page: 1, skipped: 0, remaining: 200 });
  });

  it('lists from the page holding the last kept transaction', () => {
    expect(
      getHydraHeadHistoryWindow(150, 100, HYDRA_HEAD_HISTORY_LIMITS),
    ).toEqual({ page: 2, skipped: 100, remaining: 100 });
    expect(
      getHydraHeadHistoryWindow(100, 100, HYDRA_HEAD_HISTORY_LIMITS),
    ).toEqual({ page: 1, skipped: 0, remaining: 200 });
  });

  it('reads no further once the history reaches the transaction limit', () => {
    expect(
      getHydraHeadHistoryWindow(200, 100, HYDRA_HEAD_HISTORY_LIMITS),
    ).toBeUndefined();
  });
});

describe('continuesHydraHeadHistory', () => {
  it('holds when the listing repeats the kept transactions past the skipped ones', () => {
    expect(continuesHydraHeadHistory(['a', 'b', 'c'], ['b', 'c', 'd'], 1)).toBe(
      true,
    );
  });

  it('fails when a rollback replaced a kept transaction', () => {
    expect(continuesHydraHeadHistory(['a', 'b', 'c'], ['b', 'x', 'd'], 1)).toBe(
      false,
    );
  });
});

describe('countHydraHeadHistoryOutsideInputs', () => {
  it('counts the inputs produced outside the history only', () => {
    const key = ({ txId, index }: HydraOutRef) => `${txId}#${index}`;
    const history = [
      {
        inputs: [{ txId: 'x', index: 0 }],
        outputs: [{ txId: 't1', index: 0 }],
      },
      {
        inputs: [
          { txId: 't1', index: 0 },
          { txId: 'y', index: 1 },
        ],
        outputs: [],
      },
    ];

    expect(countHydraHeadHistoryOutsideInputs(history, key)).toBe(2);
  });
});

describe('getHydraHeadAccountFunds', () => {
  const recorded = preprodHeadHistories.v20Increments;
  const history = historyOf(recorded);
  const last = history.at(-1)!;

  it('reconstructs the figures of a history that ends at the head UTxO', () => {
    const funds = getHydraHeadAccountFunds(
      { headId: recorded.headId, outpoint: { txId: last.txId, index: 0 } },
      history,
      [DEPOSITOR],
    );

    expect(funds?.deposited.coins).toBeGreaterThan(0n);
    expect(funds).toEqual(
      reconstructHydraHeadFunds(recorded.headId, history, [DEPOSITOR]),
    );
  });

  it('gives no figures for a history missing its newest step, or none read', () => {
    const head = {
      headId: recorded.headId,
      outpoint: { txId: last.txId, index: 0 },
    };

    expect(
      getHydraHeadAccountFunds(head, history.slice(0, -1), [DEPOSITOR]),
    ).toBeUndefined();
    expect(
      getHydraHeadAccountFunds(head, undefined, [DEPOSITOR]),
    ).toBeUndefined();
  });
});
