import { ActivityType } from '@lace-contract/activities';
import {
  FEATURE_FLAG_HYDRA_HEADS,
  hydraHeadsIndexActions,
  hydraHeadsIndexReducers,
} from '@lace-contract/cardano-context';
import {
  Cardano,
  ProviderError,
  ProviderFailure,
} from '@lace-lib/cardano-core';
import * as Crypto from '@lace-lib/cardano-crypto';
import { createTestScheduler } from '@lace-lib/cardano-util-dev';
import {
  HYDRA_HEAD_HISTORY_LIMITS,
  getHydraScriptRegistry,
} from '@lace-lib/hydra-head';
import { Err, Ok } from '@lace-lib/util';
import { BehaviorSubject, delay, of, shareReplay } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';

import { toHydraHeadCards } from '../../../src/components/hydra-head-cards';
import { makeHydraHeadsIndexSweep } from '../../../src/store/hydra-heads/index-side-effect';

import {
  headUtxoOf,
  lookalikeOf,
  preprodHeadHistories,
  recordedTransactions,
  resolveRecordedInput,
  toHistoryItems,
  toTransactionDetails,
} from './preprod-head-histories';
import { preprodHydraUtxos, toCardanoUtxo } from './preprod-utxos';

import type { LookalikeHeadHistory } from './preprod-head-histories';
import type { Activity } from '@lace-contract/activities';
import type {
  CardanoTransactionHistoryItem,
  HydraHeadsIndexSliceState,
} from '@lace-contract/cardano-context';
import type { AccountId } from '@lace-contract/wallet-repo';
import type { HydraHeadHistoryLimits } from '@lace-lib/hydra-head';
import type { Observable } from 'rxjs';
import type { RunHelpers } from 'rxjs/testing';

const preprod: Cardano.ChainId = {
  networkId: Cardano.NetworkId.Testnet,
  networkMagic: 1,
};

const ownerAccountId = 'acct-owner' as AccountId;
const coParticipantAccountId = 'acct-co-participant' as AccountId;
const previewAccountId = 'acct-preview' as AccountId;

const OWNER_KEY_HASH =
  'ba1e067abfb07ecd833cec7005a8aa89cbdf09e10d6c87bb73da9e35';
const CO_PARTICIPANT_KEY_HASH =
  'aca3f7a29699c17f8fc7029d1f3c7956e262be059b2d55774939bb08';

const cardanoAddress = (
  accountId: AccountId,
  paymentKeyHash: string,
  networkMagic: number,
) => ({
  accountId,
  blockchainName: 'Cardano' as const,
  address: Cardano.BaseAddress.fromCredentials(
    Cardano.NetworkId.Testnet,
    {
      type: Cardano.CredentialType.KeyHash,
      hash: Crypto.Hash28ByteBase16(paymentKeyHash),
    },
    {
      type: Cardano.CredentialType.KeyHash,
      hash: Crypto.Hash28ByteBase16('ab'.repeat(28)),
    },
  )
    .toAddress()
    .toBech32(),
  data: { networkId: Cardano.NetworkId.Testnet, networkMagic },
});

const decommitterAccountId = 'acct-decommitter' as AccountId;
const firstSharerAccountId = 'acct-first-sharer' as AccountId;
const secondSharerAccountId = 'acct-second-sharer' as AccountId;
const firstDepositorAccountId = 'acct-first-depositor' as AccountId;
const secondDepositorAccountId = 'acct-second-depositor' as AccountId;

const DECOMMITTER_KEY_HASH =
  '4d6885624e031c24dcf87fa672150660d81a706174b8470abacd0c28';

/** Keys holding the two participation tokens of the shared head. */
const FIRST_PARTICIPANT_KEY_HASH =
  '7099552de5127f5ca4f671d47f6ab785a2a676fb415d4329e9459bf6';
const SECOND_PARTICIPANT_KEY_HASH =
  'cde0c82d83345bbdde6d8c560702799b5fb196ec1f5a046a022915bd';

/** Keys that deposited into the shared head without participating in it. */
const FIRST_DEPOSITOR_KEY_HASH =
  '088d20811270899db3efe4eb2851da07182e88581a57d2645457a9a9';
const SECOND_DEPOSITOR_KEY_HASH =
  '97176dedd72cd47441ff92a750ca95b590e82de2f4226f1a8b75314c';

/**
 * Keys of the two sharer accounts, each holding a participant key and a
 * depositor key, so it participates in the shared head and owns a deposit.
 */
const FIRST_SHARER_KEY_HASHES = [
  FIRST_PARTICIPANT_KEY_HASH,
  FIRST_DEPOSITOR_KEY_HASH,
];
const SECOND_SHARER_KEY_HASHES = [
  SECOND_PARTICIPANT_KEY_HASH,
  SECOND_DEPOSITOR_KEY_HASH,
];

const ownerAddress = cardanoAddress(ownerAccountId, OWNER_KEY_HASH, 1);
const decommitterAddress = cardanoAddress(
  decommitterAccountId,
  DECOMMITTER_KEY_HASH,
  1,
);
const sharerAddresses = [
  ...FIRST_SHARER_KEY_HASHES.map(keyHash =>
    cardanoAddress(firstSharerAccountId, keyHash, 1),
  ),
  ...SECOND_SHARER_KEY_HASHES.map(keyHash =>
    cardanoAddress(secondSharerAccountId, keyHash, 1),
  ),
];

/**
 * Addresses of the two depositor accounts, which own only a depositor key and
 * so hold no participation token. The recorded history of the shared head
 * ends before the fanout, so neither has withdrawn anything.
 */
const depositorAddresses = [
  cardanoAddress(firstDepositorAccountId, FIRST_DEPOSITOR_KEY_HASH, 1),
  cardanoAddress(secondDepositorAccountId, SECOND_DEPOSITOR_KEY_HASH, 1),
];

const coParticipantAddress = cardanoAddress(
  coParticipantAccountId,
  CO_PARTICIPANT_KEY_HASH,
  1,
);
const previewAddress = cardanoAddress(previewAccountId, OWNER_KEY_HASH, 2);
const allAddresses = [ownerAddress, coParticipantAddress, previewAddress];

const recordedUtxos = [
  ...Object.values(preprodHydraUtxos),
  headUtxoOf(preprodHeadHistories.decommitted),
  headUtxoOf(preprodHeadHistories.sharedBeforeFanout),
].map(toCardanoUtxo);

const recordedHistories = Object.values(preprodHeadHistories);

const distinctTestnetAddresses = new Set(
  getHydraScriptRegistry(Cardano.NetworkId.Testnet).flatMap(
    ({ headAddress, depositAddress }) =>
      depositAddress ? [headAddress, depositAddress] : [headAddress],
  ),
);

const depositDeadline = '2026-09-01T13:10:29.599Z';
const beforeDeadline = new Date('2026-09-01T00:00:00.000Z');
const afterDeadline = new Date('2026-09-02T00:00:00.000Z');
const sweepStartedAt = beforeDeadline.getTime();

const flagsOn = {
  modules: [],
  featureFlags: [{ key: FEATURE_FLAG_HYDRA_HEADS }],
};
const flagsOff = { modules: [], featureFlags: [] };

const PROVIDER_LATENCY_FRAMES = 1;

/** Renders a translation key with its parameters, as the card model tests do. */
const t: Parameters<typeof toHydraHeadCards>[0]['t'] = (key, params) =>
  `${key}${params ? JSON.stringify(params) : ''}`;

/** Frames a sweep takes: its reads run four at a time, one frame each. */
const SWEEP_FRAMES = Math.ceil(distinctTestnetAddresses.size / 4);
const NO_RESWEEP = 1_000_000;

const preview: Cardano.ChainId = {
  networkId: Cardano.NetworkId.Testnet,
  networkMagic: 2,
};

const bitcoinAddress = {
  accountId: ownerAccountId,
  blockchainName: 'Bitcoin' as const,
  address: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx',
  data: {},
};

const activity = (
  activityId: string,
  hydra: boolean,
  timestamp = 0,
): Activity => ({
  accountId: ownerAccountId,
  activityId,
  timestamp: timestamp as Activity['timestamp'],
  tokenBalanceChanges: [],
  type: ActivityType.Send,
  ...(hydra
    ? { blockchainSpecific: { Cardano: { hydra: { txName: 'DepositTx' } } } }
    : {}),
});

/** An activity whose transaction the classifier read as a deposit into the head. */
const depositActivity = (
  accountId: AccountId,
  headId: string,
  activityId = `deposit-${accountId}`,
): Activity => ({
  accountId,
  activityId,
  timestamp: 0 as Activity['timestamp'],
  tokenBalanceChanges: [],
  type: ActivityType.Send,
  blockchainSpecific: { Cardano: { hydra: { txName: 'DepositTx', headId } } },
});

/** The id of the `index`th lookalike head, lower than any real head id. */
const lookalikeHeadId = (index: number) =>
  (index + 1).toString(16).padStart(56, '0');

/** The deposit activities of both depositors of the shared head. */
const depositorActivities = {
  [firstDepositorAccountId]: [
    depositActivity(
      firstDepositorAccountId,
      preprodHeadHistories.sharedBeforeFanout.headId,
    ),
  ],
  [secondDepositorAccountId]: [
    depositActivity(
      secondDepositorAccountId,
      preprodHeadHistories.sharedBeforeFanout.headId,
    ),
  ],
};

type Sources = {
  features$: Observable<unknown>;
  chainId$: Observable<Cardano.ChainId | undefined>;
  addresses$: Observable<unknown[]>;
  tip$: Observable<Cardano.Tip | undefined>;
  /** Replayed to late subscribers, as store selectors are. */
  activities$: Observable<Record<string, Activity[]>>;
  isWalletActive$: Observable<boolean>;
  failingReads: number;
  /** Whether the `read`th address read, counted from zero, fails for good. */
  isReadFailing: (address: string, read: number) => boolean;
  /** How many history listings succeed before every later one fails. */
  historyListingsBeforeFailure: number;
  /** The listing the provider returns on each successive call. */
  listingOf: (
    recorded: CardanoTransactionHistoryItem[],
    call: number,
  ) => CardanoTransactionHistoryItem[];
  /** How many times the details read of each listed transaction fails first. */
  failingDetailReads: Partial<Record<string, number>>;
  /** How many frames each history listing takes. */
  listingLatencyFrames: number;
  /** The UTxOs the provider returns on each successive address read. */
  utxosOf: (utxos: Cardano.Utxo[], read: number) => Cardano.Utxo[];
  /** Lookalike heads at their validators, with their histories. */
  lookalikes: LookalikeHeadHistory[];
};

type Emitted = {
  frame: number;
  type: string;
  payload: Record<string, unknown>;
};

const tip = (hash: string) =>
  ({ hash, blockNo: 1, slot: 1 } as unknown as Cardano.Tip);

const run = (
  build: (helpers: RunHelpers) => Partial<Sources> = () => ({}),
  options: {
    resweepIntervalMs?: number;
    inputsSettleMs?: number;
    hydraActivityThrottleMs?: number;
    historyPageSize?: number;
    historyLimits?: Partial<HydraHeadHistoryLimits>;
    now?: Date;
    /** The deposited head ids restored from disk before the first sweep. */
    keptDepositedHeadIds?: HydraHeadsIndexSliceState['depositedHeadIdsByAccount'];
    /** The head histories kept before the first sweep. */
    keptHistories?: HydraHeadsIndexSliceState['historyByHeadId'];
    /** The head verdicts kept before the first sweep. */
    keptVerdicts?: HydraHeadsIndexSliceState['genuineByHeadId'];
  } = {},
) => {
  const emitted: Emitted[] = [];
  const states: { type: string; state: HydraHeadsIndexSliceState }[] = [];
  const readFrames: number[] = [];
  const getUtxosAtAddress =
    vi.fn<
      (
        props: { address: string },
        context: { chainId: Cardano.ChainId },
      ) => Observable<unknown>
    >();
  const getAssetTransactionHistory =
    vi.fn<
      (props: {
        assetId: string;
        page?: number;
        pageSize?: number;
        maxPages?: number;
      }) => Observable<unknown>
    >();
  const getTransactionDetails =
    vi.fn<(txId: Cardano.TransactionId) => Observable<unknown>>();
  const resolveInput = vi.fn<(txIn: Cardano.TxIn) => Observable<unknown>>();
  const reducer = hydraHeadsIndexReducers.hydraHeadsIndex;
  let state: HydraHeadsIndexSliceState = {
    ...reducer(undefined, { type: '@@init' }),
    ...(options.keptDepositedHeadIds && {
      depositedHeadIdsByAccount: options.keptDepositedHeadIds,
    }),
    ...(options.keptHistories && { historyByHeadId: options.keptHistories }),
    ...(options.keptVerdicts && { genuineByHeadId: options.keptVerdicts }),
  };
  const historyByHeadId$ = new BehaviorSubject(state.historyByHeadId);
  const genuineByHeadId$ = new BehaviorSubject(state.genuineByHeadId);
  const depositedHeadIdsByAccount$ = new BehaviorSubject(
    state.depositedHeadIdsByAccount,
  );
  const scheduler = createTestScheduler();
  scheduler.run(helpers => {
    const sources: Sources = {
      features$: of(flagsOn),
      chainId$: of(preprod),
      addresses$: of(allAddresses),
      tip$: of(undefined),
      activities$: of({}),
      isWalletActive$: of(true),
      failingReads: 0,
      isReadFailing: () => false,
      historyListingsBeforeFailure: Number.POSITIVE_INFINITY,
      listingOf: recorded => recorded,
      failingDetailReads: {},
      listingLatencyFrames: 0,
      utxosOf: utxos => utxos,
      lookalikes: [],
      ...build(helpers),
    };
    const lookalikeUtxos = sources.lookalikes.map(lookalike =>
      toCardanoUtxo(headUtxoOf(lookalike)),
    );
    const lookalikeTransactions = new Map(
      sources.lookalikes.flatMap(lookalike =>
        lookalike.transactions.map(
          transaction =>
            [
              transaction.hash,
              toTransactionDetails(
                transaction,
                transaction.hash === lookalike.listing[0]?.tx_hash
                  ? lookalike.initScripts
                  : [],
              ),
            ] as const,
        ),
      ),
    );
    const detailFailuresLeft = { ...sources.failingDetailReads };
    let failuresLeft = sources.failingReads;
    getUtxosAtAddress.mockImplementation(({ address }: { address: string }) => {
      readFrames.push(scheduler.now());
      if (
        failuresLeft > 0 ||
        sources.isReadFailing(address, getUtxosAtAddress.mock.calls.length - 1)
      ) {
        failuresLeft -= 1;
        return of(Err(new Error('provider down'))).pipe(
          delay(PROVIDER_LATENCY_FRAMES),
        );
      }
      return of(
        Ok(
          sources.utxosOf(
            [...recordedUtxos, ...lookalikeUtxos].filter(
              ([, txOut]) => txOut.address === address,
            ),
            getUtxosAtAddress.mock.calls.length - 1,
          ),
        ),
      ).pipe(delay(PROVIDER_LATENCY_FRAMES));
    });
    getAssetTransactionHistory.mockImplementation(
      ({ assetId, page, pageSize, maxPages }) => {
        const call = getAssetTransactionHistory.mock.calls.length - 1;
        if (call >= sources.historyListingsBeforeFailure) {
          return of(Err(new Error('provider down')));
        }
        const history = [...recordedHistories, ...sources.lookalikes].find(
          ({ stateToken }) => stateToken === assetId,
        );
        if (!history) throw new Error(`no recorded history for ${assetId}`);
        const skipped = page && pageSize ? (page - 1) * pageSize : 0;
        const end =
          maxPages && pageSize ? skipped + maxPages * pageSize : undefined;
        const listing$ = of(
          Ok(
            sources
              .listingOf(toHistoryItems(history), call)
              .slice(skipped, end),
          ),
        );
        return sources.listingLatencyFrames > 0
          ? listing$.pipe(delay(sources.listingLatencyFrames))
          : listing$;
      },
    );
    getTransactionDetails.mockImplementation(txId => {
      const failuresLeft = detailFailuresLeft[txId] ?? 0;
      if (failuresLeft > 0) {
        detailFailuresLeft[txId] = failuresLeft - 1;
        return of(
          Err(new ProviderError(ProviderFailure.NotFound, null, 'not indexed')),
        );
      }
      const lookalikeTransaction = lookalikeTransactions.get(txId);
      if (lookalikeTransaction) return of(Ok(lookalikeTransaction));
      const transaction = recordedTransactions.get(txId);
      if (!transaction) throw new Error(`no recorded transaction ${txId}`);
      return of(Ok(toTransactionDetails(transaction)));
    });
    resolveInput.mockImplementation(txIn =>
      of(
        Ok(
          resolveRecordedInput(
            txIn,
            sources.lookalikes.flatMap(({ transactions }) => transactions),
          ) ?? resolveRecordedInput(txIn),
        ),
      ),
    );
    makeHydraHeadsIndexSweep({
      resweepIntervalMs: options.resweepIntervalMs ?? NO_RESWEEP,
      inputsSettleMs: options.inputsSettleMs ?? 0,
      hydraActivityThrottleMs:
        'hydraActivityThrottleMs' in options
          ? options.hydraActivityThrottleMs
          : 0,
      historyPageSize: options.historyPageSize,
      historyLimits: { ...HYDRA_HEAD_HISTORY_LIMITS, ...options.historyLimits },
      now: () => options.now ?? beforeDeadline,
    })(
      {} as never,
      {
        activities: {
          selectAllMap$: sources.activities$.pipe(
            shareReplay({ bufferSize: 1, refCount: false }),
          ),
        },
        addresses: { selectAllAddresses$: sources.addresses$ },
        cardanoContext: {
          selectChainId$: sources.chainId$,
          selectTip$: sources.tip$,
        },
        features: { selectLoadedFeatures$: sources.features$ },
        hydraHeadsIndex: {
          selectHistoryByHeadId$: historyByHeadId$,
          selectGenuineByHeadId$: genuineByHeadId$,
          selectDepositedHeadIdsByAccount$: depositedHeadIdsByAccount$,
        },
      } as never,
      {
        actions: hydraHeadsIndexActions,
        cardanoProvider: {
          getUtxosAtAddress,
          getAssetTransactionHistory,
          getTransactionDetails,
          resolveInput,
        },
        isWalletActive$: sources.isWalletActive$,
      } as never,
    ).subscribe(action => {
      const { type, payload } = action as Omit<Emitted, 'frame'>;
      emitted.push({ frame: scheduler.now(), type, payload });
      state = reducer(state, action);
      states.push({ type, state });
      historyByHeadId$.next(state.historyByHeadId);
      genuineByHeadId$.next(state.genuineByHeadId);
      depositedHeadIdsByAccount$.next(state.depositedHeadIdsByAccount);
    });
  });
  return {
    emitted,
    getUtxosAtAddress,
    getAssetTransactionHistory,
    getTransactionDetails,
    resolveInput,
    readFrames,
    states,
    state: () => state,
  };
};

/** The heads of an account once each sweep stored their figures. */
const resolvedHeadsOf = (
  states: { type: string; state: HydraHeadsIndexSliceState }[],
  accountId: AccountId,
) =>
  states
    .filter(({ type }) => type === 'hydraHeadsIndex/headFundsResolved')
    .map(({ state }) => state.byAccount[accountId]?.snapshot?.heads);

const sweepsCompleted = (emitted: Emitted[]) =>
  emitted.filter(({ type }) => type === 'hydraHeadsIndex/sweepCompleted');

const sweepCompletedFrames = (emitted: Emitted[]) =>
  sweepsCompleted(emitted).map(({ frame }) => frame);

const sweptAccountIds = (emitted: Emitted[]) =>
  sweepsCompleted(emitted).map(({ payload }) =>
    (payload.accounts as { accountId: AccountId }[]).map(
      ({ accountId }) => accountId,
    ),
  );

describe('makeHydraHeadsIndexSweep', () => {
  it('sweeps once the network and accounts are known, reading each validator address once', () => {
    const { emitted, getUtxosAtAddress } = run();

    expect(sweepCompletedFrames(emitted)).toEqual([SWEEP_FRAMES]);
    expect(getUtxosAtAddress).toHaveBeenCalledTimes(
      distinctTestnetAddresses.size,
    );
    expect(
      new Set(getUtxosAtAddress.mock.calls.map(([{ address }]) => address)),
    ).toEqual(distinctTestnetAddresses);
    for (const [, context] of getUtxosAtAddress.mock.calls) {
      expect(context).toEqual({ chainId: preprod });
    }
  });

  it('reads the same addresses however many accounts there are', () => {
    const single = run(() => ({ addresses$: of([ownerAddress]) }));
    const many = run();

    expect(many.getUtxosAtAddress).toHaveBeenCalledTimes(
      single.getUtxosAtAddress.mock.calls.length,
    );
  });

  it('gives each account its own deposits and heads only', () => {
    const { emitted } = run(undefined, {
      keptVerdicts: {
        [preprodHeadHistories.openedSoleParticipant.headId]: true,
        [preprodHeadHistories.openedThreeParticipants.headId]: true,
      },
    });

    expect(emitted.map(({ type }) => type)).toEqual([
      'hydraHeadsIndex/sweepCompleted',
      'hydraHeadsIndex/headFundsResolved',
    ]);
    expect(emitted[0]?.payload).toEqual({
      lastSyncedAt: beforeDeadline.toISOString(),
      unreadAddresses: [],
      accounts: [
        {
          accountId: coParticipantAccountId,
          deposits: [],
          heads: [
            expect.objectContaining({
              headId:
                '976b3e073a7c7eae48ca8b2cf84bf9d16b7e4f993eefbf67093f51a4',
              version: '2.3.0',
              state: 'open',
              participantCount: 3,
              isParticipant: true,
              isSoleParticipant: false,
            }),
          ],
          candidateHeads: [],
        },
        {
          accountId: ownerAccountId,
          deposits: [
            {
              outpoint: {
                txId: preprodHydraUtxos.depositV2.tx_hash,
                index: 0,
              },
              headId:
                '324c8b8198c4c9db7526d6dccb79e992c4863b24b56453bb16995bdc',
              deadline: depositDeadline,
              value: { coins: '4626931', assets: {} },
              status: 'pending',
            },
          ],
          heads: [
            expect.objectContaining({
              headId:
                '324c8b8198c4c9db7526d6dccb79e992c4863b24b56453bb16995bdc',
              outpoint: {
                txId: preprodHydraUtxos.headV2Open.tx_hash,
                index: 0,
              },
              state: 'open',
              headValue: {
                coins: '2094660',
                assets: {
                  '324c8b8198c4c9db7526d6dccb79e992c4863b24b56453bb16995bdc4879647261486561645632':
                    '1',
                  '324c8b8198c4c9db7526d6dccb79e992c4863b24b56453bb16995bdcba1e067abfb07ecd833cec7005a8aa89cbdf09e10d6c87bb73da9e35':
                    '1',
                },
              },
              participantCount: 1,
              isParticipant: true,
              isSoleParticipant: true,
            }),
          ],
          candidateHeads: [],
        },
      ],
    });
  });

  it('lists a head once its check finds it genuine', () => {
    const { states, state } = run(() => ({
      addresses$: of([decommitterAddress]),
    }));

    expect(
      states.map(
        ({ state }) =>
          state.byAccount[decommitterAccountId]?.snapshot?.heads.length,
      ),
    ).toEqual([0, 1]);
    expect(state().genuineByHeadId).toEqual({
      [preprodHeadHistories.decommitted.headId]: true,
    });
  });

  it('stores the deposits and heads known to be genuine before reading the head histories', () => {
    const { emitted, states } = run(
      () => ({
        addresses$: of([decommitterAddress]),
        listingLatencyFrames: 5,
      }),
      {
        keptVerdicts: { [preprodHeadHistories.decommitted.headId]: true },
      },
    );

    expect(emitted.map(({ type, frame }) => ({ type, frame }))).toEqual([
      { type: 'hydraHeadsIndex/sweepCompleted', frame: SWEEP_FRAMES },
      {
        type: 'hydraHeadsIndex/headFundsResolved',
        frame: SWEEP_FRAMES + 5,
      },
    ]);
    expect(
      states[0]?.state.byAccount[decommitterAccountId]?.snapshot?.heads,
    ).toEqual([
      expect.not.objectContaining({
        depositedValue: expect.anything() as unknown,
      }),
    ]);
  });

  it('gives each head what the account deposited into it and withdrew from it', () => {
    const { states, getTransactionDetails, resolveInput } = run(() => ({
      addresses$: of([decommitterAddress]),
    }));

    expect(resolvedHeadsOf(states, decommitterAccountId)[0]).toEqual([
      expect.objectContaining({
        headId: preprodHeadHistories.decommitted.headId,
        state: 'closed',
        depositedValue: { coins: '15000000', assets: {} },
        withdrawnValue: { coins: '7000000', assets: {} },
      }),
    ]);
    expect(getTransactionDetails).toHaveBeenCalledTimes(4);
    expect(resolveInput.mock.calls.map(([txIn]) => txIn.txId)).toEqual([
      'b71a55df098e85666d17f81535dd20ea5b79cd101ec7e50b1ae301140b0943ed',
    ]);
  });

  it('counts a pending deposit as not yet deposited', () => {
    const { states } = run(() => ({ addresses$: of([ownerAddress]) }));

    expect(resolvedHeadsOf(states, ownerAccountId)[0]).toEqual([
      expect.objectContaining({
        depositedValue: { coins: '0', assets: {} },
        withdrawnValue: { coins: '0', assets: {} },
      }),
    ]);
  });

  it('attributes the deposits into a shared head to each account, reading the head once', () => {
    const { states, getAssetTransactionHistory } = run(() => ({
      addresses$: of(sharerAddresses),
    }));

    expect(resolvedHeadsOf(states, firstSharerAccountId)[0]).toEqual([
      expect.objectContaining({
        participantCount: 2,
        depositedValue: { coins: '400000000', assets: {} },
        withdrawnValue: { coins: '0', assets: {} },
      }),
    ]);
    expect(resolvedHeadsOf(states, secondSharerAccountId)[0]).toEqual([
      expect.objectContaining({
        depositedValue: { coins: '110000000', assets: {} },
        withdrawnValue: { coins: '0', assets: {} },
      }),
    ]);
    expect(getAssetTransactionHistory).toHaveBeenCalledTimes(1);
  });

  describe('heads an account deposited into without participating', () => {
    const sharedHeadId = preprodHeadHistories.sharedBeforeFanout.headId;

    it('lists the head with what each depositor moved through it once the history confirms it', () => {
      const { states } = run(() => ({
        addresses$: of(depositorAddresses),
        activities$: of(depositorActivities),
      }));

      expect(
        states[0]?.state.byAccount[firstDepositorAccountId]?.snapshot?.heads,
      ).toEqual([]);
      expect(resolvedHeadsOf(states, firstDepositorAccountId)).toEqual([
        [
          expect.objectContaining({
            headId: sharedHeadId,
            state: 'closed',
            participantCount: 2,
            isParticipant: false,
            isSoleParticipant: false,
            depositedValue: { coins: '400000000', assets: {} },
            withdrawnValue: { coins: '0', assets: {} },
          }),
        ],
      ]);
      expect(resolvedHeadsOf(states, secondDepositorAccountId)).toEqual([
        [
          expect.objectContaining({
            headId: sharedHeadId,
            isParticipant: false,
            depositedValue: { coins: '110000000', assets: {} },
            withdrawnValue: { coins: '0', assets: {} },
          }),
        ],
      ]);
    });

    it('keeps the head listed through later sweeps', () => {
      const { states } = run(
        ({ hot }) => ({
          addresses$: of(depositorAddresses),
          activities$: of(depositorActivities),
          tip$: hot('---------------a', { a: tip('a') }),
        }),
        { resweepIntervalMs: 10 },
      );

      expect(
        states.map(
          ({ state }) =>
            state.byAccount[firstDepositorAccountId]?.snapshot?.heads.length,
        ),
      ).toEqual([0, 1, 1, 1]);
    });

    it('finds the head once its deposit activity is loaded again with the Hydra Head tags', () => {
      const untagged: Activity = {
        ...depositActivity(firstDepositorAccountId, sharedHeadId),
        blockchainSpecific: undefined,
      };
      const { states } = run(
        ({ cold, hot }) => ({
          addresses$: of([depositorAddresses[0]]),
          activities$: cold('a---------b', {
            a: { [firstDepositorAccountId]: [untagged] },
            b: depositorActivities,
          }),
          tip$: hot('---------------a', { a: tip('a') }),
        }),
        { resweepIntervalMs: 10 },
      );

      expect(resolvedHeadsOf(states, firstDepositorAccountId)).toEqual([
        [],
        [
          expect.objectContaining({
            headId: sharedHeadId,
            isParticipant: false,
            depositedValue: { coins: '400000000', assets: {} },
          }),
        ],
      ]);
    });

    it('keeps the head listed once its deposit activity is no longer loaded', () => {
      const { states, getAssetTransactionHistory } = run(
        ({ cold, hot }) => ({
          addresses$: of(depositorAddresses),
          activities$: cold('a---------b', { a: depositorActivities, b: {} }),
          tip$: hot('---------------a', { a: tip('a') }),
        }),
        { resweepIntervalMs: 10 },
      );

      expect(resolvedHeadsOf(states, firstDepositorAccountId)).toEqual([
        [expect.objectContaining({ headId: sharedHeadId })],
        [
          expect.objectContaining({
            headId: sharedHeadId,
            isParticipant: false,
            depositedValue: { coins: '400000000', assets: {} },
          }),
        ],
      ]);
      expect(getAssetTransactionHistory).toHaveBeenCalledTimes(2);
    });

    it('lists a head kept from before a restart without its deposit activity', () => {
      const { states } = run(() => ({ addresses$: of(depositorAddresses) }), {
        keptDepositedHeadIds: {
          [firstDepositorAccountId]: [sharedHeadId],
        },
      });

      expect(resolvedHeadsOf(states, firstDepositorAccountId)).toEqual([
        [
          expect.objectContaining({
            headId: sharedHeadId,
            isParticipant: false,
            depositedValue: { coins: '400000000', assets: {} },
            withdrawnValue: { coins: '0', assets: {} },
          }),
        ],
      ]);
      expect(states.at(-1)?.state.depositedHeadIdsByAccount).toEqual({
        [firstDepositorAccountId]: [sharedHeadId],
      });
    });

    it('reads nothing for a kept head id that names no live head, and forgets it', () => {
      const { state, getAssetTransactionHistory, getTransactionDetails } = run(
        () => ({ addresses$: of(depositorAddresses) }),
        {
          keptDepositedHeadIds: {
            [firstDepositorAccountId]: ['cd'.repeat(28)],
          },
        },
      );

      expect(getAssetTransactionHistory).not.toHaveBeenCalled();
      expect(getTransactionDetails).not.toHaveBeenCalled();
      expect(state().depositedHeadIdsByAccount).toEqual({});
    });

    it('forgets a kept head id whose history shows no deposit for the account', () => {
      const { state } = run(() => ({ addresses$: of(depositorAddresses) }), {
        keptDepositedHeadIds: {
          [firstDepositorAccountId]: [preprodHeadHistories.decommitted.headId],
        },
      });

      expect(state().depositedHeadIdsByAccount).toEqual({});
    });

    it('reads nothing for a head id that names no live head', () => {
      const { states, getAssetTransactionHistory, getTransactionDetails } = run(
        () => ({
          addresses$: of(depositorAddresses),
          activities$: of({
            [firstDepositorAccountId]: [
              depositActivity(firstDepositorAccountId, 'cd'.repeat(28)),
            ],
          }),
        }),
      );

      expect(getAssetTransactionHistory).not.toHaveBeenCalled();
      expect(getTransactionDetails).not.toHaveBeenCalled();
      expect(resolvedHeadsOf(states, firstDepositorAccountId)).toEqual([[]]);
    });

    it('reads no head for a deposit activity of another account', () => {
      const { states, getAssetTransactionHistory } = run(() => ({
        addresses$: of(depositorAddresses),
        activities$: of({
          [ownerAccountId]: [depositActivity(ownerAccountId, sharedHeadId)],
        }),
      }));

      expect(getAssetTransactionHistory).not.toHaveBeenCalled();
      expect(resolvedHeadsOf(states, firstDepositorAccountId)).toEqual([[]]);
    });

    it('ignores other Hydra activities that name a live head', () => {
      const { getAssetTransactionHistory } = run(() => ({
        addresses$: of(depositorAddresses),
        activities$: of({
          [firstDepositorAccountId]: [
            {
              ...depositActivity(firstDepositorAccountId, sharedHeadId),
              blockchainSpecific: {
                Cardano: {
                  hydra: { txName: 'IncrementTx', headId: sharedHeadId },
                },
              },
            },
          ],
        }),
      }));

      expect(getAssetTransactionHistory).not.toHaveBeenCalled();
    });

    it('reads no head for a deposit the account received', () => {
      const { states, getAssetTransactionHistory, getTransactionDetails } = run(
        () => ({
          addresses$: of(depositorAddresses),
          activities$: of({
            [firstDepositorAccountId]: [
              {
                ...depositActivity(firstDepositorAccountId, sharedHeadId),
                type: ActivityType.Receive,
              },
            ],
          }),
        }),
      );

      expect(getAssetTransactionHistory).not.toHaveBeenCalled();
      expect(getTransactionDetails).not.toHaveBeenCalled();
      expect(resolvedHeadsOf(states, firstDepositorAccountId)).toEqual([[]]);
    });

    it('leaves out a live head whose history shows no deposit for the account', () => {
      const { states, getAssetTransactionHistory } = run(() => ({
        addresses$: of(depositorAddresses),
        activities$: of({
          [firstDepositorAccountId]: [
            depositActivity(
              firstDepositorAccountId,
              preprodHeadHistories.decommitted.headId,
            ),
          ],
        }),
      }));

      expect(getAssetTransactionHistory).toHaveBeenCalledTimes(1);
      expect(resolvedHeadsOf(states, firstDepositorAccountId)).toEqual([[]]);
    });

    describe('with a deposit the head has not absorbed yet', () => {
      const soleHeadId = preprodHeadHistories.openedSoleParticipant.headId;
      const ownerToken = Cardano.AssetId(`${soleHeadId}${OWNER_KEY_HASH}`);
      const strangerToken = Cardano.AssetId(`${soleHeadId}${'ee'.repeat(28)}`);

      /**
       * The UTxOs with the owner's participation token of its head handed to
       * another key, so the owner only deposited into that head.
       */
      const withOwnerAsDepositorOnly = (utxos: Cardano.Utxo[]) =>
        utxos.map(([txIn, txOut]): Cardano.Utxo => {
          const assets = txOut.value.assets;
          const quantity = assets?.get(ownerToken);
          if (!assets || quantity === undefined) return [txIn, txOut];
          const swapped = new Map(assets);
          swapped.delete(ownerToken);
          swapped.set(strangerToken, quantity);
          return [
            txIn,
            { ...txOut, value: { ...txOut.value, assets: swapped } },
          ];
        });

      const ownerDeposit = {
        addresses$: of([ownerAddress]),
        activities$: of({
          [ownerAccountId]: [depositActivity(ownerAccountId, soleHeadId)],
        }),
        utxosOf: withOwnerAsDepositorOnly,
      };

      it('lists the head with the deposit though its history credits nothing yet', () => {
        const { states, state } = run(() => ownerDeposit);

        expect(resolvedHeadsOf(states, ownerAccountId)).toEqual([
          [
            expect.objectContaining({
              headId: soleHeadId,
              isParticipant: false,
              depositedValue: { coins: '0', assets: {} },
              withdrawnValue: { coins: '0', assets: {} },
            }),
          ],
        ]);
        expect(state().depositedHeadIdsByAccount).toEqual({
          [ownerAccountId]: [soleHeadId],
        });
        const snapshot = state().byAccount[ownerAccountId]?.snapshot;
        const [card] = toHydraHeadCards({
          heads: snapshot?.heads ?? [],
          deposits: snapshot?.deposits ?? [],
          now: beforeDeadline.getTime(),
          currency: { decimals: 6, ticker: 'tADA' },
          t,
        }).cards;
        expect(card?.deposits).toEqual([
          {
            label: 'v2.portfolio.hydra-heads.waiting{"amount":"4.626931 tADA"}',
            tone: 'pending',
          },
        ]);
      });

      it('lists a head found genuine before as soon as the sweep stores the deposit', () => {
        const { states } = run(() => ownerDeposit, {
          keptVerdicts: { [soleHeadId]: true },
        });

        expect(
          states[0]?.state.byAccount[ownerAccountId]?.snapshot?.heads,
        ).toEqual([
          expect.objectContaining({ headId: soleHeadId, isParticipant: false }),
        ]);
      });

      it('lists no lookalike for the deposit', () => {
        const { states, state } = run(() => ownerDeposit, {
          keptVerdicts: { [soleHeadId]: false },
        });

        expect(resolvedHeadsOf(states, ownerAccountId)).toEqual([[]]);
        expect(state().depositedHeadIdsByAccount).toEqual({});
      });
    });

    it('reads a head once for its participants and depositors', () => {
      const { states, getAssetTransactionHistory, getTransactionDetails } = run(
        () => ({
          addresses$: of([...sharerAddresses, ...depositorAddresses]),
          activities$: of({
            ...depositorActivities,
            [firstSharerAccountId]: [
              depositActivity(firstSharerAccountId, sharedHeadId),
            ],
          }),
        }),
      );

      expect(getAssetTransactionHistory).toHaveBeenCalledTimes(1);
      expect(getTransactionDetails).toHaveBeenCalledTimes(
        preprodHeadHistories.sharedBeforeFanout.listing.length,
      );
      expect(resolvedHeadsOf(states, firstSharerAccountId)).toEqual([
        [
          expect.objectContaining({
            headId: sharedHeadId,
            isParticipant: true,
          }),
        ],
      ]);
      expect(resolvedHeadsOf(states, firstDepositorAccountId)).toEqual([
        [
          expect.objectContaining({
            headId: sharedHeadId,
            isParticipant: false,
          }),
        ],
      ]);
    });
  });

  it('keeps the history and reads only newer transactions on later sweeps', () => {
    const { states, getTransactionDetails, state } = run(
      ({ hot }) => ({
        addresses$: of([decommitterAddress]),
        tip$: hot('---------------a--------------b', {
          a: tip('a'),
          b: tip('b'),
        }),
        listingOf: (recorded, call) => recorded.slice(0, call === 0 ? 3 : 4),
      }),
      { resweepIntervalMs: 10 },
    );

    expect(resolvedHeadsOf(states, decommitterAccountId)).toEqual([
      [
        expect.not.objectContaining({
          depositedValue: expect.anything() as unknown,
        }),
      ],
      [
        expect.objectContaining({
          depositedValue: { coins: '15000000', assets: {} },
          withdrawnValue: { coins: '7000000', assets: {} },
        }),
      ],
      [
        expect.objectContaining({
          depositedValue: { coins: '15000000', assets: {} },
          withdrawnValue: { coins: '7000000', assets: {} },
        }),
      ],
    ]);
    expect(getTransactionDetails.mock.calls.map(([txId]) => txId)).toEqual(
      preprodHeadHistories.decommitted.listing.map(({ tx_hash }) => tx_hash),
    );
    expect(
      state().historyByHeadId[preprodHeadHistories.decommitted.headId],
    ).toHaveLength(4);
  });

  it('reads the whole history again when the listing no longer starts with the kept one', () => {
    const [initTx, , decrementTx, closeTx] =
      preprodHeadHistories.decommitted.listing.map(({ tx_hash }) => tx_hash);
    const { getTransactionDetails, state } = run(
      ({ hot }) => ({
        addresses$: of([decommitterAddress]),
        tip$: hot('---------------a', { a: tip('a') }),
        listingOf: (recorded, call) =>
          call === 0 ? recorded : [recorded[0], ...recorded.slice(2)],
      }),
      { resweepIntervalMs: 10 },
    );

    expect(
      getTransactionDetails.mock.calls.slice(4).map(([txId]) => txId),
    ).toEqual([initTx, decrementTx, closeTx]);
    expect(
      state().historyByHeadId[preprodHeadHistories.decommitted.headId]?.map(
        ({ txId }) => txId,
      ),
    ).toEqual([initTx, decrementTx, closeTx]);
  });

  it('keeps the transactions read before a failed one and resumes from it on the next sweep', () => {
    const [initTx, incrementTx, decrementTx, closeTx] =
      preprodHeadHistories.decommitted.listing.map(({ tx_hash }) => tx_hash);
    const { states, getTransactionDetails } = run(
      ({ hot }) => ({
        addresses$: of([decommitterAddress]),
        tip$: hot('---------------a', { a: tip('a') }),
        failingDetailReads: { [incrementTx]: 1 },
      }),
      { resweepIntervalMs: 10 },
    );

    expect(
      states
        .filter(({ type }) => type === 'hydraHeadsIndex/headFundsResolved')
        .map(({ state }) =>
          state.historyByHeadId[preprodHeadHistories.decommitted.headId]?.map(
            ({ txId }) => txId,
          ),
        ),
    ).toEqual([[initTx], [initTx, incrementTx, decrementTx, closeTx]]);
    expect(getTransactionDetails.mock.calls.map(([txId]) => txId)).toEqual([
      initTx,
      incrementTx,
      incrementTx,
      decrementTx,
      closeTx,
    ]);
    expect(resolvedHeadsOf(states, decommitterAccountId)).toEqual([
      [
        expect.not.objectContaining({
          depositedValue: expect.anything() as unknown,
        }),
      ],
      [
        expect.objectContaining({
          depositedValue: { coins: '15000000', assets: {} },
          withdrawnValue: { coins: '7000000', assets: {} },
        }),
      ],
    ]);
  });

  it('lists a kept history from the page holding its last transaction', () => {
    const [, , , closeTx] = preprodHeadHistories.decommitted.listing.map(
      ({ tx_hash }) => tx_hash,
    );
    const { getAssetTransactionHistory, getTransactionDetails, state } = run(
      ({ hot }) => ({
        addresses$: of([decommitterAddress]),
        tip$: hot('---------------a', { a: tip('a') }),
        listingOf: (recorded, call) => recorded.slice(0, call === 0 ? 3 : 4),
      }),
      { resweepIntervalMs: 10, historyPageSize: 2 },
    );

    expect(
      getAssetTransactionHistory.mock.calls.map(([{ page, pageSize }]) => ({
        page,
        pageSize,
      })),
    ).toEqual([
      { page: 1, pageSize: 2 },
      { page: 2, pageSize: 2 },
    ]);
    expect(
      getTransactionDetails.mock.calls.slice(3).map(([txId]) => txId),
    ).toEqual([closeTx]);
    expect(
      state().historyByHeadId[preprodHeadHistories.decommitted.headId]?.map(
        ({ txId }) => txId,
      ),
    ).toEqual(
      preprodHeadHistories.decommitted.listing.map(({ tx_hash }) => tx_hash),
    );
  });

  it('lists a kept history that fills its last page from that page', () => {
    const [initTx, incrementTx, decrementTx, closeTx] =
      preprodHeadHistories.decommitted.listing.map(({ tx_hash }) => tx_hash);
    const { getAssetTransactionHistory, getTransactionDetails, state } = run(
      ({ hot }) => ({
        addresses$: of([decommitterAddress]),
        tip$: hot('---------------a', { a: tip('a') }),
        listingOf: (recorded, call) => recorded.slice(0, call === 0 ? 2 : 4),
      }),
      { resweepIntervalMs: 10, historyPageSize: 2 },
    );

    expect(
      getAssetTransactionHistory.mock.calls.map(([{ page, pageSize }]) => ({
        page,
        pageSize,
      })),
    ).toEqual([
      { page: 1, pageSize: 2 },
      { page: 1, pageSize: 2 },
    ]);
    expect(getTransactionDetails.mock.calls.map(([txId]) => txId)).toEqual([
      initTx,
      incrementTx,
      decrementTx,
      closeTx,
    ]);
    expect(
      state().historyByHeadId[preprodHeadHistories.decommitted.headId]?.map(
        ({ txId }) => txId,
      ),
    ).toEqual([initTx, incrementTx, decrementTx, closeTx]);
  });

  it('lists the whole history again when the page holding the last kept transaction does not continue it', () => {
    const [initTx, incrementTx, , closeTx] =
      preprodHeadHistories.decommitted.listing.map(({ tx_hash }) => tx_hash);
    const { getAssetTransactionHistory, getTransactionDetails, state } = run(
      ({ hot }) => ({
        addresses$: of([decommitterAddress]),
        tip$: hot('---------------a', { a: tip('a') }),
        listingOf: (recorded, call) =>
          call === 0
            ? recorded.slice(0, 3)
            : [recorded[0], recorded[1], recorded[3]],
      }),
      { resweepIntervalMs: 10, historyPageSize: 2 },
    );

    expect(
      getAssetTransactionHistory.mock.calls.map(([{ page, maxPages }]) => ({
        page,
        maxPages,
      })),
    ).toEqual([
      { page: 1, maxPages: 100 },
      { page: 2, maxPages: 99 },
      { page: 1, maxPages: 100 },
    ]);
    expect(
      getTransactionDetails.mock.calls.slice(3).map(([txId]) => txId),
    ).toEqual([initTx, incrementTx, closeTx]);
    expect(
      state().historyByHeadId[preprodHeadHistories.decommitted.headId]?.map(
        ({ txId }) => txId,
      ),
    ).toEqual([initTx, incrementTx, closeTx]);
  });

  it('leaves a head out, unverified, but completes the sweep when its listing fails', () => {
    const { emitted, states, state } = run(() => ({
      addresses$: of([decommitterAddress]),
      historyListingsBeforeFailure: 0,
    }));

    expect(emitted.map(({ type }) => type)).toEqual([
      'hydraHeadsIndex/sweepCompleted',
      'hydraHeadsIndex/headFundsResolved',
    ]);
    expect(resolvedHeadsOf(states, decommitterAccountId)).toEqual([[]]);
    expect(state().genuineByHeadId).toEqual({});
    expect(state().historyByHeadId).toEqual({});
  });

  it('checks an unverified head again on the next sweep', () => {
    const { states, state } = run(
      ({ hot }) => ({
        addresses$: of([decommitterAddress]),
        tip$: hot('---------------a', { a: tip('a') }),
        failingDetailReads: {
          [preprodHeadHistories.decommitted.listing[0]?.tx_hash ?? '']: 1,
        },
      }),
      { resweepIntervalMs: 10 },
    );

    expect(resolvedHeadsOf(states, decommitterAccountId)).toEqual([
      [],
      [
        expect.objectContaining({
          headId: preprodHeadHistories.decommitted.headId,
          depositedValue: { coins: '15000000', assets: {} },
        }),
      ],
    ]);
    expect(state().genuineByHeadId).toEqual({
      [preprodHeadHistories.decommitted.headId]: true,
    });
  });

  it('leaves the figures out but completes the sweep when a history read of a genuine head fails', () => {
    const { emitted, states, state } = run(
      () => ({
        addresses$: of([decommitterAddress]),
        historyListingsBeforeFailure: 0,
      }),
      {
        keptVerdicts: { [preprodHeadHistories.decommitted.headId]: true },
      },
    );

    expect(emitted.map(({ type }) => type)).toEqual([
      'hydraHeadsIndex/sweepCompleted',
      'hydraHeadsIndex/headFundsResolved',
    ]);
    const head = resolvedHeadsOf(states, decommitterAccountId)[0]?.[0];
    expect(head).toEqual(expect.objectContaining({ state: 'closed' }));
    expect(head).not.toHaveProperty('depositedValue');
    expect(head).not.toHaveProperty('withdrawnValue');
    expect(state().historyByHeadId).toEqual({});
  });

  it('keeps the history and figures of a head whose later history read fails', () => {
    const { states, state } = run(
      ({ hot }) => ({
        addresses$: of([decommitterAddress]),
        tip$: hot('---------------a', { a: tip('a') }),
        historyListingsBeforeFailure: 1,
      }),
      { resweepIntervalMs: 10 },
    );

    expect(resolvedHeadsOf(states, decommitterAccountId)).toEqual([
      [
        expect.objectContaining({
          depositedValue: { coins: '15000000', assets: {} },
          withdrawnValue: { coins: '7000000', assets: {} },
        }),
      ],
      [
        expect.objectContaining({
          depositedValue: { coins: '15000000', assets: {} },
          withdrawnValue: { coins: '7000000', assets: {} },
        }),
      ],
    ]);
    expect(
      state().historyByHeadId[preprodHeadHistories.decommitted.headId],
    ).toHaveLength(4);
  });

  it('leaves the figures out when a history read fails and the kept history does not reach the head UTxO', () => {
    const { states, state } = run(
      ({ hot }) => ({
        addresses$: of([decommitterAddress]),
        tip$: hot('---------------a', { a: tip('a') }),
        historyListingsBeforeFailure: 1,
        listingOf: recorded => recorded.slice(0, 3),
      }),
      { resweepIntervalMs: 10 },
    );

    expect(resolvedHeadsOf(states, decommitterAccountId)).toEqual([
      [
        expect.not.objectContaining({
          depositedValue: expect.anything() as unknown,
        }),
      ],
      [
        expect.not.objectContaining({
          depositedValue: expect.anything() as unknown,
        }),
      ],
    ]);
    expect(
      state().historyByHeadId[preprodHeadHistories.decommitted.headId],
    ).toHaveLength(3);
  });

  it('drops the history of a head no account participates in any more', () => {
    const { state } = run(({ hot }) => ({
      addresses$: hot('a---------b', {
        a: [decommitterAddress],
        b: [ownerAddress],
      }),
    }));

    expect(Object.keys(state().historyByHeadId)).toEqual([
      '324c8b8198c4c9db7526d6dccb79e992c4863b24b56453bb16995bdc',
    ]);
  });

  it('marks a deposit past its deadline recoverable', () => {
    const { emitted } = run(undefined, { now: afterDeadline });

    const accounts = emitted[0]?.payload.accounts as {
      deposits: { status: string }[];
    }[];
    expect(accounts[1]?.deposits[0]?.status).toBe('recoverable');
  });

  it('resweeps on tip changes at most once per interval', () => {
    const { emitted } = run(
      ({ hot }) => ({
        tip$: hot('a-b-c----------d', {
          a: tip('a'),
          b: tip('b'),
          c: tip('c'),
          d: tip('d'),
        }),
      }),
      { resweepIntervalMs: 10 },
    );

    expect(sweepCompletedFrames(emitted)).toEqual([
      SWEEP_FRAMES,
      15 + SWEEP_FRAMES,
    ]);
  });

  it('does not resweep when the tip is unchanged', () => {
    const { emitted } = run(
      ({ hot }) => ({
        tip$: hot('a--------------a', { a: tip('a') }),
      }),
      { resweepIntervalMs: 10 },
    );

    expect(sweepCompletedFrames(emitted)).toEqual([SWEEP_FRAMES]);
  });

  it('sweeps at once when a new Hydra activity appears, but not for other activities', () => {
    const deposit = activity('deposit', true, sweepStartedAt + 1);
    const { emitted } = run(({ hot }) => ({
      activities$: hot('a---------b---------c', {
        a: {},
        b: { [ownerAccountId]: [deposit] },
        c: {
          [ownerAccountId]: [
            deposit,
            activity('send', false, sweepStartedAt + 2),
          ],
        },
      }),
    }));

    expect(sweepCompletedFrames(emitted)).toEqual([
      SWEEP_FRAMES,
      10 + SWEEP_FRAMES,
    ]);
  });

  it('does not sweep when Hydra history older than the first sweep syncs', () => {
    const { emitted, getUtxosAtAddress } = run(({ hot }) => ({
      activities$: hot('a---------b', {
        a: {},
        b: {
          [ownerAccountId]: [
            activity('old-deposit', true, sweepStartedAt - 100),
            activity('old-recover', true, sweepStartedAt - 50),
          ],
        },
      }),
    }));

    expect(sweepCompletedFrames(emitted)).toEqual([SWEEP_FRAMES]);
    expect(getUtxosAtAddress).toHaveBeenCalledTimes(
      distinctTestnetAddresses.size,
    );
  });

  it('does not sweep when a page of older Hydra activities loads, only for a newer one', () => {
    const latest = activity('latest-deposit', true, sweepStartedAt + 200);
    const olderPage = [
      latest,
      activity('older-deposit', true, sweepStartedAt + 100),
      activity('older-recover', true, sweepStartedAt - 50),
    ];
    const { emitted, getUtxosAtAddress } = run(({ hot }) => ({
      activities$: hot('a---------b---------c', {
        a: { [ownerAccountId]: [latest] },
        b: { [ownerAccountId]: olderPage },
        c: {
          [ownerAccountId]: [
            activity('newer-deposit', true, sweepStartedAt + 300),
            ...olderPage,
          ],
        },
      }),
    }));

    expect(sweepCompletedFrames(emitted)).toEqual([
      SWEEP_FRAMES,
      20 + SWEEP_FRAMES,
    ]);
    expect(getUtxosAtAddress).toHaveBeenCalledTimes(
      2 * distinctTestnetAddresses.size,
    );
  });

  it('sweeps for new Hydra activities at most once per throttle window, keeping the last one', () => {
    const { emitted } = run(
      ({ hot }) => ({
        activities$: hot('a---------b-c-d', {
          a: {},
          b: {
            [ownerAccountId]: [activity('first', true, sweepStartedAt + 1)],
          },
          c: {
            [ownerAccountId]: [
              activity('first', true, sweepStartedAt + 1),
              activity('second', true, sweepStartedAt + 2),
            ],
          },
          d: {
            [ownerAccountId]: [
              activity('first', true, sweepStartedAt + 1),
              activity('second', true, sweepStartedAt + 2),
              activity('third', true, sweepStartedAt + 3),
            ],
          },
        }),
      }),
      { hydraActivityThrottleMs: 20 },
    );

    expect(sweepCompletedFrames(emitted)).toEqual([
      SWEEP_FRAMES,
      10 + SWEEP_FRAMES,
      30 + SWEEP_FRAMES,
    ]);
  });

  it('collapses a burst of account and address changes into one sweep', () => {
    const { emitted, getUtxosAtAddress } = run(
      ({ hot }) => ({
        addresses$: hot('a-b-c', {
          a: [ownerAddress],
          b: [ownerAddress, previewAddress],
          c: allAddresses,
        }),
      }),
      { inputsSettleMs: 5 },
    );

    expect(sweepCompletedFrames(emitted)).toEqual([9 + SWEEP_FRAMES]);
    expect(sweptAccountIds(emitted)).toEqual([
      [coParticipantAccountId, ownerAccountId],
    ]);
    expect(getUtxosAtAddress).toHaveBeenCalledTimes(
      distinctTestnetAddresses.size,
    );
  });

  it('reads nothing more when the network and addresses re-emit unchanged', () => {
    const { emitted, getUtxosAtAddress } = run(({ hot }) => ({
      chainId$: hot('a---------b', { a: preprod, b: { ...preprod } }),
      addresses$: hot('a---------b---------c', {
        a: allAddresses,
        b: [...allAddresses],
        c: [...allAddresses, bitcoinAddress],
      }),
    }));

    expect(sweepCompletedFrames(emitted)).toEqual([SWEEP_FRAMES]);
    expect(getUtxosAtAddress).toHaveBeenCalledTimes(
      distinctTestnetAddresses.size,
    );
  });

  it('sweeps again when the accounts change', () => {
    const { emitted, getUtxosAtAddress } = run(({ hot }) => ({
      addresses$: hot('a---------b', {
        a: [ownerAddress],
        b: [ownerAddress, coParticipantAddress],
      }),
    }));

    expect(sweepCompletedFrames(emitted)).toEqual([
      SWEEP_FRAMES,
      10 + SWEEP_FRAMES,
    ]);
    expect(sweptAccountIds(emitted)).toEqual([
      [ownerAccountId],
      [coParticipantAccountId, ownerAccountId],
    ]);
    expect(getUtxosAtAddress).toHaveBeenCalledTimes(
      2 * distinctTestnetAddresses.size,
    );
  });

  it('sweeps again under the new network when the network changes', () => {
    const { emitted, getUtxosAtAddress } = run(({ hot }) => ({
      chainId$: hot('a---------b', { a: preprod, b: preview }),
    }));

    expect(sweepCompletedFrames(emitted)).toEqual([
      SWEEP_FRAMES,
      10 + SWEEP_FRAMES,
    ]);
    expect(sweptAccountIds(emitted)).toEqual([
      [coParticipantAccountId, ownerAccountId],
      [previewAccountId],
    ]);
    const contexts = getUtxosAtAddress.mock.calls.map(([, context]) => context);
    expect(contexts.slice(distinctTestnetAddresses.size)).toEqual(
      Array.from({ length: distinctTestnetAddresses.size }, () => ({
        chainId: preview,
      })),
    );
  });

  it('reads nothing while the network is paired with addresses of another network', () => {
    const { emitted, getUtxosAtAddress, readFrames } = run(({ hot }) => ({
      chainId$: hot('a---------b', { a: preprod, b: preview }),
      addresses$: hot('a-------------------b', {
        a: [ownerAddress, coParticipantAddress],
        b: [previewAddress],
      }),
    }));

    expect(sweepCompletedFrames(emitted)).toEqual([
      SWEEP_FRAMES,
      20 + SWEEP_FRAMES,
    ]);
    expect(readFrames.filter(frame => frame >= 10 && frame < 20)).toEqual([]);
    for (const [, context] of getUtxosAtAddress.mock.calls.slice(
      distinctTestnetAddresses.size,
    )) {
      expect(context).toEqual({ chainId: preview });
    }
  });

  it('drops a sweep requested while one is in flight', () => {
    const { emitted, getUtxosAtAddress } = run(({ hot }) => ({
      activities$: hot('a-b', {
        a: {},
        b: {
          [ownerAccountId]: [activity('deposit', true, sweepStartedAt + 1)],
        },
      }),
    }));

    expect(sweepCompletedFrames(emitted)).toEqual([SWEEP_FRAMES]);
    expect(getUtxosAtAddress).toHaveBeenCalledTimes(
      distinctTestnetAddresses.size,
    );
  });

  it('drops a sweep requested while the head histories are still being read', () => {
    const { emitted } = run(({ hot }) => ({
      addresses$: of([decommitterAddress]),
      listingLatencyFrames: 10,
      activities$: hot('a----b', {
        a: {},
        b: {
          [ownerAccountId]: [activity('deposit', true, sweepStartedAt + 1)],
        },
      }),
    }));

    expect(emitted.map(({ type, frame }) => ({ type, frame }))).toEqual([
      { type: 'hydraHeadsIndex/sweepCompleted', frame: SWEEP_FRAMES },
      {
        type: 'hydraHeadsIndex/headFundsResolved',
        frame: SWEEP_FRAMES + 10,
      },
    ]);
  });

  it('retries a failed read before completing the sweep', () => {
    const { emitted, getUtxosAtAddress } = run(() => ({ failingReads: 2 }));

    expect(emitted.map(({ type }) => type)).toEqual([
      'hydraHeadsIndex/sweepCompleted',
      'hydraHeadsIndex/headFundsResolved',
    ]);
    expect(getUtxosAtAddress).toHaveBeenCalledTimes(
      distinctTestnetAddresses.size + 2,
    );
  });

  /** The validator address holding the owner's deposit. */
  const depositAddress = preprodHydraUtxos.depositV2.address;

  /** The deposits of the owner in each snapshot a sweep stored. */
  const ownerDepositsOf = (emitted: Emitted[]) =>
    sweepsCompleted(emitted).map(
      ({ payload }) =>
        (
          payload.accounts as { accountId: AccountId; deposits: unknown[] }[]
        ).find(({ accountId }) => accountId === ownerAccountId)?.deposits
          .length,
    );

  describe('a validator address whose read fails', () => {
    it('completes the first sweep from the other addresses when it was never read, naming it unread rather than empty', () => {
      const { emitted, getUtxosAtAddress, state } = run(() => ({
        isReadFailing: address => address === depositAddress,
      }));

      expect(emitted.map(({ type }) => type)).toEqual([
        'hydraHeadsIndex/sweepCompleted',
        'hydraHeadsIndex/headFundsResolved',
      ]);
      expect(getUtxosAtAddress).toHaveBeenCalledTimes(
        distinctTestnetAddresses.size + 3,
      );
      expect(ownerDepositsOf(emitted)).toEqual([0]);
      expect(state().byAccount[ownerAccountId]).toMatchObject({
        failed: false,
        snapshot: { unreadAddresses: [depositAddress] },
      });
      expect(
        state().byAccount[ownerAccountId]?.snapshot?.heads.length,
      ).toBeGreaterThan(0);
    });

    it('keeps the head ids kept from before a restart when their head address was never read', () => {
      const sharedHeadId = preprodHeadHistories.sharedBeforeFanout.headId;
      const sharedHeadAddress = toCardanoUtxo(
        headUtxoOf(preprodHeadHistories.sharedBeforeFanout),
      )[1].address;
      const { emitted, state } = run(
        () => ({
          addresses$: of(depositorAddresses),
          isReadFailing: address => address === sharedHeadAddress,
        }),
        {
          keptDepositedHeadIds: {
            [firstDepositorAccountId]: [sharedHeadId],
          },
        },
      );

      expect(emitted.map(({ type }) => type)).toEqual([
        'hydraHeadsIndex/sweepCompleted',
        'hydraHeadsIndex/headFundsResolved',
      ]);
      expect(state().depositedHeadIdsByAccount).toEqual({
        [firstDepositorAccountId]: [sharedHeadId],
      });
    });

    it('stands in with what the last sweep read there, so only its deposits and heads go stale', () => {
      const { emitted } = run(
        ({ hot }) => ({
          tip$: hot('a--------------b', { a: tip('a'), b: tip('b') }),
          isReadFailing: (address, read) =>
            read >= distinctTestnetAddresses.size && address === depositAddress,
        }),
        { resweepIntervalMs: 10 },
      );

      expect(emitted.map(({ type }) => type)).toEqual([
        'hydraHeadsIndex/sweepCompleted',
        'hydraHeadsIndex/headFundsResolved',
        'hydraHeadsIndex/sweepCompleted',
        'hydraHeadsIndex/headFundsResolved',
      ]);
      expect(ownerDepositsOf(emitted)).toEqual([1, 1]);
    });

    it('is read again on the next sweep', () => {
      const { emitted } = run(
        ({ hot }) => ({
          tip$: hot('a 5s b', { a: tip('a'), b: tip('b') }),
          isReadFailing: (address, read) =>
            read < distinctTestnetAddresses.size + 3 &&
            address === depositAddress,
        }),
        { resweepIntervalMs: 10 },
      );

      expect(emitted.map(({ type }) => type)).toEqual([
        'hydraHeadsIndex/sweepCompleted',
        'hydraHeadsIndex/headFundsResolved',
        'hydraHeadsIndex/sweepCompleted',
        'hydraHeadsIndex/headFundsResolved',
      ]);
      expect(ownerDepositsOf(emitted)).toEqual([0, 1]);
    });
  });

  /** `count` UTxOs at the address of `utxo`, holding no Hydra state. */
  const crowdOf = ([input, output]: Cardano.Utxo, count: number) =>
    Array.from(
      { length: count },
      (_, index): Cardano.Utxo => [
        { ...input, index },
        { address: output.address, value: { coins: 2_000_000n } },
      ],
    );
  const crowdedAddress = recordedUtxos[0][1].address;

  describe('validator page cap', () => {
    it('reads each validator address at most 20 pages of 100 UTxOs', () => {
      const { getUtxosAtAddress } = run();

      expect(getUtxosAtAddress).toHaveBeenCalledTimes(
        distinctTestnetAddresses.size,
      );
      for (const [props] of getUtxosAtAddress.mock.calls) {
        expect(props).toMatchObject({ pageSize: 100, maxPages: 20 });
      }
    });

    it('completes the sweep when an address fills fewer pages than the cap', () => {
      const { emitted } = run(() => ({
        utxosOf: utxos =>
          utxos[0]?.[1].address === crowdedAddress
            ? [...utxos, ...crowdOf(utxos[0], 1999 - utxos.length)]
            : utxos,
      }));

      expect(emitted.map(({ type }) => type)).toEqual([
        'hydraHeadsIndex/sweepCompleted',
        'hydraHeadsIndex/headFundsResolved',
      ]);
    });

    it('completes the first sweep, without a retry, naming unread an address never read that fills its last allowed page', () => {
      const { emitted, getUtxosAtAddress, state } = run(() => ({
        utxosOf: utxos =>
          utxos[0]?.[1].address === crowdedAddress
            ? [...utxos, ...crowdOf(utxos[0], 2000 - utxos.length)]
            : utxos,
      }));

      expect(emitted.map(({ type }) => type)).toEqual([
        'hydraHeadsIndex/sweepCompleted',
        'hydraHeadsIndex/headFundsResolved',
      ]);
      expect(state().byAccount[ownerAccountId]?.snapshot).toMatchObject({
        unreadAddresses: [crowdedAddress],
      });
      expect(getUtxosAtAddress).toHaveBeenCalledTimes(
        distinctTestnetAddresses.size,
      );
    });

    it('keeps what an earlier sweep read at an address that fills its last allowed page once the accounts change', () => {
      const { emitted } = run(
        ({ hot }) => ({
          addresses$: hot('a----------b', {
            a: [ownerAddress],
            b: allAddresses,
          }).pipe(shareReplay({ bufferSize: 1, refCount: false })),
          utxosOf: (utxos, read) =>
            read >= distinctTestnetAddresses.size &&
            utxos[0]?.[1].address === crowdedAddress
              ? [...utxos, ...crowdOf(utxos[0], 2000 - utxos.length)]
              : utxos,
        }),
        { resweepIntervalMs: 100 },
      );

      expect(sweptAccountIds(emitted)).toEqual([
        [ownerAccountId],
        [coParticipantAccountId, ownerAccountId],
      ]);
      expect(ownerDepositsOf(emitted)).toEqual([1, 1]);
    });

    it('keeps what the previous sweep read at an address that later fills its last allowed page', () => {
      const { emitted, state } = run(
        ({ hot }) => ({
          tip$: hot('a--------------b', { a: tip('a'), b: tip('b') }),
          utxosOf: (utxos, read) =>
            read >= distinctTestnetAddresses.size &&
            utxos[0]?.[1].address === crowdedAddress
              ? [...utxos, ...crowdOf(utxos[0], 2000 - utxos.length)]
              : utxos,
        }),
        { resweepIntervalMs: 10 },
      );

      expect(emitted.map(({ type }) => type)).toEqual([
        'hydraHeadsIndex/sweepCompleted',
        'hydraHeadsIndex/headFundsResolved',
        'hydraHeadsIndex/sweepCompleted',
        'hydraHeadsIndex/headFundsResolved',
      ]);
      expect(ownerDepositsOf(emitted)).toEqual([1, 1]);
      expect(state().byAccount[ownerAccountId]).toMatchObject({
        failed: false,
      });
    });
  });

  describe('sweeps on unlock', () => {
    it('reads nothing when the wallet unlocks within the interval of the last sweep', () => {
      const { emitted, getUtxosAtAddress } = run(
        ({ hot }) => ({
          isWalletActive$: hot('a---------b-c', {
            a: true,
            b: false,
            c: true,
          }),
        }),
        { resweepIntervalMs: 100 },
      );

      expect(sweepCompletedFrames(emitted)).toEqual([SWEEP_FRAMES]);
      expect(getUtxosAtAddress).toHaveBeenCalledTimes(
        distinctTestnetAddresses.size,
      );
    });

    it('sweeps when the wallet unlocks once the interval has passed', () => {
      const { emitted } = run(
        ({ hot }) => ({
          isWalletActive$: hot('a---------b---------c', {
            a: true,
            b: false,
            c: true,
          }),
        }),
        { resweepIntervalMs: 10 },
      );

      expect(sweepCompletedFrames(emitted)).toEqual([
        SWEEP_FRAMES,
        20 + SWEEP_FRAMES,
      ]);
    });

    it('sweeps when the wallet unlocks after a failed sweep', () => {
      const { emitted } = run(
        ({ hot }) => ({
          isWalletActive$: hot('a---------b-c', {
            a: true,
            b: false,
            c: true,
          }),
          utxosOf: (utxos, read) =>
            read < distinctTestnetAddresses.size
              ? crowdOf(recordedUtxos[0], 2000)
              : utxos,
        }),
        { resweepIntervalMs: 100 },
      );

      expect(emitted.map(({ type }) => type)).toEqual([
        'hydraHeadsIndex/sweepFailed',
        'hydraHeadsIndex/sweepCompleted',
        'hydraHeadsIndex/headFundsResolved',
      ]);
      expect(sweepCompletedFrames(emitted)).toEqual([12 + SWEEP_FRAMES]);
    });

    it('sweeps when the accounts changed while the wallet was locked', () => {
      const { emitted } = run(
        ({ hot }) => ({
          isWalletActive$: hot('a---------b-c', {
            a: true,
            b: false,
            c: true,
          }),
          addresses$: hot('a----------b', {
            a: [ownerAddress],
            b: allAddresses,
          }).pipe(shareReplay({ bufferSize: 1, refCount: false })),
        }),
        { resweepIntervalMs: 100 },
      );

      expect(sweptAccountIds(emitted)).toEqual([
        [ownerAccountId],
        [coParticipantAccountId, ownerAccountId],
      ]);
    });
  });

  it('throttles sweeps for new Hydra activities to one per minute by default', () => {
    const first = activity('first', true, sweepStartedAt + 1);
    const second = activity('second', true, sweepStartedAt + 2);
    const { emitted } = run(
      ({ hot }) => ({
        activities$: hot('a 9ms b 58999ms c', {
          a: {},
          b: { [ownerAccountId]: [first] },
          c: { [ownerAccountId]: [first, second] },
        }),
      }),
      { hydraActivityThrottleMs: undefined },
    );

    expect(sweepCompletedFrames(emitted)).toEqual([
      SWEEP_FRAMES,
      10 + SWEEP_FRAMES,
      60_010 + SWEEP_FRAMES,
    ]);
  });

  it('reports a failed sweep for every swept account once retries run out', () => {
    const { emitted } = run(() => ({ failingReads: Number.POSITIVE_INFINITY }));

    expect(emitted.map(({ type, payload }) => ({ type, payload }))).toEqual([
      {
        type: 'hydraHeadsIndex/sweepFailed',
        payload: { accountIds: [coParticipantAccountId, ownerAccountId] },
      },
    ]);
  });

  it('reads nothing while the wallet is inactive', () => {
    const { emitted, getUtxosAtAddress } = run(() => ({
      isWalletActive$: of(false),
    }));

    expect(emitted).toEqual([]);
    expect(getUtxosAtAddress).not.toHaveBeenCalled();
  });

  it('stops resweeping once the wallet becomes inactive', () => {
    const { emitted } = run(
      ({ hot }) => ({
        isWalletActive$: hot('a-------b', { a: true, b: false }),
        tip$: hot('---------------a', { a: tip('a') }),
      }),
      { resweepIntervalMs: 10 },
    );

    expect(sweepCompletedFrames(emitted)).toEqual([SWEEP_FRAMES]);
  });

  it('reads nothing while the Hydra Head flag is off', () => {
    const { emitted, getUtxosAtAddress, getAssetTransactionHistory } = run(
      () => ({ features$: of(flagsOff) }),
    );

    expect(emitted).toEqual([]);
    expect(getUtxosAtAddress).not.toHaveBeenCalled();
    expect(getAssetTransactionHistory).not.toHaveBeenCalled();
  });

  it('stops sweeping when the Hydra Head flag is turned off', () => {
    const { emitted } = run(
      ({ hot }) => ({
        features$: hot('a-------b', { a: flagsOn, b: flagsOff }),
        tip$: hot('---------------a', { a: tip('a') }),
      }),
      { resweepIntervalMs: 10 },
    );

    expect(sweepCompletedFrames(emitted)).toEqual([SWEEP_FRAMES]);
  });

  it('reads nothing when no account has an address on the network', () => {
    const { emitted, getUtxosAtAddress } = run(() => ({
      addresses$: of([previewAddress]),
    }));

    expect(emitted).toEqual([]);
    expect(getUtxosAtAddress).not.toHaveBeenCalled();
  });

  describe('history read limits', () => {
    const decommittedTxIds = preprodHeadHistories.decommitted.listing.map(
      ({ tx_hash }) => tx_hash,
    );
    const noFigures = [
      expect.not.objectContaining({
        depositedValue: expect.anything() as unknown,
      }),
    ];

    it('reads every recorded head in full under the default limits', () => {
      const { states, getTransactionDetails } = run(() => ({
        addresses$: of([decommitterAddress, ...sharerAddresses]),
      }));

      expect(getTransactionDetails).toHaveBeenCalledTimes(
        preprodHeadHistories.decommitted.listing.length +
          preprodHeadHistories.sharedBeforeFanout.listing.length,
      );
      for (const accountId of [
        decommitterAccountId,
        firstSharerAccountId,
        secondSharerAccountId,
      ]) {
        expect(resolvedHeadsOf(states, accountId)[0]?.[0]).toHaveProperty(
          'depositedValue',
        );
      }
    });

    it('stops reading a history at the transaction limit and leaves the figures out', () => {
      const { states, getTransactionDetails, state } = run(
        () => ({
          addresses$: of([decommitterAddress]),
        }),
        { historyLimits: { maxTransactionsPerHead: 3 } },
      );

      expect(getTransactionDetails.mock.calls.map(([txId]) => txId)).toEqual(
        decommittedTxIds.slice(0, 3),
      );
      expect(
        state().historyByHeadId[preprodHeadHistories.decommitted.headId],
      ).toHaveLength(3);
      expect(resolvedHeadsOf(states, decommitterAccountId)).toEqual([
        noFigures,
      ]);
    });

    it('reads nothing more for a history at the transaction limit on later sweeps', () => {
      const { states, getAssetTransactionHistory, getTransactionDetails } = run(
        ({ hot }) => ({
          addresses$: of([decommitterAddress]),
          tip$: hot('---------------a--------------b', {
            a: tip('a'),
            b: tip('b'),
          }),
        }),
        { resweepIntervalMs: 10, historyLimits: { maxTransactionsPerHead: 3 } },
      );

      expect(resolvedHeadsOf(states, decommitterAccountId)).toEqual([
        noFigures,
        noFigures,
        noFigures,
      ]);
      expect(getAssetTransactionHistory).toHaveBeenCalledTimes(1);
      expect(getTransactionDetails).toHaveBeenCalledTimes(3);
    });

    it('lists only the pages that hold the first transactions up to the limit', () => {
      const { getAssetTransactionHistory, getTransactionDetails } = run(
        () => ({ addresses$: of([decommitterAddress]) }),
        { historyPageSize: 1, historyLimits: { maxTransactionsPerHead: 2 } },
      );

      expect(
        getAssetTransactionHistory.mock.calls.map(([{ page, maxPages }]) => ({
          page,
          maxPages,
        })),
      ).toEqual([{ page: 1, maxPages: 2 }]);
      expect(getTransactionDetails.mock.calls.map(([txId]) => txId)).toEqual(
        decommittedTxIds.slice(0, 2),
      );
    });

    it('stops reading before the transaction past the resolve budget, re-checking only that one later', () => {
      const [initTx, incrementTx] = decommittedTxIds;
      const {
        states,
        getAssetTransactionHistory,
        getTransactionDetails,
        resolveInput,
        state,
      } = run(
        ({ hot }) => ({
          addresses$: of([decommitterAddress]),
          tip$: hot('---------------a', { a: tip('a') }),
        }),
        {
          resweepIntervalMs: 10,
          historyPageSize: 2,
          historyLimits: {
            maxTransactionsPerHead: 4,
            maxResolvedInputsPerHead: 0,
          },
        },
      );

      expect(getTransactionDetails.mock.calls.map(([txId]) => txId)).toEqual([
        initTx,
        incrementTx,
        incrementTx,
      ]);
      expect(
        getAssetTransactionHistory.mock.calls.map(([{ page, maxPages }]) => ({
          page,
          maxPages,
        })),
      ).toEqual([
        { page: 1, maxPages: 2 },
        { page: 1, maxPages: 2 },
      ]);
      expect(resolveInput).not.toHaveBeenCalled();
      expect(
        state().historyByHeadId[preprodHeadHistories.decommitted.headId]?.map(
          ({ txId }) => txId,
        ),
      ).toEqual([initTx]);
      expect(resolvedHeadsOf(states, decommitterAccountId)).toEqual([
        noFigures,
        noFigures,
      ]);
    });

    it('counts the resolve budget across the whole history of a head', () => {
      const [initTx, firstIncrementTx, secondIncrementTx] =
        preprodHeadHistories.sharedBeforeFanout.listing.map(
          ({ tx_hash }) => tx_hash,
        );
      const { getTransactionDetails, resolveInput, state } = run(
        () => ({ addresses$: of(sharerAddresses.slice(0, 1)) }),
        { historyLimits: { maxResolvedInputsPerHead: 1 } },
      );

      expect(getTransactionDetails.mock.calls.map(([txId]) => txId)).toEqual([
        initTx,
        firstIncrementTx,
        secondIncrementTx,
      ]);
      expect(resolveInput).toHaveBeenCalledTimes(1);
      expect(
        state().historyByHeadId[
          preprodHeadHistories.sharedBeforeFanout.headId
        ]?.map(({ txId }) => txId),
      ).toEqual([initTx, firstIncrementTx]);
    });

    it('reads the history of at most the head limit per account and leaves the others without figures', () => {
      const bothHeadsAccountId = 'acct-both-heads' as AccountId;
      const { states, getAssetTransactionHistory, getTransactionDetails } = run(
        () => ({
          addresses$: of([
            cardanoAddress(bothHeadsAccountId, DECOMMITTER_KEY_HASH, 1),
            cardanoAddress(bothHeadsAccountId, FIRST_PARTICIPANT_KEY_HASH, 1),
          ]),
        }),
        { historyLimits: { maxHeadsPerAccount: 1 } },
      );

      const [heads] = resolvedHeadsOf(states, bothHeadsAccountId);
      expect(heads).toHaveLength(2);
      expect(
        heads?.filter(head => head.depositedValue !== undefined),
      ).toHaveLength(1);
      expect(getAssetTransactionHistory).toHaveBeenCalledTimes(2);
      expect(getTransactionDetails).toHaveBeenCalledTimes(
        Math.min(
          preprodHeadHistories.decommitted.listing.length,
          preprodHeadHistories.sharedBeforeFanout.listing.length,
        ) + 1,
      );
    });

    it('keeps the history of a head past the head limit and reads the same heads whatever the read order', () => {
      const bothHeadsAccountId = 'acct-both-heads' as AccountId;
      const addresses$ = of([
        cardanoAddress(bothHeadsAccountId, DECOMMITTER_KEY_HASH, 1),
        cardanoAddress(bothHeadsAccountId, FIRST_PARTICIPANT_KEY_HASH, 1),
      ]);
      const { historyByHeadId: keptHistories, genuineByHeadId: keptVerdicts } =
        run(() => ({ addresses$ })).state();
      const [readHead] = [
        preprodHeadHistories.decommitted,
        preprodHeadHistories.sharedBeforeFanout,
      ].sort((a, b) => a.headId.localeCompare(b.headId));

      const { getAssetTransactionHistory, getTransactionDetails, state } = run(
        ({ hot }) => ({
          addresses$,
          tip$: hot('---------------a', { a: tip('a') }),
          utxosOf: (utxos, read) =>
            read < distinctTestnetAddresses.size ? utxos : [...utxos].reverse(),
        }),
        {
          resweepIntervalMs: 10,
          keptHistories,
          keptVerdicts,
          historyLimits: { maxHeadsPerAccount: 1 },
        },
      );

      expect(
        getAssetTransactionHistory.mock.calls.map(([{ assetId }]) => assetId),
      ).toEqual([readHead?.stateToken, readHead?.stateToken]);
      expect(getTransactionDetails).not.toHaveBeenCalled();
      expect(state().historyByHeadId).toEqual(keptHistories);
    });

    it('reads the heads an account deposited into before the ones it only participates in', () => {
      const depositorAndDecommitterId =
        'acct-depositor-decommitter' as AccountId;
      const { states, getAssetTransactionHistory, getTransactionDetails } = run(
        () => ({
          addresses$: of([
            cardanoAddress(
              depositorAndDecommitterId,
              FIRST_DEPOSITOR_KEY_HASH,
              1,
            ),
            cardanoAddress(depositorAndDecommitterId, DECOMMITTER_KEY_HASH, 1),
          ]),
          activities$: of({
            [depositorAndDecommitterId]: [
              depositActivity(
                depositorAndDecommitterId,
                preprodHeadHistories.sharedBeforeFanout.headId,
              ),
            ],
          }),
        }),
        { historyLimits: { maxHeadsPerAccount: 1 } },
      );

      expect(
        getAssetTransactionHistory.mock.calls.map(([{ assetId }]) => assetId),
      ).toEqual([
        preprodHeadHistories.sharedBeforeFanout.stateToken,
        preprodHeadHistories.decommitted.stateToken,
      ]);
      expect(getTransactionDetails.mock.calls.map(([txId]) => txId)).toEqual(
        expect.arrayContaining(
          preprodHeadHistories.sharedBeforeFanout.listing.map(
            ({ tx_hash }) => tx_hash,
          ),
        ),
      );
      expect(getTransactionDetails).toHaveBeenCalledTimes(
        preprodHeadHistories.sharedBeforeFanout.listing.length + 1,
      );
      expect(resolvedHeadsOf(states, depositorAndDecommitterId)).toEqual([
        [
          expect.not.objectContaining({
            headId: preprodHeadHistories.sharedBeforeFanout.headId,
          }),
          expect.objectContaining({
            headId: preprodHeadHistories.sharedBeforeFanout.headId,
            depositedValue: { coins: '400000000', assets: {} },
          }),
        ],
      ]);
    });

    it('checks a head the account deposited into ahead of lookalike heads with lower head ids', () => {
      const lookalikes = [0, 1, 2].map(index =>
        lookalikeOf(
          preprodHeadHistories.sharedBeforeFanout,
          lookalikeHeadId(index),
        ),
      );
      const { states, getAssetTransactionHistory } = run(
        () => ({
          addresses$: of(sharerAddresses.slice(0, 2)),
          activities$: of({
            [firstSharerAccountId]: [
              depositActivity(
                firstSharerAccountId,
                preprodHeadHistories.sharedBeforeFanout.headId,
              ),
            ],
          }),
          lookalikes,
        }),
        { historyLimits: { maxHeadChecksPerAccount: 2 } },
      );

      expect(resolvedHeadsOf(states, firstSharerAccountId)).toEqual([
        [
          expect.objectContaining({
            headId: preprodHeadHistories.sharedBeforeFanout.headId,
            depositedValue: { coins: '400000000', assets: {} },
          }),
        ],
      ]);
      expect(
        getAssetTransactionHistory.mock.calls.map(([{ assetId }]) => assetId),
      ).toEqual([
        preprodHeadHistories.sharedBeforeFanout.stateToken,
        lookalikes[0]?.stateToken,
      ]);
    });
  });

  describe('lookalike heads', () => {
    const realHead = preprodHeadHistories.decommitted;
    const lookalike = lookalikeOf(realHead, lookalikeHeadId(0));

    it('gives a lookalike under its own policy no figures and no card, while the real head keeps them', () => {
      const { states, state, getTransactionDetails } = run(() => ({
        addresses$: of([decommitterAddress]),
        lookalikes: [lookalike],
      }));

      expect(resolvedHeadsOf(states, decommitterAccountId)).toEqual([
        [
          expect.objectContaining({
            headId: realHead.headId,
            depositedValue: { coins: '15000000', assets: {} },
            withdrawnValue: { coins: '7000000', assets: {} },
          }),
        ],
      ]);
      expect(
        getTransactionDetails.mock.calls
          .map(([txId]) => txId)
          .filter(txId => txId.startsWith(lookalike.headId)),
      ).toEqual([lookalike.listing[0]?.tx_hash]);
      expect(state().genuineByHeadId).toEqual({
        [realHead.headId]: true,
        [lookalike.headId]: false,
      });
      expect(Object.keys(state().historyByHeadId)).toEqual([realHead.headId]);
      const snapshot = state().byAccount[decommitterAccountId]?.snapshot;
      expect(
        toHydraHeadCards({
          heads: snapshot?.heads ?? [],
          deposits: snapshot?.deposits ?? [],
          now: beforeDeadline.getTime(),
          currency: { decimals: 6, ticker: 'tADA' },
          t,
        }).cards.map(({ headId }) => headId),
      ).toEqual([realHead.headId]);
    });

    it('would credit the account from the lookalike history were it genuine', () => {
      const { states } = run(
        () => ({
          addresses$: of([decommitterAddress]),
          lookalikes: [lookalike],
        }),
        { keptVerdicts: { [lookalike.headId]: true } },
      );

      expect(resolvedHeadsOf(states, decommitterAccountId)).toEqual([
        expect.arrayContaining([
          expect.objectContaining({
            headId: lookalike.headId,
            depositedValue: { coins: '15000000', assets: {} },
          }),
        ]),
      ]);
    });

    it('never checks a known lookalike again', () => {
      const { getAssetTransactionHistory, getTransactionDetails } = run(
        ({ hot }) => ({
          addresses$: of([decommitterAddress]),
          lookalikes: [lookalike],
          tip$: hot('---------------a', { a: tip('a') }),
        }),
        { resweepIntervalMs: 10 },
      );

      expect(
        getAssetTransactionHistory.mock.calls.filter(
          ([{ assetId }]) => assetId === lookalike.stateToken,
        ),
      ).toHaveLength(1);
      expect(
        getTransactionDetails.mock.calls.filter(([txId]) =>
          txId.startsWith(lookalike.headId),
        ),
      ).toHaveLength(1);
    });

    it('never displaces a head verified before with lookalikes past the check budget', () => {
      const lookalikes = [0, 1, 2].map(index =>
        lookalikeOf(realHead, lookalikeHeadId(index)),
      );
      const lookalikeTokens = new Set(
        lookalikes.map(({ stateToken }) => stateToken),
      );
      const { states, state, getAssetTransactionHistory } = run(
        ({ hot }) => ({
          addresses$: of([decommitterAddress]),
          lookalikes,
          utxosOf: (utxos, read) =>
            read < distinctTestnetAddresses.size
              ? utxos.filter(
                  ([, txOut]) =>
                    ![...(txOut.value.assets?.keys() ?? [])].some(unit =>
                      lookalikeTokens.has(unit),
                    ),
                )
              : utxos,
          tip$: hot('---------------a--------------b', {
            a: tip('a'),
            b: tip('b'),
          }),
        }),
        {
          resweepIntervalMs: 10,
          historyLimits: { maxHeadsPerAccount: 1, maxHeadChecksPerAccount: 2 },
        },
      );

      const withFigures = [
        expect.objectContaining({
          headId: realHead.headId,
          depositedValue: { coins: '15000000', assets: {} },
        }),
      ];
      expect(resolvedHeadsOf(states, decommitterAccountId)).toEqual([
        withFigures,
        withFigures,
        withFigures,
      ]);
      expect(
        getAssetTransactionHistory.mock.calls
          .map(([{ assetId }]) => assetId)
          .filter(assetId => lookalikeTokens.has(assetId)),
      ).toEqual(lookalikes.map(({ stateToken }) => stateToken));
      expect(state().genuineByHeadId).toEqual({
        [realHead.headId]: true,
        ...Object.fromEntries(lookalikes.map(({ headId }) => [headId, false])),
      });
    });

    it('fills the head limit with genuine heads, not lookalikes', () => {
      const bothHeadsAccountId = 'acct-both-heads' as AccountId;
      const lookalikes = [0, 1, 2].map(index =>
        lookalikeOf(realHead, lookalikeHeadId(index)),
      );
      const { states } = run(
        () => ({
          addresses$: of([
            cardanoAddress(bothHeadsAccountId, DECOMMITTER_KEY_HASH, 1),
            cardanoAddress(bothHeadsAccountId, FIRST_PARTICIPANT_KEY_HASH, 1),
          ]),
          lookalikes,
        }),
        { historyLimits: { maxHeadsPerAccount: 2 } },
      );

      const [heads] = resolvedHeadsOf(states, bothHeadsAccountId);
      expect(heads?.map(({ headId }) => headId).sort()).toEqual(
        [
          preprodHeadHistories.decommitted.headId,
          preprodHeadHistories.sharedBeforeFanout.headId,
        ].sort(),
      );
      for (const head of heads ?? []) {
        expect(head).toHaveProperty('depositedValue');
      }
    });
  });
});
