// The SDK's engine worker: the canary build emits it next to the Midnight entry, and `createMidnightModule` starts it
// in Worker mode. Only modules free of the engine load before it listens: the engine and its WebAssembly load through
// the dynamic import below, which the build checks.
import { Buffer } from 'buffer';

import { dummyLogger } from 'ts-log';

import { runMidnightEngineWorker } from './run-engine-worker';

import type { MidnightEngineWorkerScope } from './run-engine-worker';

void runMidnightEngineWorker({
  scope: globalThis as unknown as MidnightEngineWorkerScope,
  locks: navigator.locks,
  buffer: Buffer,
  loadHost: async () =>
    (await import('./engine-host')).createSdkMidnightEngineHost(dummyLogger),
  logger: dummyLogger,
});
