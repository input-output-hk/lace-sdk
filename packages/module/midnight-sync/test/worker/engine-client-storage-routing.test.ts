import { activitiesActions } from '@lace-contract/activities';
import { addressesActions } from '@lace-contract/addresses';
import { failuresActions } from '@lace-contract/failures';
import {
  midnightContextActions,
  MidnightNetworkId,
  MidnightSDKNetworkIds,
  midnightWalletsForRuntime,
} from '@lace-contract/midnight-context';
import { syncActions } from '@lace-contract/sync';
import { tokensActions } from '@lace-contract/tokens';
import { walletsActions } from '@lace-contract/wallet-repo';
import { Percent } from '@lace-lib/cardano-util';
import { Timestamp } from '@lace-lib/util';
import { testSideEffect } from '@lace-lib/util-dev';
import {
  BehaviorSubject,
  delay,
  firstValueFrom,
  merge,
  NEVER,
  of,
  retry,
  Subject,
  throwError,
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

import { FEATURE_FLAG_MIDNIGHT_SHIELDED_ACTIVITY_ROWS } from '../../src/const';
import { createAccountKeyManager } from '../../src/store/account-keys';
import { midnightSyncActions } from '../../src/store/actions';
import { updateActivities } from '../../src/store/side-effects/activities';
import {
  createWorkerClearWalletStateOnResync,
  createWorkerDeleteWalletSideEffect,
  createWorkerResetSyncStateSideEffect,
  showMidnightEngineResets,
} from '../../src/store/side-effects/resync';
import { surfaceMidnightEngineFailures } from '../../src/store/side-effects/sync-failure';
import {
  createWatchMidnightAccount,
  updateSyncProgress,
} from '../../src/store/side-effects/watch';
import { MidnightSyncFailureId } from '../../src/value-objects/midnight-sync-failure-id.vo';
import { encodeMidnightFinalizedTx } from '../../src/worker/codec';
import {
  acrossMidnightEngineResets,
  MidnightEngineClientError,
} from '../../src/worker/engine-client';

import {
  createClient,
  createFakeWorkers,
  flush,
  passwordAuth,
  startParams,
  until,
} from './engine-client-fakes';
import {
  accountAddress,
  checkpoint,
  facadeState,
  fakeEngines,
  finalized,
  nightCoin,
  PASSWORD,
  sealedAccount,
  useFastKeyDerivation,
  WRONG_PASSWORD,
} from './engine-host-fakes';

import type { SideEffect } from '../../src/context';
import type {
  MidnightEngineClient,
  MidnightRemoteEngineClient,
} from '../../src/worker/engine-client';
import type {
  MidnightAccountId,
  MidnightAccountProps,
  MidnightEngine,
  MidnightEnginesByAccountId,
} from '@lace-contract/midnight-context';
import type {
  AnyWallet,
  InMemoryWalletAccount,
} from '@lace-contract/wallet-repo';
import type { Action } from '@reduxjs/toolkit';
import type { Observable, ObservedValueOf, Subscription } from 'rxjs';

const watchMidnightAccount = createWatchMidnightAccount(
  createAccountKeyManager,
);

vi.mock('../../src/store/dependencies', async importOriginal => {
  const fakes = await import('./engine-host-fakes');
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    createStartMidnightAccountWallet: fakes.fakeEngines.createStart,
  };
});

type Account = InMemoryWalletAccount<MidnightAccountProps>;
type MidnightEngineNotice = ObservedValueOf<MidnightEngineClient['notices$']>;
type MidnightEngineClientErrorReason = MidnightEngineClientError['reason'];

const actions = {
  ...midnightSyncActions,
  ...tokensActions,
  ...addressesActions,
  ...midnightContextActions,
  ...activitiesActions,
  ...syncActions,
  ...walletsActions,
  ...failuresActions,
};

const cacheResets = (account: Account) => [
  actions.addresses.resetAddresses({ accountId: account.accountId }),
  actions.tokens.resetAccountTokens({ accountId: account.accountId }),
  actions.activities.resetActivities({ accountId: account.accountId }),
  actions.midnightContext.resetAccountDust({
    accountId: account.accountId as MidnightAccountId,
  }),
];
const typesOf = (emitted: Action[]) => emitted.map(({ type }) => type);
// The page clears the caches that the reader fills on the client's reset notices.
const withResetNotices = (
  client: Pick<MidnightEngineClient, 'notices$'>,
  reader$: Observable<Action>,
) =>
  merge(
    showMidnightEngineResets(client)(
      {} as Parameters<SideEffect>[0],
      {} as Parameters<SideEffect>[1],
      { actions } as unknown as Parameters<SideEffect>[2],
    ),
    reader$,
  );
// The module's watcher of an account, over an engine this tab has attached.
const watchAttached = (account: Account, engine: MidnightRemoteEngineClient) =>
  watchMidnightAccount(
    account,
    startParams(account).config,
    startParams(account).store,
  )(
    {} as Parameters<SideEffect>[0],
    {
      features: {
        selectLoadedFeatures$: of({ featureFlags: [], modules: [] }),
      },
      sync: { selectSyncStatusByAccount$: of({}) },
      tokens: { selectTokensMetadata$: of({}) },
      midnightContext: { selectNetworksConfig$: NEVER },
    } as unknown as Parameters<SideEffect>[1],
    {
      actions,
      logger: dummyLogger,
      runtime: {},
      accessAuthSecret: passwordAuth().accessAuthSecret,
      startMidnightAccountWallet: () => of(engine),
    } as unknown as Parameters<SideEffect>[2],
  );
const historyEntry = (hash: string) => ({
  hash,
  protocolVersion: 1,
  identifiers: [],
  timestamp: new Date(1000),
  fees: null,
  status: 'SUCCESS',
});
const progress = (ratio: number) => ({
  shielded: ratio,
  unshielded: ratio,
  dust: ratio,
  isStrictlyComplete: {
    shielded: ratio === 1,
    unshielded: ratio === 1,
    dust: ratio === 1,
  },
});

describe('test:engine-client-storage-routing', () => {
  let a: Account;
  let b: Account;
  const subscriptions: Subscription[] = [];

  beforeAll(async () => {
    useFastKeyDerivation();
    a = await sealedAccount({ walletId: 'wallet-a' });
    b = await sealedAccount({
      walletId: 'wallet-a',
      accountIndex: 1,
      network: MidnightSDKNetworkIds.Preview,
    });
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

  const attachedTab = async (
    workers: ReturnType<typeof createFakeWorkers>,
    account: Account,
    client: MidnightEngineClient = createClient(workers),
  ) => {
    const engines: MidnightRemoteEngineClient[] = [];
    const notices: MidnightEngineNotice[] = [];
    const resets: (string | undefined)[] = [];
    const failures: unknown[] = [];
    subscriptions.push(
      client.notices$.subscribe(notice => notices.push(notice)),
      client.startAccountEngine(startParams(account)).subscribe(engine => {
        engines.push(engine);
        subscriptions.push(
          engine.resets$.subscribe({
            next: () => resets.push(engine.engineGeneration),
            error: (error: unknown) => failures.push(error),
          }),
        );
      }),
    );
    await until(() => engines.length === 1);
    return { client, engines, notices, resets, failures };
  };

  describe('in the worker', () => {
    it('resets an attached account for every tab, whose engine signals the reset once it ran', async () => {
      const workers = createFakeWorkers();
      const tab1 = await attachedTab(workers, a);
      const tab2 = await attachedTab(
        workers,
        a,
        createClient(workers, { createClientId: () => 'tab-2' }),
      );
      const before = tab1.engines[0].engineGeneration;

      await expect(
        firstValueFrom(tab1.client.resetAccount(a)),
      ).resolves.toBeUndefined();
      await until(() => tab1.resets.length > 0 && tab2.resets.length > 0);

      expect(tab1.resets).toHaveLength(1);
      expect(tab2.resets).toHaveLength(1);
      expect(tab1.resets[0]).not.toBe(before);
      expect(tab1.notices).toEqual([{ accountId: a.accountId, kind: 'reset' }]);
      expect(tab2.notices).toEqual([{ accountId: a.accountId, kind: 'reset' }]);
      expect(fakeEngines.of(a.accountId)).toHaveLength(2);
      expect(tab1.engines[0].engineGeneration).not.toBe(before);
      const reset = workers.connections[0].calls.find(
        ({ method }) => method === 'resetAccount',
      )!.request as { authority: { password: Uint8Array } };
      expect(reset.authority.password.every(byte => byte === 0)).toBe(true);
    });

    it('ends the replaced engine with an engine-failed client error naming the account when the replacement engine of a reset fails to start with an empty message, and the next start gets a fresh engine whose streams emit', async () => {
      const workers = createFakeWorkers();
      const tab = await attachedTab(workers, a);
      const replacedGeneration = tab.engines[0].engineGeneration;
      fakeEngines.failNextStart = new Error();

      await expect(
        firstValueFrom(tab.client.resetAccount(a)),
      ).rejects.toThrow();
      await until(() => tab.failures.length === 1);
      const retried = await attachedTab(workers, a, tab.client);

      expect(tab.resets).toEqual([undefined]);
      expect(tab.failures[0]).toBeInstanceOf(MidnightEngineClientError);
      expect(tab.failures[0]).toMatchObject({
        reason: 'engine-failed',
        accountId: a.accountId,
        message: expect.stringContaining(a.accountId) as unknown,
      });
      expect(fakeEngines.of(a.accountId)).toHaveLength(2);
      expect(retried.engines[0].engineGeneration).toBeDefined();
      expect(retried.engines[0].engineGeneration).not.toBe(replacedGeneration);
      await expect(
        firstValueFrom(retried.engines[0].transactionHistory$),
      ).resolves.toEqual([]);
    });

    it('wipes an account this page does not run, signalling its reset as the wipe settles and not again when this page attaches an engine of it', async () => {
      const workers = createFakeWorkers();
      const client = createClient(workers);
      const notices: MidnightEngineNotice[] = [];
      subscriptions.push(
        client.notices$.subscribe(notice => notices.push(notice)),
      );
      await attachedTab(workers, b, client);
      workers.worker.stores
        .get('memory')!
        .documents.set(String(a.accountId), checkpoint(a));

      await expect(
        firstValueFrom(client.resetAccount(a)),
      ).resolves.toBeUndefined();
      const isWiped = !workers.worker.stores
        .get('memory')!
        .documents.has(String(a.accountId));
      const noticesAtSettle = [...notices];
      await attachedTab(workers, a, client);

      expect(isWiped).toBe(true);
      expect(noticesAtSettle).toEqual([
        { accountId: a.accountId, kind: 'reset' },
      ]);
      expect(notices).toEqual([{ accountId: a.accountId, kind: 'reset' }]);
    });

    it('shows a reset that waits for a settling submission, then signals it once it ran', async () => {
      const workers = createFakeWorkers();
      const tab = await attachedTab(workers, a);
      const finality = new Subject<string>();
      vi.mocked(
        fakeEngines.current(a.accountId).engine.submitTransaction,
      ).mockReturnValue(finality);
      const [engine] = tab.engines;
      subscriptions.push(
        engine
          .submit(
            encodeMidnightFinalizedTx(finalized(), {
              accountId: engine.accountId,
              engineGeneration: engine.engineGeneration!,
            }),
            { pendingRowTimeout: 10_000 },
          )
          .subscribe(),
      );
      await until(() =>
        workers.connections[0].calls.some(({ method }) => method === 'submit'),
      );

      await firstValueFrom(tab.client.resetAccount(a));
      await until(() => tab.notices.length === 1);
      const resetsWhilePending = tab.resets.length;
      finality.next('tx-hash');
      finality.complete();
      await until(() => tab.resets.length === 1);

      expect(resetsWhilePending).toBe(0);
      expect(tab.notices).toEqual([
        { accountId: a.accountId, kind: 'reset-pending' },
        { accountId: a.accountId, kind: 'reset' },
      ]);
    });

    it('resyncs from a page that runs no engine, presenting a running account as its authority', async () => {
      const workers = createFakeWorkers();
      const runner = await attachedTab(workers, b);
      const idle = createClient(workers, { createClientId: () => 'idle-tab' });

      await expect(
        firstValueFrom(idle.resyncAll([a, b])),
      ).resolves.toBeUndefined();
      await until(() => runner.resets.length > 0);

      expect(runner.resets).toHaveLength(1);
      expect(fakeEngines.of(b.accountId)).toHaveLength(2);
    });

    it('detaches a deleting tab while another tab uses the wallet, and wipes once the last tab deletes it', async () => {
      const workers = createFakeWorkers();
      const tab1 = await attachedTab(workers, a);
      const tab2 = await attachedTab(
        workers,
        a,
        createClient(workers, { createClientId: () => 'tab-2' }),
      );
      const { documents } = workers.worker.stores.get('memory')!;
      documents.set(String(a.accountId), checkpoint(a));

      await firstValueFrom(tab1.client.deleteWallet(a.walletId, [a, b]), {
        defaultValue: undefined,
      });
      const isKeptWhileShared = documents.has(String(a.accountId));
      const isRunningWhileShared = !fakeEngines.current(a.accountId).tornDown;
      await firstValueFrom(tab2.client.deleteWallet(a.walletId, [a, b]), {
        defaultValue: undefined,
      });
      await flush();

      expect(isKeptWhileShared).toBe(true);
      expect(isRunningWhileShared).toBe(true);
      expect(documents.has(String(a.accountId))).toBe(false);
      expect(fakeEngines.current(a.accountId).tornDown).toBe(true);
    });
  });

  describe('values of an engine that a worker reset replaced', () => {
    it("reach no new subscriber of any engine stream, which gets the replacement engine's values once it emits them", async () => {
      const workers = createFakeWorkers();
      const tab = await attachedTab(workers, a);
      const [engine] = tab.engines;
      const streams = {
        address$: engine.address$,
        coinsByTokenType$: engine.coinsByTokenType$,
        syncProgress$: engine.syncProgress$,
        transactionHistory$: engine.transactionHistory$,
        stateView$: engine.stateView$,
      };
      const replaced = fakeEngines.current(a.accountId);
      replaced.address$.next({
        ...accountAddress,
        shielded: 'replaced' as typeof accountAddress.shielded,
      });
      replaced.coinsByTokenType$.next({ shielded: { replaced: 1n } });
      replaced.syncProgress$.next(progress(1));
      replaced.transactionHistory$.next([historyEntry('replaced')]);
      replaced.state$.next(facadeState({ availableCoins: [nightCoin(1n)] }));
      for (const stream of Object.values(streams))
        subscriptions.push((stream as Observable<unknown>).subscribe());
      await flush();
      fakeEngines.withholdValues = true;

      await firstValueFrom(tab.client.resetAccount(a));
      await until(() => tab.resets.length === 1);
      const seen = Object.fromEntries(
        Object.keys(streams).map(key => [key, [] as unknown[]]),
      );
      for (const [key, stream] of Object.entries(streams))
        subscriptions.push(
          (stream as Observable<unknown>).subscribe(value =>
            seen[key].push(value),
          ),
        );
      await flush();
      await flush();
      const seenBeforeEmit = Object.values(seen).map(values => values.length);
      const replacement = fakeEngines.current(a.accountId);
      replacement.address$.next(accountAddress);
      replacement.coinsByTokenType$.next({ shielded: {} });
      replacement.syncProgress$.next(progress(0));
      replacement.transactionHistory$.next([]);
      replacement.state$.next(facadeState({ availableCoins: [nightCoin(2n)] }));
      await until(() => Object.values(seen).every(values => values.length > 0));

      expect(replacement).not.toBe(replaced);
      expect(seenBeforeEmit).toEqual([0, 0, 0, 0, 0]);
      expect(seen).toMatchObject({
        address$: [accountAddress],
        coinsByTokenType$: [{ shielded: {} }],
        syncProgress$: [progress(0)],
        transactionHistory$: [[]],
        stateView$: [
          {
            unshielded: {
              availableCoins: [
                expect.objectContaining({
                  utxo: expect.objectContaining({ value: 2n }) as unknown,
                }),
              ],
            },
          },
        ],
      });
    });
  });

  // With values not withheld, the replacement engine emits on install, before the host publishes the status naming it.
  describe('values of the engine that replaced one at a worker reset, which arrive before the status naming it', () => {
    it('reach a reader that the reset restarts once, after it cleared the old state', async () => {
      const workers = createFakeWorkers();
      const tab = await attachedTab(workers, a);
      const [engine] = tab.engines;
      fakeEngines
        .current(a.accountId)
        .coinsByTokenType$.next({ shielded: { replaced: 1n } });
      await flush();
      const seen: unknown[] = [];
      subscriptions.push(
        acrossMidnightEngineResets<unknown>(
          engine,
          () => ['cleared'],
          () => engine.coinsByTokenType$,
        ).subscribe(value => seen.push(value)),
      );

      await firstValueFrom(tab.client.resetAccount(a));
      await until(() => tab.resets.length === 1);
      await flush();

      expect(seen).toEqual([
        { shielded: { replaced: 1n } },
        'cleared',
        { shielded: {}, unshielded: {} },
      ]);
    });

    it('reach a subscriber that the reset does not restart exactly once, under the generation of their engine', async () => {
      const workers = createFakeWorkers();
      const tab = await attachedTab(workers, a);
      const [engine] = tab.engines;
      const before = engine.engineGeneration;
      fakeEngines
        .current(a.accountId)
        .coinsByTokenType$.next({ shielded: { replaced: 1n } });
      await flush();
      const seen: unknown[] = [];
      subscriptions.push(
        engine.coinsByTokenType$.subscribe(value =>
          seen.push([engine.engineGeneration, value]),
        ),
      );

      await firstValueFrom(tab.client.resetAccount(a));
      await until(() => tab.resets.length === 1);
      await flush();

      expect(engine.engineGeneration).not.toBe(before);
      expect(seen).toEqual([
        [before, { shielded: { replaced: 1n } }],
        [engine.engineGeneration, { shielded: {}, unshielded: {} }],
      ]);
    });
  });

  describe('the watcher of a worker engine', () => {
    it('clears the account caches after a worker reset, then reads the fresh engine again, in that order', async () => {
      const workers = createFakeWorkers();
      const tab = await attachedTab(workers, a);
      const [engine] = tab.engines;
      const emitted: Action[] = [];
      subscriptions.push(
        withResetNotices(tab.client, watchAttached(a, engine)).subscribe(
          action => emitted.push(action),
        ),
      );
      await until(() =>
        emitted.some(
          ({ type }) => type === actions.addresses.upsertAddresses.type,
        ),
      );
      const beforeReset = emitted.length;

      await firstValueFrom(tab.client.resetAccount(a));
      await until(() =>
        emitted
          .slice(beforeReset)
          .some(({ type }) => type === actions.addresses.upsertAddresses.type),
      );

      const afterReset = typesOf(emitted.slice(beforeReset));
      const cleared = afterReset.indexOf(actions.addresses.resetAddresses.type);
      expect(cleared).toBeGreaterThanOrEqual(0);
      expect(afterReset.slice(cleared, cleared + 5)).toEqual([
        actions.addresses.resetAddresses.type,
        actions.tokens.resetAccountTokens.type,
        actions.midnightContext.resetAccountDust.type,
        actions.sync.resetAccountSyncStatus.type,
        actions.sync.addSyncOperation.type,
      ]);
      expect(afterReset[cleared + 5]).toBe(
        actions.activities.resetActivities.type,
      );
      expect(
        afterReset.filter(
          type => type === actions.addresses.resetAddresses.type,
        ),
      ).toHaveLength(1);
      expect(
        afterReset.lastIndexOf(actions.addresses.upsertAddresses.type),
      ).toBeGreaterThan(cleared);
      expect(
        afterReset.lastIndexOf(actions.midnightContext.setDustBalance.type),
      ).toBeGreaterThan(cleared);
    });
  });

  describe('the sync progress of a worker engine', () => {
    it("never completes the sync with the replaced engine's progress after a worker reset, when the stream replays it and the fresh progress arrives later", async () => {
      const workers = createFakeWorkers();
      const tab = await attachedTab(workers, a);
      const [engine] = tab.engines;
      fakeEngines.current(a.accountId).syncProgress$.next(progress(1));
      await flush();
      const emitted: Action[] = [];
      subscriptions.push(
        withResetNotices(tab.client, watchAttached(a, engine)).subscribe(
          action => emitted.push(action),
        ),
      );
      await until(() =>
        emitted.some(
          ({ type }) => type === actions.sync.completeSyncOperation.type,
        ),
      );
      const beforeReset = emitted.length;
      fakeEngines.withholdValues = true;

      await firstValueFrom(tab.client.resetAccount(a));
      const afterReset = () => emitted.slice(beforeReset);
      await until(() =>
        typesOf(afterReset()).includes(
          actions.sync.resetAccountSyncStatus.type,
        ),
      );
      await flush();
      await flush();
      const typesBeforeFreshProgress = typesOf(afterReset());
      fakeEngines.current(a.accountId).syncProgress$.next(progress(0.25));
      await until(() =>
        afterReset().some(
          action =>
            actions.sync.addSyncOperation.match(action) &&
            action.payload.operation.status === 'InProgress',
        ),
      );

      expect(typesBeforeFreshProgress).not.toContain(
        actions.sync.completeSyncOperation.type,
      );
      expect(
        afterReset().filter(
          action =>
            actions.sync.addSyncOperation.match(action) &&
            action.payload.operation.status === 'InProgress',
        ),
      ).toMatchObject([{ payload: { operation: { progress: 0.25 } } }]);
    });

    it('reports no sync progress of an engine after its worker died, not even a value that the progress throttle still held', async () => {
      const workers = createFakeWorkers();
      const tab = await attachedTab(workers, a);
      const [engine] = tab.engines;
      const emitted: Action[] = [];
      subscriptions.push(
        watchAttached(a, engine).subscribe(action => emitted.push(action)),
      );
      await until(() =>
        emitted.some(({ type }) => type === actions.sync.addSyncOperation.type),
      );

      fakeEngines.current(a.accountId).syncProgress$.next(progress(0.5));
      fakeEngines.current(a.accountId).syncProgress$.next(progress(1));
      const beforeDeath = emitted.length;
      workers.kill();
      // Longer than the progress throttle's 500 ms window, after which a held value would be emitted.
      await new Promise(resolve => {
        setTimeout(resolve, 700);
      });

      expect(
        emitted
          .slice(beforeDeath)
          .filter(({ type }) => type.startsWith('sync/')),
      ).toEqual([]);
    });
  });

  describe('the activities of a worker engine', () => {
    it("never restores the replaced engine's history after a worker reset, when the stream replays it and the fresh history arrives later", async () => {
      const workers = createFakeWorkers();
      const tab = await attachedTab(workers, a);
      const [engine] = tab.engines;
      const emitted: Action[] = [];
      subscriptions.push(
        withResetNotices(
          tab.client,
          updateActivities(
            {} as Parameters<SideEffect>[0],
            {
              features: {
                selectLoadedFeatures$: of({
                  featureFlags: [
                    { key: FEATURE_FLAG_MIDNIGHT_SHIELDED_ACTIVITY_ROWS },
                  ],
                  modules: [],
                }),
              },
            } as unknown as Parameters<SideEffect>[1],
            {
              actions,
              midnightEngines$: new BehaviorSubject({ [a.accountId]: engine }),
            } as unknown as Parameters<SideEffect>[2],
          ),
        ).subscribe(action => emitted.push(action)),
      );
      fakeEngines
        .current(a.accountId)
        .transactionHistory$.next([historyEntry('replaced')]);
      const upserts = (actionsSeen: Action[]) =>
        actionsSeen
          .filter(action => actions.activities.upsertActivities.match(action))
          .map(action => action.payload.activities);
      await until(() => upserts(emitted).some(rows => rows.length === 1));
      const beforeReset = emitted.length;
      fakeEngines.withholdValues = true;

      await firstValueFrom(tab.client.resetAccount(a));
      const afterReset = () => emitted.slice(beforeReset);
      await until(() =>
        typesOf(afterReset()).includes(actions.activities.resetActivities.type),
      );
      await flush();
      await flush();
      fakeEngines.current(a.accountId).transactionHistory$.next([]);
      const afterClear = () =>
        afterReset().slice(
          typesOf(afterReset()).indexOf(
            actions.activities.resetActivities.type,
          ),
        );
      await until(() => upserts(afterClear()).length > 0);
      await flush();

      expect(upserts(afterClear())).toEqual([[]]);
    });

    it("restores none of the replaced engine's history after a worker reset whose replacement engine fails to start, and ends without failing the side effect", async () => {
      const workers = createFakeWorkers();
      const tab = await attachedTab(workers, a);
      const [engine] = tab.engines;
      const emitted: Action[] = [];
      const errors: unknown[] = [];
      subscriptions.push(
        withResetNotices(
          tab.client,
          updateActivities(
            {} as Parameters<SideEffect>[0],
            {
              features: {
                selectLoadedFeatures$: of({
                  featureFlags: [
                    { key: FEATURE_FLAG_MIDNIGHT_SHIELDED_ACTIVITY_ROWS },
                  ],
                  modules: [],
                }),
              },
            } as unknown as Parameters<SideEffect>[1],
            {
              actions,
              midnightEngines$: new BehaviorSubject({ [a.accountId]: engine }),
            } as unknown as Parameters<SideEffect>[2],
          ),
        ).subscribe({
          next: action => emitted.push(action),
          error: (error: unknown) => errors.push(error),
        }),
      );
      fakeEngines
        .current(a.accountId)
        .transactionHistory$.next([historyEntry('replaced')]);
      await until(() =>
        emitted.some(
          action =>
            actions.activities.upsertActivities.match(action) &&
            action.payload.activities.length === 1,
        ),
      );
      const beforeReset = emitted.length;
      fakeEngines.failNextStart = new Error(
        'the replacement engine did not start',
      );

      await expect(
        firstValueFrom(tab.client.resetAccount(a)),
      ).rejects.toThrow();
      await until(() => tab.resets.length === 1);
      await flush();

      expect(fakeEngines.of(a.accountId)).toHaveLength(1);
      expect(tab.failures).toMatchObject([
        { message: 'the replacement engine did not start' },
      ]);
      expect(typesOf(emitted.slice(beforeReset))).toEqual([
        actions.addresses.resetAddresses.type,
        actions.tokens.resetAccountTokens.type,
        actions.midnightContext.resetAccountDust.type,
        actions.sync.resetAccountSyncStatus.type,
        actions.sync.addSyncOperation.type,
        actions.activities.resetActivities.type,
      ]);
      expect(errors).toEqual([]);
    });

    const readActivitiesOf = (
      engines: MidnightEnginesByAccountId,
      logger: { error: (...parameters: unknown[]) => void },
    ) => {
      const emitted: Action[] = [];
      const errors: unknown[] = [];
      subscriptions.push(
        updateActivities(
          {} as Parameters<SideEffect>[0],
          {
            features: {
              selectLoadedFeatures$: of({
                featureFlags: [
                  { key: FEATURE_FLAG_MIDNIGHT_SHIELDED_ACTIVITY_ROWS },
                ],
                modules: [],
              }),
            },
          } as unknown as Parameters<SideEffect>[1],
          {
            actions,
            logger: { ...dummyLogger, ...logger },
            midnightEngines$: new BehaviorSubject(engines),
          } as unknown as Parameters<SideEffect>[2],
        ).subscribe({
          next: action => emitted.push(action),
          error: (error: unknown) => errors.push(error),
        }),
      );
      const upsertedIds = (accountId: string) =>
        emitted
          .filter(
            action =>
              actions.activities.upsertActivities.match(action) &&
              action.payload.accountId === accountId,
          )
          .flatMap(action =>
            actions.activities.upsertActivities.match(action)
              ? action.payload.activities.map(({ activityId }) => activityId)
              : [],
          );
      return { errors, upsertedIds };
    };

    it("ends only the reader of a worker engine that the worker reports failed, logging nothing, while the other engines' readers keep mapping their history", async () => {
      const workers = createFakeWorkers();
      const tab = await attachedTab(workers, a);
      const other = await attachedTab(workers, b, tab.client);
      const error = vi.fn();
      const { errors, upsertedIds } = readActivitiesOf(
        { [a.accountId]: tab.engines[0], [b.accountId]: other.engines[0] },
        { error },
      );

      fakeEngines
        .current(a.accountId)
        .transactionHistory$.error(new Error('ws lost'));
      await until(() => tab.failures.length === 1);
      fakeEngines
        .current(b.accountId)
        .transactionHistory$.next([historyEntry('other')]);
      await until(() => upsertedIds(b.accountId).includes('other'));
      await flush();

      expect(tab.failures).toMatchObject([{ reason: 'engine-failed' }]);
      expect(errors).toEqual([]);
      expect(error).not.toHaveBeenCalled();
    });

    it("logs a history entry that the reader of a worker engine cannot map once, at error level and with its account, and ends only that reader while the other engines' readers keep mapping their history", async () => {
      const workers = createFakeWorkers();
      const tab = await attachedTab(workers, a);
      const other = await attachedTab(workers, b, tab.client);
      const error = vi.fn();
      const { errors, upsertedIds } = readActivitiesOf(
        { [a.accountId]: tab.engines[0], [b.accountId]: other.engines[0] },
        { error },
      );

      fakeEngines
        .current(a.accountId)
        .transactionHistory$.next([
          { ...historyEntry('unmappable'), timestamp: {} },
        ]);
      await until(() => error.mock.calls.length > 0);
      fakeEngines
        .current(a.accountId)
        .transactionHistory$.next([historyEntry('after-failure')]);
      fakeEngines
        .current(b.accountId)
        .transactionHistory$.next([historyEntry('other')]);
      await until(() => upsertedIds(b.accountId).includes('other'));
      await flush();

      expect(error).toHaveBeenCalledOnce();
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining(a.accountId),
        expect.any(TypeError),
      );
      expect(upsertedIds(a.accountId)).toEqual([]);
      expect(tab.failures).toEqual([]);
      expect(errors).toEqual([]);
    });

    it('clears the account activities after a worker reset, then maps the fresh history again, in that order', async () => {
      const workers = createFakeWorkers();
      const tab = await attachedTab(workers, a);
      const [engine] = tab.engines;
      const emitted: Action[] = [];
      subscriptions.push(
        withResetNotices(
          tab.client,
          updateActivities(
            {} as Parameters<SideEffect>[0],
            {
              features: {
                selectLoadedFeatures$: of({ featureFlags: [], modules: [] }),
              },
            } as unknown as Parameters<SideEffect>[1],
            {
              actions,
              midnightEngines$: new BehaviorSubject({ [a.accountId]: engine }),
            } as unknown as Parameters<SideEffect>[2],
          ),
        ).subscribe(action => emitted.push(action)),
      );
      await until(() => emitted.length > 0);
      const beforeReset = emitted.length;

      await firstValueFrom(tab.client.resetAccount(a));
      const afterReset = () => typesOf(emitted.slice(beforeReset));
      await until(() => {
        const types = afterReset();
        const cleared = types.indexOf(actions.activities.resetActivities.type);
        return (
          cleared >= 0 &&
          types.lastIndexOf(actions.activities.upsertActivities.type) > cleared
        );
      });

      expect(
        afterReset().filter(
          type => type === actions.activities.resetActivities.type,
        ),
      ).toHaveLength(1);
    });
  });

  describe('the caches of an account across a worker reset, whichever of its engines this tab attached meanwhile', () => {
    // The Worker-mode side effects that fill or clear an account's caches, each delivered through `delay(0)` as the
    // store delivers side effect output, and a watcher that registers the account's engine and retries its failure.
    const cachingTab = (
      workers: ReturnType<typeof createFakeWorkers>,
      account: Account,
      {
        persistedRows = [] as string[],
        clientOptions = {} as Parameters<typeof createClient>[1],
      } = {},
    ) => {
      const client = createClient(workers, clientOptions);
      const runtime = {} as Parameters<typeof midnightWalletsForRuntime>[0];
      const registry = midnightWalletsForRuntime(runtime);
      const resetSyncState$ = new Subject<
        ReturnType<typeof actions.midnightContext.resetSyncState>
      >();
      const resync$ = new Subject<
        ReturnType<typeof actions.midnightSync.resync>
      >();
      const watcherOutput$ = new Subject<Action>();
      const dispatched: Action[] = [];
      const errors: unknown[] = [];
      const rows = new Set(persistedRows);
      const stateObservables = {
        features: {
          selectLoadedFeatures$: of({
            featureFlags: [
              { key: FEATURE_FLAG_MIDNIGHT_SHIELDED_ACTIVITY_ROWS },
            ],
            modules: [],
          }),
        },
        sync: { selectSyncStatusByAccount$: of({}) },
        tokens: { selectTokensMetadata$: of({}) },
        wallets: {
          selectIsWalletRepoMigrating$: of(false),
          selectActiveNetworkAccounts$: of([account]),
        },
        midnightContext: {
          selectMidnightBlockchainNetworkId$: of(
            MidnightNetworkId(account.blockchainSpecific.networkId),
          ),
          selectNetworksConfig$: NEVER,
        },
      } as unknown as Parameters<SideEffect>[1];
      const dependencies = {
        actions,
        logger: dummyLogger,
        midnightEngines$: registry,
        runtime,
        accessAuthSecret: passwordAuth().accessAuthSecret,
        startMidnightAccountWallet: client.startAccountEngine,
      } as unknown as Parameters<SideEffect>[2];
      const sideEffects: SideEffect[] = [
        createWorkerResetSyncStateSideEffect(client),
        createWorkerClearWalletStateOnResync(client),
        showMidnightEngineResets(client),
        updateActivities,
      ];
      subscriptions.push(
        merge(
          ...sideEffects.map(sideEffect =>
            sideEffect(
              {
                midnightContext: { resetSyncState$ },
                midnightSync: { resync$ },
              } as unknown as Parameters<SideEffect>[0],
              stateObservables,
              dependencies,
            ),
          ),
          watcherOutput$,
        )
          .pipe(delay(0))
          .subscribe({
            next: action => {
              dispatched.push(action);
              if (
                actions.activities.upsertActivities.match(action) &&
                action.payload.accountId === account.accountId
              )
                for (const { activityId } of action.payload.activities)
                  rows.add(activityId);
              if (
                actions.activities.resetActivities.match(action) &&
                action.payload.accountId === account.accountId
              )
                rows.clear();
            },
            error: (error: unknown) => errors.push(error),
          }),
      );
      let watch: Subscription | undefined;
      return {
        dispatched,
        errors,
        rows: () => [...rows],
        engine: () => registry.value[account.accountId],
        attach: () => {
          watch = watchMidnightAccount(
            account,
            startParams(account).config,
            startParams(account).store,
          )({} as Parameters<SideEffect>[0], stateObservables, dependencies)
            .pipe(retry({ count: 3, delay: 0 }))
            .subscribe({
              next: action => {
                watcherOutput$.next(action);
              },
              error: (error: unknown) => errors.push(error),
            });
          subscriptions.push(watch);
        },
        detach: () => watch?.unsubscribe(),
        resetSyncState: () => {
          resetSyncState$.next(
            actions.midnightContext.resetSyncState({
              accountId: account.accountId,
            }),
          );
        },
        resync: () => {
          resync$.next(actions.midnightSync.resync());
        },
        clearsAndUpsertsSince: (from: number) =>
          dispatched
            .slice(from)
            .filter(
              action =>
                (actions.activities.resetActivities.match(action) ||
                  actions.activities.upsertActivities.match(action)) &&
                action.payload.accountId === account.accountId,
            )
            .map(action =>
              actions.activities.upsertActivities.match(action)
                ? action.payload.activities.map(({ activityId }) => activityId)
                : 'cleared',
            ),
        countSince: (from: number, type: string) =>
          dispatched.slice(from).filter(action => action.type === type).length,
        resyncStatus: () =>
          dispatched
            .flatMap(action =>
              actions.sync.addSyncOperation.match(action) &&
              action.payload.accountId === account.accountId &&
              action.payload.operation.description ===
                'sync.operation.midnight-resync'
                ? [action.payload.operation.status]
                : [],
            )
            .at(-1),
      };
    };

    const attachedCachingTab = async (
      workers: ReturnType<typeof createFakeWorkers>,
      account: Account,
    ) => {
      const tab = cachingTab(workers, account);
      tab.attach();
      await until(() => !!tab.engine());
      fakeEngines
        .current(account.accountId)
        .transactionHistory$.next([historyEntry('replaced')]);
      await until(() => tab.rows().includes('replaced'));
      return tab;
    };

    // The next engine start is handed out only on release, with the history it starts with.
    const holdNextStart = () => {
      const held = fakeEngines.started.length;
      let release!: () => void;
      fakeEngines.hold = new Promise<void>(resolve => {
        release = resolve;
      });
      return async (history: unknown[]) => {
        await until(() => fakeEngines.started.length > held);
        fakeEngines.started[held].transactionHistory$.next(history);
        release();
      };
    };

    // `delay(0)` waits for a timer, which `flush` alone does not reach.
    const delivered = async () => {
      await flush();
      await new Promise(resolve => {
        setTimeout(resolve, 20);
      });
      await flush();
    };

    const settledHostCalls = (
      workers: ReturnType<typeof createFakeWorkers>,
      method: 'resetAccount' | 'resyncAll',
    ) => {
      const call = vi.spyOn(workers.worker.host, method);
      return async () => {
        await until(() => call.mock.results.length > 0);
        await Promise.allSettled(
          call.mock.results.map(async ({ value }) => value as Promise<void>),
        );
        await delivered();
      };
    };

    it.each([
      ['resetSyncState', 'resetAccount'],
      ['resync', 'resyncAll'],
    ] as const)(
      "clears the activities of an engine whose %s ran while this tab switched networks away and back, once and before the replacement engine's history",
      async (request, hostMethod) => {
        const workers = createFakeWorkers();
        const tab = await attachedCachingTab(workers, a);
        const settled = settledHostCalls(workers, hostMethod);
        const stop = new Subject<undefined>();
        const stopOf = vi.mocked(fakeEngines.current(a.accountId).engine.stop);
        stopOf.mockReturnValue(stop);
        const before = tab.dispatched.length;

        tab[request]();
        await until(() => stopOf.mock.calls.length === 1);
        tab.detach();
        await flush();
        stop.next(undefined);
        stop.complete();
        await settled();
        await until(() => fakeEngines.current(a.accountId).tornDown);
        tab.attach();
        await until(() => fakeEngines.of(a.accountId).length === 3);
        fakeEngines
          .current(a.accountId)
          .transactionHistory$.next([historyEntry('fresh')]);
        await until(() => tab.rows().includes('fresh'));
        await delivered();

        expect(tab.rows()).toEqual(['fresh']);
        expect(
          tab
            .clearsAndUpsertsSince(before)
            .filter(entry => entry === 'cleared'),
        ).toHaveLength(1);
        expect(tab.errors).toEqual([]);
      },
    );

    it.each([
      ['bulk resync', 'resync', 'resyncAll'],
      ['reset', 'resetSyncState', 'resetAccount'],
    ] as const)(
      "clears the caches once, before the replacement engine's history, when a %s waits for this tab's first attach, and keeps the replacement rows",
      async (_, request, hostMethod) => {
        const workers = createFakeWorkers();
        const tab = cachingTab(workers, a, { persistedRows: ['persisted'] });
        const settled = settledHostCalls(workers, hostMethod);
        const releaseFirstStart = holdNextStart();
        tab.attach();
        await until(() => fakeEngines.of(a.accountId).length === 1);
        const before = tab.dispatched.length;

        tab[request]();
        await until(() =>
          workers.connections[0].calls.some(
            ({ method }) => method === hostMethod,
          ),
        );
        const releaseRestart = holdNextStart();
        await releaseFirstStart([]);
        await releaseRestart([historyEntry('fresh')]);
        await settled();
        await until(() =>
          tab
            .clearsAndUpsertsSince(before)
            .some(entry => Array.isArray(entry) && entry.includes('fresh')),
        );
        await delivered();

        const clearsAndUpserts = tab.clearsAndUpsertsSince(before);
        expect(
          clearsAndUpserts.slice(clearsAndUpserts.indexOf('cleared')),
        ).toEqual(['cleared', ['fresh']]);
        expect(
          clearsAndUpserts.filter(entry => entry === 'cleared'),
        ).toHaveLength(1);
        expect(tab.rows()).toEqual(['fresh']);
        expect(
          tab.countSince(before, actions.addresses.resetAddresses.type),
        ).toBe(1);
        expect(tab.errors).toEqual([]);
      },
    );

    it("clears the caches once, before the replacement engine's history, for a reset of the engine this tab keeps attached", async () => {
      const workers = createFakeWorkers();
      const tab = await attachedCachingTab(workers, a);
      const settled = settledHostCalls(workers, 'resetAccount');
      const before = tab.dispatched.length;
      const releaseRestart = holdNextStart();

      tab.resetSyncState();
      await releaseRestart([historyEntry('fresh')]);
      await settled();
      await until(() => tab.rows().includes('fresh'));
      await delivered();

      expect(tab.clearsAndUpsertsSince(before)).toEqual(['cleared', ['fresh']]);
      expect(tab.rows()).toEqual(['fresh']);
      for (const type of [
        actions.addresses.resetAddresses.type,
        actions.tokens.resetAccountTokens.type,
        actions.midnightContext.resetAccountDust.type,
        actions.sync.resetAccountSyncStatus.type,
      ])
        expect(tab.countSince(before, type)).toBe(1);
      expect(tab.errors).toEqual([]);
    });

    it('clears the caches once after a reset whose replacement engine fails to start, shows no row of the replaced engine, and shows the history of the engine the watcher attaches next', async () => {
      const workers = createFakeWorkers();
      const tab = await attachedCachingTab(workers, a);
      const settled = settledHostCalls(workers, 'resetAccount');
      const before = tab.dispatched.length;
      fakeEngines.failNextStart = new Error(
        'the replacement engine did not start',
      );

      tab.resetSyncState();
      await settled();
      await until(() => fakeEngines.of(a.accountId).length === 2);
      fakeEngines
        .current(a.accountId)
        .transactionHistory$.next([historyEntry('fresh')]);
      await until(() => tab.rows().includes('fresh'));
      await delivered();

      const clearsAndUpserts = tab.clearsAndUpsertsSince(before);
      expect(tab.rows()).toEqual(['fresh']);
      expect(
        clearsAndUpserts.filter(entry => entry === 'cleared'),
      ).toHaveLength(1);
      expect(clearsAndUpserts.flat()).not.toContain('replaced');
      expect(
        tab.countSince(before, actions.addresses.resetAddresses.type),
      ).toBe(1);
      expect(tab.errors).toEqual([]);
    });
    it("clears the persisted rows once, before the first engine's history, when this tab resets an account before it attaches an engine of it, and not again on a later attach", async () => {
      const workers = createFakeWorkers();
      const tab = cachingTab(workers, a, { persistedRows: ['persisted'] });
      const settled = settledHostCalls(workers, 'resetAccount');

      tab.resetSyncState();
      await settled();
      tab.attach();
      await until(() => !!tab.engine());
      fakeEngines
        .current(a.accountId)
        .transactionHistory$.next([historyEntry('fresh')]);
      await until(() => tab.rows().includes('fresh'));
      tab.detach();
      await flush();
      tab.attach();
      await until(() => fakeEngines.of(a.accountId).length === 2);
      await until(() => !!tab.engine());
      await delivered();

      const clearsAndUpserts = tab.clearsAndUpsertsSince(0);
      expect(clearsAndUpserts[0]).toBe('cleared');
      expect(
        clearsAndUpserts.filter(entry => entry === 'cleared'),
      ).toHaveLength(1);
      expect(tab.rows()).toEqual(['fresh']);
      expect(tab.errors).toEqual([]);
    });

    it.each([
      ['reset', 'resetSyncState', 'resetAccount'],
      ['bulk resync', 'resync', 'resyncAll'],
    ] as const)(
      'clears the persisted rows of an account this tab runs no engine of as its %s settles, and not again when this tab attaches an engine of the account',
      async (_, request, hostMethod) => {
        const workers = createFakeWorkers();
        const tab = cachingTab(workers, a, { persistedRows: ['persisted'] });
        const settled = settledHostCalls(workers, hostMethod);

        tab[request]();
        await settled();
        const atSettle = tab.clearsAndUpsertsSince(0);
        tab.attach();
        await until(() => !!tab.engine());
        fakeEngines
          .current(a.accountId)
          .transactionHistory$.next([historyEntry('fresh')]);
        await until(() => tab.rows().includes('fresh'));
        await delivered();

        expect(atSettle).toEqual(['cleared']);
        expect(
          tab.clearsAndUpsertsSince(0).filter(entry => entry === 'cleared'),
        ).toHaveLength(1);
        expect(
          tab.countSince(0, actions.sync.resetAccountSyncStatus.type),
        ).toBe(1);
        expect(tab.rows()).toEqual(['fresh']);
        expect(tab.errors).toEqual([]);
      },
    );

    it.each([
      ['reset', 'resetSyncState', 'resetAccount'],
      ['bulk resync', 'resync', 'resyncAll'],
    ] as const)(
      'clears the caches of an engine that this tab detached while its %s ran as the request settles, and not again before the history of the engine it attaches next',
      async (_, request, hostMethod) => {
        const workers = createFakeWorkers();
        const tab = await attachedCachingTab(workers, a);
        const settled = settledHostCalls(workers, hostMethod);
        const stop = new Subject<undefined>();
        const stopOf = vi.mocked(fakeEngines.current(a.accountId).engine.stop);
        stopOf.mockReturnValue(stop);
        const before = tab.dispatched.length;

        tab[request]();
        await until(() => stopOf.mock.calls.length === 1);
        tab.detach();
        await flush();
        stop.next(undefined);
        stop.complete();
        await settled();
        const atSettle = tab.clearsAndUpsertsSince(before);
        await until(() => fakeEngines.current(a.accountId).tornDown);
        tab.attach();
        await until(() => fakeEngines.of(a.accountId).length === 3);
        fakeEngines
          .current(a.accountId)
          .transactionHistory$.next([historyEntry('fresh')]);
        await until(() => tab.rows().includes('fresh'));
        await delivered();

        expect(atSettle).toEqual(['cleared']);
        expect(
          tab
            .clearsAndUpsertsSince(before)
            .filter(entry => entry === 'cleared'),
        ).toHaveLength(1);
        expect(tab.rows()).toEqual(['fresh']);
        expect(tab.errors).toEqual([]);
      },
    );

    it('clears the rows of an account that this tab reset without a session before the history of the engine it attaches meanwhile, though a bulk resync follows that attach', async () => {
      const workers = createFakeWorkers();
      const tab = await attachedCachingTab(workers, a);
      tab.detach();
      await until(() => fakeEngines.current(a.accountId).tornDown);
      const wipe = new Subject<undefined>();
      const removeWhere = vi
        .spyOn(workers.worker.stores.get('memory')!.store, 'removeWhere')
        .mockReturnValueOnce(wipe);
      const callsOf = (method: string) =>
        workers.connections[0].calls.filter(call => call.method === method);
      const before = tab.dispatched.length;

      tab.resetSyncState();
      await until(() => removeWhere.mock.calls.length === 1);
      const releaseAttachStart = holdNextStart();
      tab.attach();
      await until(() => callsOf('attach').length === 2);
      tab.resync();
      await until(() => callsOf('resyncAll').length === 1);
      wipe.next(undefined);
      wipe.complete();
      await until(() => fakeEngines.started.length === 2);
      const releaseRestart = holdNextStart();
      await releaseAttachStart([historyEntry('first')]);
      await until(() => tab.rows().includes('first'));
      const rowsBeforeResync = tab.rows();
      await releaseRestart([historyEntry('fresh')]);
      await until(() => tab.rows().includes('fresh'));
      await delivered();

      expect(rowsBeforeResync).toEqual(['first']);
      expect(
        tab.clearsAndUpsertsSince(before).filter(entry => entry === 'cleared'),
      ).toHaveLength(2);
      expect(tab.rows()).toEqual(['fresh']);
      expect(tab.errors).toEqual([]);
    });

    it('clears the caches once, before the history of the engine this tab attaches next, after another tab reset the account while this tab had its engine detached', async () => {
      const workers = createFakeWorkers();
      const other = await attachedTab(
        workers,
        a,
        createClient(workers, { createClientId: () => 'tab-2' }),
      );
      const tab = await attachedCachingTab(workers, a);
      tab.detach();
      await until(() =>
        workers.connections.some(
          ({ clientId, calls }) =>
            clientId === 'client-1' &&
            calls.some(({ method }) => method === 'detach'),
        ),
      );
      const before = tab.dispatched.length;

      await firstValueFrom(other.client.resetAccount(a));
      await until(() => other.resets.length === 1);
      tab.attach();
      await until(() => !!tab.engine());
      fakeEngines
        .current(a.accountId)
        .transactionHistory$.next([historyEntry('fresh')]);
      await until(() => tab.rows().includes('fresh'));
      await delivered();

      const clearsAndUpserts = tab.clearsAndUpsertsSince(before);
      expect(clearsAndUpserts[0]).toBe('cleared');
      expect(
        clearsAndUpserts.filter(entry => entry === 'cleared'),
      ).toHaveLength(1);
      expect(tab.rows()).toEqual(['fresh']);
      expect(tab.errors).toEqual([]);
    });

    it('clears the caches once for a reset of the engine this tab keeps attached, and not again when this tab attaches the engine after switching networks away and back', async () => {
      const workers = createFakeWorkers();
      const tab = await attachedCachingTab(workers, a);
      const settled = settledHostCalls(workers, 'resetAccount');
      const before = tab.dispatched.length;

      tab.resetSyncState();
      await settled();
      tab.detach();
      await until(() => fakeEngines.current(a.accountId).tornDown);
      tab.attach();
      await until(() => fakeEngines.of(a.accountId).length === 3);
      await until(() => !!tab.engine());
      fakeEngines
        .current(a.accountId)
        .transactionHistory$.next([historyEntry('fresh')]);
      await until(() => tab.rows().includes('fresh'));
      await delivered();

      expect(
        tab.clearsAndUpsertsSince(before).filter(entry => entry === 'cleared'),
      ).toHaveLength(1);
      expect(
        tab.countSince(before, actions.sync.resetAccountSyncStatus.type),
      ).toBe(1);
      expect(tab.rows()).toEqual(['fresh']);
      expect(tab.errors).toEqual([]);
    });

    it("keeps a reset that waited for a settling submission and failed to wipe Failed, and clears nothing when the watcher attaches the account's engine again", async () => {
      const workers = createFakeWorkers();
      const tab = await attachedCachingTab(workers, a);
      const settled = settledHostCalls(workers, 'resetAccount');
      const finality = new Subject<string>();
      vi.mocked(
        fakeEngines.current(a.accountId).engine.submitTransaction,
      ).mockReturnValue(finality);
      const engine = tab.engine() as MidnightRemoteEngineClient;
      subscriptions.push(
        engine
          .submit(
            encodeMidnightFinalizedTx(finalized(), {
              accountId: engine.accountId,
              engineGeneration: engine.engineGeneration!,
            }),
            { pendingRowTimeout: 10_000 },
          )
          .subscribe(),
      );
      await until(() =>
        workers.connections[0].calls.some(({ method }) => method === 'submit'),
      );
      vi.spyOn(
        workers.worker.stores.get('memory')!.store,
        'removeWhere',
      ).mockReturnValue(throwError(() => new Error('disk full')));
      const before = tab.dispatched.length;

      tab.resetSyncState();
      await settled();
      finality.next('tx-hash');
      finality.complete();
      await until(() => tab.resyncStatus() === 'Failed');
      await until(
        () =>
          fakeEngines.of(a.accountId).length === 3 &&
          !!tab.engine() &&
          tab.engine() !== engine,
      );
      await delivered();

      expect(tab.resyncStatus()).toBe('Failed');
      expect(
        tab.countSince(before, actions.activities.resetActivities.type),
      ).toBe(0);
      expect(
        tab.countSince(before, actions.sync.resetAccountSyncStatus.type),
      ).toBe(0);
      expect(tab.rows()).toEqual(['replaced']);
      expect(tab.errors).toEqual([]);
    });

    it("keeps a bulk resync that the worker refused Failed, and clears nothing more when the watch it restarts attaches the account's engine", async () => {
      const workers = createFakeWorkers();
      await attachedTab(
        workers,
        b,
        createClient(workers, { createClientId: () => 'tab-2' }),
      );
      const tab = cachingTab(workers, a, { persistedRows: ['persisted'] });
      const settled = settledHostCalls(workers, 'resyncAll');

      tab.resync();
      await settled();
      await until(() =>
        tab.dispatched.some(action =>
          actions.midnightSync.restartWalletWatch.match(action),
        ),
      );
      const before = tab.dispatched.length;
      tab.attach();
      await until(() => !!tab.engine());
      fakeEngines
        .current(a.accountId)
        .transactionHistory$.next([historyEntry('fresh')]);
      await until(() => tab.rows().includes('fresh'));
      await delivered();

      expect(tab.resyncStatus()).toBe('Failed');
      expect(
        tab.countSince(before, actions.activities.resetActivities.type),
      ).toBe(0);
      expect(
        tab.countSince(before, actions.sync.resetAccountSyncStatus.type),
      ).toBe(0);
      expect(tab.rows()).toEqual(['fresh']);
      expect(tab.errors).toEqual([]);
    });

    it("keeps a reset that the worker refused Failed, and clears nothing when this tab attaches the account's engine afterwards", async () => {
      const workers = createFakeWorkers();
      await attachedTab(
        workers,
        a,
        createClient(workers, { createClientId: () => 'tab-2' }),
      );
      // The tab lends a wrong password until the worker refused its reset.
      let password = WRONG_PASSWORD;
      const tab = cachingTab(workers, a, {
        persistedRows: ['persisted'],
        clientOptions: {
          accessAuthSecret: callback =>
            passwordAuth(password).accessAuthSecret(callback),
        },
      });
      const settled = settledHostCalls(workers, 'resetAccount');

      tab.resetSyncState();
      await settled();
      password = PASSWORD;
      const before = tab.dispatched.length;
      tab.attach();
      await until(() => !!tab.engine());
      await delivered();

      expect(tab.resyncStatus()).toBe('Failed');
      expect(
        tab.countSince(before, actions.activities.resetActivities.type),
      ).toBe(0);
      expect(
        tab.countSince(before, actions.sync.resetAccountSyncStatus.type),
      ).toBe(0);
      expect(tab.rows()).toEqual(['persisted']);
      expect(tab.errors).toEqual([]);
    });
  });

  describe('the side effects in Worker mode', () => {
    const accountsState = (
      cold: Parameters<Parameters<typeof testSideEffect>[1]>[0]['cold'],
    ) => ({
      wallets: {
        selectIsWalletRepoMigrating$: cold('a', { a: false }),
        selectActiveNetworkAccounts$: cold('a', { a: [a] }),
      },
      midnightContext: {
        selectMidnightBlockchainNetworkId$: cold('a', {
          a: MidnightNetworkId(a.blockchainSpecific.networkId),
        }),
      },
    });

    it('routes a headless reset to the worker and shows it Pending, leaving the caches to the reset notice', () => {
      const resetAccount = vi.fn();
      testSideEffect(
        createWorkerResetSyncStateSideEffect({ resetAccount }),
        ({ hot, cold, flush }) => {
          resetAccount.mockReturnValue(cold('--(a|)', { a: undefined }));
          return {
            actionObservables: {
              midnightContext: {
                resetSyncState$: hot('-a', {
                  a: actions.midnightContext.resetSyncState({
                    accountId: a.accountId,
                  }),
                }),
              },
            },
            stateObservables: accountsState(cold),
            dependencies: { actions, logger: dummyLogger },
            assertion: sideEffect$ => {
              const emitted: Action[] = [];
              sideEffect$.subscribe(action => emitted.push(action));
              flush();
              expect(resetAccount).toHaveBeenCalledWith(a);
              expect(emitted).toMatchObject([
                {
                  type: actions.sync.addSyncOperation.type,
                  payload: {
                    accountId: a.accountId,
                    operation: {
                      operationId: `${a.accountId}-midnight-sync`,
                      status: 'Pending',
                      description: 'sync.operation.midnight-resync',
                    },
                  },
                },
              ]);
              expect(emitted).toHaveLength(1);
            },
          };
        },
      );
    });

    it('shows a refused headless reset as a failed resync', () => {
      const resetAccount = vi.fn();
      testSideEffect(
        createWorkerResetSyncStateSideEffect({ resetAccount }),
        ({ hot, cold, flush }) => {
          resetAccount.mockReturnValue(
            cold('--#', {}, new Error('wrong password')),
          );
          return {
            actionObservables: {
              midnightContext: {
                resetSyncState$: hot('-a', {
                  a: actions.midnightContext.resetSyncState({
                    accountId: a.accountId,
                  }),
                }),
              },
            },
            stateObservables: accountsState(cold),
            dependencies: { actions, logger: dummyLogger },
            assertion: sideEffect$ => {
              const emitted: Action[] = [];
              sideEffect$.subscribe(action => emitted.push(action));
              flush();
              expect(emitted).toHaveLength(2);
              expect(emitted[1]).toMatchObject({
                type: actions.sync.addSyncOperation.type,
                payload: { operation: { status: 'Failed' } },
              });
            },
          };
        },
      );
    });

    it('routes a bulk resync to the worker, leaving the caches to the reset notices and restarting no watch', () => {
      const resyncAll = vi.fn();
      testSideEffect(
        createWorkerClearWalletStateOnResync({ resyncAll }),
        ({ hot, cold, flush }) => {
          resyncAll.mockReturnValue(cold('--(a|)', { a: undefined }));
          return {
            actionObservables: {
              midnightSync: {
                resync$: hot('-a', { a: actions.midnightSync.resync() }),
              },
            },
            stateObservables: accountsState(cold),
            dependencies: { actions, logger: dummyLogger },
            assertion: sideEffect$ => {
              const emitted: Action[] = [];
              sideEffect$.subscribe(action => emitted.push(action));
              flush();
              expect(resyncAll).toHaveBeenCalledWith([a]);
              expect(emitted).toEqual([]);
            },
          };
        },
      );
    });

    it('resets the selected accounts, shows their resync as Failed and restarts the watch when the worker fails the bulk resync', () => {
      const resyncAll = vi.fn();
      testSideEffect(
        createWorkerClearWalletStateOnResync({ resyncAll }),
        ({ hot, cold, flush }) => {
          resyncAll.mockReturnValue(cold('--#', {}, new Error('gone')));
          return {
            actionObservables: {
              midnightSync: {
                resync$: hot('-a', { a: actions.midnightSync.resync() }),
              },
            },
            stateObservables: accountsState(cold),
            dependencies: { actions, logger: dummyLogger },
            assertion: sideEffect$ => {
              const emitted: Action[] = [];
              sideEffect$.subscribe(action => emitted.push(action));
              flush();
              expect(emitted.slice(0, 4)).toEqual(cacheResets(a));
              expect(emitted.slice(4)).toMatchObject([
                {
                  type: actions.sync.addSyncOperation.type,
                  payload: {
                    accountId: a.accountId,
                    operation: {
                      operationId: `${a.accountId}-midnight-sync`,
                      status: 'Failed',
                      description: 'sync.operation.midnight-resync',
                    },
                  },
                },
                actions.midnightSync.restartWalletWatch(),
              ]);
            },
          };
        },
      );
    });

    it('routes a wallet deletion to the worker with the wallet accounts, then resets their caches, even when the worker fails it', () => {
      const deleteWallet = vi.fn();
      const wallet = { walletId: a.walletId, accounts: [a, b] } as AnyWallet;
      testSideEffect(
        createWorkerDeleteWalletSideEffect({ deleteWallet }),
        ({ hot, cold, flush }) => {
          deleteWallet.mockReturnValue(cold('--#', {}, new Error('gone')));
          return {
            actionObservables: {
              wallets: {
                removeWallet$: hot('-a', {
                  a: actions.wallets.removeWallet(a.walletId, [
                    a.accountId,
                    b.accountId,
                  ]),
                }),
              },
            },
            stateObservables: {
              wallets: { selectAll$: cold('a', { a: [wallet] }) },
            },
            dependencies: { actions, logger: dummyLogger },
            assertion: sideEffect$ => {
              const emitted: Action[] = [];
              sideEffect$.subscribe(action => emitted.push(action));
              flush();
              expect(deleteWallet).toHaveBeenCalledWith(a.walletId, [a, b]);
              expect(emitted).toEqual(
                [a, b].flatMap(account => cacheResets(account).slice(0, 3)),
              );
            },
          };
        },
      );
    });

    it('routes the deletion of a wallet that the store removed before the action reached it', () => {
      const deleteWallet = vi.fn();
      const wallet = { walletId: a.walletId, accounts: [a, b] } as AnyWallet;
      testSideEffect(
        createWorkerDeleteWalletSideEffect({ deleteWallet }),
        ({ hot, cold, flush }) => {
          deleteWallet.mockReturnValue(cold('-(a|)', { a: undefined }));
          return {
            actionObservables: {
              wallets: {
                removeWallet$: hot('--a', {
                  a: actions.wallets.removeWallet(a.walletId, [
                    a.accountId,
                    b.accountId,
                  ]),
                }),
              },
            },
            stateObservables: {
              wallets: { selectAll$: hot('ab', { a: [wallet], b: [] }) },
            },
            dependencies: { actions, logger: dummyLogger },
            assertion: sideEffect$ => {
              const emitted: Action[] = [];
              sideEffect$.subscribe(action => emitted.push(action));
              flush();
              expect(deleteWallet).toHaveBeenCalledWith(a.walletId, [a, b]);
              expect(emitted).toHaveLength(6);
            },
          };
        },
      );
    });

    it('shows a reset waiting for a settling submission as Pending and a failed reset wipe as Failed', () => {
      testSideEffect(
        {
          build: ({ hot }) =>
            showMidnightEngineResets({
              notices$: hot('-ac', {
                a: { accountId: a.accountId, kind: 'reset-pending' },
                c: { accountId: a.accountId, kind: 'reset-failed' },
              } satisfies Record<string, MidnightEngineNotice>),
            }),
        },
        ({ flush }) => ({
          dependencies: { actions },
          assertion: sideEffect$ => {
            const emitted: Action[] = [];
            sideEffect$.subscribe(action => emitted.push(action));
            flush();
            expect(typesOf(emitted)).toEqual([
              actions.sync.addSyncOperation.type,
              actions.sync.addSyncOperation.type,
            ]);
            expect(emitted[0]).toMatchObject({
              payload: { operation: { status: 'Pending' } },
            });
            expect(emitted.at(-1)).toMatchObject({
              payload: { operation: { status: 'Failed' } },
            });
          },
        }),
      );
    });

    it('clears the account caches and shows its resync Pending on a reset notice', () => {
      testSideEffect(
        {
          build: ({ hot }) =>
            showMidnightEngineResets({
              notices$: hot('-a', {
                a: { accountId: a.accountId, kind: 'reset' },
              } satisfies Record<string, MidnightEngineNotice>),
            }),
        },
        ({ flush }) => ({
          dependencies: { actions },
          assertion: sideEffect$ => {
            const emitted: Action[] = [];
            sideEffect$.subscribe(action => emitted.push(action));
            flush();
            expect(typesOf(emitted)).toEqual([
              actions.addresses.resetAddresses.type,
              actions.tokens.resetAccountTokens.type,
              actions.midnightContext.resetAccountDust.type,
              actions.sync.resetAccountSyncStatus.type,
              actions.sync.addSyncOperation.type,
              actions.activities.resetActivities.type,
            ]);
            for (const action of emitted)
              expect(action).toMatchObject({
                payload: { accountId: a.accountId },
              });
            expect(emitted[4]).toMatchObject({
              payload: {
                operation: {
                  status: 'Pending',
                  description: 'sync.operation.midnight-resync',
                },
              },
            });
          },
        }),
      );
    });

    const clientFailure = (
      account: Account,
      reason: MidnightEngineClientErrorReason,
    ) =>
      new MidnightEngineClientError({
        reason,
        accountId: account.accountId,
        message: reason,
      });
    const failedSyncOf = (account: Account) => ({
      failure: actions.failures.addFailure({
        failureId: MidnightSyncFailureId(account.accountId),
        message: 'sync.error.midnight-sync-failed',
      }),
      operation: {
        type: actions.sync.addSyncOperation.type,
        payload: {
          accountId: account.accountId,
          operation: {
            operationId: `${account.accountId}-midnight-sync`,
            status: 'Failed',
            description: 'sync.operation.midnight-wallet-sync',
            error: 'sync.error.midnight-sync-failed',
            startedAt: expect.any(Number) as unknown,
            failedAt: expect.any(Number) as unknown,
          },
        },
      },
    });

    it('publishes each failure the client records, a refused start or the end of the worker, as the failed sync of its account without a retry action, as only a public call starts it again', () => {
      const refused = clientFailure(a, 'wrong-password');
      testSideEffect(
        {
          build: ({ hot }) =>
            surfaceMidnightEngineFailures({
              startFailures$: hot('-abcd', {
                a: { [a.accountId]: refused },
                b: {
                  [a.accountId]: refused,
                  [b.accountId]: clientFailure(b, 'runtime-stopped'),
                },
                c: {},
                d: { [a.accountId]: clientFailure(a, 'startup-failed') },
              }),
            }),
        },
        ({ flush }) => ({
          dependencies: { actions },
          assertion: sideEffect$ => {
            const emitted: Action[] = [];
            sideEffect$.subscribe(action => emitted.push(action));
            flush();
            expect(emitted).toEqual([
              failedSyncOf(a).failure,
              failedSyncOf(a).operation,
              failedSyncOf(b).failure,
              failedSyncOf(b).operation,
              failedSyncOf(a).failure,
              failedSyncOf(a).operation,
            ]);
          },
        }),
      );
    });

    it('publishes the end of the worker as the failed sync of each account it served, nothing as public calls clear the records for the next starts, and again when the next worker ends', () => {
      const deadA = clientFailure(a, 'runtime-stopped');
      const deadB = clientFailure(b, 'runtime-stopped');
      testSideEffect(
        {
          build: ({ hot }) =>
            surfaceMidnightEngineFailures({
              startFailures$: hot('-a-----bcd', {
                a: { [a.accountId]: deadA, [b.accountId]: deadB },
                b: { [b.accountId]: deadB },
                c: {},
                d: { [a.accountId]: clientFailure(a, 'runtime-stopped') },
              }),
            }),
        },
        ({ expectObservable }) => ({
          dependencies: { actions },
          assertion: sideEffect$ => {
            expectObservable(sideEffect$).toBe('-(wxyz)--(uv)', {
              w: failedSyncOf(a).failure,
              x: failedSyncOf(a).operation,
              y: failedSyncOf(b).failure,
              z: failedSyncOf(b).operation,
              u: failedSyncOf(a).failure,
              v: failedSyncOf(a).operation,
            });
          },
        }),
      );
    });

    it('completes the Failed sync operation of a worker death once the next engine of the account reports it synced', () => {
      const operationId = `${a.accountId}-midnight-sync`;
      const failedAt = Timestamp(0);
      const { operation: failedOperation } = actions.sync.addSyncOperation({
        accountId: a.accountId,
        operation: {
          operationId,
          status: 'Failed',
          description: 'sync.operation.midnight-wallet-sync',
          error: 'sync.error.midnight-sync-failed',
          startedAt: failedAt,
          failedAt,
        },
      }).payload;
      testSideEffect(
        {
          build: ({ cold }) => {
            const next = {
              accountId: a.accountId,
              syncProgress$: cold('--a', { a: progress(1) }),
            } as unknown as MidnightEngine;
            return updateSyncProgress(
              next,
              cold('a', { a: true }),
              new BehaviorSubject<MidnightEnginesByAccountId>({
                [a.accountId]: next,
              }),
            );
          },
        },
        ({ cold, flush }) => ({
          stateObservables: {
            sync: {
              selectSyncStatusByAccount$: cold('a', {
                a: {
                  [a.accountId]: {
                    pendingSync: {
                      startedAt: failedAt,
                      operations: { [operationId]: failedOperation },
                    },
                  },
                },
              }),
            },
          },
          dependencies: { actions },
          assertion: sideEffect$ => {
            const emitted: Action[] = [];
            sideEffect$.subscribe(action => emitted.push(action));
            flush();
            expect(emitted).toEqual([
              actions.sync.updateSyncProgress({
                accountId: a.accountId,
                operationId,
                progress: Percent(1),
              }),
              actions.sync.completeSyncOperation({
                accountId: a.accountId,
                operationId,
              }),
            ]);
          },
        }),
      );
    });
  });
});
