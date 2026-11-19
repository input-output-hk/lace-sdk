import { EMPTY, mergeMap } from 'rxjs';

/** Operator that drops every value of its source, completing when the source does. */
export const toEmpty = mergeMap(() => EMPTY);
