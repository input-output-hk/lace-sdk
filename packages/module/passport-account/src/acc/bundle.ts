import { AccountBundleUnknownError } from '@lace-contract/passport';

import { expectedVk } from './acc-module';
import { accManifest } from './manifest';
import { pinnedAccountBundle } from './pinned-bundle';
import { createPassportRegistry } from './registry';

import type { AccountBundle, CalledContract } from '@lace-contract/passport';

/**
 * The bundle of the vendored Account Custody Contract: the generated
 * module behind `acc-module`, its manifest and the roster this module
 * deploys, see {@link pinnedAccountBundle}. Its verifier key fingerprints
 * are the generated module's `expectedVk` table, which covers every
 * circuit of the compiled contract, the roster among them.
 */
export const accountBundle: AccountBundle = {
  ...pinnedAccountBundle,
  bindingVersion: accManifest.bindingVersion,
  module: async () => import('./acc-module'),
  manifest: accManifest,
  verifierKeys: expectedVk,
};

/**
 * The account bundles a module was created with. `bundles` lists them,
 * the default first. `get` answers the bundle an id names. `resolve`
 * answers the bundle of an account from the sha256 of each operation's
 * verifier key the chain holds for it: the bundle whose fingerprints
 * match every on-chain operation, and, among several, the one whose
 * roster is exactly the on-chain set, else the one with the smallest
 * roster, since a build with fewer circuits is the closer description
 * of an account whose install is unfinished. `calledContracts` are the
 * contracts the host registered for the bundles' circuits to call.
 */
export type BundleRegistry = {
  readonly bundles: readonly AccountBundle[];
  readonly calledContracts: readonly CalledContract[];
  get: (id: string) => AccountBundle;
  resolve: (onChain: ReadonlyMap<string, string>) => AccountBundle;
};

/** Whether `bundle` pins, for every on-chain operation, the verifier key the chain holds. */
const covers = (
  bundle: AccountBundle,
  onChain: ReadonlyMap<string, string>,
): boolean =>
  [...onChain].every(
    ([operation, hash]) => bundle.verifierKeys[operation] === hash,
  );

/** Whether the roster of `bundle` is exactly the on-chain operation set. */
const hasExactRoster = (
  bundle: AccountBundle,
  onChain: ReadonlyMap<string, string>,
): boolean => {
  const roster = new Set(bundle.operations);
  return (
    roster.size === onChain.size &&
    [...onChain.keys()].every(operation => roster.has(operation))
  );
};

/**
 * The reason no registered bundle covers the on-chain operations: the
 * operations whose verifier key no bundle pins, when there are any, else
 * that every operation is pinned but by no single bundle.
 */
const uncoveredReason = (
  bundles: readonly AccountBundle[],
  onChain: ReadonlyMap<string, string>,
): string => {
  const uncovered = [...onChain].flatMap(([operation, hash]) =>
    bundles.some(bundle => bundle.verifierKeys[operation] === hash)
      ? []
      : [operation],
  );
  return uncovered.length > 0
    ? `no registered account bundle pins the verifier key of ${uncovered
        .map(operation => `'${operation}'`)
        .join(', ')}`
    : 'no single registered account bundle pins every verifier key of the account';
};

/**
 * Builds the registry of account bundles a module runs with: the default
 * {@link accountBundle} and the `bundles` the host registers, with the
 * `calledContracts` it registers, each held to the rules
 * {@link createPassportRegistry} checks.
 *
 * @throws {@link AccountBundleInvalidError} naming the bundle and the rule
 * it breaks.
 */
export const createBundleRegistry = (
  bundles: readonly AccountBundle[] = [],
  calledContracts: readonly CalledContract[] = [],
): BundleRegistry => {
  createPassportRegistry({ bundles, calledContracts });
  const registered = [accountBundle, ...bundles];

  return {
    bundles: registered,
    calledContracts,
    get: id => {
      const bundle = registered.find(candidate => candidate.id === id);
      if (!bundle) {
        throw new AccountBundleUnknownError(
          `No account bundle '${id}' is registered.`,
        );
      }
      return bundle;
    },
    resolve: onChain => {
      if (onChain.size === 0) {
        throw new AccountBundleUnknownError(
          'The account holds no operation to recognise its build by.',
        );
      }
      const covering = registered.filter(bundle => covers(bundle, onChain));
      const [first] = covering;
      if (!first) {
        throw new AccountBundleUnknownError(
          `The build of the account is not registered: ${uncoveredReason(
            registered,
            onChain,
          )}.`,
        );
      }
      return (
        covering.find(bundle => hasExactRoster(bundle, onChain)) ??
        covering.reduce(
          (smallest, bundle) =>
            bundle.operations.length < smallest.operations.length
              ? bundle
              : smallest,
          first,
        )
      );
    },
  };
};
