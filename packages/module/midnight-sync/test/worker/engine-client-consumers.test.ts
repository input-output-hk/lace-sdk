import { activitiesActions } from '@lace-contract/activities';
import {
  inProcessMidnightWallets$,
  isRemoteMidnightEngine,
  midnightContextActions,
  midnightWalletsForRuntime,
} from '@lace-contract/midnight-context';
import { HexBytes } from '@lace-lib/util';
import {
  BehaviorSubject,
  firstValueFrom,
  lastValueFrom,
  of,
  take,
  toArray,
} from 'rxjs';
import { dummyLogger } from 'ts-log';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { createMidnightSideEffectDependencies } from '../../src/store/dependencies';
import {
  loadActivityDetails,
  updateActivities,
} from '../../src/store/side-effects/activities';
import {
  updateDustBalance,
  updateDustGenerationDetails,
  updateSetPublicKeys,
} from '../../src/store/side-effects/watch';
import { encodeMidnightRecipe } from '../../src/worker/codec';
import { remoteEngineClientOf } from '../../src/worker/engine-client';
import {
  dustBalancesOf,
  dustGenerationOf,
  midnightStateOf$,
  shieldedPublicKeysOf,
  strictCompletionOf,
} from '../../src/worker/state-accessors';
import { toMidnightStateView } from '../../src/worker/state-view';

import {
  createClient,
  createFakeWorkers,
  startParams,
  until,
} from './engine-client-fakes';
import {
  facadeState,
  fakeEngines,
  finalized,
  nightCoin,
  sealedAccount,
  unprovenRecipe,
  useFastKeyDerivation,
} from './engine-host-fakes';

import type { FakeConnection } from './engine-client-fakes';
import type { SideEffect } from '../../src/context';
import type { OpaqueMidnightRecipe } from '../../src/worker/codec';
import type { MidnightRemoteEngineClient } from '../../src/worker/engine-client';
import type {
  MidnightConnectorRequest,
  MidnightEngineHost,
  MidnightWorkerTxRequest,
} from '../../src/worker/protocol';
import type {
  AttestationProgressEvent,
  MidnightAccountProps,
  MidnightEngine,
  MidnightEnginesByAccountId,
  MidnightRemoteEngine,
  MidnightSignRequest,
  MidnightWallet,
} from '@lace-contract/midnight-context';
import type { ModuleInitProps } from '@lace-contract/module';
import type { InMemoryWalletAccount } from '@lace-contract/wallet-repo';
import type { WalletEntry } from '@midnightntwrk/wallet-sdk';
import type { FacadeState } from '@midnightntwrk/wallet-sdk/facade';
import type { Action } from '@reduxjs/toolkit';
import type { Observable, Subscription } from 'rxjs';

vi.mock('../../src/store/dependencies', async importOriginal => {
  const fakes = await import('./engine-host-fakes');
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    createStartMidnightAccountWallet: fakes.fakeEngines.createStart,
  };
});

type Account = InMemoryWalletAccount<MidnightAccountProps>;

const actions = { ...midnightContextActions, ...activitiesActions };

const states: Record<string, FacadeState> = {
  'no DUST coin': facadeState(),
  'DUST coins with generation times': facadeState({
    availableCoins: [nightCoin(10n), nightCoin(3n)],
    pendingCoins: [nightCoin(2n)],
    dustCoins: [
      {
        generatedNow: 5n,
        maxCap: 10n,
        rate: 1n,
        dtime: new Date(9000),
        maxCapReachedAt: new Date(2000),
      },
      {
        generatedNow: 7n,
        maxCap: 20n,
        rate: 2n,
        dtime: new Date(4000),
        maxCapReachedAt: new Date(6000),
      },
    ],
  }),
  'sub-wallets partly synced': facadeState({
    synced: { unshielded: true, shielded: false, dust: true },
  }),
};

// The leading emission of a reader, which its throttle lets through at once.
const firstActionOf = async (
  sideEffect: SideEffect,
  dependencies: object = {},
  actionObservables: object = {},
): Promise<Action> =>
  firstValueFrom(
    sideEffect(
      actionObservables as Parameters<SideEffect>[0],
      {} as Parameters<SideEffect>[1],
      {
        actions,
        logger: dummyLogger,
        ...dependencies,
      } as unknown as Parameters<SideEffect>[2],
    ),
  );

const transferTx: MidnightWorkerTxRequest = {
  kind: 'transfer',
  transfer: {
    kind: 'unshielded',
    outputs: [{ to: 'mn_addr_test', tokenId: 'night', amount: 1n }],
  },
};
const connectorRequest: MidnightConnectorRequest = {
  kind: 'balance-sealed',
  tx: 'aa',
};
const signRequest: MidnightSignRequest = {
  serializedTx: HexBytes.fromUTF8('{"transfers":[]}'),
};

const registryOf = (engine: MidnightEngine) =>
  new BehaviorSubject<MidnightEnginesByAccountId>({
    [engine.accountId]: engine,
  });

describe('test:engine-client-consumers', () => {
  let a: Account;
  const subscriptions: Subscription[] = [];

  beforeAll(async () => {
    useFastKeyDerivation();
    a = await sealedAccount({ walletId: 'wallet-a' });
  });
  beforeEach(() => {
    fakeEngines.reset();
    useFastKeyDerivation();
  });
  afterEach(() => {
    for (const subscription of subscriptions.splice(0))
      subscription.unsubscribe();
    vi.restoreAllMocks();
  });

  let createdConnection: () => FakeConnection = () => {
    throw new Error('no connection yet');
  };

  /** A worker engine whose worker-side engine holds `state`, and an in-process engine with the same state. */
  const bothEngines = async (state: FacadeState) => {
    const workers = createFakeWorkers();
    createdConnection = () => workers.connections[0];
    const client = createClient(workers);
    const engines: MidnightRemoteEngineClient[] = [];
    subscriptions.push(
      client
        .startAccountEngine(startParams(a))
        .subscribe(engine => engines.push(engine)),
    );
    await until(() => engines.length === 1);
    const workerSide = fakeEngines.current(a.accountId);
    workerSide.state$.next(state);
    const inProcess = {
      ...workerSide.engine,
      state: () => of(state),
    } as MidnightWallet;
    return { remote: engines[0], inProcess, workerSide };
  };

  describe('state accessors', () => {
    it.each(Object.entries(states))(
      'compute the same values from an engine state and from its view (%s)',
      (_, state) => {
        const view = toMidnightStateView(state);

        expect(dustBalancesOf(view)).toEqual(dustBalancesOf(state));
        expect(dustGenerationOf(view)).toEqual(dustGenerationOf(state));
        expect(shieldedPublicKeysOf(view)).toEqual(shieldedPublicKeysOf(state));
        expect(strictCompletionOf(view)).toEqual(strictCompletionOf(state));
      },
    );

    it('read the state of an in-process engine and the view of a worker engine', async () => {
      const state = states['DUST coins with generation times'];
      const { remote, inProcess } = await bothEngines(state);

      await expect(firstValueFrom(midnightStateOf$(inProcess))).resolves.toBe(
        state,
      );
      await expect(firstValueFrom(midnightStateOf$(remote))).resolves.toEqual(
        toMidnightStateView(state),
      );
    });

    it('refuse a remote engine that this module did not make', () => {
      const foreign = {
        accountId: a.accountId,
        remote: true,
      } as unknown as MidnightRemoteEngine;

      expect(() => midnightStateOf$(foreign)).toThrow(
        "was not made by this module's engine client",
      );
      expect(() => remoteEngineClientOf(foreign)).toThrow();
    });
  });

  describe('worker operations', () => {
    it('bind each operation to this page and the account, and pass its request and result through', async () => {
      const { remote } = await bothEngines(facadeState());
      const connection = createdConnection();
      const caller = { clientId: connection.clientId, accountId: a.accountId };
      const recipe = { tag: 'recipe' } as unknown as OpaqueMidnightRecipe;
      const circuit = {
        serializedPreimage: new Uint8Array([1]),
        keyLocation: 'circuit',
      };
      const operations: [
        keyof MidnightEngineHost,
        () => Observable<unknown>,
        Record<string, unknown>,
      ][] = [
        ['build', () => remote.build(transferTx), { tx: transferTx }],
        ['estimate', () => remote.estimate(transferTx), { tx: transferTx }],
        ['sign', () => remote.sign(recipe), { recipe }],
        ['prove', () => remote.prove(recipe), { recipe }],
        ['discard', () => remote.discard(recipe), { recipe }],
        [
          'buildConnectorTransaction',
          () => remote.buildConnectorTransaction(connectorRequest),
          { transaction: connectorRequest },
        ],
        ['checkCircuit', () => remote.checkCircuit(circuit), circuit],
        [
          'proveCircuit',
          () => remote.proveCircuit({ ...circuit, overwriteBindingInput: 3n }),
          { ...circuit, overwriteBindingInput: 3n },
        ],
        [
          'signData',
          () => remote.signData(new Uint8Array([7])),
          { data: new Uint8Array([7]) },
        ],
        [
          'transactionHistoryEntry',
          () => remote.getTransactionHistoryEntryByHash('tx-hash'),
          { hash: 'tx-hash' },
        ],
        [
          'signTransaction',
          () => remote.signTransaction(signRequest),
          { request: signRequest },
        ],
      ];

      for (const [method, call, request] of operations) {
        const result = { method };
        const spy = vi
          .spyOn(connection.host, method)
          .mockResolvedValue(result as never);

        await expect(firstValueFrom(call())).resolves.toBe(result);
        expect(spy).toHaveBeenCalledWith({ ...caller, ...request });
      }
    });

    it('stream the proving progress of their own call to its callback', async () => {
      const { remote, workerSide } = await bothEngines(facadeState());
      const event = {
        type: 'progress-event',
      } as unknown as AttestationProgressEvent;
      vi.mocked(workerSide.engine.finalizeRecipe).mockImplementation(
        (_recipe, onProgress) => {
          onProgress?.(event);
          return of(finalized()) as never;
        },
      );
      const onProgress = vi.fn();

      const proved = await firstValueFrom(
        remote.prove(
          encodeMidnightRecipe(unprovenRecipe(), {
            accountId: remote.accountId,
            engineGeneration: remote.engineGeneration!,
          }),
          onProgress,
        ),
      );

      expect(typeof proved.activityHash).toBe('string');
      await until(() => onProgress.mock.calls.length > 0);
      expect(onProgress).toHaveBeenCalledWith(event);
    });

    it('give each proving call a random operation id that names no client', async () => {
      const { remote } = await bothEngines(facadeState());
      const connection = createdConnection();
      const prove = vi.spyOn(connection.host, 'prove');
      const recipe = () =>
        encodeMidnightRecipe(unprovenRecipe(), {
          accountId: remote.accountId,
          engineGeneration: remote.engineGeneration!,
        });

      await firstValueFrom(remote.prove(recipe(), vi.fn()));
      await firstValueFrom(remote.prove(recipe(), vi.fn()));

      const ids = prove.mock.calls.map(([{ operationId }]) => operationId);
      expect(ids).toHaveLength(2);
      expect(new Set(ids).size).toBe(2);
      for (const id of ids) {
        expect(id).toMatch(
          /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/,
        );
        expect(id).not.toContain(connection.clientId);
      }
    });

    it('map a refusal of the worker to its reason and the account', async () => {
      const { remote } = await bothEngines(facadeState());

      await expect(
        firstValueFrom(
          remote.sign(
            encodeMidnightRecipe(unprovenRecipe(), {
              accountId: remote.accountId,
              engineGeneration: 'an-earlier-engine',
            }),
          ),
        ),
      ).rejects.toMatchObject({
        name: 'MidnightEngineClientError',
        reason: 'stale-value',
        accountId: a.accountId,
      });
    });
  });

  describe('registry consumers', () => {
    it.each([
      ['dust balance', updateDustBalance],
      ['DUST generation', updateDustGenerationDetails],
    ] as const)(
      'watcher, %s: dispatches the same action for a worker engine as for an in-process engine of the same state',
      async (_, reader) => {
        const state = states['DUST coins with generation times'];
        const { remote, inProcess } = await bothEngines(state);

        const fromInProcess = await firstActionOf(
          reader(inProcess, registryOf(inProcess)),
        );
        const fromRemote = await firstActionOf(
          reader(remote, registryOf(remote)),
        );

        expect(fromRemote).toEqual(fromInProcess);
      },
    );

    it('watcher, public keys: dispatches the same action for a worker engine as for an in-process engine', async () => {
      const { remote, inProcess } = await bothEngines(facadeState());

      expect(await firstActionOf(updateSetPublicKeys(remote))).toEqual(
        await firstActionOf(updateSetPublicKeys(inProcess)),
      );
    });

    it('activity details: load the history entry through the worker operation', async () => {
      const { remote, inProcess, workerSide } = await bothEngines(
        facadeState(),
      );
      const entry = {
        hash: 'tx-hash',
        status: 'SUCCESS',
        timestamp: new Date(1000),
        fees: 0n,
      } as unknown as WalletEntry;
      vi.mocked(
        workerSide.engine.getTransactionHistoryEntryByHash,
      ).mockReturnValue(of(entry));
      const detailsWith = async (engine: MidnightEngine) =>
        firstActionOf(
          loadActivityDetails,
          { getMidnightWalletByAccountId: () => of(engine) },
          {
            activities: {
              loadActivityDetails$: of(
                actions.activities.loadActivityDetails({
                  activity: { activityId: 'tx-hash', accountId: a.accountId },
                  blockchainName: 'Midnight',
                } as Parameters<typeof actions.activities.loadActivityDetails>[0]),
              ),
            },
          },
        );

      const fromInProcess = await detailsWith({
        ...inProcess,
        getTransactionHistoryEntryByHash: () => of(entry),
      } as MidnightWallet);
      const fromRemote = await detailsWith(remote);

      expect(fromRemote).toEqual(fromInProcess);
      expect(fromRemote).toMatchObject({
        type: actions.activities.setActivityDetails.type,
        payload: { activityDetails: { activityId: 'tx-hash' } },
      });
      expect(
        workerSide.engine.getTransactionHistoryEntryByHash,
      ).toHaveBeenCalledWith('tx-hash');
    });

    it('activities: map the history of a worker engine from the engine registry', async () => {
      const { remote } = await bothEngines(facadeState());
      const entry = {
        hash: 'tx-hash',
        status: 'SUCCESS',
        timestamp: new Date(1000),
      } as unknown as WalletEntry;
      fakeEngines.current(a.accountId).engine.transactionHistory$ = of([entry]);
      const emitted = await lastValueFrom(
        updateActivities(
          {} as Parameters<SideEffect>[0],
          {
            features: {
              selectLoadedFeatures$: of({ featureFlags: [], modules: [] }),
            },
          } as unknown as Parameters<SideEffect>[1],
          {
            actions,
            midnightEngines$: of(registryOf(remote).value),
          } as unknown as Parameters<SideEffect>[2],
        ).pipe(take(1), toArray()),
      );

      expect(emitted[0]).toMatchObject({
        type: actions.activities.upsertActivities.type,
        payload: { accountId: a.accountId },
      });
    });

    it('in-process consumers (transaction executor, dApp connector): their wallets stream errors once a worker engine appears', async () => {
      const runtime = {} as ModuleInitProps['runtime'];
      const registry = midnightWalletsForRuntime(runtime);
      const { remote, inProcess } = await bothEngines(facadeState());
      const { midnightWallets$, midnightEngines$ } =
        createMidnightSideEffectDependencies()({ runtime } as ModuleInitProps, {
          logger: dummyLogger,
        });
      registry.next({ [inProcess.accountId]: inProcess });
      const before = await firstValueFrom(midnightWallets$);
      registry.next({ [remote.accountId]: remote });

      expect(before[inProcess.accountId]).toBe(inProcess);
      await expect(firstValueFrom(midnightWallets$)).rejects.toThrow(
        `The Midnight transaction executor needs the Midnight engine of account "${a.accountId}" in this JavaScript context, but it runs in a worker`,
      );
      expect(midnightEngines$).toBe(registry);
    });

    it('the contract narrows each kind explicitly', async () => {
      const { remote, inProcess } = await bothEngines(facadeState());

      const inProcessWallets = await firstValueFrom(
        inProcessMidnightWallets$(
          of({ [inProcess.accountId]: inProcess }),
          'A test',
        ),
      );

      expect(isRemoteMidnightEngine(remote)).toBe(true);
      expect(isRemoteMidnightEngine(inProcess)).toBe(false);
      expect(inProcessWallets[inProcess.accountId]).toBe(inProcess);
      await expect(
        firstValueFrom(
          inProcessMidnightWallets$(
            of({ [remote.accountId]: remote }),
            'A test',
          ),
        ),
      ).rejects.toThrow('A test needs the Midnight engine');
    });
  });
});
