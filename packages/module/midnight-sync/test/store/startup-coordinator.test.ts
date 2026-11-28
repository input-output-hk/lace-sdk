import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MidnightStartupCoordinator } from '../../src/store/startup-coordinator';

describe('Midnight startup coordination', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('yields between local restores and waits for every account before releasing probes', async () => {
    const coordinator = new MidnightStartupCoordinator();
    const first = coordinator.register();
    const second = coordinator.register();
    const events: string[] = [];
    const a = first.enqueueLocalRestore(() => events.push('restore first'));
    const b = second.enqueueLocalRestore(() => events.push('restore second'));
    expect(events).toEqual([]);
    await vi.advanceTimersByTimeAsync(20);
    await Promise.all([a, b]);
    const firstReady = first
      .finishPreparationAndWaitForPeers()
      .then(() => events.push('probe first'));
    await vi.advanceTimersByTimeAsync(20);
    expect(events).toEqual(['restore first', 'restore second']);
    const secondReady = second
      .finishPreparationAndWaitForPeers()
      .then(() => events.push('probe second'));
    expect(events).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(20);
    await Promise.all([firstReady, secondReady]);
    expect(events).toEqual([
      'restore first',
      'restore second',
      'probe first',
      'probe second',
    ]);
  });

  it('includes an account registered while release is scheduled', async () => {
    const coordinator = new MidnightStartupCoordinator();
    const started = vi.fn();
    const first = coordinator.register();
    const firstReady = first.finishPreparationAndWaitForPeers().then(started);
    const late = coordinator.register();
    await vi.advanceTimersByTimeAsync(20);
    expect(started).not.toHaveBeenCalled();
    const lateReady = late.finishPreparationAndWaitForPeers();
    await vi.advanceTimersByTimeAsync(20);
    await Promise.all([firstReady, lateReady]);
    expect(started).toHaveBeenCalledOnce();
  });

  it('cancels queued restoration without poisoning the queue or blocking siblings', async () => {
    const coordinator = new MidnightStartupCoordinator();
    const cancelled = coordinator.register();
    const sibling = coordinator.register();
    const restore = vi.fn();
    const cancelledWork = cancelled
      .enqueueLocalRestore(restore)
      .catch((error: unknown) => error);
    const siblingWork = sibling.enqueueLocalRestore(() => 'restored');
    cancelled.cancel();
    await vi.advanceTimersByTimeAsync(20);
    expect(await cancelledWork).toEqual(
      new Error('Midnight wallet startup cancelled'),
    );
    expect(restore).not.toHaveBeenCalled();
    expect(await siblingWork).toBe('restored');
    const ready = sibling.finishPreparationAndWaitForPeers();
    await vi.advanceTimersByTimeAsync(20);
    await ready;
  });

  it('rejects cancelled waiters and allows a later startup batch', async () => {
    const coordinator = new MidnightStartupCoordinator();
    const first = coordinator.register();
    const second = coordinator.register();
    const ready = first
      .finishPreparationAndWaitForPeers()
      .catch((error: unknown) => error);
    first.cancel();
    second.cancel();
    expect(await ready).toEqual(new Error('Midnight wallet startup cancelled'));
    const retry = coordinator.register();
    const retryReady = retry.finishPreparationAndWaitForPeers();
    await vi.advanceTimersByTimeAsync(20);
    await retryReady;
  });

  it('does not hold other runtimes behind an unfinished restore', async () => {
    new MidnightStartupCoordinator().register();
    const independent = new MidnightStartupCoordinator()
      .register()
      .finishPreparationAndWaitForPeers();
    await vi.advanceTimersByTimeAsync(20);
    await independent;
  });

  it('lets ready peers discover while input waits, then queues the returning account local work', async () => {
    const coordinator = new MidnightStartupCoordinator();
    const waiting = coordinator.register(),
      ready = coordinator.register();
    let supply!: () => void, finish!: () => void;
    const input = new Promise<void>(resolve => {
      supply = resolve;
    });
    const discovery = new Promise<void>(resolve => {
      finish = resolve;
    });
    const prepare = vi.fn(() => undefined),
      discover = vi.fn(async () => discovery);
    const late = waiting
      .waitForPreparationInput(async () => input)
      .then(async () => waiting.enqueueLocalRestore(prepare));
    const first = ready.finishPreparationAndWaitForPeers(discover);
    await vi.advanceTimersByTimeAsync(20);
    expect(discover).toHaveBeenCalledOnce();
    supply();
    await vi.advanceTimersByTimeAsync(20);
    expect(prepare).not.toHaveBeenCalled();
    finish();
    await vi.advanceTimersByTimeAsync(20);
    await Promise.all([first, late]);
    expect(prepare).toHaveBeenCalledOnce();
    waiting.cancel();
  });

  it('releases a cancelled cohort waiter promptly while another discovery is still pending', async () => {
    const coordinator = new MidnightStartupCoordinator();
    const cancelled = coordinator.register(),
      peer = coordinator.register();
    let finish!: () => void;
    const discovery = new Promise<void>(resolve => {
      finish = resolve;
    });
    const first = cancelled
      .finishPreparationAndWaitForPeers()
      .catch((error: Error) => error.message);
    const second = peer.finishPreparationAndWaitForPeers(async () => discovery);
    await vi.advanceTimersByTimeAsync(20);
    cancelled.cancel();
    expect(await first).toContain('cancelled');
    finish();
    await vi.advanceTimersByTimeAsync(20);
    await second;
  });

  it('finishes the whole cohort discovery before releasing restored or fresh wallets', async () => {
    const coordinator = new MidnightStartupCoordinator();
    const restored = coordinator.register(),
      fresh = coordinator.register();
    const events: string[] = [];
    let finish!: () => void;
    const discovered = new Promise<void>(resolve => {
      finish = resolve;
    });
    const a = restored
      .finishPreparationAndWaitForPeers()
      .then(() => events.push('restored replay'));
    const b = fresh
      .finishPreparationAndWaitForPeers(async () => {
        events.push('discovery');
        await discovered;
      })
      .then(() => events.push('fresh init'));
    await vi.advanceTimersByTimeAsync(20);
    expect(events).toEqual(['discovery']);
    finish();
    await vi.advanceTimersByTimeAsync(20);
    await Promise.all([a, b]);
    expect(events).toEqual(['discovery', 'restored replay', 'fresh init']);
  });

  it('defers late local work until discovery finishes without blocking that cohort on the new account', async () => {
    const coordinator = new MidnightStartupCoordinator(),
      first = coordinator.register();
    let finish!: () => void;
    const discovered = new Promise<void>(resolve => {
      finish = resolve;
    });
    const firstStarted = vi.fn(),
      restored = vi.fn();
    const a = first
      .finishPreparationAndWaitForPeers(async () => discovered)
      .then(firstStarted);
    await vi.advanceTimersByTimeAsync(20);
    const late = coordinator.register(),
      local = late.enqueueLocalRestore(restored);
    await vi.advanceTimersByTimeAsync(20);
    expect(restored).not.toHaveBeenCalled();
    finish();
    await vi.advanceTimersByTimeAsync(20);
    await Promise.all([a, local]);
    expect(firstStarted).toHaveBeenCalledOnce();
    expect(restored).toHaveBeenCalledOnce();
    const b = late.finishPreparationAndWaitForPeers();
    await vi.advanceTimersByTimeAsync(20);
    await b;
  });

  it('aborts an active search on cancellation and releases a sibling', async () => {
    const coordinator = new MidnightStartupCoordinator(),
      first = coordinator.register(),
      sibling = coordinator.register();
    const a = first
      .finishPreparationAndWaitForPeers(
        async () =>
          new Promise<void>((_resolve, reject) => {
            first.signal.addEventListener(
              'abort',
              () => {
                reject(new Error('cancelled'));
              },
              { once: true },
            );
          }),
      )
      .catch((error: Error) => error.message);
    const b = sibling.finishPreparationAndWaitForPeers();
    await vi.advanceTimersByTimeAsync(20);
    first.cancel();
    await vi.advanceTimersByTimeAsync(20);
    expect(await a).toContain('cancelled');
    await b;
    const retry = coordinator.register().finishPreparationAndWaitForPeers();
    await vi.advanceTimersByTimeAsync(20);
    await retry;
  });
});
