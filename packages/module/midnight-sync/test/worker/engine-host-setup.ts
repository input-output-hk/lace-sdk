import { dummyLogger } from 'ts-log';
import { vi } from 'vitest';

import { createMidnightEngineHost } from '../../src/worker/engine-host';

import { createMemoryStore, encryptedSeedOf } from './engine-host-fakes';

import type { DerivePendingMidnightActivity } from '../../src/worker/engine-operations';
import type {
  MidnightWorkerStorageKind,
  MidnightEngineHost,
  MidnightAttachRequest,
  MidnightAttachResult,
} from '../../src/worker/protocol';

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
  const attach = host.attach;
  const fixtureHost: Omit<MidnightEngineHost, 'attach'> & {
    attach: (
      request: Omit<MidnightAttachRequest, 'encryptedSeed'> &
        Partial<Pick<MidnightAttachRequest, 'encryptedSeed'>>,
    ) => Promise<MidnightAttachResult>;
  } = {
    ...host,
    attach: async (
      request: Omit<Parameters<typeof attach>[0], 'encryptedSeed'> &
        Partial<Pick<Parameters<typeof attach>[0], 'encryptedSeed'>>,
    ) =>
      attach({
        ...request,
        encryptedSeed:
          request.encryptedSeed ?? encryptedSeedOf(request.account),
      }),
  };
  return { host: fixtureHost, stores, createStore, derivePendingActivity };
};
