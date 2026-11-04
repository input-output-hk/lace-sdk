import { AccountBundleInvalidError } from '@lace-contract/passport';
import { describe, expect, it } from 'vitest';

import { DEPLOYED_OPERATIONS } from '../../src/acc/deployed-operations';
import { accManifest } from '../../src/acc/manifest';
import { createPassportRegistry } from '../../src/acc/registry';

import type {
  AccountBundle,
  CalledContract,
  CalledContractPins,
} from '@lace-contract/passport';

const TALLY_ADDRESS = 'ab'.repeat(32);

const tallyPins: CalledContractPins = {
  set: {
    name: 'set',
    keyLocation: 'keys/set',
    zkirSha256: '11'.repeat(32),
    proverKeySha256: '22'.repeat(32),
    verifierKeySha256: '33'.repeat(32),
  },
};

const tally: CalledContract = {
  label: 'Tally',
  address: TALLY_ADDRESS,
  interface: 'Tally',
  module: async () => ({
    Contract: class {},
    pureCircuits: {},
    expectedVk: {},
    circuitSignatures: {},
    declaredInterfaces: {},
  }),
  artefactUrl: 'http://localhost:5173/zk/tally',
  pins: tallyPins,
};

/** A build of the default account with one more circuit, described nowhere. */
const tallyBundle: AccountBundle = {
  id: 'account-tally',
  bindingVersion: accManifest.bindingVersion,
  module: async () => {
    throw new Error('The tally module is never loaded');
  },
  manifest: accManifest,
  operations: [...DEPLOYED_OPERATIONS, 'tally_set_with_jubjub'],
  verifierKeys: Object.fromEntries(
    [...DEPLOYED_OPERATIONS, 'tally_set_with_jubjub'].map(operation => [
      operation,
      'aa'.repeat(32),
    ]),
  ),
  constructorArgs: [],
  circuits: {},
};

/** The registry with the given called contracts registered. */
const withCalled = (...calledContracts: CalledContract[]) =>
  createPassportRegistry({ calledContracts });

describe('createPassportRegistry', () => {
  it('registers nothing beside the default bundle by default', () => {
    expect(createPassportRegistry()).toEqual({
      bundles: [],
      calledContracts: [],
    });
  });

  it('holds the bundles and called contracts it was given', () => {
    const registry = createPassportRegistry({
      bundles: [tallyBundle],
      calledContracts: [tally],
    });

    expect(registry.bundles).toEqual([tallyBundle]);
    expect(registry.calledContracts).toEqual([tally]);
  });

  describe('bundles', () => {
    it("refuses a bundle under the default's id", () => {
      expect(() =>
        createPassportRegistry({
          bundles: [{ ...tallyBundle, id: 'account' }],
        }),
      ).toThrow("Account bundle id 'account' is registered twice.");
    });

    it('refuses the same id registered twice', () => {
      expect(() =>
        createPassportRegistry({ bundles: [tallyBundle, tallyBundle] }),
      ).toThrow("Account bundle id 'account-tally' is registered twice.");
    });

    it('refuses a bundle that breaks a rule with AccountBundleInvalidError naming it', () => {
      const bundle = {
        ...tallyBundle,
        operations: ['tally_set_with_jubjub'],
      };

      expect(() => createPassportRegistry({ bundles: [bundle] })).toThrow(
        AccountBundleInvalidError,
      );
      expect(() => createPassportRegistry({ bundles: [bundle] })).toThrow(
        `'account-tally' lacks operation '${DEPLOYED_OPERATIONS[0]}' of the default roster`,
      );
    });
  });

  describe('called contracts', () => {
    it('accepts a well formed called contract', () => {
      expect(withCalled(tally).calledContracts).toEqual([tally]);
    });

    it.each(['AB'.repeat(32), 'ab'.repeat(31), 'zz'.repeat(32), ''])(
      'refuses the address %j, which no call could name canonically',
      address => {
        expect(() => withCalled({ ...tally, address })).toThrow(
          `The Passport registry calledContracts[0].address "${address}" is not a contract address: it must be 64 lowercase hex characters.`,
        );
      },
    );

    it('refuses two called contracts at one address', () => {
      expect(() =>
        withCalled(tally, { ...tally, label: 'Tally again' }),
      ).toThrow(
        `The Passport registry calledContracts[1].address "${TALLY_ADDRESS}" is registered twice.`,
      );
    });

    it.each(['label', 'interface'] as const)(
      'refuses a called contract whose %s is empty',
      field => {
        expect(() => withCalled({ ...tally, [field]: '' })).toThrow(
          `The Passport registry calledContracts[0].${field} must not be empty.`,
        );
      },
    );

    it.each(['file:///tmp/tally', 'artefacts/tally'])(
      'refuses the artefact URL %j, which the clients cannot download from',
      artefactUrl => {
        expect(() => withCalled({ ...tally, artefactUrl })).toThrow(
          `The Passport registry calledContracts[0].artefactUrl "${artefactUrl}" must be an absolute http: or https: URL.`,
        );
      },
    );

    it.each([
      'name',
      'keyLocation',
      'zkirSha256',
      'proverKeySha256',
      'verifierKeySha256',
    ] as const)('refuses a pin without its %s', field => {
      const pins = { set: { ...tallyPins.set, [field]: '' } };

      expect(() => withCalled({ ...tally, pins })).toThrow(
        `The Passport registry calledContracts[0].pins.set has no ${field}.`,
      );
    });
  });
});
