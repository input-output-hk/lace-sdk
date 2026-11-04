import type { BundleRegistry } from './bundle';
import type * as deviceReadersModule from './device-readers';
import type * as grantsModule from './grants';
import type * as jubjubAuthoriserModule from './jubjub-authoriser';
import type { PassportRegistry } from './registry';
import type * as signerModule from './signer';

/** The jubjub signing surface the passkey ceremony builds on. */
export type JubjubSigning = typeof jubjubAuthoriserModule & typeof signerModule;

/** The grant derivation surface the signer verifies a grant flow with. */
export type GrantDerivation = typeof grantsModule;

/**
 * Caches one dynamic import: a successful load is reused by every later
 * call, and a rejected load clears the cache so the next call retries.
 */
const cachedLoad = <T>(load: () => Promise<T>): (() => Promise<T>) => {
  let cached: Promise<T> | undefined;
  return async (): Promise<T> => {
    cached ??= load();
    cached.catch(() => {
      cached = undefined;
    });
    return cached;
  };
};

/**
 * Cached dynamic import of the jubjub authoriser and signer modules. They
 * evaluate the vendored Account Custody Contract module, and with it the
 * Midnight compact runtime, at module scope; a bundle entry that must stay
 * free of Midnight dependencies reaches them only through this seam and
 * pays for them on the first key ceremony.
 */
export const loadJubjubSigning = cachedLoad(async () =>
  Promise.all([import('./jubjub-authoriser'), import('./signer')]).then(
    ([jubjubAuthoriser, signer]): JubjubSigning => ({
      ...jubjubAuthoriser,
      ...signer,
    }),
  ),
);

/**
 * Cached dynamic import of the grant derivation helpers, which evaluate
 * the contract module the same way. The remote seams reach them only
 * through this seam, when a grant flow is bound, so the signer protocol
 * stays free of Midnight dependencies until a grant is issued.
 */
export const loadGrantDerivation = cachedLoad(async () => import('./grants'));

/**
 * Cached dynamic import of the grant spend preparation and challenge
 * builders, which evaluate the contract module the same way: an agent
 * that imports the SDK pays for the Midnight runtime only when it first
 * prepares a spend.
 */
export const loadGrantSpend = cachedLoad(async () => import('./grant-spend'));

/** The device entry derivation the signer checks a rotation's readers with. */
export type DeviceEntryDerivation = typeof deviceReadersModule;

/**
 * Cached dynamic import of the device entry derivation, which evaluates
 * the contract module the same way: the signer reaches it only when a
 * flow seals the account keys to devices it must check against the
 * entries the user approved.
 */
export const loadDeviceEntryDerivation = cachedLoad(
  async () => import('./device-readers'),
);

/**
 * Cached dynamic import of the bundle registry, whose default bundle
 * carries the verifier key table of the generated module and so evaluates
 * it: the signer reaches it only when a flow names a build, a circuit or
 * operations it must hold to what it pins.
 */
const loadAccountBundles = cachedLoad(async () => import('./bundle'));

/**
 * A loader of the registry over the default bundle and the `registry` a
 * host registers, built once over the cached import of the bundle
 * registry: a seam that holds a request to a bundle's roster and pins
 * resolves the bundle through it, and so evaluates the generated module
 * only when it first does. A registry refused for a bundle that breaks a
 * rule is retried on the next call, as a failed load is.
 */
export const bundleRegistryLoader = (
  registry?: PassportRegistry,
): (() => Promise<BundleRegistry>) =>
  cachedLoad(async () =>
    (await loadAccountBundles()).createBundleRegistry(
      registry?.bundles,
      registry?.calledContracts,
    ),
  );
