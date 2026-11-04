import { AccountBundleInvalidError } from '@lace-contract/passport';

import { DECIMAL_PATTERN } from './arguments';
import { DEPLOYED_OPERATIONS, MODULE_CIRCUITS } from './deployed-operations';
import { ACCOUNT_BUNDLE_ID, accManifest, BUNDLE_ID_PATTERN } from './manifest';

import type {
  AccountBundle,
  ArgumentDescriptor,
  CalledContract,
  CircuitDescriptor,
} from '@lace-contract/passport';

/**
 * What a host registers once and hands every Passport seam: the account
 * bundles it registers beside the default, which is always present, and
 * the called contracts an account's circuits may call. A contract address
 * is content-derived and names one deployment, so the called contracts
 * are one list for every network the host serves. Built by
 * {@link createPassportRegistry}, which holds it to the registry rules.
 */
export type PassportRegistry = {
  readonly bundles: readonly AccountBundle[];
  readonly calledContracts: readonly CalledContract[];
};

const invalid = (bundle: AccountBundle, rule: string) =>
  new AccountBundleInvalidError(`Account bundle '${bundle.id}' ${rule}`);

/**
 * Holds the bound of every integer argument among `descriptors` to a
 * decimal string, so a value is compared against it when a call decodes
 * rather than failing on the bound itself. `of` names the arguments in
 * the message: a circuit's or the constructor's.
 */
const assertBounds = (
  bundle: AccountBundle,
  descriptors: readonly ArgumentDescriptor[],
  of: string,
): void => {
  for (const argument of descriptors) {
    if (argument.type === 'uint' && !DECIMAL_PATTERN.test(argument.maxval)) {
      throw invalid(
        bundle,
        `bounds ${of} '${argument.name}' by '${argument.maxval}', which is not a decimal integer.`,
      );
    }
  }
};

/**
 * Holds one descriptor to the registry rules. The module's own circuits
 * come first: a descriptor of one would let a device sign it through the
 * generic call consent, so it is refused whatever else the descriptor
 * says.
 */
const assertDescriptor = (
  bundle: AccountBundle,
  circuit: string,
  descriptor: CircuitDescriptor,
): void => {
  if (MODULE_CIRCUITS.includes(circuit)) {
    throw invalid(
      bundle,
      `describes circuit '${circuit}', which is one of the module's own and is never called through a descriptor.`,
    );
  }
  if (!bundle.operations.includes(circuit)) {
    throw invalid(
      bundle,
      `describes circuit '${circuit}', which is not in its roster.`,
    );
  }
  assertBounds(bundle, descriptor.args, `argument of circuit '${circuit}'`);
  const named = new Set([
    ...descriptor.args.map(argument => argument.name),
    ...descriptor.witnesses.map(witness => witness.name),
  ]);
  for (const name of descriptor.challengeArgs) {
    if (!named.has(name)) {
      throw invalid(
        bundle,
        `names challenge argument '${name}' of circuit '${circuit}', which is neither an argument nor a witness of it.`,
      );
    }
  }
  const contracts = new Set(
    descriptor.args.flatMap(argument =>
      argument.type === 'contract' ? [argument.name] : [],
    ),
  );
  for (const argument of descriptor.args) {
    if (argument.type === 'contract-address' && !contracts.has(argument.of)) {
      throw invalid(
        bundle,
        `derives argument '${argument.name}' of circuit '${circuit}' from '${argument.of}', which is not a contract argument of it.`,
      );
    }
  }
};

/**
 * Holds a bundle to being the vendored account plus circuits of its own:
 * the module's flows call the default roster's circuits on every build
 * and build their challenges with the vendored pure circuits, so a
 * bundle's roster and pure circuits must contain the default's.
 */
const assertVendoredBase = (bundle: AccountBundle): void => {
  for (const operation of DEPLOYED_OPERATIONS) {
    if (!bundle.operations.includes(operation)) {
      throw invalid(
        bundle,
        `lacks operation '${operation}' of the default roster, which the module's own flows call.`,
      );
    }
  }
  for (const circuit of accManifest.pureCircuits) {
    if (!bundle.manifest.pureCircuits.includes(circuit)) {
      throw invalid(
        bundle,
        `lacks pure circuit '${circuit}' of the default manifest, which the module's own flows build challenges with.`,
      );
    }
  }
};

/**
 * Holds a bundle to the registry rules, so a build that could not be
 * deployed, described or proved is refused where it is registered rather
 * than where a flow first uses it.
 */
const assertBundle = (bundle: AccountBundle): void => {
  if (!BUNDLE_ID_PATTERN.test(bundle.id)) {
    throw new AccountBundleInvalidError(
      `Account bundle id '${bundle.id}' must be lowercase letters, digits and hyphens.`,
    );
  }
  assertVendoredBase(bundle);
  for (const operation of bundle.operations) {
    if (!bundle.verifierKeys[operation]) {
      throw invalid(
        bundle,
        `pins no verifier key for operation '${operation}' of its roster.`,
      );
    }
  }
  assertBounds(bundle, bundle.constructorArgs, 'constructor argument');
  for (const argument of bundle.constructorArgs) {
    if (argument.type === 'contract-address') {
      throw invalid(
        bundle,
        `derives constructor argument '${argument.name}', which a caller must supply.`,
      );
    }
  }
  for (const [circuit, descriptor] of Object.entries(bundle.circuits)) {
    assertDescriptor(bundle, circuit, descriptor);
  }
};

/**
 * Holds the bundles a host registers beside the default to the registry
 * rules, the default's id among the taken ones.
 *
 * @throws {@link AccountBundleInvalidError} naming the bundle and the rule
 * it breaks.
 */
export const assertHostBundles = (bundles: readonly AccountBundle[]): void => {
  const ids = new Set<string>([ACCOUNT_BUNDLE_ID]);
  for (const bundle of bundles) {
    assertBundle(bundle);
    if (ids.has(bundle.id)) {
      throw new AccountBundleInvalidError(
        `Account bundle id '${bundle.id}' is registered twice.`,
      );
    }
    ids.add(bundle.id);
  }
};

/** A contract address is the 32-byte hash the ledger derives, as lowercase hex. */
const CONTRACT_ADDRESS_PATTERN = /^[0-9a-f]{64}$/;

const HTTP_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:']);

/** The fields every integrity pin of a called contract carries. */
const PIN_FIELDS = [
  'name',
  'keyLocation',
  'zkirSha256',
  'proverKeySha256',
  'verifierKeySha256',
] as const;

const invalidCallee = (field: string, rule: string) =>
  new Error(`The Passport registry ${field} ${rule}`);

/** Whether `url` is an absolute http(s) URL. */
const isHttpUrl = (url: string): boolean => {
  try {
    return HTTP_PROTOCOLS.has(new URL(url).protocol);
  } catch {
    return false;
  }
};

/**
 * Checks one called contract as the module provider and the key material
 * resolver use it: its address is compared with the one a call names, so
 * it must be the canonical lowercase hex and no two registrations may
 * share it; its artefacts are downloaded over HTTP; and each pin must
 * carry every digest an asset is checked against.
 */
const assertCalledContract = (
  contract: CalledContract,
  index: number,
  addresses: Set<string>,
): void => {
  const field = `calledContracts[${index}]`;
  if (contract.label.length === 0) {
    throw invalidCallee(`${field}.label`, 'must not be empty.');
  }
  if (contract.interface.length === 0) {
    throw invalidCallee(`${field}.interface`, 'must not be empty.');
  }
  if (!CONTRACT_ADDRESS_PATTERN.test(contract.address)) {
    throw invalidCallee(
      `${field}.address`,
      `"${contract.address}" is not a contract address: it must be 64 lowercase hex characters.`,
    );
  }
  if (addresses.has(contract.address)) {
    throw invalidCallee(
      `${field}.address`,
      `"${contract.address}" is registered twice.`,
    );
  }
  addresses.add(contract.address);
  if (!isHttpUrl(contract.artefactUrl)) {
    throw invalidCallee(
      `${field}.artefactUrl`,
      `"${contract.artefactUrl}" must be an absolute http: or https: URL.`,
    );
  }
  for (const [circuit, pin] of Object.entries(contract.pins)) {
    for (const pinField of PIN_FIELDS) {
      if (typeof pin[pinField] !== 'string' || pin[pinField].length === 0) {
        throw invalidCallee(`${field}.pins.${circuit}`, `has no ${pinField}.`);
      }
    }
  }
};

/**
 * Builds the one registry value a host hands the module, the authoriser,
 * the encryption key, the prover, the dev deposit and the signer
 * handlers, so they read what is registered in one shape. Each seam still
 * needs it: one left without it knows only the default bundle. Every rule is
 * checked here, before any seam is built. It loads no contract code.
 *
 * @throws {@link AccountBundleInvalidError} naming a bundle and the rule
 * it breaks: an id taken or malformed, a roster or pure circuits lacking
 * the default's, an operation of the roster without a verifier key pin, a
 * constructor argument that is derived rather than supplied, an integer
 * argument whose bound is not a decimal string, a descriptor of one of
 * the module's own circuits or of a circuit outside the roster, a
 * challenge argument that is neither an argument nor a witness of its
 * circuit, or a derived argument naming no contract argument of its
 * circuit.
 * @throws Error naming a called contract and the rule it breaks: an empty
 * label or interface, an address that is not canonical or is registered
 * twice, an artefact URL that is not http(s), or a pin missing a digest.
 */
export const createPassportRegistry = ({
  bundles = [],
  calledContracts = [],
}: {
  bundles?: readonly AccountBundle[];
  calledContracts?: readonly CalledContract[];
} = {}): PassportRegistry => {
  assertHostBundles(bundles);
  const addresses = new Set<string>();
  for (const [index, contract] of calledContracts.entries()) {
    assertCalledContract(contract, index, addresses);
  }
  return { bundles, calledContracts };
};
