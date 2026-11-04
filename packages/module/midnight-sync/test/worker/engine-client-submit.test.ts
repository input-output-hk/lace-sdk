import {
  firstValueFrom,
  NEVER,
  of,
  Subject,
  switchMap,
  throwError,
} from 'rxjs';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { encodeMidnightFinalizedTx } from '../../src/worker/codec';
import { MidnightWorkerError } from '../../src/worker/protocol';

import {
  createClient,
  createFakeWorkers,
  flush,
  startParams,
  until,
} from './engine-client-fakes';
import {
  fakeEngines,
  finalized,
  sealedAccount,
  useFastKeyDerivation,
} from './engine-host-fakes';

import type { OpaqueMidnightFinalizedTx } from '../../src/worker/codec';
import type {
  MidnightPendingRow,
  MidnightRemoteEngineClient,
} from '../../src/worker/engine-client';
import type { Activity } from '@lace-contract/activities';
import type { MidnightAccountProps } from '@lace-contract/midnight-context';
import type { InMemoryWalletAccount } from '@lace-contract/wallet-repo';
import type { Subscription } from 'rxjs';

vi.mock('../../src/store/dependencies', async importOriginal => {
  const fakes = await import('./engine-host-fakes');
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    createStartMidnightAccountWallet: fakes.fakeEngines.createStart,
  };
});

type Account = InMemoryWalletAccount<MidnightAccountProps>;

const pendingActivity = { activityId: 'pending-hash' } as Activity;
const PENDING_ROW_TIMEOUT_MS = 10_000;

// The outcome of a submission, as a caller that waits from the post reads it.
const submitted = (
  engine: MidnightRemoteEngineClient,
  transaction: OpaqueMidnightFinalizedTx,
  pendingRow?: MidnightPendingRow,
) =>
  engine
    .submit(transaction, {
      pendingRow,
      pendingRowTimeout: PENDING_ROW_TIMEOUT_MS,
    })
    .pipe(switchMap(outcome$ => outcome$));

// setImmediate stays real, so that `until` and `flush` let promise steps run while the clock stands still.
const useFakeClock = () =>
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
  });

describe('test:engine-client-submit', () => {
  let a: Account;
  let subscription: Subscription | undefined;

  beforeAll(async () => {
    useFastKeyDerivation();
    a = await sealedAccount({ walletId: 'wallet-a' });
  });
  beforeEach(() => {
    fakeEngines.reset();
    useFastKeyDerivation();
  });
  afterEach(() => {
    subscription?.unsubscribe();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const attached = async () => {
    const workers = createFakeWorkers();
    workers.worker.derivePendingActivity.mockReturnValue(pendingActivity);
    const client = createClient(workers);
    const engines: MidnightRemoteEngineClient[] = [];
    const watcher = { errors: 0, completions: 0 };
    subscription = client.startAccountEngine(startParams(a)).subscribe({
      next: engine => engines.push(engine),
      error: () => {
        watcher.errors += 1;
      },
      complete: () => {
        watcher.completions += 1;
      },
    });
    await until(() => engines.length === 1);
    const [engine] = engines;
    const transaction = encodeMidnightFinalizedTx(finalized(), {
      accountId: engine.accountId,
      engineGeneration: engine.engineGeneration!,
    });
    const row = { record: vi.fn(), remove: vi.fn() };
    const callsOf = (method: string) =>
      workers.connections[0].calls.filter(call => call.method === method);
    const submitCalls = () => callsOf('submit');
    // A reset whose replacement engine does not start until `release`, so that no engine runs meanwhile.
    const holdEngineAfterReset = async () => {
      let release!: () => void;
      fakeEngines.hold = new Promise(resolve => {
        release = resolve;
      });
      void firstValueFrom(client.resetAccount(a)).catch(() => undefined);
      await until(() => fakeEngines.of(a.accountId).length === 2);
      return release;
    };
    return {
      workers,
      engines,
      watcher,
      engine,
      transaction,
      row,
      callsOf,
      submitCalls,
      holdEngineAfterReset,
    };
  };

  it('records the Pending row the worker derived before it posts the submission once, and resolves at finality', async () => {
    const { engine, transaction, row, submitCalls } = await attached();
    const order: string[] = [];
    row.record.mockImplementation(() => order.push('record'));
    const fake = fakeEngines.current(a.accountId);
    vi.mocked(fake.engine.submitTransaction).mockImplementation(() => {
      order.push('submit');
      return of('engine-tx-id');
    });

    const result = await firstValueFrom(submitted(engine, transaction, row));

    expect(result).toEqual({ txId: 'engine-tx-id' });
    expect(row.record).toHaveBeenCalledWith(pendingActivity);
    expect(row.remove).not.toHaveBeenCalled();
    expect(order).toEqual(['record', 'submit']);
    expect(submitCalls()).toHaveLength(1);
  });

  it('hands over the outcome only once the submission is posted', async () => {
    const { engine, transaction, row, submitCalls } = await attached();
    vi.mocked(
      fakeEngines.current(a.accountId).engine.submitTransaction,
    ).mockReturnValue(NEVER);
    const postsWhenHandedOver: number[] = [];

    subscription?.add(
      engine
        .submit(transaction, {
          pendingRow: row,
          pendingRowTimeout: PENDING_ROW_TIMEOUT_MS,
        })
        .subscribe(() => postsWhenHandedOver.push(submitCalls().length)),
    );
    await until(() => postsWhenHandedOver.length === 1);

    expect(postsWhenHandedOver).toEqual([1]);
  });

  it('derives no Pending activity without a row, as page mode does', async () => {
    const { engine, transaction, callsOf } = await attached();

    const { txId } = await firstValueFrom(submitted(engine, transaction));

    expect(typeof txId).toBe('string');
    expect(callsOf('preparePendingActivity')).toHaveLength(0);
    expect(callsOf('submit')).toHaveLength(1);
  });

  it('posts the submission without a row once the derivation outlasts its bound, and ignores a late activity', async () => {
    const { workers, engine, transaction, row, submitCalls } = await attached();
    let derive!: (activity: Activity) => void;
    vi.spyOn(
      workers.connections[0].host,
      'preparePendingActivity',
    ).mockReturnValue(
      new Promise(resolve => {
        derive = resolve;
      }),
    );
    useFakeClock();

    const submitting = firstValueFrom(submitted(engine, transaction, row));
    await vi.advanceTimersByTimeAsync(PENDING_ROW_TIMEOUT_MS - 1);
    const postsBeforeTheBound = submitCalls().length;
    await vi.advanceTimersByTimeAsync(1);
    await until(() => submitCalls().length === 1);
    derive(pendingActivity);
    await flush();

    expect(postsBeforeTheBound).toBe(0);
    await expect(submitting).resolves.toMatchObject({
      txId: expect.any(String) as unknown,
    });
    expect(row.record).not.toHaveBeenCalled();
  });

  it('posts the submission without a row when the engine state never emits', async () => {
    fakeEngines.withholdValues = true;
    const { engine, transaction, row, callsOf, submitCalls } = await attached();
    useFakeClock();

    const submitting = firstValueFrom(submitted(engine, transaction, row));
    await until(() => callsOf('preparePendingActivity').length === 1);
    await vi.advanceTimersByTimeAsync(PENDING_ROW_TIMEOUT_MS);
    await until(() => submitCalls().length === 1);

    await expect(submitting).resolves.toMatchObject({
      txId: expect.any(String) as unknown,
    });
    expect(row.record).not.toHaveBeenCalled();
  });

  it('fails with submit-interrupted when the worker dies after the post, keeping the row and never posting again', async () => {
    const { workers, engine, transaction, row, submitCalls } = await attached();
    vi.mocked(
      fakeEngines.current(a.accountId).engine.submitTransaction,
    ).mockReturnValue(NEVER);

    const submitting = firstValueFrom(submitted(engine, transaction, row));
    await until(() => submitCalls().length === 1);
    workers.kill();

    await expect(submitting).rejects.toMatchObject({
      reason: 'submit-interrupted',
      accountId: a.accountId,
    });
    expect(row.record).toHaveBeenCalledOnce();
    expect(row.remove).not.toHaveBeenCalled();
    expect(
      workers.connections.flatMap(({ calls }) =>
        calls.filter(({ method }) => method === 'submit'),
      ),
    ).toHaveLength(1);
  });

  it('fails with submit-interrupted, keeping the row, when the worker replaces the engine after the post', async () => {
    const { workers, engine, transaction, row } = await attached();
    vi.spyOn(workers.connections[0].host, 'submit').mockRejectedValue(
      new MidnightWorkerError('engine-replaced', 'replaced'),
    );

    await expect(
      firstValueFrom(submitted(engine, transaction, row)),
    ).rejects.toMatchObject({ reason: 'submit-interrupted' });
    expect(row.remove).not.toHaveBeenCalled();
  });

  it('removes the row and fails with stale-value, saying nothing was broadcast, when no engine runs to take the posted submission', async () => {
    const { workers, engine, transaction, row, submitCalls, ...tab } =
      await attached();
    let derive!: (activity: Activity) => void;
    vi.spyOn(
      workers.connections[0].host,
      'preparePendingActivity',
    ).mockReturnValue(
      new Promise(resolve => {
        derive = resolve;
      }),
    );
    const [stopped] = fakeEngines.of(a.accountId);

    const submitting = firstValueFrom(submitted(engine, transaction, row));
    const release = await tab.holdEngineAfterReset();
    derive(pendingActivity);
    const refusal = await submitting.catch((error: unknown) => error);
    release();

    expect(refusal).toMatchObject({
      reason: 'stale-value',
      message: expect.stringContaining('nothing was broadcast') as string,
      cause: { reason: 'not-running' },
    });
    expect(submitCalls()).toHaveLength(1);
    expect(row.record).toHaveBeenCalledWith(pendingActivity);
    expect(row.remove).toHaveBeenCalledWith(pendingActivity);
    expect(stopped.engine.submitTransaction).not.toHaveBeenCalled();
  });

  it('fails with stale-value and records no row when no engine runs to take the derivation', async () => {
    const { engine, transaction, row, submitCalls, ...tab } = await attached();
    const release = await tab.holdEngineAfterReset();

    const refusal = await firstValueFrom(
      submitted(engine, transaction, row),
    ).catch((error: unknown) => error);
    release();

    expect(refusal).toMatchObject({
      reason: 'stale-value',
      cause: { reason: 'not-running' },
    });
    expect(submitCalls()).toHaveLength(0);
    expect(row.record).not.toHaveBeenCalled();
  });

  it('removes the row when the live worker reports a definitive failure', async () => {
    const { engine, transaction, row } = await attached();
    vi.mocked(
      fakeEngines.current(a.accountId).engine.submitTransaction,
    ).mockReturnValue(throwError(() => new Error('rejected by the node')));

    await expect(
      firstValueFrom(submitted(engine, transaction, row)),
    ).rejects.toMatchObject({ message: 'rejected by the node' });
    expect(row.record).toHaveBeenCalledOnce();
    expect(row.remove).toHaveBeenCalledWith(pendingActivity);
  });

  it('removes the row when the worker refuses the submission before broadcasting it', async () => {
    const { workers, engine, transaction, row } = await attached();
    vi.spyOn(workers.connections[0].host, 'submit').mockRejectedValue(
      new MidnightWorkerError('reset-pending', 'a reset waits'),
    );

    await expect(
      firstValueFrom(submitted(engine, transaction, row)),
    ).rejects.toMatchObject({ reason: 'reset-pending' });
    expect(row.remove).toHaveBeenCalledWith(pendingActivity);
  });

  it('removes the row when the submission fails after the caller stopped waiting, and replays the failure', async () => {
    const { workers, engine, transaction, row } = await attached();
    let refuse!: (error: Error) => void;
    vi.spyOn(workers.connections[0].host, 'submit').mockReturnValue(
      new Promise((_, reject) => {
        refuse = reject;
      }),
    );
    const outcome$ = await firstValueFrom(
      engine.submit(transaction, {
        pendingRow: row,
        pendingRowTimeout: PENDING_ROW_TIMEOUT_MS,
      }),
    );

    refuse(new Error('rejected by the node'));
    await flush();

    expect(row.remove).toHaveBeenCalledWith(pendingActivity);
    await expect(firstValueFrom(outcome$)).rejects.toMatchObject({
      message: 'rejected by the node',
    });
  });

  it('fails with runtime-stopped and removes the row when the worker dies before the post', async () => {
    const { workers, engine, transaction, row, submitCalls } = await attached();
    row.record.mockImplementation(() => {
      workers.kill();
    });

    await expect(
      firstValueFrom(submitted(engine, transaction, row)),
    ).rejects.toMatchObject({ reason: 'runtime-stopped' });
    expect(row.remove).toHaveBeenCalledWith(pendingActivity);
    expect(submitCalls()).toHaveLength(0);
  });

  it('fails with runtime-stopped and records no row when the worker dies while it derives the row', async () => {
    const { workers, engine, transaction, row, submitCalls } = await attached();
    const held = new Subject<never>();
    vi.spyOn(
      workers.connections[0].host,
      'preparePendingActivity',
    ).mockReturnValue(firstValueFrom(held));

    const submitting = firstValueFrom(submitted(engine, transaction, row));
    workers.kill();
    held.error(new Error('RemoteApiShutdownError'));

    await expect(submitting).rejects.toMatchObject({
      reason: 'runtime-stopped',
    });
    expect(row.record).not.toHaveBeenCalled();
    expect(submitCalls()).toHaveLength(0);
  });

  it('submits without a row when the worker cannot derive one', async () => {
    const { workers, engine, transaction, row } = await attached();
    workers.worker.derivePendingActivity.mockReturnValue(undefined);

    const { txId } = await firstValueFrom(submitted(engine, transaction, row));

    expect(typeof txId).toBe('string');
    expect(row.record).not.toHaveBeenCalled();
  });

  it('keeps an engine that fails while a submission of it settles, without attaching again, and follows its replacement once the submission settles', async () => {
    const { engine, engines, watcher, transaction, row, callsOf, submitCalls } =
      await attached();
    const failing = fakeEngines.current(a.accountId);
    const finality = new Subject<string>();
    vi.mocked(failing.engine.submitTransaction).mockReturnValue(finality);
    const addresses: unknown[] = [];
    const ends: string[] = [];
    subscription?.add(
      engine.address$.subscribe({
        next: address => addresses.push(address),
        error: () => ends.push('error'),
        complete: () => ends.push('complete'),
      }),
    );
    subscription?.add(
      engine.syncProgress$.subscribe({ error: () => ends.push('error') }),
    );
    const submitting = firstValueFrom(submitted(engine, transaction, row));
    await until(() => submitCalls().length === 1);

    failing.syncProgress$.error(new Error('indexer unreachable'));
    await flush();
    const generationWhileHeld = engine.engineGeneration;
    const isTornDownWhileHeld = failing.tornDown;
    finality.next('tx-hash');
    finality.complete();

    await expect(submitting).resolves.toEqual({ txId: 'tx-hash' });
    await until(() => engine.engineGeneration !== generationWhileHeld);
    await until(() => addresses.length === 2);
    expect(isTornDownWhileHeld).toBe(false);
    expect(failing.tornDown).toBe(true);
    expect(fakeEngines.of(a.accountId)).toHaveLength(2);
    expect(ends).toEqual([]);
    expect(watcher).toEqual({ errors: 0, completions: 0 });
    expect(engines).toHaveLength(1);
    expect(callsOf('attach')).toHaveLength(1);
  });
});
