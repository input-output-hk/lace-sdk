import { DustTimelineDiscovery } from './dust-timeline';

const yieldToEventLoop = async () =>
  new Promise<void>(resolve => setTimeout(resolve, 0));

/** Gates network startup on every registered account's local preparation. */
export class MidnightStartupCoordinator {
  public readonly dustTimeline = new DustTimelineDiscovery();
  private readonly preparing = new Set<object>();
  private readonly waitingForPeers = new Map<
    object,
    {
      discover?: () => Promise<void>;
      resolve: () => void;
      reject: (error: unknown) => void;
    }
  >();
  private restoreTail: Promise<unknown> = Promise.resolve();
  private releasing = false;
  private discovery: Promise<unknown> = Promise.resolve();

  public register() {
    const token = {};
    this.preparing.add(token);
    let isCancelled = false;
    const controller = new AbortController();
    let releaseWaiter: (() => void) | undefined;
    const assertActive = () => {
      if (isCancelled) throw new Error('Midnight wallet startup cancelled');
    };
    return {
      signal: controller.signal,
      get cancelled() {
        return isCancelled;
      },
      // Storage and authentication can wait indefinitely. They must not hold
      // ready peers; rejoining local preparation waits for any active discovery.
      waitForPreparationInput: async <T>(
        read: () => Promise<T>,
      ): Promise<T> => {
        assertActive();
        this.preparing.delete(token);
        this.releaseReady();
        const value = await read();
        assertActive();
        this.preparing.add(token);
        return value;
      },
      // Only synchronous, local work belongs here. Auth and network requests
      // must not hold the restore queue (LW-15215).
      enqueueLocalRestore: async <T>(work: () => T): Promise<T> => {
        const run = this.restoreTail.then(async () => {
          // Late accounts must not deserialize while a cohort's timed
          // discovery is running. Discovery itself never uses this queue.
          await this.discovery;
          await yieldToEventLoop();
          assertActive();
          return work();
        });
        this.restoreTail = run.catch(() => undefined);
        return run;
      },
      finishPreparationAndWaitForPeers: async (
        discover?: () => Promise<void>,
      ) => {
        assertActive();
        this.preparing.delete(token);
        await new Promise<void>((resolve, reject) => {
          releaseWaiter = resolve;
          this.waitingForPeers.set(token, { discover, resolve, reject });
          this.releaseReady();
        });
        assertActive();
      },
      cancel: () => {
        isCancelled = true;
        controller.abort();
        releaseWaiter?.();
        this.preparing.delete(token);
        this.waitingForPeers.get(token)?.resolve();
        this.waitingForPeers.delete(token);
        this.releaseReady();
      },
    };
  }

  private releaseReady() {
    if (
      this.releasing ||
      this.preparing.size > 0 ||
      this.waitingForPeers.size === 0
    )
      return;
    this.releasing = true;
    // Recheck after yielding: another account can join before sync starts.
    void yieldToEventLoop().then(async () => {
      if (this.preparing.size > 0) {
        this.releasing = false;
        return;
      }
      const cohort = [...this.waitingForPeers.values()];
      this.waitingForPeers.clear();
      // Resolve public discovery before any cohort member initializes its
      // SDK wallet or starts replay/persistence. Failed discovery is bounded
      // by its owner; it must never enqueue local work behind this phase.
      const discovery = Promise.allSettled(
        cohort.map(async waiter =>
          Promise.resolve().then(async () => waiter.discover?.()),
        ),
      );
      this.discovery = discovery;
      const results = await discovery;
      for (const [index, waiter] of cohort.entries()) {
        await yieldToEventLoop();
        const result = results[index];
        if (result.status === 'fulfilled') waiter.resolve();
        else waiter.reject(result.reason);
      }
      this.releasing = false;
      this.releaseReady();
    });
  }
}

export type MidnightStartup = ReturnType<
  MidnightStartupCoordinator['register']
>;
