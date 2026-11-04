import { DEPLOYED_OPERATIONS } from './deployed-operations';
import { ACCOUNT_BUNDLE_ID } from './manifest';

import type { AccountBundle } from '@lace-contract/passport';

/**
 * A bundle as a signer pins it to hold a descriptor to and to describe a
 * call by: its id, its roster, its constructor arguments and the
 * descriptors of its callable circuits. The compiled module, the manifest
 * and the verifier keys stay with the bundle itself, so a consent screen
 * reads these without loading the build.
 */
export type PinnedBundle = Pick<
  AccountBundle,
  'circuits' | 'constructorArgs' | 'id' | 'operations'
>;

/**
 * The default build without its module, manifest or verifier keys: its
 * id, the vendored roster, no constructor argument beyond the standard
 * ones and no circuit for a caller to run. Built from the manifest side
 * alone, it is what a signer pins to describe a creation or an install
 * under the default, and with `accManifest` the base an app derives a
 * bundle of its own from.
 */
export const pinnedAccountBundle: PinnedBundle = {
  id: ACCOUNT_BUNDLE_ID,
  operations: DEPLOYED_OPERATIONS,
  constructorArgs: [],
  circuits: {},
};
