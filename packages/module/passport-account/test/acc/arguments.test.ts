import {
  CallArgumentInvalidError,
  CalledContractNotRegisteredError,
} from '@lace-contract/passport';
import { describe, expect, it, vi } from 'vitest';

import { decodeArguments, normaliseArguments } from '../../src/acc/arguments';

import type {
  ArgumentDescriptor,
  CalledContract,
} from '@lace-contract/passport';

const TALLY_ADDRESS = 'ab'.repeat(32);
const BRIDGE_ADDRESS = 'cd'.repeat(32);
const SALT = 'ef'.repeat(32);
const UINT64_MAX = '18446744073709551615';

const tally: CalledContract = {
  label: 'Tally',
  address: TALLY_ADDRESS,
  interface: 'Tally',
  module: vi.fn(),
  artefactUrl: 'https://artefacts.example/tally',
  pins: {},
};
const bridge: CalledContract = {
  ...tally,
  label: 'Bridge',
  address: BRIDGE_ADDRESS,
  interface: 'Bridge',
};
const calledContracts = [tally, bridge];

/** One argument of every kind, the derived address between its contract and the rest. */
const descriptors: readonly ArgumentDescriptor[] = [
  { name: 'tally', label: 'Tally', type: 'contract', interface: 'Tally' },
  { name: 'tally_address', type: 'contract-address', of: 'tally' },
  { name: 'value', label: 'Value', type: 'uint', maxval: UINT64_MAX },
  { name: 'salt', label: 'Salt', type: 'bytes32' },
  { name: 'guarded', label: 'Guarded', type: 'bool' },
];
const values = ['AB'.repeat(32), '007', 'EF'.repeat(32), 'true'];
const canonical = [TALLY_ADDRESS, '7', SALT, 'true'];

const bytesOf = (byte: number): Uint8Array => new Uint8Array(32).fill(byte);

describe('normaliseArguments', () => {
  it('answers one canonical string per supplied argument, in declaration order, skipping derived ones', () => {
    expect(normaliseArguments(descriptors, values)).toEqual(canonical);
  });

  it('keeps canonical values as they are', () => {
    expect(normaliseArguments(descriptors, canonical)).toEqual(canonical);
  });

  it('answers nothing for a bundle declaring no argument', () => {
    expect(normaliseArguments([], [])).toEqual([]);
  });

  it('accepts an integer at its bound and strips the leading zeros of zero', () => {
    const [value] = descriptors.filter(({ type }) => type === 'uint');

    expect(normaliseArguments([value], [UINT64_MAX])).toEqual([UINT64_MAX]);
    expect(normaliseArguments([value], ['000'])).toEqual(['0']);
  });

  it('accepts an unregistered contract address, since it checks shape alone', () => {
    expect(normaliseArguments([descriptors[0]], ['11'.repeat(32)])).toEqual([
      '11'.repeat(32),
    ]);
  });
});

describe('decodeArguments', () => {
  it('answers the compact value of every argument, the derived address filled from its contract', () => {
    expect(decodeArguments(descriptors, values, calledContracts)).toEqual([
      { bytes: bytesOf(0xab) },
      { bytes: bytesOf(0xab) },
      7n,
      bytesOf(0xef),
      true,
    ]);
  });

  it('decodes a false boolean', () => {
    expect(
      decodeArguments(
        descriptors,
        [...canonical.slice(0, 3), 'false'],
        [tally],
      ),
    ).toEqual([
      { bytes: bytesOf(0xab) },
      { bytes: bytesOf(0xab) },
      7n,
      bytesOf(0xef),
      false,
    ]);
  });

  it('answers nothing for a bundle declaring no argument', () => {
    expect(decodeArguments([], [], [])).toEqual([]);
  });

  it('refuses a contract address no called contract is registered at, naming the argument', () => {
    expect(() =>
      decodeArguments(
        descriptors,
        ['11'.repeat(32), ...canonical.slice(1)],
        [tally],
      ),
    ).toThrow(
      new CalledContractNotRegisteredError(
        `No called contract at ${'11'.repeat(
          32,
        )}, which argument 'tally' names, is registered.`,
      ),
    );
  });

  it('refuses a called contract registered under another interface than the argument declares', () => {
    expect(() =>
      decodeArguments(
        descriptors,
        [BRIDGE_ADDRESS, ...canonical.slice(1)],
        calledContracts,
      ),
    ).toThrow(
      new CalledContractNotRegisteredError(
        `The called contract at ${BRIDGE_ADDRESS} is registered as 'Bridge', not as the 'Tally' that argument 'tally' takes.`,
      ),
    );
  });

  it('refuses a derived address whose contract argument is not declared', () => {
    expect(() =>
      decodeArguments(
        [{ name: 'tally_address', type: 'contract-address', of: 'tally' }],
        [],
        calledContracts,
      ),
    ).toThrow(new CallArgumentInvalidError("Argument 'tally' has no value."));
  });
});

describe.each<[string, readonly string[], string]>([
  [
    'fewer values than arguments',
    canonical.slice(0, 3),
    "Argument 'guarded' has no value.",
  ],
  [
    'more values than arguments',
    [...canonical, '1'],
    '5 values were given for 4 declared arguments.',
  ],
  [
    'a contract address that is not 64 hex characters',
    ['ab'.repeat(31), ...canonical.slice(1)],
    "Argument 'tally' must be a contract address of 64 hex characters.",
  ],
  [
    'an integer that is not decimal',
    [TALLY_ADDRESS, '-1', SALT, 'true'],
    "Argument 'value' must be a decimal integer.",
  ],
  [
    'an integer written as hex',
    [TALLY_ADDRESS, '0x10', SALT, 'true'],
    "Argument 'value' must be a decimal integer.",
  ],
  [
    'an integer above its bound',
    [TALLY_ADDRESS, '18446744073709551616', SALT, 'true'],
    `Argument 'value' must be at most ${UINT64_MAX}.`,
  ],
  [
    'bytes that are not 32',
    [TALLY_ADDRESS, '7', 'ef'.repeat(33), 'true'],
    "Argument 'salt' must be 32 bytes as 64 hex characters.",
  ],
  [
    'bytes that are not hex',
    [TALLY_ADDRESS, '7', 'zz'.repeat(32), 'true'],
    "Argument 'salt' must be 32 bytes as 64 hex characters.",
  ],
  [
    'a boolean spelt otherwise than true or false',
    [TALLY_ADDRESS, '7', SALT, 'True'],
    "Argument 'guarded' must be 'true' or 'false'.",
  ],
])('given %s', (_case, given, message) => {
  it('normaliseArguments refuses with CallArgumentInvalidError naming it', () => {
    expect(() => normaliseArguments(descriptors, given)).toThrow(
      new CallArgumentInvalidError(message),
    );
  });

  it('decodeArguments refuses the same way before resolving any contract', () => {
    expect(() => decodeArguments(descriptors, given, [])).toThrow(
      new CallArgumentInvalidError(message),
    );
  });
});
