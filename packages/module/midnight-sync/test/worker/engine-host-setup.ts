import { dummyLogger } from 'ts-log';
import { vi } from 'vitest';

import { createMidnightEngineHost } from '../../src/worker/engine-host';

import { createMemoryStore } from './engine-host-fakes';

import type { DerivePendingMidnightActivity } from '../../src/worker/engine-operations';
import type { MidnightWorkerStorageKind } from '../../src/worker/protocol';

export const createHost = () => {
  const stores = new Map<
    MidnightWorkerStorageKind,
    ReturnType<typeof createMemoryStore>
  >();
  const createStore = vi.fn((kind: MidnightWorkerStorageKind) => {
    const created = createMemoryStore(kind);
    stores.set(kind, created);
    return created.store;
  });
  const derivePendingActivity = vi.fn<DerivePendingMidnightActivity>();
  const host = createMidnightEngineHost({
    createStore,
    derivePendingActivity,
    logger: dummyLogger,
  });
  return { host, stores, createStore, derivePendingActivity };
};
