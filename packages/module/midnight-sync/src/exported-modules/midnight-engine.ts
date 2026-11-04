import { midnightWalletsForRuntime } from '@lace-contract/midnight-context';
import { defer, of } from 'rxjs';

import { midnightEngineClientFor } from '../worker/engine-client';

import type { MidnightEngineAccess } from '@lace-contract/midnight-context';
import type { ModuleInitProps } from '@lace-contract/module';

const accesses = new WeakMap<
  ModuleInitProps['runtime'],
  MidnightEngineAccess
>();

// One access per app instance, as its registry. The client is read on use: the store, which creates it in Worker
// mode, may initialize after the addon loads.
const initMidnightEngine = ({
  runtime,
}: Pick<ModuleInitProps, 'runtime'>): MidnightEngineAccess => {
  let access = accesses.get(runtime);
  if (!access) {
    access = {
      engines$: midnightWalletsForRuntime(runtime),
      startFailures$: defer(
        () => midnightEngineClientFor(runtime)?.startFailures$ ?? of({}),
      ),
      requestEngine: accountId => {
        midnightEngineClientFor(runtime)?.requestEngine(accountId);
      },
    };
    accesses.set(runtime, access);
  }
  return access;
};

export default initMidnightEngine;
