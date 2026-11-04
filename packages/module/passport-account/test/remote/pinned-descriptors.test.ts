import { AccAddress } from '@lace-contract/passport';
import { ByteArray, HexBytes } from '@lace-lib/util';
import { describe, expect, it } from 'vitest';

import { pinnedAccountBundle } from '../../src/acc/pinned-bundle';
import { FlowScopeError } from '../../src/remote/errors';
import {
  pinCallContractFlow,
  pinCreateAccountFlow,
  pinInstallOperationsFlow,
} from '../../src/remote/pinned-descriptors';

import type { PinnedBundle } from '../../src/acc/pinned-bundle';
import type {
  CallContractFlow,
  CreateAccountFlow,
  InstallOperationsFlow,
} from '../../src/remote/flow-descriptor';
import type { DescriptorPins } from '../../src/remote/pinned-descriptors';
import type { CalledContract } from '@lace-contract/passport';

const ACCOUNT = AccAddress('01'.repeat(32));
const TALLY_ADDRESS = 'ab'.repeat(32);
const OTHER_ADDRESS = 'cd'.repeat(32);
const TALLY_CIRCUIT = 'tally_set_with_jubjub';

const tally: CalledContract = {
  label: 'Tally',
  address: TALLY_ADDRESS,
  interface: 'Tally',
  module: async () => {
    throw new Error('The tally module is never loaded');
  },
  artefactUrl: 'http://artefacts.example.com/tally',
  pins: {},
};

/** A build with a tally call and a constructor taking the tally it reports to and a bound. */
const tallyBundle: PinnedBundle = {
  id: 'account-tally',
  operations: [...pinnedAccountBundle.operations, TALLY_CIRCUIT],
  constructorArgs: [
    { name: 'tally', label: 'Tally', type: 'contract', interface: 'Tally' },
    { name: 'bound', label: 'Bound', type: 'uint', maxval: '255' },
  ],
  circuits: {
    [TALLY_CIRCUIT]: {
      label: 'Set the tally',
      args: [
        { name: 'tally', label: 'Tally', type: 'contract', interface: 'Tally' },
        { name: 'tally_addr', type: 'contract-address', of: 'tally' },
        { name: 'value', label: 'New total', type: 'uint', maxval: '255' },
        { name: 'final', label: 'Final', type: 'bool' },
      ],
      challenge: 'challenge_tally_set_with_jubjub',
      challengeArgs: ['tally_addr', 'value'],
      witnesses: [],
    },
  },
};

const pins: DescriptorPins = {
  bundles: [pinnedAccountBundle, tallyBundle],
  calledContracts: [tally],
};

const callFlow: CallContractFlow = {
  kind: 'call-contract',
  account: ACCOUNT,
  bundleId: 'account-tally',
  circuit: TALLY_CIRCUIT,
  args: [TALLY_ADDRESS.toUpperCase(), '042', 'true'],
  callees: [TALLY_ADDRESS],
};

const unpinned = (kind: string, field: string) =>
  new FlowScopeError(kind, { descriptor: field });

describe('pinCallContractFlow', () => {
  it('resolves the bundle, the descriptor, the canonical and compact arguments and the callees from the pins', () => {
    expect(pinCallContractFlow(callFlow, pins)).toEqual({
      bundle: tallyBundle,
      descriptor: tallyBundle.circuits[TALLY_CIRCUIT],
      args: [TALLY_ADDRESS, '42', 'true'],
      decoded: [
        { bytes: ByteArray.fromHex(HexBytes(TALLY_ADDRESS)) },
        { bytes: ByteArray.fromHex(HexBytes(TALLY_ADDRESS)) },
        42n,
        true,
      ],
      callees: [tally],
    });
  });

  it.each<[string, Partial<CallContractFlow>, string]>([
    ['a bundle outside the pins', { bundleId: 'account-dex' }, 'bundleId'],
    [
      'a circuit the bundle does not describe',
      { circuit: 'constructor' },
      'circuit',
    ],
    [
      'a value outside its bound',
      { args: [TALLY_ADDRESS, '256', 'true'] },
      'args',
    ],
    [
      'a boolean that is not one',
      { args: [TALLY_ADDRESS, '1', 'yes'] },
      'args',
    ],
    ['a value too few', { args: [TALLY_ADDRESS, '1'] }, 'args'],
    ['a value too many', { args: [TALLY_ADDRESS, '1', 'true', '1'] }, 'args'],
    ['callees that are not its contract arguments', { callees: [] }, 'callees'],
    [
      'a callee the pins do not hold',
      { args: [OTHER_ADDRESS, '1', 'true'], callees: [OTHER_ADDRESS] },
      'callees',
    ],
  ])('refuses a call naming %s', (_case, carried, field) => {
    expect(() =>
      pinCallContractFlow({ ...callFlow, ...carried }, pins),
    ).toThrow(unpinned('call-contract', field));
  });

  it('refuses a callee pinned under another interface than the argument declares', () => {
    expect(() =>
      pinCallContractFlow(callFlow, {
        ...pins,
        calledContracts: [{ ...tally, interface: 'Counter' }],
      }),
    ).toThrow(unpinned('call-contract', 'callees'));
  });

  it('refuses a call on the default bundle, which describes no circuit', () => {
    expect(() =>
      pinCallContractFlow({ ...callFlow, bundleId: 'account' }, pins),
    ).toThrow(unpinned('call-contract', 'circuit'));
  });

  it('refuses a call to a circuit that reads a witness, whose value the descriptor cannot show', () => {
    const reading: PinnedBundle = {
      ...tallyBundle,
      circuits: {
        [TALLY_CIRCUIT]: {
          ...tallyBundle.circuits[TALLY_CIRCUIT],
          witnesses: [{ name: 'held_coin', label: 'Coin' }],
        },
      },
    };
    expect(() =>
      pinCallContractFlow(callFlow, {
        ...pins,
        bundles: [pinnedAccountBundle, reading],
      }),
    ).toThrow(unpinned('call-contract', 'witnesses'));
  });

  it('passes through a failure of the pins themselves, such as a bound that is not a decimal', () => {
    const misdeclared: PinnedBundle = {
      ...tallyBundle,
      circuits: {
        [TALLY_CIRCUIT]: {
          ...tallyBundle.circuits[TALLY_CIRCUIT],
          args: tallyBundle.circuits[TALLY_CIRCUIT].args.map(argument =>
            argument.type === 'uint'
              ? { ...argument, maxval: 'many' }
              : argument,
          ),
        },
      },
    };
    expect(() =>
      pinCallContractFlow(callFlow, {
        ...pins,
        bundles: [pinnedAccountBundle, misdeclared],
      }),
    ).toThrow(SyntaxError);
  });
});

describe('pinCreateAccountFlow', () => {
  const creation: CreateAccountFlow = {
    kind: 'create-account',
    lockAccount: true,
    bundleId: 'account-tally',
    constructorArgs: [TALLY_ADDRESS, '007'],
  };

  it('resolves the bundle and the canonical constructor arguments, the default bundle when none is named', () => {
    expect(pinCreateAccountFlow(creation, pins)).toEqual({
      bundle: tallyBundle,
      constructorArgs: [TALLY_ADDRESS, '7'],
    });
    expect(
      pinCreateAccountFlow({ kind: 'create-account', lockAccount: true }, pins),
    ).toEqual({ bundle: pinnedAccountBundle, constructorArgs: [] });
  });

  it.each<[string, Partial<CreateAccountFlow>, string]>([
    ['a bundle outside the pins', { bundleId: 'account-dex' }, 'bundleId'],
    [
      'a constructor argument the bundle does not declare',
      { bundleId: undefined, constructorArgs: ['7'] },
      'constructorArgs',
    ],
    [
      'a missing constructor argument',
      { constructorArgs: [TALLY_ADDRESS] },
      'constructorArgs',
    ],
    [
      'a contract argument the pins do not hold',
      { constructorArgs: [OTHER_ADDRESS, '7'] },
      'constructorArgs',
    ],
  ])('refuses a creation naming %s', (_case, carried, field) => {
    expect(() =>
      pinCreateAccountFlow({ ...creation, ...carried }, pins),
    ).toThrow(unpinned('create-account', field));
  });
});

describe('pinInstallOperationsFlow', () => {
  const install: InstallOperationsFlow = {
    kind: 'install-operations',
    account: ACCOUNT,
    operations: ['withdraw_unshielded_with_grant_k256', TALLY_CIRCUIT],
    bundleId: 'account-tally',
  };

  it('resolves the bundle whose roster holds every operation, the default when none is named', () => {
    expect(pinInstallOperationsFlow(install, pins)).toBe(tallyBundle);
    expect(
      pinInstallOperationsFlow(
        { ...install, bundleId: undefined, operations: ['deposit_shielded'] },
        pins,
      ),
    ).toBe(pinnedAccountBundle);
  });

  it('refuses an install naming a bundle outside the pins, or an operation outside the roster, naming the first', () => {
    expect(() =>
      pinInstallOperationsFlow({ ...install, bundleId: 'account-dex' }, pins),
    ).toThrow(unpinned('install-operations', 'bundleId'));
    expect(() =>
      pinInstallOperationsFlow({ ...install, bundleId: undefined }, pins),
    ).toThrow(unpinned('install-operations', 'operations[1]'));
  });
});
