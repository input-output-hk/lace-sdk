import {
  CallArgumentInvalidError,
  CalledContractNotRegisteredError,
} from '@lace-contract/passport';

import {
  calleeAddressesOf,
  decodeArguments,
  normaliseArguments,
} from '../acc/arguments';
import { ACCOUNT_BUNDLE_ID } from '../acc/manifest';

import { FlowScopeError } from './errors';

import type {
  CallContractFlow,
  CreateAccountFlow,
  InstallOperationsFlow,
} from './flow-descriptor';
import type { PinnedBundle } from '../acc/pinned-bundle';
import type {
  CalledContract,
  CircuitDescriptor,
} from '@lace-contract/passport';

/**
 * What a signer pins descriptors against: every bundle a descriptor may
 * name, the default among them, and the called contracts of the networks
 * it serves. A contract address belongs to one deployment, so the callees
 * of every network are held together and found by address.
 */
export type DescriptorPins = {
  bundles: readonly PinnedBundle[];
  calledContracts: readonly CalledContract[];
};

/**
 * A call descriptor held to what the signer pins: the bundle and the
 * descriptor of the circuit it names, the canonical strings of its
 * arguments, the compact values an authorisation of the call must carry,
 * in declaration order, and the registered called contracts its contract
 * arguments name, in argument order.
 */
export type PinnedCall = {
  bundle: PinnedBundle;
  descriptor: CircuitDescriptor;
  args: string[];
  decoded: unknown[];
  callees: CalledContract[];
};

/** A creation descriptor held to what the signer pins: its bundle and canonical constructor arguments. */
type PinnedCreation = {
  bundle: PinnedBundle;
  constructorArgs: string[];
};

type PinnedFlow = CallContractFlow | CreateAccountFlow | InstallOperationsFlow;

const unpinned = (flow: PinnedFlow, field: string): FlowScopeError =>
  new FlowScopeError(flow.kind, { descriptor: field });

/**
 * The pinned bundle a descriptor names, the default when it names none.
 *
 * @throws {@link FlowScopeError} naming `bundleId` when no pinned bundle
 * has the id.
 */
const pinnedBundle = (
  flow: PinnedFlow,
  { bundles }: DescriptorPins,
): PinnedBundle => {
  const id = flow.bundleId ?? ACCOUNT_BUNDLE_ID;
  const bundle = bundles.find(candidate => candidate.id === id);
  if (!bundle) throw unpinned(flow, 'bundleId');
  return bundle;
};

/**
 * Runs one argument reading, refusing the descriptor field it reads when
 * a value does not fit its argument or names no registered contract.
 * Any other failure is the pins' own, not the descriptor's, and passes
 * through.
 */
const pinned = <T>(flow: PinnedFlow, field: string, read: () => T): T => {
  try {
    return read();
  } catch (error) {
    if (
      error instanceof CallArgumentInvalidError ||
      error instanceof CalledContractNotRegisteredError
    ) {
      throw unpinned(flow, field);
    }
    throw error;
  }
};

/**
 * Holds a call descriptor to what the signer pins: the bundle it names
 * must be pinned and describe the circuit, the circuit must read no
 * witness, the arguments must fit the descriptor, the callees must be
 * exactly the addresses the contract arguments name, in order, and each
 * must be a registered called contract of the interface the descriptor
 * declares. Nothing of the descriptor is taken as sent: the circuit's
 * label, its arguments' labels and types and each callee's label come
 * from the pins, so a consent screen shows, and a session binds, what
 * the signer itself knows about the call. A witness is chosen by the
 * dApp at call time and the descriptor carries no value for it, so a
 * circuit that reads one would be approved without the user seeing what
 * it spends; it is refused until the descriptor carries the values.
 *
 * @throws {@link FlowScopeError} naming the descriptor field that falls
 * outside the pins.
 */
export const pinCallContractFlow = (
  flow: CallContractFlow,
  pins: DescriptorPins,
): PinnedCall => {
  const bundle = pinnedBundle(flow, pins);
  if (!Object.hasOwn(bundle.circuits, flow.circuit)) {
    throw unpinned(flow, 'circuit');
  }
  const descriptor = bundle.circuits[flow.circuit];
  if (descriptor.witnesses.length > 0) throw unpinned(flow, 'witnesses');
  const args = pinned(flow, 'args', () =>
    normaliseArguments(descriptor.args, flow.args),
  );
  const named = calleeAddressesOf(descriptor.args, args);
  if (named.join(',') !== flow.callees.join(',')) {
    throw unpinned(flow, 'callees');
  }
  const decoded = pinned(flow, 'callees', () =>
    decodeArguments(descriptor.args, args, pins.calledContracts),
  );
  const callees = named.map(address => {
    const callee = pins.calledContracts.find(
      candidate => candidate.address === address,
    );
    if (!callee) throw unpinned(flow, 'callees');
    return callee;
  });
  return { bundle, descriptor, args, decoded, callees };
};

/**
 * Holds a creation descriptor to what the signer pins: the bundle it
 * names, the default when it names none, must be pinned, and the
 * constructor arguments it carries, none when it carries none, must fit
 * that bundle's declared constructor arguments, a contract argument
 * naming a registered called contract.
 *
 * @throws {@link FlowScopeError} naming the descriptor field that falls
 * outside the pins.
 */
export const pinCreateAccountFlow = (
  flow: CreateAccountFlow,
  pins: DescriptorPins,
): PinnedCreation => {
  const bundle = pinnedBundle(flow, pins);
  const constructorArgs = pinned(flow, 'constructorArgs', () => {
    const args = flow.constructorArgs ?? [];
    decodeArguments(bundle.constructorArgs, args, pins.calledContracts);
    return normaliseArguments(bundle.constructorArgs, args);
  });
  return { bundle, constructorArgs };
};

/**
 * Holds an install descriptor to what the signer pins: the bundle it
 * names, the default when it names none, must be pinned, and every
 * operation must be in that bundle's roster.
 *
 * @throws {@link FlowScopeError} naming `bundleId`, or the first
 * operation outside the roster.
 */
export const pinInstallOperationsFlow = (
  flow: InstallOperationsFlow,
  pins: DescriptorPins,
): PinnedBundle => {
  const bundle = pinnedBundle(flow, pins);
  const outside = flow.operations.findIndex(
    operation => !bundle.operations.includes(operation),
  );
  if (outside !== -1) throw unpinned(flow, `operations[${outside}]`);
  return bundle;
};
