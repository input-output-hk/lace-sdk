import { BigNumber } from '@lace-lib/util';
import { describe, expect, it } from 'vitest';

import { FEATURE_FLAG_HYDRA_HEADS } from '../../../src/hydra-heads-feature-flag';
import { selectHydraDepositActivityStates } from '../../../src/store/hydra-heads-index';
import { toHydraDepositActivityStates } from '../../../src/store/hydra-heads-index/deposit-activity-states';

import type { HydraHeadsIndexDeposit } from '../../../src/store/hydra-heads-index';
import type { State } from '@lace-contract/module';
import type { AccountId } from '@lace-contract/wallet-repo';

const accountId = 'acct-owner' as AccountId;
const otherAccountId = 'acct-other' as AccountId;

const PENDING_TX_ID = 'aa'.repeat(32);
const RECOVERABLE_TX_ID = 'bb'.repeat(32);
const LATER_PENDING_TX_ID = 'cc'.repeat(32);

const DEADLINE = '2026-09-01T13:10:29.599Z';
const DEADLINE_MS = Date.parse(DEADLINE);

const deposit = (
  txId: string,
  deadline: string,
  status: HydraHeadsIndexDeposit['status'],
): HydraHeadsIndexDeposit => ({
  outpoint: { txId, index: 0 },
  headId: '324c8b8198c4c9db7526d6dccb79e992c4863b24b56453bb16995bdc',
  deadline,
  value: { coins: BigNumber(4626931n), assets: {} },
  status,
});

const buildState = ({
  deposits,
  isEnabled = true,
}: {
  deposits: HydraHeadsIndexDeposit[];
  isEnabled?: boolean;
}) =>
  ({
    features: {
      loaded: {
        modules: [],
        featureFlags: isEnabled ? [{ key: FEATURE_FLAG_HYDRA_HEADS }] : [],
      },
    },
    hydraHeadsIndex: {
      byAccount: {
        [accountId]: {
          snapshot: { deposits, heads: [], lastSyncedAt: DEADLINE },
          failed: false,
        },
      },
    },
  } as unknown as State);

describe('selectHydraDepositActivityStates', () => {
  it('derives the status from the deadline rather than the stored status', () => {
    const state = buildState({
      deposits: [deposit(PENDING_TX_ID, DEADLINE, 'pending')],
    });

    expect(
      selectHydraDepositActivityStates(state, accountId, DEADLINE_MS),
    ).toEqual({
      byActivityId: {
        [PENDING_TX_ID]: { status: 'pending', deadline: DEADLINE },
      },
      nextChangeAt: DEADLINE_MS + 1,
      isTaggingEnabled: true,
    });
    expect(
      selectHydraDepositActivityStates(state, accountId, DEADLINE_MS + 1),
    ).toEqual({
      byActivityId: {
        [PENDING_TX_ID]: { status: 'recoverable', deadline: DEADLINE },
      },
      isTaggingEnabled: true,
    });
  });

  it('schedules the next change at the earliest pending deadline', () => {
    const laterDeadline = '2026-09-02T00:00:00.000Z';
    const state = buildState({
      deposits: [
        deposit(LATER_PENDING_TX_ID, laterDeadline, 'pending'),
        deposit(PENDING_TX_ID, DEADLINE, 'pending'),
        deposit(RECOVERABLE_TX_ID, '2026-08-01T00:00:00.000Z', 'pending'),
      ],
    });

    const states = selectHydraDepositActivityStates(
      state,
      accountId,
      DEADLINE_MS - 1,
    );

    expect(states.nextChangeAt).toBe(DEADLINE_MS + 1);
    expect(states.byActivityId).toMatchObject({
      [LATER_PENDING_TX_ID]: { status: 'pending' },
      [PENDING_TX_ID]: { status: 'pending' },
      [RECOVERABLE_TX_ID]: { status: 'recoverable' },
    });
  });

  it('returns the same object for the same state, account and time', () => {
    const state = buildState({
      deposits: [deposit(PENDING_TX_ID, DEADLINE, 'pending')],
    });

    expect(
      selectHydraDepositActivityStates(state, accountId, DEADLINE_MS),
    ).toBe(selectHydraDepositActivityStates(state, accountId, DEADLINE_MS));
  });

  it('keeps the result of each caller across callers and unrelated dispatches', () => {
    const deposits = [deposit(PENDING_TX_ID, DEADLINE, 'pending')];
    const state = buildState({ deposits });
    const listStates = selectHydraDepositActivityStates(
      state,
      accountId,
      DEADLINE_MS - 1,
    );
    const sheetStates = selectHydraDepositActivityStates(
      state,
      accountId,
      DEADLINE_MS + 1,
    );
    const nextState = {
      ...buildState({ deposits }),
      hydraHeadsIndex: state.hydraHeadsIndex,
    } as State;

    expect(
      selectHydraDepositActivityStates(nextState, accountId, DEADLINE_MS - 1),
    ).toBe(listStates);
    expect(
      selectHydraDepositActivityStates(nextState, accountId, DEADLINE_MS + 1),
    ).toBe(sheetStates);
    expect(listStates).not.toBe(sheetStates);
  });

  it('keeps the result of an active caller while other times come and go', () => {
    const state = buildState({
      deposits: [deposit(PENDING_TX_ID, DEADLINE, 'pending')],
    });
    const listNow = DEADLINE_MS - 1;
    const listStates = selectHydraDepositActivityStates(
      state,
      accountId,
      listNow,
    );

    for (let tick = 1; tick <= 50; tick++) {
      selectHydraDepositActivityStates(state, accountId, listNow + tick);
      expect(selectHydraDepositActivityStates(state, accountId, listNow)).toBe(
        listStates,
      );
    }
  });

  it('releases the result of a time nobody selects any more', () => {
    const state = buildState({
      deposits: [deposit(PENDING_TX_ID, DEADLINE, 'pending')],
    });
    const staleNow = DEADLINE_MS - 1;
    const staleStates = selectHydraDepositActivityStates(
      state,
      accountId,
      staleNow,
    );

    for (let tick = 1; tick <= 50; tick++) {
      selectHydraDepositActivityStates(state, accountId, staleNow + tick);
    }

    const recomputed = selectHydraDepositActivityStates(
      state,
      accountId,
      staleNow,
    );
    expect(recomputed).not.toBe(staleStates);
    expect(recomputed).toEqual(staleStates);
  });

  it('allows tags without states for an account the index has not seen', () => {
    const state = buildState({
      deposits: [deposit(PENDING_TX_ID, DEADLINE, 'pending')],
    });

    expect(
      selectHydraDepositActivityStates(state, otherAccountId, DEADLINE_MS),
    ).toEqual({ byActivityId: {}, isTaggingEnabled: true });
  });

  it('has no states and no tags while the Hydra Head feature flag is off', () => {
    const state = buildState({
      deposits: [deposit(PENDING_TX_ID, DEADLINE, 'pending')],
      isEnabled: false,
    });

    expect(
      selectHydraDepositActivityStates(state, accountId, DEADLINE_MS),
    ).toEqual({ byActivityId: {} });
  });
});

describe('toHydraDepositActivityStates', () => {
  it('derives each status as of now and the next change from the earliest pending deadline', () => {
    const laterDeadline = '2026-09-02T00:00:00.000Z';

    expect(
      toHydraDepositActivityStates(
        [
          deposit(RECOVERABLE_TX_ID, '2026-08-01T00:00:00.000Z', 'pending'),
          deposit(LATER_PENDING_TX_ID, laterDeadline, 'recoverable'),
          deposit(PENDING_TX_ID, DEADLINE, 'pending'),
        ],
        DEADLINE_MS,
      ),
    ).toEqual({
      byActivityId: {
        [RECOVERABLE_TX_ID]: {
          status: 'recoverable',
          deadline: '2026-08-01T00:00:00.000Z',
        },
        [LATER_PENDING_TX_ID]: { status: 'pending', deadline: laterDeadline },
        [PENDING_TX_ID]: { status: 'pending', deadline: DEADLINE },
      },
      nextChangeAt: DEADLINE_MS + 1,
      isTaggingEnabled: true,
    });
  });

  it('has no next change once every deposit is recoverable', () => {
    expect(
      toHydraDepositActivityStates(
        [deposit(PENDING_TX_ID, DEADLINE, 'pending')],
        DEADLINE_MS + 1,
      ),
    ).toEqual({
      byActivityId: {
        [PENDING_TX_ID]: { status: 'recoverable', deadline: DEADLINE },
      },
      isTaggingEnabled: true,
    });
  });
});
