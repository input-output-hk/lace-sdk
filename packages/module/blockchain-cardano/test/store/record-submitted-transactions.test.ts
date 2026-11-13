import {
  cardanoContextActions,
  cardanoContextSelectors,
  CardanoNetworkId,
  inFlightTransactionOf,
} from '@lace-contract/cardano-context';
import { cardanoContextReducers } from '@lace-contract/cardano-context/src/store/slice';
import {
  combineContracts,
  createModuleLoader,
  createStore,
  inferModuleContext,
  inferStoreContext,
  ModuleName,
} from '@lace-contract/module';
import { makeBuildTx, makeSubmitTx } from '@lace-contract/tx-executor';
import { makeExecuteTxPhase } from '@lace-contract/tx-executor/src/store/side-effects';
import { txExecutorActions } from '@lace-contract/tx-executor/src/store/slice';
import { AccountId } from '@lace-contract/wallet-repo';
import { Cardano, Serialization } from '@lace-lib/cardano-core';
import { BigNumber, HexBytes, Timestamp } from '@lace-lib/util';
import { testSideEffect } from '@lace-lib/util-dev';
import { createAction } from '@reduxjs/toolkit';
import { map, mergeMap, of, take } from 'rxjs';
import { dummyLogger } from 'ts-log';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { recordSubmittedTransactions } from '../../src/store/record-submitted-transactions-side-effect';

import type {
  AnyLaceSideEffect,
  AppConfig,
  StateObservables,
} from '@lace-contract/module';
import type { TokenId } from '@lace-contract/tokens';
import type {
  BuildTxParams,
  TxExecutorImplementation,
} from '@lace-contract/tx-executor';
import type { Storage } from 'redux-persist';
import type { Logger } from 'ts-log';

const accountId = AccountId('test-account');
const submittedAt = 1_700_000_000_000;
const preprod = Cardano.ChainIds.Preprod;
const mainnet = Cardano.ChainIds.Mainnet;

const signedCbor = (index: number): string =>
  Serialization.Transaction.fromCore({
    body: {
      inputs: [
        {
          txId: Cardano.TransactionId(
            '39a7a284c2a0948189dc45dec670211cd4d72f7b66c5726c08d9b3df11e44d58',
          ),
          index,
        },
      ],
      outputs: [
        {
          address: Cardano.PaymentAddress(
            'addr_test1qqt3r9kd56aq9ajynjkz8hdfw3kc0pcv3tpzug8azxls62tvvz7nw9gmznn65g4ksrrfvyzhz52knc3mqxdyya47gz2qmcjmcq',
          ),
          value: { coins: 9_800_000n },
        },
      ],
      fee: 200_000n,
    },
    id: Cardano.TransactionId('0'.repeat(64)),
    witness: { signatures: new Map() },
  }).toCbor();

const firstTx = signedCbor(0);
const secondTx = signedCbor(1);

const requested = (
  executionId: string,
  serializedTx: string,
  { blockchainName = 'Cardano', type = 'submitTx' } = {},
) => ({
  type: 'txExecutor/tx-phase-requested',
  payload: {
    executionId,
    config: {
      type,
      params: {
        accountId,
        blockchainName,
        blockchainSpecificSendFlowData: {},
        serializedTx,
      },
    },
  },
});

const accepted = (executionId: string) => ({
  type: 'txExecutor/tx-phase-completed',
  payload: { executionId, result: { success: true, txId: 'tx' } },
});

const refused = (executionId: string) => ({
  type: 'txExecutor/tx-phase-completed',
  payload: {
    executionId,
    result: {
      success: false,
      errorTranslationKeys: { title: 'title', subtitle: 'subtitle' },
    },
  },
});

const recorded = (serializedTx: string, chainId: Cardano.ChainId) =>
  cardanoContextActions.cardanoContext.recordInFlightTransaction(
    inFlightTransactionOf({
      serializedTx: HexBytes(serializedTx),
      chainId,
      submittedAt: Timestamp(submittedAt),
    }),
  );

type Marbles = {
  requested: string;
  requestedValues: Record<string, unknown>;
  completed: string;
  completedValues: Record<string, unknown>;
  chainId?: string;
  chainIdValues?: Record<string, Cardano.ChainId | undefined>;
  expected: string;
  expectedValues?: Record<string, unknown>;
  logger?: Logger;
};

const run = ({
  requested: requestedMarble,
  requestedValues,
  completed: completedMarble,
  completedValues,
  chainId = 'c',
  chainIdValues = { c: preprod },
  expected,
  expectedValues,
  logger = { error: vi.fn() } as unknown as Logger,
}: Marbles) => {
  testSideEffect(
    recordSubmittedTransactions,
    ({ cold, hot, expectObservable }) => ({
      actionObservables: {
        // Hot: every completion subscriber sees the one action stream.
        txExecutor: {
          txPhaseRequested$: hot(requestedMarble, requestedValues) as never,
          txPhaseCompleted$: hot(completedMarble, completedValues) as never,
        },
      },
      stateObservables: {
        cardanoContext: { selectChainId$: cold(chainId, chainIdValues) },
      },
      dependencies: { actions: cardanoContextActions, logger },
      assertion: sideEffect$ => {
        expectObservable(sideEffect$).toBe(expected, expectedValues);
      },
    }),
  );
};

describe('recordSubmittedTransactions', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(submittedAt);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("records an accepted Cardano submission from the request's bytes on the network at request time", () => {
    run({
      requested: '-a',
      requestedValues: { a: requested('1', firstTx) },
      completed: '---b',
      completedValues: { b: accepted('1') },
      // The network switches while the provider answers: the body went to
      // the network the request saw.
      chainId: 'p-m',
      chainIdValues: { p: preprod, m: mainnet },
      expected: '---r',
      expectedValues: { r: recorded(firstTx, preprod) },
    });
  });

  it('joins each completion to its own request by executionId', () => {
    run({
      requested: '-(ab)',
      requestedValues: {
        a: requested('1', firstTx),
        b: requested('2', secondTx),
      },
      completed: '--BA',
      completedValues: { A: accepted('1'), B: accepted('2') },
      expected: '--ba',
      expectedValues: {
        a: recorded(firstTx, preprod),
        b: recorded(secondTx, preprod),
      },
    });
  });

  it('records nothing when the provider refused the submission', () => {
    run({
      requested: '-a',
      requestedValues: { a: requested('1', firstTx) },
      completed: '--b',
      completedValues: { b: refused('1') },
      expected: '',
    });
  });

  it('records nothing for a Bitcoin submission or another phase', () => {
    run({
      requested: '-ab',
      requestedValues: {
        a: requested('1', firstTx, { blockchainName: 'Bitcoin' }),
        b: requested('2', secondTx, { type: 'buildTx' }),
      },
      completed: '---AB',
      completedValues: { A: accepted('1'), B: accepted('2') },
      expected: '',
    });
  });

  it('records nothing without a chain id', () => {
    run({
      requested: '-a',
      requestedValues: { a: requested('1', firstTx) },
      completed: '--b',
      completedValues: { b: accepted('1') },
      chainIdValues: { c: undefined },
      expected: '',
    });
  });

  it('logs a body that does not decode and keeps recording later submissions', () => {
    const logger = { error: vi.fn() } as unknown as Logger;

    run({
      requested: '-a-b',
      requestedValues: {
        a: requested('1', 'deadbeef'),
        b: requested('2', secondTx),
      },
      completed: '--A-B',
      completedValues: { A: accepted('1'), B: accepted('2') },
      expected: '----b',
      expectedValues: { b: recorded(secondTx, preprod) },
      logger,
    });

    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});

describe('recordSubmittedTransactions in the store', () => {
  const flowActions = {
    flow: {
      submit: createAction('flow/submit'),
      submitted: createAction('flow/submitted'),
      built: createAction('flow/built'),
    },
  };
  const actions = {
    ...cardanoContextActions,
    ...txExecutorActions,
    ...flowActions,
  };

  const buildParams = {
    accountId,
    blockchainName: 'Cardano',
    blockchainSpecificSendFlowData: {},
    serializedTx: '',
    txParams: [
      {
        address: 'addr_test',
        tokenTransfers: [
          {
            normalizedAmount: BigNumber(1n),
            token: { tokenId: 'lovelace' as TokenId },
          },
        ],
      },
    ],
  } as unknown as BuildTxParams;

  /** A flow that submits through the tx-executor and dispatches its result. */
  const submitFlow: AnyLaceSideEffect = ({ flow: { submit$ }, txExecutor }) =>
    submit$.pipe(
      mergeMap(() =>
        makeSubmitTx(txExecutor)(
          {
            accountId,
            blockchainName: 'Cardano',
            blockchainSpecificSendFlowData: {},
            serializedTx: firstTx,
          },
          () => flowActions.flow.submitted(),
        ),
      ),
    );

  /** A flow that requests its next build on the submit result action. */
  const buildOnSubmitted: AnyLaceSideEffect = ({
    flow: { submitted$ },
    txExecutor,
  }) =>
    submitted$.pipe(
      mergeMap(() =>
        makeBuildTx(txExecutor)(buildParams, () => flowActions.flow.built()),
      ),
    );

  const reduxPersistStorage: Storage = {
    getItem: async () => undefined,
    removeItem: async () => undefined,
    setItem: async () => undefined,
  };

  it('records the entry before a build a flow requests on its submit result', async () => {
    const builtOn: string[][] = [];
    const cardanoImplementation = (
      _: unknown,
      stateObservables: StateObservables<typeof selectors>,
    ) =>
      ({
        blockchainName: 'Cardano',
        submitTx: () => of({ success: true, txId: 'tx' }),
        buildTx: () =>
          stateObservables.cardanoContext.selectInFlightTransactions$.pipe(
            take(1),
            map(inFlight => {
              builtOn.push(Object.keys(inFlight));
              return { success: true, fees: [], serializedTx: '' };
            }),
          ),
      } as unknown as TxExecutorImplementation);
    const selectors = {
      cardanoContext: {
        selectChainId: () => preprod,
        selectInFlightTransactions:
          cardanoContextSelectors.cardanoContext.selectInFlightTransactions,
      },
    };
    const runtime = {
      app: 'lace-extension' as const,
      env: 'production' as const,
      config: {} as AppConfig,
      platform: 'web-extension' as const,
      features: {
        availableModules: [],
        loaded: { featureFlags: [], modules: [] },
      },
    };
    const module = inferModuleContext({
      moduleName: ModuleName('record-ordering-test'),
      implements: combineContracts([] as const),
      store: inferStoreContext({
        context: { actions, selectors },
        load: async () => ({
          default: () => ({
            reducers: cardanoContextReducers,
            // Persisted, as in the apps, so the store's rehydration completes.
            persistConfig: {
              cardanoContext: {
                version: 1,
                whitelist: ['inFlightTransactions'],
              },
            },
            sideEffects: [
              makeExecuteTxPhase({
                implementationFactories: [
                  cardanoImplementation as unknown as Parameters<
                    typeof makeExecuteTxPhase
                  >[0]['implementationFactories'][number],
                ],
              }),
              recordSubmittedTransactions,
              submitFlow,
              buildOnSubmitted,
            ] as AnyLaceSideEffect[],
          }),
        }),
      }),
      addons: {},
    });
    const { store, teardown } = await createStore(
      {
        loadModules: createModuleLoader(
          { modules: [module], runtime },
          { logger: dummyLogger },
        ),
        runtime,
      },
      { logger: dummyLogger, reduxPersistStorage },
    );

    try {
      store.dispatch(flowActions.flow.submit());
      await vi.waitFor(() => {
        expect(builtOn).toHaveLength(1);
      });

      const { txId } = inFlightTransactionOf({
        serializedTx: HexBytes(firstTx),
        chainId: preprod,
      });
      expect(builtOn).toEqual([
        [`${CardanoNetworkId(preprod.networkMagic)}:${txId}`],
      ]);
    } finally {
      teardown();
    }
  });
});
