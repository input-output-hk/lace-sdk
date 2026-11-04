import {
  CallArgumentInvalidError,
  CalledContractNotRegisteredError,
} from '@lace-contract/passport';
import { ByteArray, HexBytes } from '@lace-lib/util';

import type {
  ArgumentDescriptor,
  CalledContract,
} from '@lace-contract/passport';

/** 32 bytes as hex, in either case; a contract address has the same shape. */
export const BYTES32_HEX_PATTERN = /^[\da-f]{64}$/i;

/** A non-negative integer as a decimal string, the form every bound and count takes. */
export const DECIMAL_PATTERN = /^\d+$/;

/** An argument a caller supplies a value for; a derived address is filled in. */
type SuppliedDescriptor = Exclude<
  ArgumentDescriptor,
  { type: 'contract-address' }
>;

/** A contract address as the compact runtime takes it. */
type ContractAddress = { bytes: Uint8Array };

const isSupplied = (
  descriptor: ArgumentDescriptor,
): descriptor is SuppliedDescriptor => descriptor.type !== 'contract-address';

const invalid = (name: string, rule: string): CallArgumentInvalidError =>
  new CallArgumentInvalidError(`Argument '${name}' ${rule}`);

/**
 * The canonical string of one supplied value: lowercase hex for 32 bytes
 * and a contract address, a decimal without leading zeros within the
 * declared bound for an integer, and `true` or `false` for a boolean.
 */
const canonical = (descriptor: SuppliedDescriptor, value: string): string => {
  switch (descriptor.type) {
    case 'bytes32':
      if (!BYTES32_HEX_PATTERN.test(value)) {
        throw invalid(
          descriptor.name,
          'must be 32 bytes as 64 hex characters.',
        );
      }
      return value.toLowerCase();
    case 'contract':
      if (!BYTES32_HEX_PATTERN.test(value)) {
        throw invalid(
          descriptor.name,
          'must be a contract address of 64 hex characters.',
        );
      }
      return value.toLowerCase();
    case 'uint': {
      if (!DECIMAL_PATTERN.test(value)) {
        throw invalid(descriptor.name, 'must be a decimal integer.');
      }
      const number = BigInt(value);
      if (number > BigInt(descriptor.maxval)) {
        throw invalid(descriptor.name, `must be at most ${descriptor.maxval}.`);
      }
      return number.toString();
    }
    case 'bool':
      if (value !== 'true' && value !== 'false') {
        throw invalid(descriptor.name, "must be 'true' or 'false'.");
      }
      return value;
  }
};

/**
 * Pairs each supplied argument with its value, in declaration order: the
 * derived arguments take none, every other takes exactly one, and a value
 * beyond them belongs to no argument.
 */
const pairValues = (
  descriptors: readonly ArgumentDescriptor[],
  values: readonly string[],
): [SuppliedDescriptor, string][] => {
  const supplied = descriptors.filter(element => isSupplied(element));
  if (values.length > supplied.length) {
    throw new CallArgumentInvalidError(
      `${values.length} values were given for ${supplied.length} declared arguments.`,
    );
  }
  return supplied.map((descriptor, index) => {
    if (index >= values.length) throw invalid(descriptor.name, 'has no value.');
    return [descriptor, values[index]];
  });
};

/**
 * The canonical strings of `values`, the values a caller gives for the
 * arguments `descriptors` declare, in declaration order: lowercase hex,
 * decimals without leading zeros, `true` or `false`. A creation
 * descriptor carries them and a signer compares them, so both see one
 * spelling of each value.
 *
 * @throws {@link CallArgumentInvalidError} naming the argument whose value
 * is missing or does not fit its type, or the count of values beyond the
 * declared arguments.
 */
export const normaliseArguments = (
  descriptors: readonly ArgumentDescriptor[],
  values: readonly string[],
): string[] =>
  pairValues(descriptors, values).map(([descriptor, value]) =>
    canonical(descriptor, value),
  );

/**
 * The addresses of the called contracts the contract arguments among
 * `descriptors` name, as the `canonical` strings of the supplied
 * arguments give them, in argument order: what a call binds and a
 * descriptor must list as its callees.
 */
export const calleeAddressesOf = (
  descriptors: readonly ArgumentDescriptor[],
  canonical: readonly string[],
): string[] =>
  descriptors
    .filter(descriptor => isSupplied(descriptor))
    .flatMap((descriptor, index) =>
      descriptor.type === 'contract' ? [canonical[index]] : [],
    );

/**
 * The registered called contract a contract argument names: the one at
 * `address` on the network, registered under the interface the argument
 * declares.
 */
const registeredContract = (
  descriptor: Extract<ArgumentDescriptor, { type: 'contract' }>,
  address: string,
  calledContracts: readonly CalledContract[],
): CalledContract => {
  const contract = calledContracts.find(
    candidate => candidate.address === address,
  );
  if (!contract) {
    throw new CalledContractNotRegisteredError(
      `No called contract at ${address}, which argument '${descriptor.name}' names, is registered.`,
    );
  }
  if (contract.interface !== descriptor.interface) {
    throw new CalledContractNotRegisteredError(
      `The called contract at ${address} is registered as '${contract.interface}', not as the '${descriptor.interface}' that argument '${descriptor.name}' takes.`,
    );
  }
  return contract;
};

const toContractAddress = (hex: string): ContractAddress => ({
  bytes: ByteArray.fromHex(HexBytes(hex)),
});

/**
 * The compact values of `values`, the values a caller gives for the
 * arguments `descriptors` declare, in declaration order, as a circuit or
 * constructor takes them: 32 bytes, a bigint, a boolean, or the address
 * of a registered called contract for a contract argument and for the
 * derived address of one. A contract argument resolves against
 * `calledContracts`, the registered called contracts, by
 * address and interface.
 *
 * @throws {@link CallArgumentInvalidError} as {@link normaliseArguments}
 * does, and for a derived address naming no contract argument.
 * @throws {@link CalledContractNotRegisteredError} naming the argument
 * whose address no called contract has, or whose contract is registered
 * under another interface.
 */
export const decodeArguments = (
  descriptors: readonly ArgumentDescriptor[],
  values: readonly string[],
  calledContracts: readonly CalledContract[],
): unknown[] => {
  const canonicals = new Map(
    pairValues(descriptors, values).map(
      ([descriptor, value]) =>
        [descriptor.name, canonical(descriptor, value)] as const,
    ),
  );
  const canonicalOf = (name: string): string => {
    const value = canonicals.get(name);
    if (value === undefined) throw invalid(name, 'has no value.');
    return value;
  };
  return descriptors.map(descriptor => {
    switch (descriptor.type) {
      case 'bytes32':
        return ByteArray.fromHex(HexBytes(canonicalOf(descriptor.name)));
      case 'uint':
        return BigInt(canonicalOf(descriptor.name));
      case 'bool':
        return canonicalOf(descriptor.name) === 'true';
      case 'contract':
        return toContractAddress(
          registeredContract(
            descriptor,
            canonicalOf(descriptor.name),
            calledContracts,
          ).address,
        );
      case 'contract-address':
        return toContractAddress(canonicalOf(descriptor.of));
    }
  });
};
