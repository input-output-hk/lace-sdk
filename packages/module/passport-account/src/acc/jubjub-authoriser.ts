import {
  CircuitNotRegisteredError,
  DeviceCommitmentHex,
} from '@lace-contract/passport';
import { ByteArray, HexBytes } from '@lace-lib/util';

import { createBundleRegistry } from './bundle';
import { descriptorChallenge, jubjubChallenges } from './challenges';
import { DEVICE_AUTHORISED_CIRCUITS } from './deployed-operations';
import { ADD_DEVICE_CIRCUIT, REMOVE_DEVICE_CIRCUIT } from './device-circuits';
import {
  APPEND_INBOX_CIRCUIT,
  ROTATE_ENC_KEY_CIRCUIT,
} from './enc-key-circuits';
import {
  ISSUE_GRANT_CIRCUIT,
  REVOKE_ALL_GRANTS_CIRCUIT,
  REVOKE_GRANT_CIRCUIT,
} from './grant-circuits';
import { issueGrantBinding } from './grants';

import type { BundleRegistry } from './bundle';
import type {
  CallContext,
  ChallengeBuilder,
  ContextChallenge,
} from './challenges';
import type { DeviceAuthorisedCircuit } from './deployed-operations';
import type { PassportRegistry } from './registry';
import type { JubjubDevice } from './signer';
import type {
  AccAddress,
  AuthorisationRequest,
  PassportAuthoriser,
} from '@lace-contract/passport';
import type { JubjubPoint } from '@midnight-ntwrk/compact-runtime';

const HEX_BYTE_PATTERN = /^(?:[0-9a-f]{2})*$/;

const accountToBytes = (account: AccAddress): Uint8Array => {
  if (!HEX_BYTE_PATTERN.test(account)) {
    throw new Error(
      `AccAddress is not lowercase hex of whole bytes: "${account}"`,
    );
  }
  return ByteArray.fromHex(HexBytes(account));
};

const bytesArgument = (request: AuthorisationRequest): Uint8Array => {
  const [entry] = request.args;
  if (!(entry instanceof Uint8Array)) {
    throw new Error(
      `Circuit ${request.circuit} expects a byte-array entry as its first argument`,
    );
  }
  return entry;
};

const noArguments = (request: AuthorisationRequest): void => {
  if (request.args.length > 0) {
    throw new Error(`Circuit ${request.circuit} takes no argument`);
  }
};

/** Builds the challenge of one request once the device key is at hand. */
type RequestChallenge = (
  context: CallContext,
  pk: JubjubPoint,
  request: AuthorisationRequest,
) => ChallengeBuilder;

/**
 * The fixed challenge builders of the module's own device-authorised
 * circuits, keyed by {@link DEVICE_AUTHORISED_CIRCUITS}, so a circuit
 * joins or leaves the list and its builder together.
 */
const challengeBuilders: Record<DeviceAuthorisedCircuit, RequestChallenge> = {
  [ADD_DEVICE_CIRCUIT]: (context, pk, request) =>
    jubjubChallenges.addDevice(context, pk, bytesArgument(request)),
  [REMOVE_DEVICE_CIRCUIT]: (context, pk, request) =>
    jubjubChallenges.removeDevice(context, pk, bytesArgument(request)),
  [ISSUE_GRANT_CIRCUIT]: (context, pk, request) =>
    jubjubChallenges.issueGrant(context, pk, issueGrantBinding(request.args)),
  [REVOKE_GRANT_CIRCUIT]: (context, pk, request) =>
    jubjubChallenges.revokeGrant(context, pk, bytesArgument(request)),
  [REVOKE_ALL_GRANTS_CIRCUIT]: (context, pk, request) => {
    noArguments(request);
    return jubjubChallenges.revokeAllGrants(context, pk);
  },
  [ROTATE_ENC_KEY_CIRCUIT]: (context, pk, request) =>
    jubjubChallenges.rotateEncKey(context, pk, bytesArgument(request)),
  [APPEND_INBOX_CIRCUIT]: (context, pk, request) =>
    jubjubChallenges.appendInbox(context, pk, bytesArgument(request)),
};

/**
 * Runs one authoriser operation against a JubjubDevice the key source
 * supplies. The runner owns the device lifetime: a passkey source builds
 * a fresh device per call and disposes it afterwards, while the dev
 * source reuses one in-memory device.
 */
export type JubjubDeviceRunner = <T>(
  operation: (device: JubjubDevice) => T,
) => Promise<T>;

/**
 * A PassportAuthoriser that always implements the optional batched
 * deviceCommitments lookup.
 */
export type JubjubAuthoriser = PassportAuthoriser &
  Required<Pick<PassportAuthoriser, 'deviceCommitments'>>;

/**
 * The challenge of a circuit a registered bundle describes: the request
 * names the bundle, whose descriptor of the circuit names the pure
 * circuit of its module that builds the challenge. The module is loaded
 * and the challenge resolved here, before any device key is asked for,
 * so a call nothing describes or the module cannot challenge is refused
 * without a ceremony.
 *
 * @throws {@link CircuitNotRegisteredError} when the request names no
 * bundle, its bundle describes no such circuit, or the descriptor's
 * challenge cannot be built from the module and the call.
 */
const descriptorBuilder = async (
  registry: BundleRegistry,
  request: AuthorisationRequest,
): Promise<ContextChallenge> => {
  if (request.bundleId === undefined) {
    throw new CircuitNotRegisteredError(
      `Circuit ${request.circuit} is not one of the module's own and names no account bundle.`,
    );
  }
  const bundle = registry.get(request.bundleId);
  if (!Object.hasOwn(bundle.circuits, request.circuit)) {
    throw new CircuitNotRegisteredError(
      `Account bundle '${bundle.id}' describes no circuit '${request.circuit}'.`,
    );
  }
  const { pureCircuits } = await bundle.module();
  return descriptorChallenge({
    pureCircuits,
    circuit: request.circuit,
    descriptor: bundle.circuits[request.circuit],
    args: request.args,
    witnessValues: request.witnessValues,
  });
};

/**
 * Whether `circuit` is one the module's own flows call from a device, as
 * the list names them; an inherited property name such as `constructor`
 * is not.
 */
const isDeviceAuthorisedCircuit = (
  circuit: string,
): circuit is DeviceAuthorisedCircuit =>
  (DEVICE_AUTHORISED_CIRCUITS as readonly string[]).includes(circuit);

/**
 * The challenge of one request: the fixed builder of a module circuit,
 * else the one the descriptor of the named bundle builds.
 */
const requestChallenge = async (
  registry: BundleRegistry,
  request: AuthorisationRequest,
): Promise<ContextChallenge> => {
  if (!isDeviceAuthorisedCircuit(request.circuit)) {
    return descriptorBuilder(registry, request);
  }
  const fixed = challengeBuilders[request.circuit];
  return (context, pk) => fixed(context, pk, request);
};

/**
 * A PassportAuthoriser over any JubJub device key source. Authorises the
 * device-management, grant lifecycle and encryption key circuits this
 * module calls over their fixed challenge builders, and any circuit a
 * registered bundle describes over the challenge its descriptor names,
 * when the request names the bundle. `registry` is what the host
 * registers, as for the module. Everything else is
 * refused with {@link CircuitNotRegisteredError}, the permissionless
 * `activate_initial_device_with_jubjub` included, which needs no
 * authorisation.
 */
export const createJubjubAuthoriser = (
  runWithDevice: JubjubDeviceRunner,
  registered?: PassportRegistry,
): JubjubAuthoriser => {
  const registry = createBundleRegistry(
    registered?.bundles,
    registered?.calledContracts,
  );

  const authorise = async (request: AuthorisationRequest) => {
    const toBuilder = await requestChallenge(registry, request);
    return runWithDevice(device => {
      const context: CallContext = {
        contractAddress: accountToBytes(request.account),
        authNonce: request.authNonce,
      };
      return device.sign(toBuilder(context, device.pk), request.useCounter);
    });
  };

  return {
    scheme: 'jubjub-schnorr',

    deviceCommitment: async (account, epoch, counter) =>
      runWithDevice(device =>
        DeviceCommitmentHex(
          HexBytes.fromByteArray(
            device.entryAt(accountToBytes(account), epoch, counter),
          ),
        ),
      ),

    deviceCommitments: async (account, epoch, counters) =>
      runWithDevice(device => {
        const accountBytes = accountToBytes(account);
        return counters.map(counter =>
          DeviceCommitmentHex(
            HexBytes.fromByteArray(
              device.entryAt(accountBytes, epoch, counter),
            ),
          ),
        );
      }),

    devicePublicKey: async () => runWithDevice(device => device.pk),

    authorise,
  };
};
