import { of } from 'rxjs';

import type {
  MidnightEngineAccess,
  MidnightEnginesByAccountId,
} from '@lace-contract/midnight-context';
import type { Observable } from 'rxjs';

/** The engine addon as page mode serves it: the registry, and never a recorded start failure. */
export const pageModeEngineAccess = (
  engines$: Observable<MidnightEnginesByAccountId>,
): MidnightEngineAccess => ({
  engines$,
  startFailures$: of({}),
  requestEngine: () => undefined,
});
