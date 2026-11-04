import { ADD_DEVICE_CIRCUIT, REMOVE_DEVICE_CIRCUIT } from './device-circuits';
import {
  APPEND_INBOX_CIRCUIT,
  ROTATE_ENC_KEY_CIRCUIT,
} from './enc-key-circuits';
import {
  GRANTEE_WITHDRAWAL_CIRCUITS,
  ISSUE_GRANT_CIRCUIT,
  REVOKE_ALL_GRANTS_CIRCUIT,
  REVOKE_GRANT_CIRCUIT,
} from './grant-circuits';

/** The permissionless circuit a creation runs to install the first device. */
export const ACTIVATE_INITIAL_DEVICE_CIRCUIT =
  'activate_initial_device_with_jubjub';

/** Gated circuit bases the contract exports once per authorisation arm. */
const GATED_CIRCUIT_BASES = [
  'withdraw_unshielded',
  'append_inbox',
  'withdraw_shielded',
  'withdraw_shielded_to_contract',
  'rotate_enc_key',
  'add_device',
  'remove_device',
] as const;

/** Every impure circuit of the jubjub arm, activation included. */
const JUBJUB_ARM_CIRCUITS = [
  ACTIVATE_INITIAL_DEVICE_CIRCUIT,
  ...GATED_CIRCUIT_BASES.map(base => `${base}_with_jubjub`),
];

/** Permissionless deposit circuits shared by all arms. */
const SHARED_CIRCUITS = ['deposit_unshielded', 'deposit_shielded'];

/** The grant lifecycle circuits, authorised by a jubjub device. */
const GRANT_LIFECYCLE_BASES = [
  'issue_grant',
  'revoke_grant',
  'revoke_all_grants',
] as const;

/**
 * The scoped grant circuits: the lifecycle a jubjub device authorises,
 * then the withdrawals of a jubjub grantee and of a secp256k1 grantee.
 */
const GRANT_CIRCUITS = [
  ...GRANT_LIFECYCLE_BASES.map(base => `${base}_with_jubjub`),
  ...GRANTEE_WITHDRAWAL_CIRCUITS['jubjub-schnorr'],
  ...GRANTEE_WITHDRAWAL_CIRCUITS['secp256k1-ecdsa'],
];

/**
 * The complete operation set this module deploys, in installation order:
 * the deposits, the jubjub device arm and the grant circuits. The device
 * arm is jubjub only: the compiled contract also carries k256 and P-256
 * device arms, their grant lifecycles and the recovery circuits, and none
 * of their verifier keys are installed, so on an account deployed here
 * only jubjub devices can ever authorise. A grant may name a jubjub or a
 * secp256k1 grantee, so the withdrawals of both grantee arms are
 * installed.
 */
export const DEPLOYED_OPERATIONS: readonly string[] = [
  ...SHARED_CIRCUITS,
  ...JUBJUB_ARM_CIRCUITS,
  ...GRANT_CIRCUITS,
];

/**
 * The gated circuits the module's own flows call from a device, each
 * authorised over the fixed challenge the authoriser builds for it and
 * consented to on its own screen: the device roster, the grant lifecycle
 * and the encryption key circuits.
 */
export const DEVICE_AUTHORISED_CIRCUITS = [
  ADD_DEVICE_CIRCUIT,
  REMOVE_DEVICE_CIRCUIT,
  ISSUE_GRANT_CIRCUIT,
  REVOKE_GRANT_CIRCUIT,
  REVOKE_ALL_GRANTS_CIRCUIT,
  ROTATE_ENC_KEY_CIRCUIT,
  APPEND_INBOX_CIRCUIT,
] as const;

/** A circuit the authoriser holds a fixed challenge builder for. */
export type DeviceAuthorisedCircuit =
  (typeof DEVICE_AUTHORISED_CIRCUITS)[number];

/**
 * The module's own circuits: the permissionless deposits and activation,
 * and the device-authorised circuits. A registered bundle may describe
 * none of them as callable, since a call through a descriptor would reach
 * them by the generic call consent, outside the origin binding, the
 * dedicated screens and the bookkeeping their own flows carry.
 */
export const MODULE_CIRCUITS: readonly string[] = [
  ...SHARED_CIRCUITS,
  ACTIVATE_INITIAL_DEVICE_CIRCUIT,
  ...DEVICE_AUTHORISED_CIRCUITS,
];
