import type { ProviderError } from '@lace-lib/cardano-core';
import type { Result } from '@lace-lib/util';

/** The value of a provider result, or its error thrown. */
export const throwOnError = <T>(result: Result<T, ProviderError>): T => {
  if (result.isErr()) throw result.unwrapErr();
  return result.unwrap();
};
