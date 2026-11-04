import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { MidnightSDKNetworkIds } from '@lace-contract/midnight-context';
import { ByteArray } from '@lace-lib/util';
import { filter, firstValueFrom, NEVER, Subject, throwError } from 'rxjs';
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

import {
  encodeMidnightFinalizedTx,
  encodeMidnightRecipe,
  midnightEngineGeneration,
} from '../../src/worker/codec';
import { createMidnightEngineHost } from '../../src/worker/engine-host';
import { MidnightWorkerError } from '../../src/worker/protocol';

import {
  checkpoint,
  createMemoryStore,
  events,
  fakeEngines,
  finalized,
  holdKeyDerivation,
  PASSWORD,
  sealedAccount,
  settings,
  unprovenRecipe,
  useFastKeyDerivation,
  WRONG_PASSWORD,
} from './engine-host-fakes';
import { createHost } from './engine-host-setup';

import type { FakeEngine } from './engine-host-fakes';
import type {
  MidnightEngineHost,
  MidnightSessionStatus,
  MidnightWorkerCaller,
} from '../../src/worker/protocol';
import type { MidnightAccountProps } from '@lace-contract/midnight-context';
import type { InMemoryWalletAccount } from '@lace-contract/wallet-repo';
import type { Observable } from 'rxjs';

vi.mock('../../src/store/dependencies', async importOriginal => {
  const fakes = await import('./engine-host-fakes');
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    createStartMidnightAccountWallet: fakes.fakeEngines.createStart,
  };
});

type Account = InMemoryWalletAccount<MidnightAccountProps>;

const reasonOf = async (call: Promise<unknown>) =>
  call.then(
    () => 'resolved',
    (error: unknown) => (error as { reason?: string }).reason ?? error,
  );

const attachTo =
  (host: MidnightEngineHost) =>
  async (
    clientId: string,
    account: Account,
    storage: 'indexeddb' | 'memory' = 'memory',
  ) =>
    host.attach({
      clientId,
      account,
      password: PASSWORD.slice(),
      settings: settings({ storage }),
    });

const statusOf = async (
  host: MidnightEngineHost,
  caller: MidnightWorkerCaller,
) => firstValueFrom(host.streams(caller).status$);

// On real timers: steps that wait on each other forever fail the test instead of hanging it.
const settlesWithin = async (call: Promise<unknown>, ms = 1000) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const isSettled = await Promise.race([
    call.then(
      () => true,
      () => true,
    ),
    new Promise<boolean>(resolve => {
      timer = setTimeout(() => {
        resolve(false);
      }, ms);
    }),
  ]);
  clearTimeout(timer);
  return isSettled;
};

const STOP_BOUND_MS = 30_000;
const START_BOUND_MS = 120_000;

// setImmediate stays real, so that `flush` lets every queued promise step run while the clock stands still.
const useFakeClock = () =>
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
  });
const flush = async () =>
  new Promise<void>(resolve => {
    setImmediate(resolve);
  });

const until = async (condition: () => boolean) => {
  for (let round = 0; round < 1000 && !condition(); round += 1) await flush();
  expect(condition()).toBe(true);
};

const tracked = <T>(call: Promise<T>) => {
  const state = { call, isSettled: false };
  void call.then(
    () => {
      state.isSettled = true;
    },
    () => {
      state.isSettled = true;
    },
  );
  return state;
};

const isZeroed = (bytes: Uint8Array) => bytes.every(byte => byte === 0);

// The proof of authority a client attached to none of the affected engines presents.
const authorityOver = (account: Account, password: Uint8Array = PASSWORD) => ({
  account,
  password: password.slice(),
});

// Leaves the account's engine with a submission that settles only when the test says so.
const submitUnsettled = (
  host: MidnightEngineHost,
  clientId: string,
  account: Account,
) => {
  const draining = fakeEngines.current(account.accountId);
  const finality = new Subject<string>();
  vi.mocked(draining.engine.submitTransaction).mockReturnValue(finality);
  const submission = tracked(
    host.submit({
      clientId,
      accountId: account.accountId,
      transaction: encodeMidnightFinalizedTx(finalized(), {
        accountId: draining.engine.accountId,
        engineGeneration: midnightEngineGeneration(draining.engine),
      }),
    }),
  );
  const settle = () => {
    finality.next('tx-hash');
    finality.complete();
  };
  return { draining, submission, settle };
};

// Replaces only the stop acknowledgement: the stop call, which halts persistence, is still logged.
const acknowledgeStopWith = (
  fake: FakeEngine,
  acknowledgement: Observable<void>,
) =>
  vi.mocked(fake.engine.stop).mockImplementation(() => {
    events.push(`stop:${fake.engine.accountId}`);
    return acknowledgement;
  });

describe('engine-host-storage-operations', () => {
  let a: Account;
  let b: Account;
  let c: Account;
  let otherWallet: Account;

  beforeAll(async () => {
    useFastKeyDerivation();
    a = await sealedAccount({ walletId: 'wallet-a' });
    b = await sealedAccount({
      walletId: 'wallet-a',
      accountIndex: 1,
      network: MidnightSDKNetworkIds.Preview,
    });
    c = await sealedAccount({
      walletId: 'wallet-c',
      network: MidnightSDKNetworkIds.PreProd,
    });
    otherWallet = await sealedAccount({ walletId: 'wallet-z' });
  });
  beforeEach(() => {
    fakeEngines.reset();
    useFastKeyDerivation();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('account reset', () => {
    it('stops the engine, wipes only its checkpoint and restarts it for every attached client', async () => {
      const { host, stores } = createHost();
      await attachTo(host)('tab-1', a);
      await attachTo(host)('tab-2', a);
      await attachTo(host)('tab-2', c);
      const { documents } = stores.get('memory')!;
      for (const account of [a, c])
        documents.set(String(account.accountId), checkpoint(account));
      const [first] = fakeEngines.of(a.accountId);
      events.length = 0;

      await host.resetAccount({
        clientId: 'tab-1',
        accountId: a.accountId,
        storage: 'memory',
      });

      expect(events).toEqual([
        `stop:${a.accountId}`,
        'memory:removeWhere',
        `start:${a.accountId}`,
      ]);
      expect([...documents.keys()]).toEqual([String(c.accountId)]);
      expect(first.tornDown).toBe(true);
      const replacement = fakeEngines.current(a.accountId);
      for (const clientId of ['tab-1', 'tab-2'])
        await expect(
          statusOf(host, { clientId, accountId: a.accountId }),
        ).resolves.toEqual({
          engineGeneration: midnightEngineGeneration(replacement.engine),
          resets: 1,
        });
      expect(fakeEngines.of(c.accountId)).toHaveLength(1);
      expect(fakeEngines.current(c.accountId).stopped).toBe(false);
      await expect(
        statusOf(host, { clientId: 'tab-2', accountId: c.accountId }),
      ).resolves.toMatchObject({ resets: 0 });
    });

    it('fails a call in flight on the account with the reset error', async () => {
      const { host } = createHost();
      await attachTo(host)('tab-1', a);
      await attachTo(host)('tab-2', a);
      const running = fakeEngines.current(a.accountId);
      vi.mocked(running.engine.finalizeRecipe).mockReturnValue(new Subject());
      const recipe = encodeMidnightRecipe(unprovenRecipe(), {
        accountId: running.engine.accountId,
        engineGeneration: midnightEngineGeneration(running.engine),
      });

      const proving = host.prove({
        clientId: 'tab-2',
        accountId: a.accountId,
        recipe,
      });
      await host.resetAccount({
        clientId: 'tab-1',
        accountId: a.accountId,
        storage: 'memory',
      });

      await expect(reasonOf(proving)).resolves.toBe('engine-replaced');
    });

    it('wipes the checkpoint of an account whose engine does not run here', async () => {
      const { host, stores } = createHost();
      await attachTo(host)('tab-1', c, 'indexeddb');
      const { documents } = stores.get('indexeddb')!;
      documents.set(String(a.accountId), checkpoint(a));
      documents.set(String(c.accountId), checkpoint(c));

      await host.resetAccount({
        clientId: 'tab-1',
        accountId: a.accountId,
        storage: 'indexeddb',
        authority: authorityOver(a),
      });

      expect([...documents.keys()]).toEqual([String(c.accountId)]);
      expect(fakeEngines.started).toHaveLength(1);
    });

    it('carries on with the reset when the engine stop fails, as persistence halts before the stop settles', async () => {
      const { host, stores } = createHost();
      await attachTo(host)('tab-1', a);
      stores.get('memory')!.documents.set(String(a.accountId), checkpoint(a));
      vi.mocked(fakeEngines.current(a.accountId).engine.stop).mockReturnValue(
        throwError(() => new Error('facade stop failed')),
      );

      await host.resetAccount({
        clientId: 'tab-1',
        accountId: a.accountId,
        storage: 'memory',
      });

      expect(stores.get('memory')!.documents.size).toBe(0);
      expect(fakeEngines.of(a.accountId)).toHaveLength(2);
    });

    it('refuses a client that is not attached to the running engine', async () => {
      const { host } = createHost();
      await attachTo(host)('tab-1', a);

      await expect(
        reasonOf(
          host.resetAccount({
            clientId: 'tab-2',
            accountId: a.accountId,
            storage: 'memory',
          }),
        ),
      ).resolves.toBe('not-attached');
      expect(fakeEngines.current(a.accountId).stopped).toBe(false);
    });

    it('restarts the engine after a failed wipe and returns the wipe error', async () => {
      const { host, stores } = createHost();
      await attachTo(host)('tab-1', a);
      vi.spyOn(stores.get('memory')!.store, 'removeWhere').mockReturnValue(
        throwError(() => new Error('disk full')),
      );

      await expect(
        host.resetAccount({
          clientId: 'tab-1',
          accountId: a.accountId,
          storage: 'memory',
        }),
      ).rejects.toThrow('disk full');
      expect(fakeEngines.of(a.accountId)).toHaveLength(2);
      await expect(
        statusOf(host, { clientId: 'tab-1', accountId: a.accountId }),
      ).resolves.toMatchObject({ resets: 0 });
    });

    it('tells every attached client when the engine does not restart, and restarts it on the next attach', async () => {
      const { host } = createHost();
      await attachTo(host)('tab-1', a);
      await attachTo(host)('tab-2', a);
      fakeEngines.failNextStart = new Error('indexer unreachable');

      await expect(
        host.resetAccount({
          clientId: 'tab-1',
          accountId: a.accountId,
          storage: 'memory',
        }),
      ).rejects.toThrow('indexer unreachable');
      for (const clientId of ['tab-1', 'tab-2'])
        await expect(
          statusOf(host, { clientId, accountId: a.accountId }),
        ).resolves.toEqual({ resets: 1, failure: 'indexer unreachable' });
      await attachTo(host)('tab-2', a);
      await expect(
        statusOf(host, { clientId: 'tab-1', accountId: a.accountId }),
      ).resolves.toEqual({
        engineGeneration: midnightEngineGeneration(
          fakeEngines.current(a.accountId).engine,
        ),
        resets: 1,
      });
    });

    it('wipes and restarts once a stop that is never acknowledged reaches the bound, not before, leaving other accounts alone', async () => {
      const { host, stores } = createHost();
      await attachTo(host)('tab-1', a);
      await attachTo(host)('tab-1', c);
      const { documents } = stores.get('memory')!;
      documents.set(String(a.accountId), checkpoint(a));
      acknowledgeStopWith(fakeEngines.current(a.accountId), NEVER);
      const logError = vi.spyOn(dummyLogger, 'error');
      useFakeClock();
      events.length = 0;

      const reset = tracked(
        host.resetAccount({
          clientId: 'tab-1',
          accountId: a.accountId,
          storage: 'memory',
        }),
      );
      await vi.advanceTimersByTimeAsync(STOP_BOUND_MS - 1);
      await flush();
      const isSettledBeforeBound = reset.isSettled;
      const eventsBeforeBound = [...events];
      await vi.advanceTimersByTimeAsync(1);
      await flush();

      expect(isSettledBeforeBound).toBe(false);
      expect(eventsBeforeBound).toEqual([`stop:${a.accountId}`]);
      expect(reset.isSettled).toBe(true);
      await reset.call;
      expect(events).toEqual([
        `stop:${a.accountId}`,
        'memory:removeWhere',
        `start:${a.accountId}`,
      ]);
      expect(documents.size).toBe(0);
      expect(logError).toHaveBeenCalledWith(
        expect.stringContaining('did not acknowledge its stop'),
        expect.anything(),
      );
      expect(fakeEngines.of(c.accountId)).toHaveLength(1);
      expect(fakeEngines.current(c.accountId).stopped).toBe(false);
    });

    it('carries on at once when the stop is acknowledged just before the bound, leaving no timer', async () => {
      const { host } = createHost();
      await attachTo(host)('tab-1', a);
      const stopping = new Subject<void>();
      acknowledgeStopWith(fakeEngines.current(a.accountId), stopping);
      const logError = vi.spyOn(dummyLogger, 'error');
      useFakeClock();

      const reset = tracked(
        host.resetAccount({
          clientId: 'tab-1',
          accountId: a.accountId,
          storage: 'memory',
        }),
      );
      await vi.advanceTimersByTimeAsync(STOP_BOUND_MS - 1);
      const timersWhileWaiting = vi.getTimerCount();
      stopping.next();
      await flush();

      expect(timersWhileWaiting).toBe(1);
      expect(reset.isSettled).toBe(true);
      await reset.call;
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(STOP_BOUND_MS);
      expect(logError).not.toHaveBeenCalled();
      expect(fakeEngines.of(a.accountId)).toHaveLength(2);
    });
  });

  describe('a reset while a submission of an attached client settles', () => {
    const settling = async () => {
      const { host, stores } = createHost();
      await attachTo(host)('tab-1', a);
      await attachTo(host)('tab-2', a);
      await attachTo(host)('tab-2', c);
      const { documents } = stores.get('memory')!;
      documents.set(String(a.accountId), checkpoint(a));
      const unsettled = submitUnsettled(host, 'tab-1', a);
      events.length = 0;
      return { host, stores, documents, ...unsettled };
    };
    const statusesOfTab2 = (host: MidnightEngineHost) => {
      const statuses: MidnightSessionStatus[] = [];
      host
        .streams({ clientId: 'tab-2', accountId: a.accountId })
        .status$.subscribe(status => statuses.push(status));
      return statuses;
    };
    const resetByTab2 = async (host: MidnightEngineHost) =>
      host.resetAccount({
        clientId: 'tab-2',
        accountId: a.accountId,
        storage: 'memory',
      });
    const untilRestarted = async () => {
      await vi.waitFor(() => {
        expect(events).toContain(`start:${a.accountId}`);
      });
      await flush();
    };

    it('keeps the engine for its clients until the submission settles, then resets it and restarts it with resets + 1', async () => {
      const { host, documents, draining, submission, settle } =
        await settling();

      await resetByTab2(host);
      await flush();
      const eventsWhileHeld = [...events];
      const signedWhileHeld = await host.signData({
        clientId: 'tab-2',
        accountId: a.accountId,
        data: new Uint8Array([1]),
      });
      settle();

      expect(eventsWhileHeld).toEqual([]);
      expect(signedWhileHeld).toMatchObject({ signature: 'signature' });
      await expect(submission.call).resolves.toEqual({ txId: 'tx-hash' });
      await untilRestarted();
      expect(events).toEqual([
        `stop:${a.accountId}`,
        'memory:removeWhere',
        `start:${a.accountId}`,
      ]);
      expect(draining.tornDown).toBe(true);
      expect(documents.has(String(a.accountId))).toBe(false);
      await expect(
        statusOf(host, { clientId: 'tab-2', accountId: a.accountId }),
      ).resolves.toEqual({
        engineGeneration: midnightEngineGeneration(
          fakeEngines.current(a.accountId).engine,
        ),
        resets: 1,
      });
    });

    it('holds the account through a bulk resync, which resets the other engines at once', async () => {
      const { host, draining, submission, settle } = await settling();

      await host.resyncAll({ clientId: 'tab-2', storage: 'memory' });
      const eventsOfResync = [...events];
      const isStoppedWhileHeld = draining.stopped;
      settle();

      expect(eventsOfResync).toEqual([
        `stop:${c.accountId}`,
        'memory:clear',
        `start:${c.accountId}`,
      ]);
      expect(isStoppedWhileHeld).toBe(false);
      await expect(submission.call).resolves.toEqual({ txId: 'tx-hash' });
      await untilRestarted();
      expect(events.slice(eventsOfResync.length)).toEqual([
        `stop:${a.accountId}`,
        'memory:removeWhere',
        `start:${a.accountId}`,
      ]);
      await expect(
        statusOf(host, { clientId: 'tab-2', accountId: a.accountId }),
      ).resolves.toEqual({
        engineGeneration: midnightEngineGeneration(
          fakeEngines.current(a.accountId).engine,
        ),
        resets: 1,
      });
    });

    it('refuses a new submission on the account while the reset waits, broadcasting nothing and advising to build and prove it again', async () => {
      const { host, draining, submission, settle } = await settling();
      await resetByTab2(host);

      const refusal = await host
        .submit({
          clientId: 'tab-2',
          accountId: a.accountId,
          transaction: encodeMidnightFinalizedTx(finalized(), {
            accountId: draining.engine.accountId,
            engineGeneration: midnightEngineGeneration(draining.engine),
          }),
        })
        .catch((error: unknown) => error);
      settle();

      expect(refusal).toMatchObject({
        reason: 'reset-pending',
        message: expect.stringContaining(
          'build and prove the transaction again once the reset has run',
        ) as string,
      });
      expect(draining.engine.submitTransaction).toHaveBeenCalledOnce();
      await expect(submission.call).resolves.toEqual({ txId: 'tx-hash' });
    });

    it('publishes the pending reset in the status of the account and clears it only once resets has risen', async () => {
      const { host, draining, settle } = await settling();
      const statuses = statusesOfTab2(host);

      await resetByTab2(host);
      const held = statuses.length;
      const whileHeld = statuses[held - 1];
      settle();
      await untilRestarted();

      const reset = {
        engineGeneration: midnightEngineGeneration(
          fakeEngines.current(a.accountId).engine,
        ),
        resets: 1,
      };
      expect(whileHeld).toEqual({
        engineGeneration: midnightEngineGeneration(draining.engine),
        resets: 0,
        resetPending: true,
      });
      expect(statuses[statuses.length - 1]).toEqual(reset);
      expect(
        statuses.slice(held).filter(status => !status.resetPending),
      ).toEqual([reset]);
    });

    it('publishes a held reset whose wipe fails as the status failure, clearing the pending reset, and the next attach replaces the engine', async () => {
      const { host, stores, submission, settle } = await settling();
      vi.spyOn(stores.get('memory')!.store, 'removeWhere').mockReturnValue(
        throwError(() => new Error('disk full')),
      );
      const statuses = statusesOfTab2(host);

      await resetByTab2(host);
      const held = statuses.length;
      settle();
      await expect(submission.call).resolves.toEqual({ txId: 'tx-hash' });
      await untilRestarted();

      const failed = {
        engineGeneration: midnightEngineGeneration(
          fakeEngines.current(a.accountId).engine,
        ),
        resets: 0,
        failure: expect.stringContaining('disk full') as string,
      };
      expect(fakeEngines.of(a.accountId)).toHaveLength(2);
      expect(statuses[statuses.length - 1]).toEqual(failed);
      expect(
        statuses.slice(held).filter(status => !status.resetPending),
      ).toEqual([failed]);
      await attachTo(host)('tab-2', a);
      expect(fakeEngines.of(a.accountId)).toHaveLength(3);
      await expect(
        statusOf(host, { clientId: 'tab-1', accountId: a.accountId }),
      ).resolves.toEqual({
        engineGeneration: midnightEngineGeneration(
          fakeEngines.current(a.accountId).engine,
        ),
        resets: 0,
      });
    });

    it('waits for the last of several unsettled submissions before it resets', async () => {
      const { host, submission, settle } = await settling();
      const later = submitUnsettled(host, 'tab-2', a);

      await resetByTab2(host);
      settle();
      await expect(submission.call).resolves.toEqual({ txId: 'tx-hash' });
      await flush();
      const eventsAfterFirst = [...events];
      const statusAfterFirst = await statusOf(host, {
        clientId: 'tab-2',
        accountId: a.accountId,
      });
      const isLaterSettled = later.submission.isSettled;
      later.settle();

      expect(eventsAfterFirst).toEqual([]);
      expect(statusAfterFirst).toMatchObject({ resetPending: true });
      expect(isLaterSettled).toBe(false);
      await expect(later.submission.call).resolves.toEqual({
        txId: 'tx-hash',
      });
      await untilRestarted();
      expect(events).toEqual([
        `stop:${a.accountId}`,
        'memory:removeWhere',
        `start:${a.accountId}`,
      ]);
      await expect(
        statusOf(host, { clientId: 'tab-2', accountId: a.accountId }),
      ).resolves.toEqual({
        engineGeneration: midnightEngineGeneration(
          fakeEngines.current(a.accountId).engine,
        ),
        resets: 1,
      });
    });

    it('runs a single reset for a repeated request that waits in the lane while the last submission settles', async () => {
      const { host, documents, submission, settle } = await settling();
      const statuses = statusesOfTab2(host);
      await resetByTab2(host);
      const keyCheck = holdKeyDerivation();
      const attaching = attachTo(host)('tab-3', a);
      await keyCheck.entered;

      const repeated = host.resetAccount({
        clientId: 'tab-1',
        accountId: a.accountId,
        storage: 'memory',
      });
      settle();
      await expect(submission.call).resolves.toEqual({ txId: 'tx-hash' });
      keyCheck.release();
      await attaching;
      await repeated;
      await until(() => !statuses[statuses.length - 1].resetPending);

      expect(events).toEqual([
        `stop:${a.accountId}`,
        'memory:removeWhere',
        `start:${a.accountId}`,
      ]);
      expect(documents.has(String(a.accountId))).toBe(false);
      expect(statuses[statuses.length - 1]).toEqual({
        engineGeneration: midnightEngineGeneration(
          fakeEngines.current(a.accountId).engine,
        ),
        resets: 1,
      });
    });

    it('still runs the held reset when the last client detaches behind another lane step while the submission settles', async () => {
      const { host, stores } = createHost();
      await attachTo(host)('tab-1', a);
      const { documents } = stores.get('memory')!;
      documents.set(String(a.accountId), checkpoint(a));
      const { submission, settle } = submitUnsettled(host, 'tab-1', a);
      await host.resetAccount({
        clientId: 'tab-1',
        accountId: a.accountId,
        storage: 'memory',
      });
      const keyCheck = holdKeyDerivation();
      const reattaching = attachTo(host)('tab-1', a);
      await keyCheck.entered;

      const detaching = host.detach({
        clientId: 'tab-1',
        accountId: a.accountId,
      });
      settle();
      await expect(submission.call).resolves.toEqual({ txId: 'tx-hash' });
      keyCheck.release();
      await reattaching;
      await detaching;
      const reattached = await attachTo(host)('tab-2', a);

      expect({
        checkpointRemains: documents.has(String(a.accountId)),
        resets: reattached.resets,
      }).toEqual({ checkpointRemains: false, resets: 1 });
    });

    it('schedules a single reset for repeated reset and resync requests while the submission settles', async () => {
      const { host, submission, settle } = await settling();

      await resetByTab2(host);
      await host.resetAccount({
        clientId: 'tab-1',
        accountId: a.accountId,
        storage: 'memory',
      });
      await host.resyncAll({ clientId: 'tab-2', storage: 'memory' });
      settle();
      await expect(submission.call).resolves.toEqual({ txId: 'tx-hash' });
      await untilRestarted();

      expect(
        events.filter(
          event =>
            event.endsWith(String(a.accountId)) ||
            event === 'memory:removeWhere',
        ),
      ).toEqual([
        `stop:${a.accountId}`,
        'memory:removeWhere',
        `start:${a.accountId}`,
      ]);
      await expect(
        statusOf(host, { clientId: 'tab-2', accountId: a.accountId }),
      ).resolves.toMatchObject({ resets: 1 });
    });
  });

  describe('account reset of an engine that drains a submission', () => {
    it('leaves the engine running and resets the account once the submission settles', async () => {
      const { host, stores } = createHost();
      await attachTo(host)('tab-1', a);
      const { documents } = stores.get('memory')!;
      documents.set(String(a.accountId), checkpoint(a));
      const { draining, submission, settle } = submitUnsettled(
        host,
        'tab-1',
        a,
      );
      await host.detachClient('tab-1');
      events.length = 0;

      await host.resetAccount({
        clientId: 'tab-2',
        accountId: a.accountId,
        storage: 'memory',
        authority: authorityOver(a),
      });
      await flush();
      const eventsWhileUnsettled = [...events];
      const isSettledBeforeFinality = submission.isSettled;
      settle();

      expect(eventsWhileUnsettled).toEqual([]);
      expect(isSettledBeforeFinality).toBe(false);
      expect(documents.has(String(a.accountId))).toBe(true);
      await expect(submission.call).resolves.toEqual({ txId: 'tx-hash' });
      await vi.waitFor(() => {
        expect(documents.size).toBe(0);
      });
      expect(events).toEqual([`stop:${a.accountId}`, 'memory:removeWhere']);
      expect(draining.tornDown).toBe(true);
      await expect(attachTo(host)('tab-2', a)).resolves.toMatchObject({
        resets: 1,
      });
    });
  });

  describe('bulk resync', () => {
    it('stops every engine of every wallet and network, clears every checkpoint and restarts the engines with attached clients', async () => {
      const { host, stores } = createHost();
      await attachTo(host)('tab-1', a);
      await attachTo(host)('tab-1', b);
      await attachTo(host)('tab-2', c);
      await attachTo(host)('tab-2', a);
      await attachTo(host)('tab-2', otherWallet);
      const { documents } = stores.get('memory')!;
      for (const account of [a, b, c, otherWallet])
        documents.set(String(account.accountId), checkpoint(account));
      const before = [a, b, c].map(({ accountId }) =>
        fakeEngines.current(accountId),
      );
      events.length = 0;

      await host.resyncAll({ clientId: 'tab-1', storage: 'memory' });

      const clearAt = events.indexOf('memory:clear');
      expect(events.slice(0, clearAt).sort()).toEqual(
        [a, b, c, otherWallet]
          .map(({ accountId }) => `stop:${accountId}`)
          .sort(),
      );
      expect(events.slice(clearAt + 1).sort()).toEqual(
        [a, b, c, otherWallet]
          .map(({ accountId }) => `start:${accountId}`)
          .sort(),
      );
      expect(documents.size).toBe(0);
      expect(before.every(({ tornDown }) => tornDown)).toBe(true);
      for (const [clientId, account] of [
        ['tab-1', a],
        ['tab-1', b],
        ['tab-2', c],
        ['tab-2', otherWallet],
      ] as const)
        await expect(
          statusOf(host, { clientId, accountId: account.accountId }),
        ).resolves.toEqual({
          engineGeneration: midnightEngineGeneration(
            fakeEngines.current(account.accountId).engine,
          ),
          resets: 1,
        });
    });

    it('leaves an engine that drains a submission running, and resets its account once the submission settles', async () => {
      const { host, stores } = createHost();
      await attachTo(host)('tab-1', a);
      await attachTo(host)('tab-2', otherWallet);
      const { documents } = stores.get('memory')!;
      const { draining, submission, settle } = submitUnsettled(
        host,
        'tab-2',
        otherWallet,
      );
      await host.detach({
        clientId: 'tab-2',
        accountId: otherWallet.accountId,
      });
      events.length = 0;

      await host.resyncAll({ clientId: 'tab-1', storage: 'memory' });
      // A persist write of the draining engine after the clear.
      documents.set(String(otherWallet.accountId), checkpoint(otherWallet));
      await flush();
      const isStoppedWhileUnsettled = draining.stopped;
      const isSettledBeforeFinality = submission.isSettled;
      settle();

      expect(events).not.toContain(`stop:${otherWallet.accountId}`);
      expect(isStoppedWhileUnsettled).toBe(false);
      expect(isSettledBeforeFinality).toBe(false);
      await expect(submission.call).resolves.toEqual({ txId: 'tx-hash' });
      await vi.waitFor(() => {
        expect(documents.has(String(otherWallet.accountId))).toBe(false);
      });
      expect(draining.stopped).toBe(true);
      expect(draining.tornDown).toBe(true);
      await expect(attachTo(host)('tab-2', otherWallet)).resolves.toMatchObject(
        { resets: 1 },
      );
    });

    it('keeps the call order of an attach and a detach called while it runs', async () => {
      const { host } = createHost();
      await attachTo(host)('tab-1', a);
      const stopping = new Subject<void>();
      vi.mocked(fakeEngines.current(a.accountId).engine.stop).mockReturnValue(
        stopping,
      );

      const resync = host.resyncAll({ clientId: 'tab-1', storage: 'memory' });
      const attaching = attachTo(host)('tab-2', c);
      const detaching = host.detach({
        clientId: 'tab-2',
        accountId: c.accountId,
      });
      stopping.next();
      stopping.complete();
      await Promise.all([resync, attaching, detaching]);

      expect(fakeEngines.of(c.accountId)).toHaveLength(1);
      expect(fakeEngines.current(c.accountId).tornDown).toBe(true);
    });

    it('keeps the call order of an attach that waited for it and a detach called in any microtask as it ends', async () => {
      const stillAttachedAt: number[] = [];
      for (let ticks = 0; ticks <= 40; ticks += 1) {
        fakeEngines.reset();
        const { host } = createHost();
        await attachTo(host)('tab-1', a);
        const stopping = new Subject<void>();
        vi.mocked(fakeEngines.current(a.accountId).engine.stop).mockReturnValue(
          stopping,
        );
        // The resync's last step publishes the restarted engine; the detach follows it by `ticks` microtasks.
        const detaching = firstValueFrom(
          host
            .streams({ clientId: 'tab-1', accountId: a.accountId })
            .status$.pipe(
              filter(({ engineGeneration, resets }) =>
                Boolean(engineGeneration && resets === 1),
              ),
            ),
        ).then(async () => {
          for (let tick = 0; tick < ticks; tick += 1) await Promise.resolve();
          await host.detach({ clientId: 'tab-2', accountId: c.accountId });
        });

        const resync = host.resyncAll({
          clientId: 'tab-1',
          storage: 'memory',
        });
        const attaching = attachTo(host)('tab-2', c);
        stopping.next();
        stopping.complete();
        await Promise.all([resync, attaching, detaching]);

        if (!fakeEngines.current(c.accountId).tornDown)
          stillAttachedAt.push(ticks);
      }

      expect(stillAttachedAt).toEqual([]);
    });

    it('starts a new engine only after the checkpoints are cleared', async () => {
      const { host } = createHost();
      await attachTo(host)('tab-1', a);
      const stopping = new Subject<void>();
      vi.mocked(fakeEngines.current(a.accountId).engine.stop).mockReturnValue(
        stopping,
      );
      events.length = 0;

      const resync = host.resyncAll({ clientId: 'tab-1', storage: 'memory' });
      const starting = attachTo(host)('tab-1', c);
      await new Promise(resolve => setTimeout(resolve, 50));
      const didStartWhileStopping = events.includes(`start:${c.accountId}`);
      stopping.next();
      stopping.complete();
      await Promise.all([resync, starting]);

      expect(didStartWhileStopping).toBe(false);
      expect(events.indexOf(`start:${c.accountId}`)).toBeGreaterThan(
        events.indexOf('memory:clear'),
      );
    });

    it('clears the checkpoints of every storage kind in use', async () => {
      const { host, stores } = createHost();
      await attachTo(host)('tab-1', a, 'indexeddb');
      await attachTo(host)('tab-1', c, 'memory');
      events.length = 0;

      await host.resyncAll({ clientId: 'tab-1', storage: 'memory' });

      expect(events.filter(event => event.endsWith(':clear')).sort()).toEqual([
        'indexeddb:clear',
        'memory:clear',
      ]);
      expect([...stores.keys()].sort()).toEqual(['indexeddb', 'memory']);
    });

    it('restarts the engines when the clear fails, counts no reset and then fails with the clear error', async () => {
      const { host, stores } = createHost();
      await attachTo(host)('tab-1', a);
      vi.spyOn(stores.get('memory')!.store, 'clear').mockReturnValue(
        throwError(() => new Error('disk full')),
      );

      await expect(
        host.resyncAll({ clientId: 'tab-1', storage: 'memory' }),
      ).rejects.toThrow('disk full');
      expect(fakeEngines.of(a.accountId)).toHaveLength(2);
      await expect(
        statusOf(host, { clientId: 'tab-1', accountId: a.accountId }),
      ).resolves.toEqual({
        engineGeneration: midnightEngineGeneration(
          fakeEngines.current(a.accountId).engine,
        ),
        resets: 0,
      });
    });

    it('restarts every engine, counting no reset, and serves the next attach when the clear step itself throws', async () => {
      const { store } = createMemoryStore('memory');
      // The one throw the clear step cannot catch: its own log of a failed clear.
      const host = createMidnightEngineHost({
        createStore: () => ({
          ...store,
          clear: () => throwError(() => new Error('disk full')),
        }),
        derivePendingActivity: vi.fn(),
        logger: {
          ...dummyLogger,
          error: (message: string) => {
            if (message.startsWith('Clearing'))
              throw new Error('the log is unavailable');
          },
        },
      });
      await attachTo(host)('tab-1', a);

      await expect(
        host.resyncAll({ clientId: 'tab-1', storage: 'memory' }),
      ).rejects.toThrow('the log is unavailable');
      const attaching = attachTo(host)('tab-2', a);

      await expect(settlesWithin(attaching)).resolves.toBe(true);
      await expect(attaching).resolves.toMatchObject({ resets: 0 });
      expect(fakeEngines.of(a.accountId)).toHaveLength(2);
    });

    it('counts a reset only for the accounts whose storage kind cleared, restarts every engine and fails with the clear error', async () => {
      const { host, stores } = createHost();
      await attachTo(host)('tab-1', a, 'indexeddb');
      await attachTo(host)('tab-1', c, 'memory');
      stores
        .get('indexeddb')!
        .documents.set(String(a.accountId), checkpoint(a));
      stores.get('memory')!.documents.set(String(c.accountId), checkpoint(c));
      vi.spyOn(stores.get('indexeddb')!.store, 'clear').mockReturnValue(
        throwError(() => new Error('quota exceeded')),
      );

      await expect(
        host.resyncAll({ clientId: 'tab-1', storage: 'memory' }),
      ).rejects.toThrow('quota exceeded');
      const statuses = await Promise.all(
        [a, c].map(async ({ accountId }) =>
          statusOf(host, { clientId: 'tab-1', accountId }),
        ),
      );

      expect(statuses).toEqual(
        [a, c].map(({ accountId }, index) => ({
          engineGeneration: midnightEngineGeneration(
            fakeEngines.current(accountId).engine,
          ),
          resets: index === 0 ? 0 : 1,
        })),
      );
      expect(fakeEngines.of(a.accountId)).toHaveLength(2);
      expect(fakeEngines.of(c.accountId)).toHaveLength(2);
      expect([...stores.get('indexeddb')!.documents.keys()]).toEqual([
        String(a.accountId),
      ]);
      expect(stores.get('memory')!.documents.size).toBe(0);
    });

    it('fails with a restart error once the other engines restarted', async () => {
      const { host } = createHost();
      await attachTo(host)('tab-1', a);
      await attachTo(host)('tab-1', c);
      fakeEngines.failNextStart = new Error('indexer unreachable');

      await expect(
        host.resyncAll({ clientId: 'tab-1', storage: 'memory' }),
      ).rejects.toThrow('indexer unreachable');
      const statuses = await Promise.all(
        [a, c].map(async ({ accountId }) =>
          statusOf(host, { clientId: 'tab-1', accountId }),
        ),
      );
      expect(
        statuses.filter(({ engineGeneration }) => engineGeneration).length,
      ).toBe(1);
      expect(fakeEngines.started).toHaveLength(3);
    });

    it('refuses a client attached to no engine while engines run', async () => {
      const { host } = createHost();
      await attachTo(host)('tab-1', a);

      await expect(
        reasonOf(host.resyncAll({ clientId: 'tab-2', storage: 'memory' })),
      ).resolves.toBe('not-attached');
      expect(fakeEngines.current(a.accountId).stopped).toBe(false);
    });

    it('finishes when a session ends while an attach of its account waits ahead of the resync', async () => {
      const { host } = createHost();
      await attachTo(host)('tab-3', c);
      let release!: () => void;
      fakeEngines.hold = new Promise(resolve => {
        release = resolve;
      });
      const first = attachTo(host)('tab-1', a);
      await vi.waitFor(() => {
        expect(fakeEngines.of(a.accountId)).toHaveLength(1);
      });
      const second = attachTo(host)('tab-2', a);
      const resync = host.resyncAll({ clientId: 'tab-3', storage: 'memory' });
      // The first attach's tab closes while its engine starts, which ends the session the resync would stop.
      await host.detachClient('tab-1');
      release();

      await expect(reasonOf(first)).resolves.toBe('not-attached');
      await expect(settlesWithin(Promise.all([second, resync]))).resolves.toBe(
        true,
      );
      await expect(
        statusOf(host, { clientId: 'tab-2', accountId: a.accountId }),
      ).resolves.toEqual({
        engineGeneration: midnightEngineGeneration(
          fakeEngines.current(a.accountId).engine,
        ),
        resets: 1,
      });
    });

    it('restarts after the clear an engine whose attach was checking the password when the resync started', async () => {
      const { host, stores } = createHost();
      await attachTo(host)('tab-3', c);
      stores.get('memory')!.documents.set(String(a.accountId), checkpoint(a));
      const stopping = new Subject<void>();
      vi.mocked(fakeEngines.current(c.accountId).engine.stop).mockReturnValue(
        stopping,
      );
      const derivation = holdKeyDerivation();
      const attaching = attachTo(host)('tab-1', a);
      await derivation.entered;
      events.length = 0;

      const resync = host.resyncAll({ clientId: 'tab-3', storage: 'memory' });
      derivation.release();
      await new Promise(resolve => setTimeout(resolve, 50));
      stopping.next();
      stopping.complete();

      await expect(
        settlesWithin(Promise.all([attaching, resync])),
      ).resolves.toBe(true);
      expect(events.lastIndexOf(`start:${a.accountId}`)).toBeGreaterThan(
        events.indexOf('memory:clear'),
      );
    });

    it('tells every attached client of an account whose engine does not restart', async () => {
      const { host } = createHost();
      await attachTo(host)('tab-1', a);
      await attachTo(host)('tab-2', a);
      fakeEngines.failNextStart = new Error('indexer unreachable');

      await expect(
        host.resyncAll({ clientId: 'tab-1', storage: 'memory' }),
      ).rejects.toThrow('indexer unreachable');
      for (const clientId of ['tab-1', 'tab-2'])
        await expect(
          statusOf(host, { clientId, accountId: a.accountId }),
        ).resolves.toEqual({ resets: 1, failure: 'indexer unreachable' });
    });

    it('carries on once one engine stop reaches the bound unacknowledged, restarting every account and starting new engines afterwards', async () => {
      const { host } = createHost();
      await attachTo(host)('tab-1', a);
      await attachTo(host)('tab-2', c);
      acknowledgeStopWith(fakeEngines.current(a.accountId), NEVER);
      useFakeClock();
      events.length = 0;

      const resync = tracked(
        host.resyncAll({ clientId: 'tab-1', storage: 'memory' }),
      );
      await vi.advanceTimersByTimeAsync(STOP_BOUND_MS - 1);
      await flush();
      const isSettledBeforeBound = resync.isSettled;
      const isClearedBeforeBound = events.includes('memory:clear');
      await vi.advanceTimersByTimeAsync(1);
      await flush();

      expect(isSettledBeforeBound).toBe(false);
      expect(isClearedBeforeBound).toBe(false);
      expect(resync.isSettled).toBe(true);
      await resync.call;
      const clearAt = events.indexOf('memory:clear');
      expect(events.slice(0, clearAt).sort()).toEqual(
        [a, c].map(({ accountId }) => `stop:${accountId}`).sort(),
      );
      expect(events.slice(clearAt + 1).sort()).toEqual(
        [a, c].map(({ accountId }) => `start:${accountId}`).sort(),
      );
      vi.useRealTimers();
      await attachTo(host)('tab-2', otherWallet);
      expect(fakeEngines.of(otherWallet.accountId)).toHaveLength(1);
    });
  });

  describe('a first engine that never arrives', () => {
    it('fails a new session at the bound, not before, releasing its keys and letting a resync and other accounts carry on', async () => {
      const { host } = createHost();
      await attachTo(host)('tab-2', c);
      const clone = vi.spyOn(ByteArray, 'clone');
      const logError = vi.spyOn(dummyLogger, 'error');
      useFakeClock();
      fakeEngines.hold = new Promise(() => undefined);
      const attaching = tracked(attachTo(host)('tab-1', a));
      await until(() => fakeEngines.of(a.accountId).length === 1);
      fakeEngines.hold = undefined;
      const [hung] = fakeEngines.of(a.accountId);
      const destroy = vi.spyOn(hung.params.keyManager, 'destroy');
      const copies = clone.mock.results.map(({ value }) => value as Uint8Array);
      const resync = tracked(
        host.resyncAll({ clientId: 'tab-2', storage: 'memory' }),
      );
      const detaching = tracked(
        host.detach({ clientId: 'tab-2', accountId: c.accountId }),
      );

      await vi.advanceTimersByTimeAsync(START_BOUND_MS - 1);
      await flush();
      const settledBeforeBound = [attaching, resync, detaching].map(
        ({ isSettled }) => isSettled,
      );
      await vi.advanceTimersByTimeAsync(1);
      await flush();

      expect(settledBeforeBound).toEqual([false, false, false]);
      expect(
        [attaching, resync, detaching].map(({ isSettled }) => isSettled),
      ).toEqual([true, true, true]);
      await expect(attaching.call).rejects.toThrow(
        `did not start within ${START_BOUND_MS} ms`,
      );
      await expect(reasonOf(attaching.call)).resolves.toBe('start-timeout');
      await resync.call;
      await detaching.call;
      expect(hung.tornDown).toBe(true);
      expect(destroy).toHaveBeenCalledOnce();
      expect(copies.length).toBeGreaterThan(0);
      expect(copies.every(isZeroed)).toBe(true);
      expect(logError).toHaveBeenCalledWith(
        `Starting the Midnight engine of ${a.accountId}`,
        new MidnightWorkerError(
          'start-timeout',
          `The Midnight engine of ${a.accountId} did not start within ${START_BOUND_MS} ms`,
        ),
      );
      expect(fakeEngines.current(c.accountId).tornDown).toBe(true);
      vi.useRealTimers();
      await attachTo(host)('tab-3', otherWallet);
      expect(fakeEngines.of(otherWallet.accountId)).toHaveLength(1);
    });

    it('fails a restart after a reset at the bound, not before, telling its clients and letting a resync and other accounts carry on', async () => {
      const { host } = createHost();
      const clone = vi.spyOn(ByteArray, 'clone');
      await attachTo(host)('tab-1', a);
      const copies = clone.mock.results.map(({ value }) => value as Uint8Array);
      await attachTo(host)('tab-2', c);
      const statuses: MidnightSessionStatus[] = [];
      host
        .streams({ clientId: 'tab-1', accountId: a.accountId })
        .status$.subscribe(status => statuses.push(status));
      useFakeClock();
      fakeEngines.hold = new Promise(() => undefined);
      const reset = tracked(
        host.resetAccount({
          clientId: 'tab-1',
          accountId: a.accountId,
          storage: 'memory',
        }),
      );
      await until(() => fakeEngines.of(a.accountId).length === 2);
      fakeEngines.hold = undefined;
      const hung = fakeEngines.current(a.accountId);
      const resync = tracked(
        host.resyncAll({ clientId: 'tab-2', storage: 'memory' }),
      );
      const detaching = tracked(
        host.detach({ clientId: 'tab-2', accountId: c.accountId }),
      );

      await vi.advanceTimersByTimeAsync(START_BOUND_MS - 1);
      await flush();
      const settledBeforeBound = [reset, resync, detaching].map(
        ({ isSettled }) => isSettled,
      );
      await vi.advanceTimersByTimeAsync(1);
      await flush();

      expect(settledBeforeBound).toEqual([false, false, false]);
      expect(
        [reset, resync, detaching].map(({ isSettled }) => isSettled),
      ).toEqual([true, true, true]);
      await expect(reset.call).rejects.toThrow(
        `did not start within ${START_BOUND_MS} ms`,
      );
      await resync.call;
      await detaching.call;
      expect(hung.tornDown).toBe(true);
      expect(statuses).toContainEqual({
        resets: 1,
        failure: `The Midnight engine of ${a.accountId} did not start within ${START_BOUND_MS} ms`,
      });
      // The resync restarted the engine for the client that stayed; its tab closing now releases the keys.
      const { keyManager } = fakeEngines.current(a.accountId).params;
      const destroy = vi.spyOn(keyManager, 'destroy');
      vi.useRealTimers();
      await host.detachClient('tab-1');
      expect(destroy).toHaveBeenCalledOnce();
      expect(copies.every(isZeroed)).toBe(true);
    });
  });

  describe('wallet deletion', () => {
    it('only detaches the client while another client uses the wallet engines', async () => {
      const { host, stores } = createHost();
      await attachTo(host)('tab-1', a);
      await attachTo(host)('tab-1', b);
      await attachTo(host)('tab-2', b);
      stores.get('memory')!.documents.set(String(a.accountId), checkpoint(a));

      await host.deleteWallet({
        clientId: 'tab-1',
        walletId: a.walletId,
        storage: 'memory',
      });

      expect(stores.get('memory')!.documents.size).toBe(1);
      expect(fakeEngines.current(b.accountId).tornDown).toBe(false);
      await expect(
        reasonOf(
          host.signData({
            clientId: 'tab-1',
            accountId: b.accountId,
            data: new Uint8Array([1]),
          }),
        ),
      ).resolves.toBe('not-attached');
    });

    it('stops the wallet engines and then wipes every checkpoint of the wallet when the client was the last', async () => {
      const { host, stores } = createHost();
      await attachTo(host)('tab-1', a);
      await attachTo(host)('tab-2', c);
      const { documents } = stores.get('memory')!;
      for (const account of [a, b, c])
        documents.set(String(account.accountId), checkpoint(account));
      events.length = 0;

      await host.deleteWallet({
        clientId: 'tab-1',
        walletId: a.walletId,
        storage: 'memory',
      });

      expect(events).toEqual([`stop:${a.accountId}`, 'memory:removeWhere']);
      expect([...documents.keys()]).toEqual([String(c.accountId)]);
      expect(fakeEngines.current(a.accountId).tornDown).toBe(true);
      expect(fakeEngines.current(c.accountId).tornDown).toBe(false);
    });

    it('stops the engines of the wallet even when the wipe fails', async () => {
      const { host, stores } = createHost();
      await attachTo(host)('tab-1', a);
      vi.spyOn(stores.get('memory')!.store, 'removeWhere').mockReturnValue(
        throwError(() => new Error('disk full')),
      );

      await host.deleteWallet({
        clientId: 'tab-1',
        walletId: a.walletId,
        storage: 'memory',
      });

      expect(fakeEngines.current(a.accountId).tornDown).toBe(true);
    });

    it('wipes the checkpoints of a wallet whose engines do not run here', async () => {
      const { host, stores } = createHost();
      await attachTo(host)('tab-1', c);
      stores.get('memory')!.documents.set(String(a.accountId), checkpoint(a));

      await host.deleteWallet({
        clientId: 'tab-1',
        walletId: a.walletId,
        storage: 'memory',
        authority: authorityOver(a),
      });

      expect(stores.get('memory')!.documents.size).toBe(0);
    });

    it('wipes every store in use when the clients of two stores delete the wallet one after the other', async () => {
      const { host, stores } = createHost();
      await attachTo(host)('tab-1', a, 'indexeddb');
      await attachTo(host)('tab-2', b, 'memory');
      stores
        .get('indexeddb')!
        .documents.set(String(a.accountId), checkpoint(a));
      stores.get('memory')!.documents.set(String(b.accountId), checkpoint(b));

      await host.deleteWallet({
        clientId: 'tab-1',
        walletId: a.walletId,
        storage: 'indexeddb',
      });
      expect(stores.get('indexeddb')!.documents.size).toBe(1);
      await host.deleteWallet({
        clientId: 'tab-2',
        walletId: a.walletId,
        storage: 'memory',
      });

      expect(stores.get('indexeddb')!.documents.size).toBe(0);
      expect(stores.get('memory')!.documents.size).toBe(0);
    });

    it('only detaches the client when another client was checking its password for a wallet account as the deletion started', async () => {
      const { host, stores } = createHost();
      await attachTo(host)('tab-1', a);
      const { documents } = stores.get('memory')!;
      for (const account of [a, b])
        documents.set(String(account.accountId), checkpoint(account));
      const derivation = holdKeyDerivation();
      const attaching = attachTo(host)('tab-2', b);
      await derivation.entered;

      const deletion = host.deleteWallet({
        clientId: 'tab-1',
        walletId: a.walletId,
        storage: 'memory',
      });
      derivation.release();

      await expect(
        settlesWithin(Promise.all([attaching, deletion])),
      ).resolves.toBe(true);
      expect([...documents.keys()].sort()).toEqual(
        [a, b].map(({ accountId }) => String(accountId)).sort(),
      );
      expect(fakeEngines.current(a.accountId).tornDown).toBe(true);
      expect(fakeEngines.current(b.accountId).tornDown).toBe(false);
    });

    it('releases the keys before waiting for the stop, and wipes once a stop that is never acknowledged reaches the bound', async () => {
      const { host, stores } = createHost();
      const clone = vi.spyOn(ByteArray, 'clone');
      await attachTo(host)('tab-1', a);
      const copies = clone.mock.results.map(({ value }) => value as Uint8Array);
      await attachTo(host)('tab-2', c);
      const { documents } = stores.get('memory')!;
      documents.set(String(a.accountId), checkpoint(a));
      const deleted = fakeEngines.current(a.accountId);
      const destroy = vi.spyOn(deleted.params.keyManager, 'destroy');
      acknowledgeStopWith(deleted, NEVER);
      const isCopyLiveBefore = copies.some(copy => !isZeroed(copy));
      useFakeClock();
      events.length = 0;

      const deletion = tracked(
        host.deleteWallet({
          clientId: 'tab-1',
          walletId: a.walletId,
          storage: 'memory',
        }),
      );
      await flush();
      const isDestroyedWhileWaiting = destroy.mock.calls.length > 0;
      const areCopiesZeroedWhileWaiting = copies.every(isZeroed);
      await vi.advanceTimersByTimeAsync(STOP_BOUND_MS - 1);
      await flush();
      const isSettledBeforeBound = deletion.isSettled;
      const eventsBeforeBound = [...events];
      await vi.advanceTimersByTimeAsync(1);
      await flush();

      expect(isCopyLiveBefore).toBe(true);
      expect(isDestroyedWhileWaiting).toBe(true);
      expect(areCopiesZeroedWhileWaiting).toBe(true);
      expect(isSettledBeforeBound).toBe(false);
      expect(eventsBeforeBound).toEqual([`stop:${a.accountId}`]);
      expect(deletion.isSettled).toBe(true);
      await deletion.call;
      expect(events).toEqual([`stop:${a.accountId}`, 'memory:removeWhere']);
      expect(documents.size).toBe(0);
      expect(fakeEngines.current(c.accountId).stopped).toBe(false);
    });

    describe('of a wallet whose engine drains a submission', () => {
      const drainingWallet = async () => {
        const { host, stores } = createHost();
        await attachTo(host)('tab-1', a);
        await attachTo(host)('tab-2', otherWallet);
        const { documents } = stores.get('memory')!;
        for (const account of [a, b, otherWallet])
          documents.set(String(account.accountId), checkpoint(account));
        const unsettled = submitUnsettled(host, 'tab-1', a);
        events.length = 0;
        return { host, documents, ...unsettled };
      };

      it('refuses an unrelated client, leaving the submission to settle normally and the checkpoints in place', async () => {
        const { host, documents, draining, submission, settle } =
          await drainingWallet();
        await host.detachClient('tab-1');

        const reason = await reasonOf(
          host.deleteWallet({
            clientId: 'tab-2',
            walletId: a.walletId,
            storage: 'memory',
          }),
        );
        const isStoppedAfterRefusal = draining.stopped;
        settle();

        expect(reason).toBe('not-attached');
        expect(isStoppedAfterRefusal).toBe(false);
        await expect(submission.call).resolves.toEqual({ txId: 'tx-hash' });
        await vi.waitFor(() => {
          expect(draining.tornDown).toBe(true);
        });
        expect(documents.size).toBe(3);
        expect(events).not.toContain('memory:removeWhere');
      });

      it('wipes the draining account only once the submission settles when the wallet is deleted with its password', async () => {
        const { host, documents, draining, submission, settle } =
          await drainingWallet();
        await host.detachClient('tab-1');

        await host.deleteWallet({
          clientId: 'tab-2',
          walletId: a.walletId,
          storage: 'memory',
          authority: authorityOver(a),
        });
        await flush();
        const eventsWhileUnsettled = [...events];
        const documentsWhileUnsettled = [...documents.keys()].sort();
        const isSettledBeforeFinality = submission.isSettled;
        settle();

        expect(eventsWhileUnsettled).toEqual(['memory:removeWhere']);
        expect(documentsWhileUnsettled).toEqual(
          [a, otherWallet].map(({ accountId }) => String(accountId)).sort(),
        );
        expect(isSettledBeforeFinality).toBe(false);
        await expect(submission.call).resolves.toEqual({ txId: 'tx-hash' });
        await vi.waitFor(() => {
          expect([...documents.keys()]).toEqual([
            String(otherWallet.accountId),
          ]);
        });
        expect(events).toEqual([
          'memory:removeWhere',
          `stop:${a.accountId}`,
          'memory:removeWhere',
        ]);
        expect(draining.tornDown).toBe(true);
      });

      it('wipes the other accounts of the wallet at once, so a worker that ends before the submission settles keeps only the draining checkpoint', async () => {
        const { host, stores } = createHost();
        await attachTo(host)('tab-1', a);
        await attachTo(host)('tab-1', b);
        await attachTo(host)('tab-2', otherWallet);
        const { documents } = stores.get('memory')!;
        for (const account of [a, b, otherWallet])
          documents.set(String(account.accountId), checkpoint(account));
        const { draining, submission } = submitUnsettled(host, 'tab-1', a);
        const idle = fakeEngines.current(b.accountId);
        events.length = 0;

        await host.deleteWallet({
          clientId: 'tab-1',
          walletId: a.walletId,
          storage: 'memory',
        });

        // The worker ends here, before the submission settles.
        expect([...documents.keys()].sort()).toEqual(
          [a, otherWallet].map(({ accountId }) => String(accountId)).sort(),
        );
        expect(events).toEqual([`stop:${b.accountId}`, 'memory:removeWhere']);
        expect(idle.tornDown).toBe(true);
        expect(draining.stopped).toBe(false);
        expect(submission.isSettled).toBe(false);
      });

      it('wipes every store that repeated deletions named, while draining accounts of the wallet settle one by one', async () => {
        const { host, stores } = createHost();
        await attachTo(host)('tab-1', a, 'indexeddb');
        await attachTo(host)('tab-1', b, 'memory');
        const indexedDb = stores.get('indexeddb')!.documents;
        const memory = stores.get('memory')!.documents;
        indexedDb.set(String(a.accountId), checkpoint(a));
        memory.set(String(b.accountId), checkpoint(b));
        const first = submitUnsettled(host, 'tab-1', a);
        const second = submitUnsettled(host, 'tab-1', b);
        await host.deleteWallet({
          clientId: 'tab-1',
          walletId: a.walletId,
          storage: 'memory',
        });
        first.settle();
        await expect(first.submission.call).resolves.toEqual({
          txId: 'tx-hash',
        });
        await vi.waitFor(() => {
          expect(first.draining.tornDown).toBe(true);
        });

        await host.deleteWallet({
          clientId: 'tab-2',
          walletId: a.walletId,
          storage: 'memory',
          authority: authorityOver(b),
        });
        const afterRepeat = [...indexedDb.keys()];
        second.settle();

        await expect(second.submission.call).resolves.toEqual({
          txId: 'tx-hash',
        });
        await vi.waitFor(() => {
          expect(memory.size).toBe(0);
        });
        expect({ afterRepeat, atEnd: [...indexedDb.keys()] }).toEqual({
          afterRepeat: [],
          atEnd: [],
        });
      });

      it('detaches the deleting client at once and wipes the draining account once the submission settles', async () => {
        const { host, documents, draining, submission, settle } =
          await drainingWallet();

        await host.deleteWallet({
          clientId: 'tab-1',
          walletId: a.walletId,
          storage: 'memory',
        });
        const reasonAfterDeletion = await reasonOf(
          host.signData({
            clientId: 'tab-1',
            accountId: a.accountId,
            data: new Uint8Array([1]),
          }),
        );
        const eventsWhileUnsettled = [...events];
        settle();

        expect(reasonAfterDeletion).toBe('not-attached');
        expect(eventsWhileUnsettled).toEqual(['memory:removeWhere']);
        await expect(submission.call).resolves.toEqual({ txId: 'tx-hash' });
        await vi.waitFor(() => {
          expect([...documents.keys()]).toEqual([
            String(otherWallet.accountId),
          ]);
        });
        expect(draining.tornDown).toBe(true);
      });

      it('keeps the draining checkpoint when a client attaches to another account of the wallet before the submission settles, also once the submission of that client settles after it left', async () => {
        const { host, documents, draining, submission, settle } =
          await drainingWallet();
        await host.deleteWallet({
          clientId: 'tab-1',
          walletId: a.walletId,
          storage: 'memory',
        });
        events.length = 0;

        await attachTo(host)('tab-3', b);
        settle();
        await expect(submission.call).resolves.toEqual({ txId: 'tx-hash' });
        await vi.waitFor(() => {
          expect(draining.tornDown).toBe(true);
        });
        const later = submitUnsettled(host, 'tab-3', b);
        await host.detachClient('tab-3');
        later.settle();

        await expect(later.submission.call).resolves.toEqual({
          txId: 'tx-hash',
        });
        await vi.waitFor(() => {
          expect(later.draining.tornDown).toBe(true);
        });
        await flush();
        expect(draining.stopped).toBe(false);
        expect([...documents.keys()].sort()).toEqual(
          [a, otherWallet].map(({ accountId }) => String(accountId)).sort(),
        );
        expect(events).not.toContain('memory:removeWhere');
      });

      it('keeps the draining checkpoint when a client attaches to the draining account before the submission settles, also once its own submission settles after it left', async () => {
        const { host, documents, draining, submission, settle } =
          await drainingWallet();
        await host.deleteWallet({
          clientId: 'tab-1',
          walletId: a.walletId,
          storage: 'memory',
        });
        events.length = 0;

        await attachTo(host)('tab-3', a);
        settle();
        await expect(submission.call).resolves.toEqual({ txId: 'tx-hash' });
        const later = submitUnsettled(host, 'tab-3', a);
        await host.detachClient('tab-3');
        later.settle();

        await expect(later.submission.call).resolves.toEqual({
          txId: 'tx-hash',
        });
        await vi.waitFor(() => {
          expect(draining.tornDown).toBe(true);
        });
        await flush();
        expect([...documents.keys()].sort()).toEqual(
          [a, otherWallet].map(({ accountId }) => String(accountId)).sort(),
        );
        expect(events).not.toContain('memory:removeWhere');
      });
    });
  });

  describe('authority', () => {
    const attacker = new TextEncoder().encode('not the owner');
    const running = async () => {
      const { host, stores } = createHost();
      await attachTo(host)('tab-1', a);
      await attachTo(host)('tab-2', otherWallet);
      const { documents } = stores.get('memory')!;
      for (const account of [a, b, otherWallet])
        documents.set(String(account.accountId), checkpoint(account));
      events.length = 0;
      return { host, documents };
    };
    const tryEach = async (
      host: MidnightEngineHost,
      clientId: string,
      authority: () => ReturnType<typeof authorityOver> | undefined,
    ) =>
      Promise.all(
        [
          host.resetAccount({
            clientId,
            accountId: a.accountId,
            storage: 'memory',
            authority: authority(),
          }),
          host.resyncAll({
            clientId,
            storage: 'memory',
            authority: authority(),
          }),
          host.deleteWallet({
            clientId,
            walletId: a.walletId,
            storage: 'memory',
            authority: authority(),
          }),
        ].map(reasonOf),
      );

    it('refuses reset, resync and deletion to a client that never attached, stopping and wiping nothing', async () => {
      const { host, documents } = await running();

      const reasons = await tryEach(host, 'tab-9', () => undefined);

      expect(reasons).toEqual(['not-attached', 'not-attached', 'not-attached']);
      expect(events).toEqual([]);
      expect(documents.size).toBe(3);
    });

    it('refuses reset, resync and deletion with the password an attach was refused for, stopping and wiping nothing', async () => {
      const { host, documents } = await running();
      const refused = await reasonOf(
        host.attach({
          clientId: 'tab-8',
          account: a,
          password: WRONG_PASSWORD.slice(),
          settings: settings(),
        }),
      );

      const reasons = await tryEach(host, 'tab-8', () =>
        authorityOver(a, WRONG_PASSWORD),
      );

      expect(refused).toBe('wrong-password');
      expect(reasons).toEqual([
        'wrong-password',
        'wrong-password',
        'wrong-password',
      ]);
      expect(events).toEqual([]);
      expect(documents.size).toBe(3);
    });

    it('refuses reset and deletion to a client of another wallet, even with the password of its own account, stopping and wiping nothing', async () => {
      const { host, documents } = await running();

      const reasons = await Promise.all(
        [
          host.resetAccount({
            clientId: 'tab-2',
            accountId: a.accountId,
            storage: 'memory',
            authority: authorityOver(otherWallet),
          }),
          host.deleteWallet({
            clientId: 'tab-2',
            walletId: a.walletId,
            storage: 'memory',
            authority: authorityOver(otherWallet),
          }),
        ].map(reasonOf),
      );

      expect(reasons).toEqual(['not-attached', 'not-attached']);
      expect(events).toEqual([]);
      expect(documents.size).toBe(3);
    });

    it('refuses account data that the running engines do not hold, sealed under another password, stopping and wiping nothing', async () => {
      const { host, documents } = await running();
      // Same ids as the running account a and the stored account b, sealed under a password the owner never used.
      const forgedA = await sealedAccount({
        walletId: 'wallet-a',
        password: attacker,
      });
      const forgedB = await sealedAccount({
        walletId: 'wallet-a',
        accountIndex: 1,
        network: MidnightSDKNetworkIds.Preview,
        password: attacker,
      });

      const reasons = await Promise.all(
        [
          host.resetAccount({
            clientId: 'tab-9',
            accountId: a.accountId,
            storage: 'memory',
            authority: authorityOver(forgedA, attacker),
          }),
          host.resyncAll({
            clientId: 'tab-9',
            storage: 'memory',
            authority: authorityOver(forgedB, attacker),
          }),
          host.deleteWallet({
            clientId: 'tab-9',
            walletId: a.walletId,
            storage: 'memory',
            authority: authorityOver(forgedB, attacker),
          }),
        ].map(reasonOf),
      );

      expect(reasons).toEqual([
        'wrong-password',
        'not-attached',
        'not-attached',
      ]);
      expect(events).toEqual([]);
      expect(documents.size).toBe(3);
    });

    it('refuses reset, resync and deletion where no engine runs to a client without authority over their scope, wiping nothing', async () => {
      const { host, stores } = createHost();
      // Creates the store, then leaves the host with no engine.
      await attachTo(host)('tab-0', otherWallet);
      await host.detach({
        clientId: 'tab-0',
        accountId: otherWallet.accountId,
      });
      const { documents } = stores.get('memory')!;
      for (const account of [a, b, otherWallet])
        documents.set(String(account.accountId), checkpoint(account));
      events.length = 0;
      type Authority = ReturnType<typeof authorityOver> | undefined;
      const reset = async (authority: Authority) =>
        reasonOf(
          host.resetAccount({
            clientId: 'tab-9',
            accountId: a.accountId,
            storage: 'memory',
            authority,
          }),
        );
      const resync = async (authority: Authority) =>
        reasonOf(
          host.resyncAll({ clientId: 'tab-9', storage: 'memory', authority }),
        );
      const deletion = async (authority: Authority) =>
        reasonOf(
          host.deleteWallet({
            clientId: 'tab-9',
            walletId: a.walletId,
            storage: 'memory',
            authority,
          }),
        );

      const reasons = {
        withoutAuthority: [
          await reset(undefined),
          await resync(undefined),
          await deletion(undefined),
        ],
        outOfScope: [
          await reset(authorityOver(b)),
          await deletion(authorityOver(otherWallet)),
        ],
        wrongPassword: [
          await reset(authorityOver(a, WRONG_PASSWORD)),
          await resync(authorityOver(a, WRONG_PASSWORD)),
          await deletion(authorityOver(a, WRONG_PASSWORD)),
        ],
      };

      expect(reasons).toEqual({
        withoutAuthority: ['not-attached', 'not-attached', 'not-attached'],
        outOfScope: ['not-attached', 'not-attached'],
        wrongPassword: ['wrong-password', 'wrong-password', 'wrong-password'],
      });
      expect(events).toEqual([]);
      expect(documents.size).toBe(3);
    });

    it('accepts the password of a running account from a client attached to none of its engines', async () => {
      const { host, documents } = await running();

      await host.resetAccount({
        clientId: 'tab-9',
        accountId: a.accountId,
        storage: 'memory',
        authority: authorityOver(a),
      });

      expect(events).toEqual([
        `stop:${a.accountId}`,
        'memory:removeWhere',
        `start:${a.accountId}`,
      ]);
      expect(documents.has(String(a.accountId))).toBe(false);
    });

    it('zeroes the password it was given once the storage operation settles, refused or not', async () => {
      const { host } = await running();
      const given = [
        authorityOver(a),
        authorityOver(a, WRONG_PASSWORD),
        authorityOver(a, WRONG_PASSWORD),
        authorityOver(a, WRONG_PASSWORD),
      ];

      await host.resetAccount({
        clientId: 'tab-9',
        accountId: a.accountId,
        storage: 'memory',
        authority: given[0],
      });
      await reasonOf(
        host.resetAccount({
          clientId: 'tab-9',
          accountId: a.accountId,
          storage: 'memory',
          authority: given[1],
        }),
      );
      await reasonOf(
        host.resyncAll({
          clientId: 'tab-9',
          storage: 'memory',
          authority: given[2],
        }),
      );
      await reasonOf(
        host.deleteWallet({
          clientId: 'tab-9',
          walletId: a.walletId,
          storage: 'memory',
          authority: given[3],
        }),
      );

      expect(given.map(({ password }) => isZeroed(password))).toEqual([
        true,
        true,
        true,
        true,
      ]);
    });
  });

  it('creates each storage kind once and hands every engine the store of its kind', async () => {
    const { host, stores, createStore } = createHost();

    await attachTo(host)('tab-1', a, 'indexeddb');
    await attachTo(host)('tab-1', b, 'memory');
    await attachTo(host)('tab-2', c, 'memory');

    expect(createStore.mock.calls).toEqual([['indexeddb'], ['memory']]);
    expect(fakeEngines.started.map(({ params }) => params.store)).toEqual([
      stores.get('indexeddb')!.store,
      stores.get('memory')!.store,
      stores.get('memory')!.store,
    ]);
  });

  it('imports no other module, directly or through the files it imports (ADR 14)', () => {
    const source = resolve(__dirname, '../../src');
    const seen = new Set<string>();
    const specifiers = new Set<string>();
    const visit = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const text = readFileSync(file, 'utf8');
      for (const [, specifier] of text.matchAll(
        /(?:from|import)\s*\(?\s*'([^']+)'/g,
      )) {
        specifiers.add(specifier);
        if (specifier.startsWith('.'))
          visit(`${join(dirname(file), specifier)}.ts`);
      }
    };

    visit(join(source, 'worker/engine-host.ts'));

    expect(seen.size).toBeGreaterThan(10);
    expect(
      [...specifiers].filter(specifier =>
        specifier.startsWith('@lace-module/'),
      ),
    ).toEqual([]);
  });
});
