import { MAX_DEVICE_ENTRIES } from '../acc/envelopes';

import {
  decodeAccount,
  decodeBoolean,
  decodeBundleId,
  decodeBytes,
  decodeDeviceReader,
  decodeGrantId,
  decodeGrantScope,
  decodeScopeSalt,
  decodeSlot,
  encodeBytes,
  MalformedPayloadError,
} from './codec';

import type {
  AccAddress,
  DeviceReader,
  GrantId,
  GrantScopeInput,
  GrantScopeSalt,
  GrantSlot,
} from '@lace-contract/passport';
import type { SignerFlow, SignerFlowKind } from '@lace-lib/passkey';

/** An issue-grant descriptor once read: every field present and typed. */
export type IssueGrantFlow = {
  kind: 'issue-grant';
  account: AccAddress;
  grantId: GrantId;
  scope: GrantScopeInput;
  slot: GrantSlot;
  scopeSalt: GrantScopeSalt;
  scopeDigest: string;
  /** The device entries a read grant's rotation may seal to; absent otherwise. */
  devices?: string[];
};

/**
 * What a revoke descriptor names: the account whose grants it revokes,
 * and about the encryption key nothing, a read flag that is false, or a
 * rotation of that account's key to the device entries it lists.
 */
type RevokeRotation = { account: AccAddress } & (
  | { read: true; devices: string[] }
  | { read?: false; devices?: undefined }
);

/**
 * A device descriptor once read: the entry it targets, the account it
 * acts on and, for an enrolment that hands the joining device the
 * account keys, that device's reader and device keys, with the device
 * entries a rotation ahead of it may seal to when a read grant is live.
 */
type DeviceFlow =
  | {
      kind: 'add-device';
      commitmentHex: string;
      account: AccAddress;
      reader?: DeviceReader;
      devices?: string[];
    }
  | {
      kind: 'remove-device';
      commitmentHex: string;
      account: AccAddress;
      devices: string[];
    };

/**
 * An install descriptor once read: the account it upgrades, the bundle
 * of its build when the install names one, the default otherwise, and
 * the operations whose verifier keys it installs, in the order the flow
 * installs them. The descriptor is held to each field's shape alone; the
 * roster the operations must belong to is the bundle's, which the signer
 * checks against what it pins.
 */
export type InstallOperationsFlow = {
  kind: 'install-operations';
  account: AccAddress;
  operations: string[];
  bundleId?: string;
};

/**
 * A creation descriptor once read: its lock choice and, for a creation
 * from a bundle other than the default, the bundle it names and the
 * values of that bundle's declared constructor arguments, as the strings
 * consent shows. The descriptor is held to the id's shape alone; the
 * bundle it names is the dApp's claim until the signer checks it against
 * what it pins.
 */
export type CreateAccountFlow = {
  kind: 'create-account';
  lockAccount: boolean;
  bundleId?: string;
  constructorArgs?: string[];
};

/**
 * A call descriptor once read: the account it calls from, the bundle of
 * that account's build and the circuit of it to call, the values of the
 * circuit's declared arguments as the canonical strings consent shows,
 * and the addresses of the called contracts those arguments name. The
 * descriptor is held to each field's shape alone; the bundle, the
 * circuit and the callees it names are the dApp's claim until the signer
 * checks them against what it pins.
 */
export type CallContractFlow = {
  kind: 'call-contract';
  account: AccAddress;
  bundleId: string;
  circuit: string;
  args: string[];
  callees: string[];
};

/**
 * A flow descriptor as the signer holds it: each kind with exactly the
 * fields it binds, so a session check and a consent screen read them
 * without a second look. A revoke flow carries the `account` whose
 * grants it revokes, and `read` only when the revocation rotates that
 * account's encryption key; every rotating flow carries the device
 * entries whose devices the new secret may be sealed to. A creation
 * carries its lock choice with the bundle and constructor arguments it
 * names, an install the operations it installs, and a contract call the
 * bundle, circuit, arguments and callees it names.
 */
export type DecodedSignerFlow =
  | CallContractFlow
  | CreateAccountFlow
  | DeviceFlow
  | InstallOperationsFlow
  | IssueGrantFlow
  | { kind: 'read-holdings' | 'sign-in' }
  | (RevokeRotation & { kind: 'revoke-all-grants' })
  | (RevokeRotation & { kind: 'revoke-grant'; grantId: GrantId });

const FLOW_KINDS: ReadonlySet<string> = new Set<SignerFlowKind>([
  'add-device',
  'call-contract',
  'create-account',
  'install-operations',
  'issue-grant',
  'read-holdings',
  'remove-device',
  'revoke-all-grants',
  'revoke-grant',
  'sign-in',
]);

type DescriptorField = Exclude<keyof SignerFlow, 'kind'>;

const DESCRIPTOR_FIELDS: readonly DescriptorField[] = [
  'commitmentHex',
  'account',
  'grantId',
  'scope',
  'slot',
  'scopeSalt',
  'scopeDigest',
  'read',
  'reader',
  'devices',
  'lockAccount',
  'bundleId',
  'constructorArgs',
  'operations',
  'circuit',
  'args',
  'callees',
];

const ISSUE_GRANT_FIELDS: readonly DescriptorField[] = [
  'account',
  'grantId',
  'scope',
  'slot',
  'scopeSalt',
  'scopeDigest',
  'devices',
];

/** The descriptor fields each flow kind carries; any other is refused. */
const FLOW_FIELDS: Record<SignerFlowKind, ReadonlySet<DescriptorField>> = {
  'create-account': new Set(['lockAccount', 'bundleId', 'constructorArgs']),
  'install-operations': new Set(['account', 'operations', 'bundleId']),
  'call-contract': new Set([
    'account',
    'bundleId',
    'circuit',
    'args',
    'callees',
  ]),
  'read-holdings': new Set(),
  'sign-in': new Set(),
  'add-device': new Set(['commitmentHex', 'account', 'reader', 'devices']),
  'remove-device': new Set(['commitmentHex', 'account', 'devices']),
  'issue-grant': new Set(ISSUE_GRANT_FIELDS),
  'revoke-grant': new Set(['grantId', 'read', 'account', 'devices']),
  'revoke-all-grants': new Set(['read', 'account', 'devices']),
};

const COMMITMENT_HEX_PATTERN = /^[\da-f]{64}$/i;
/** A contract address as a call descriptor carries it: canonical, so lowercase. */
const CALLEE_ADDRESS_PATTERN = /^[\da-f]{64}$/;
/** A circuit name as the compiler admits it. */
const CIRCUIT_NAME_PATTERN = /^[A-Za-z0-9_]+$/;
const SCOPE_DIGEST_LENGTH = 32;
/**
 * The longest value an argument may carry: a 32-byte hex, a decimal or a
 * boolean each fit well within it, so a longer one is not a value any
 * descriptor could accept.
 */
const MAX_ARGUMENT_LENGTH = 128;
/**
 * The most called contracts one call may name: a circuit takes at most a
 * handful of contract arguments, so more is not a call any descriptor
 * could describe.
 */
const MAX_CALLEES = 8;
/**
 * The most operations one install may name: a build of the account has a
 * few dozen circuits, so more is not a roster any bundle could have.
 */
const MAX_INSTALL_OPERATIONS = 64;

/**
 * The commitment a device flow targets, which is what the user approves
 * and what the authorisation is checked against: 32 bytes of hex, kept
 * lowercase so it compares and shows one way.
 */
const decodeCommitment = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !COMMITMENT_HEX_PATTERN.test(value)) {
    throw new MalformedPayloadError(field);
  }
  return value.toLowerCase();
};

/**
 * The device entries a rotating flow names, those whose devices may keep
 * reading: at most {@link MAX_DEVICE_ENTRIES}, each 32 bytes of hex, kept
 * lowercase, none twice, and never `except`, the entry a removal takes
 * out.
 */
const decodeDevices = (
  value: unknown,
  field: string,
  except?: string,
): string[] => {
  if (!Array.isArray(value) || value.length > MAX_DEVICE_ENTRIES) {
    throw new MalformedPayloadError(field);
  }
  const devices = value.map((item, index) =>
    decodeCommitment(item, `${field}[${index}]`),
  );
  if (
    new Set(devices).size !== devices.length ||
    (except !== undefined && devices.includes(except))
  ) {
    throw new MalformedPayloadError(field);
  }
  return devices;
};

/** The circuit a call names, in the shape of a compiled circuit's name. */
const decodeCircuitName = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !CIRCUIT_NAME_PATTERN.test(value)) {
    throw new MalformedPayloadError(field);
  }
  return value;
};

/**
 * The operations an install names: at least one, at most
 * {@link MAX_INSTALL_OPERATIONS}, each in the shape of a circuit name and
 * none twice, so the user approves exactly the verifier keys the flow
 * may install. Which roster they must belong to is the bundle's to say,
 * once the session resolves it.
 */
const decodeInstallOperations = (value: unknown, field: string): string[] => {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_INSTALL_OPERATIONS
  ) {
    throw new MalformedPayloadError(field);
  }
  const operations = value.map((operation: unknown, index) =>
    decodeCircuitName(operation, `${field}[${index}]`),
  );
  if (new Set(operations).size !== operations.length) {
    throw new MalformedPayloadError(field);
  }
  return operations;
};

/**
 * The argument values a creation or a call names: strings, each short
 * enough to be a value of some argument type. What each one must look
 * like is the bundle's to say, once the session resolves it.
 */
const decodeArgumentValues = (value: unknown, field: string): string[] => {
  if (!Array.isArray(value)) throw new MalformedPayloadError(field);
  return value.map((argument: unknown, index) => {
    if (typeof argument !== 'string' || argument.length > MAX_ARGUMENT_LENGTH) {
      throw new MalformedPayloadError(`${field}[${index}]`);
    }
    return argument;
  });
};

/**
 * A creation descriptor: its lock choice, which it must carry, and the
 * bundle and constructor arguments it names, each kept only when carried.
 */
const decodeCreateAccountFlow = (
  fields: Record<string, unknown>,
): CreateAccountFlow => ({
  kind: 'create-account',
  lockAccount: decodeBoolean(fields.lockAccount, 'flow.lockAccount'),
  ...(fields.bundleId === undefined
    ? {}
    : { bundleId: decodeBundleId(fields.bundleId, 'flow.bundleId') }),
  ...(fields.constructorArgs === undefined
    ? {}
    : {
        constructorArgs: decodeArgumentValues(
          fields.constructorArgs,
          'flow.constructorArgs',
        ),
      }),
});

/**
 * The called contracts a call names: at most {@link MAX_CALLEES}, each
 * an address of 64 lowercase hex characters, none twice, so the user
 * approves exactly the contracts the call may reach.
 */
const decodeCallees = (value: unknown, field: string): string[] => {
  if (!Array.isArray(value) || value.length > MAX_CALLEES) {
    throw new MalformedPayloadError(field);
  }
  const callees = value.map((callee: unknown, index) => {
    if (typeof callee !== 'string' || !CALLEE_ADDRESS_PATTERN.test(callee)) {
      throw new MalformedPayloadError(`${field}[${index}]`);
    }
    return callee;
  });
  if (new Set(callees).size !== callees.length) {
    throw new MalformedPayloadError(field);
  }
  return callees;
};

/**
 * A call descriptor: the account, bundle, circuit, argument values and
 * callees it names, each of which it must carry.
 */
const decodeCallContractFlow = (
  fields: Record<string, unknown>,
): CallContractFlow => ({
  kind: 'call-contract',
  account: decodeAccount(fields.account, 'flow.account'),
  bundleId: decodeBundleId(fields.bundleId, 'flow.bundleId'),
  circuit: decodeCircuitName(fields.circuit, 'flow.circuit'),
  args: decodeArgumentValues(fields.args, 'flow.args'),
  callees: decodeCallees(fields.callees, 'flow.callees'),
});

/**
 * The account a revoke descriptor must name, its read flag, kept only
 * when it is carried, and the device entries a rotating revocation must
 * name, which any other must leave out.
 */
const decodeRevokeRotation = (
  fields: Record<string, unknown>,
): RevokeRotation => {
  const account = decodeAccount(fields.account, 'flow.account');
  if (fields.read === undefined || !decodeBoolean(fields.read, 'flow.read')) {
    if (fields.devices !== undefined) {
      throw new MalformedPayloadError('flow.devices');
    }
    return fields.read === undefined ? { account } : { account, read: false };
  }
  return {
    account,
    read: true,
    devices: decodeDevices(fields.devices, 'flow.devices'),
  };
};

/**
 * An issue descriptor: a read grant's must name the device entries its
 * rotation may seal to, and any other must leave them out.
 */
const decodeIssueGrantFlow = (
  value: Record<string, unknown>,
): IssueGrantFlow => {
  const scope = decodeGrantScope(value.scope, 'flow.scope');
  if (scope.read !== true && value.devices !== undefined) {
    throw new MalformedPayloadError('flow.devices');
  }
  return {
    kind: 'issue-grant',
    account: decodeAccount(value.account, 'flow.account'),
    grantId: decodeGrantId(value.grantId, 'flow.grantId'),
    scope,
    slot: decodeSlot(value.slot, 'flow.slot'),
    scopeSalt: decodeScopeSalt(value.scopeSalt, 'flow.scopeSalt'),
    scopeDigest: encodeBytes(
      decodeBytes(value.scopeDigest, 'flow.scopeDigest', SCOPE_DIGEST_LENGTH),
    ),
    ...(scope.read === true
      ? { devices: decodeDevices(value.devices, 'flow.devices') }
      : {}),
  };
};

/**
 * Reads the flow descriptor the dApp sent with its flow-open. The kind
 * decides what the session will serve and the other fields are what the
 * user approves and what the flow's authorisation is checked against, so
 * none is trusted as sent: each kind must carry exactly its own fields,
 * each in the shape the flow binds. The signer handlers read a descriptor
 * through this before they open a session, and a signer page reads it
 * the same way before it asks consent, so the two never disagree on what
 * a descriptor says.
 *
 * @throws {@link MalformedPayloadError} naming the first field that
 * cannot be read.
 */
export const decodeSignerFlow = (value: unknown): DecodedSignerFlow => {
  if (typeof value !== 'object' || value === null) {
    throw new MalformedPayloadError('flow');
  }
  const fields = value as Record<string, unknown>;
  const { kind } = fields;
  if (typeof kind !== 'string' || !FLOW_KINDS.has(kind)) {
    throw new MalformedPayloadError('flow.kind');
  }
  const flowKind = kind as SignerFlowKind;
  const carried = FLOW_FIELDS[flowKind];
  for (const field of DESCRIPTOR_FIELDS) {
    if (!carried.has(field) && fields[field] !== undefined) {
      throw new MalformedPayloadError(`flow.${field}`);
    }
  }
  switch (flowKind) {
    case 'add-device':
      if (fields.devices !== undefined && fields.reader === undefined) {
        throw new MalformedPayloadError('flow.devices');
      }
      return {
        kind: flowKind,
        commitmentHex: decodeCommitment(
          fields.commitmentHex,
          'flow.commitmentHex',
        ),
        account: decodeAccount(fields.account, 'flow.account'),
        ...(fields.reader === undefined
          ? {}
          : { reader: decodeDeviceReader(fields.reader, 'flow.reader') }),
        ...(fields.devices === undefined
          ? {}
          : { devices: decodeDevices(fields.devices, 'flow.devices') }),
      };
    case 'remove-device': {
      const commitmentHex = decodeCommitment(
        fields.commitmentHex,
        'flow.commitmentHex',
      );
      return {
        kind: flowKind,
        commitmentHex,
        account: decodeAccount(fields.account, 'flow.account'),
        devices: decodeDevices(fields.devices, 'flow.devices', commitmentHex),
      };
    }
    case 'issue-grant':
      return decodeIssueGrantFlow(fields);
    case 'revoke-grant':
      return {
        kind: flowKind,
        grantId: decodeGrantId(fields.grantId, 'flow.grantId'),
        ...decodeRevokeRotation(fields),
      };
    case 'revoke-all-grants':
      return { kind: flowKind, ...decodeRevokeRotation(fields) };
    case 'create-account':
      return decodeCreateAccountFlow(fields);
    case 'call-contract':
      return decodeCallContractFlow(fields);
    case 'install-operations':
      return {
        kind: flowKind,
        account: decodeAccount(fields.account, 'flow.account'),
        operations: decodeInstallOperations(
          fields.operations,
          'flow.operations',
        ),
        ...(fields.bundleId === undefined
          ? {}
          : { bundleId: decodeBundleId(fields.bundleId, 'flow.bundleId') }),
      };
    case 'read-holdings':
    case 'sign-in':
      return { kind: flowKind };
  }
};
