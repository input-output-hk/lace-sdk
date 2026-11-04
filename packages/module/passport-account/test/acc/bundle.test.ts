import {
  AccBindingVersion,
  AccountBundleInvalidError,
  AccountBundleUnknownError,
} from '@lace-contract/passport';
import { accountTallyBundle } from '@lace-fixture/passport-account-tally';
import { describe, expect, it } from 'vitest';

import { expectedVk } from '../../src/acc/acc-module';
import { accountBundle, createBundleRegistry } from '../../src/acc/bundle';
import { DEPLOYED_OPERATIONS } from '../../src/acc/deployed-operations';
import { accManifest } from '../../src/acc/manifest';

import type { AccountBundle, CircuitDescriptor } from '@lace-contract/passport';

const TALLY_CIRCUIT = 'tally_set_with_jubjub';
const TALLY_VK = 'aa'.repeat(32);
const COUNTER_CIRCUIT = 'counter_bump_with_jubjub';
const COUNTER_VK = 'bb'.repeat(32);

/** The verifier key hashes an account of `operations` holds on chain. */
const onChainKeys = (
  operations: readonly string[],
  keys: Readonly<Record<string, string>> = expectedVk,
): Map<string, string> =>
  new Map(operations.map(operation => [operation, keys[operation]]));

const tallyDescriptor: CircuitDescriptor = {
  label: 'Set the tally',
  args: [
    { name: 'tally', label: 'Tally', type: 'contract', interface: 'Tally' },
    { name: 'tally_address', type: 'contract-address', of: 'tally' },
    {
      name: 'value',
      label: 'Value',
      type: 'uint',
      maxval: '18446744073709551615',
    },
  ],
  challenge: 'challenge_tally_set_with_jubjub',
  challengeArgs: ['tally_address', 'value'],
  witnesses: [{ name: 'held_coin', label: 'Coin' }],
};

/** A build of the account with one more gated circuit, calling a tally. */
const tallyBundle: AccountBundle = {
  id: 'account-tally',
  bindingVersion: AccBindingVersion('0.1.0-tally.1'),
  module: async () => ({
    Contract: class {},
    ledger: () => ({}),
    pureCircuits: {},
    expectedVk: { ...expectedVk, [TALLY_CIRCUIT]: TALLY_VK },
    circuitSignatures: {},
    declaredInterfaces: {},
  }),
  manifest: {
    ...accManifest,
    bindingVersion: AccBindingVersion('0.1.0-tally.1'),
  },
  operations: [...DEPLOYED_OPERATIONS, TALLY_CIRCUIT],
  verifierKeys: { ...expectedVk, [TALLY_CIRCUIT]: TALLY_VK },
  constructorArgs: [
    { name: 'tally', label: 'Tally', type: 'contract', interface: 'Tally' },
  ],
  circuits: { [TALLY_CIRCUIT]: tallyDescriptor },
  artefactUrl: 'http://artefacts.example.com/account-tally',
};

/** The tally build with one more circuit still, so its roster is the largest. */
const counterBundle: AccountBundle = {
  ...tallyBundle,
  id: 'account-tally-counter',
  operations: [...tallyBundle.operations, COUNTER_CIRCUIT],
  verifierKeys: { ...tallyBundle.verifierKeys, [COUNTER_CIRCUIT]: COUNTER_VK },
  circuits: {},
};

const withTallyCircuit = (
  descriptor: Partial<CircuitDescriptor>,
): AccountBundle => ({
  ...tallyBundle,
  circuits: { [TALLY_CIRCUIT]: { ...tallyDescriptor, ...descriptor } },
});

describe('accountBundle', () => {
  it('is the vendored build: its manifest, roster and the generated expectedVk table', () => {
    expect(accountBundle.id).toBe('account');
    expect(accountBundle.bindingVersion).toBe(accManifest.bindingVersion);
    expect(accountBundle.manifest).toBe(accManifest);
    expect(accountBundle.operations).toBe(DEPLOYED_OPERATIONS);
    expect(accountBundle.verifierKeys).toBe(expectedVk);
    expect(accountBundle.constructorArgs).toEqual([]);
    expect(accountBundle.circuits).toEqual({});
    expect(accountBundle.artefactUrl).toBeUndefined();
  });

  it('loads the generated module with the exports the runtime checks a module by', async () => {
    const module = await accountBundle.module();

    expect(typeof module.Contract).toBe('function');
    expect(typeof module.ledger).toBe('function');
    expect(module.expectedVk).toBe(expectedVk);
    expect(Object.keys(module.pureCircuits)).toEqual(
      expect.arrayContaining([...accManifest.pureCircuits]),
    );
    expect(Object.keys(module.circuitSignatures)).toEqual(
      expect.arrayContaining([...DEPLOYED_OPERATIONS]),
    );
    expect(module.declaredInterfaces).toBeTypeOf('object');
  });
});

describe('createBundleRegistry', () => {
  it('holds the default bundle alone when nothing is registered', () => {
    const registry = createBundleRegistry();

    expect(registry.bundles).toEqual([accountBundle]);
    expect(registry.get('account')).toBe(accountBundle);
  });

  it('registers the host bundles after the default', () => {
    const registry = createBundleRegistry([tallyBundle, counterBundle]);

    expect(registry.bundles.map(bundle => bundle.id)).toEqual([
      'account',
      'account-tally',
      'account-tally-counter',
    ]);
    expect(registry.get('account-tally')).toBe(tallyBundle);
  });

  it('refuses an id it does not hold with AccountBundleUnknownError', () => {
    expect(() => createBundleRegistry().get('account-tally')).toThrow(
      AccountBundleUnknownError,
    );
    expect(() => createBundleRegistry().get('account-tally')).toThrow(
      "No account bundle 'account-tally' is registered.",
    );
  });

  it.each([
    [
      'an id with characters outside lowercase letters, digits and hyphens',
      { ...tallyBundle, id: 'Account_Tally' },
      "id 'Account_Tally' must be lowercase letters, digits and hyphens",
    ],
    [
      'an id the default bundle holds',
      { ...tallyBundle, id: 'account' },
      "id 'account' is registered twice",
    ],
    [
      'a roster without an operation of the default roster',
      {
        ...tallyBundle,
        operations: tallyBundle.operations.filter(
          operation => operation !== 'add_device_with_jubjub',
        ),
      },
      "'account-tally' lacks operation 'add_device_with_jubjub' of the default roster, which the module's own flows call",
    ],
    [
      'a manifest without a pure circuit of the default manifest',
      {
        ...tallyBundle,
        manifest: {
          ...tallyBundle.manifest,
          pureCircuits: tallyBundle.manifest.pureCircuits.slice(1),
        },
      },
      `'account-tally' lacks pure circuit '${accManifest.pureCircuits[0]}' of the default manifest, which the module's own flows build challenges with`,
    ],
    [
      'an operation of the roster without a verifier key pin',
      { ...tallyBundle, verifierKeys: expectedVk },
      `'account-tally' pins no verifier key for operation '${TALLY_CIRCUIT}' of its roster`,
    ],
    [
      'a derived constructor argument',
      {
        ...tallyBundle,
        constructorArgs: [
          ...tallyBundle.constructorArgs,
          { name: 'tally_address', type: 'contract-address', of: 'tally' },
        ],
      } as AccountBundle,
      "'account-tally' derives constructor argument 'tally_address', which a caller must supply",
    ],
    [
      'a constructor argument bounded by anything but a decimal',
      {
        ...tallyBundle,
        constructorArgs: [
          { name: 'limit', label: 'Limit', type: 'uint', maxval: '0x10' },
        ],
      } as AccountBundle,
      "'account-tally' bounds constructor argument 'limit' by '0x10', which is not a decimal integer",
    ],
    [
      'a circuit argument bounded by anything but a decimal',
      withTallyCircuit({
        args: [
          tallyDescriptor.args[0],
          tallyDescriptor.args[1],
          { name: 'value', label: 'Value', type: 'uint', maxval: '1e18' },
        ],
      }),
      `'account-tally' bounds argument of circuit '${TALLY_CIRCUIT}' 'value' by '1e18', which is not a decimal integer`,
    ],
    [
      'a descriptor of a circuit outside the roster',
      { ...tallyBundle, circuits: { tally_get: tallyDescriptor } },
      "'account-tally' describes circuit 'tally_get', which is not in its roster",
    ],
    [
      "a descriptor of one of the module's own device circuits",
      { ...tallyBundle, circuits: { add_device_with_jubjub: tallyDescriptor } },
      "'account-tally' describes circuit 'add_device_with_jubjub', which is one of the module's own and is never called through a descriptor",
    ],
    [
      'a descriptor of a permissionless deposit',
      { ...tallyBundle, circuits: { deposit_shielded: tallyDescriptor } },
      "'account-tally' describes circuit 'deposit_shielded', which is one of the module's own and is never called through a descriptor",
    ],
    [
      'a challenge argument that is neither an argument nor a witness',
      withTallyCircuit({ challengeArgs: ['tally_address', 'amount'] }),
      `'account-tally' names challenge argument 'amount' of circuit '${TALLY_CIRCUIT}', which is neither an argument nor a witness of it`,
    ],
    [
      'a derived argument naming no contract argument',
      withTallyCircuit({
        args: [
          { name: 'tally_address', type: 'contract-address', of: 'tally' },
          tallyDescriptor.args[2],
        ],
      }),
      `'account-tally' derives argument 'tally_address' of circuit '${TALLY_CIRCUIT}' from 'tally', which is not a contract argument of it`,
    ],
  ])(
    'refuses a bundle with %s with AccountBundleInvalidError naming the rule',
    (_case, bundle, rule) => {
      expect(() => createBundleRegistry([bundle])).toThrow(
        AccountBundleInvalidError,
      );
      expect(() => createBundleRegistry([bundle])).toThrow(rule);
    },
  );

  it('refuses the same id registered twice by the host', () => {
    expect(() =>
      createBundleRegistry([
        tallyBundle,
        { ...counterBundle, id: 'account-tally' },
      ]),
    ).toThrow("Account bundle id 'account-tally' is registered twice.");
  });

  it('accepts a challenge argument that names a witness', () => {
    const bundle = withTallyCircuit({ challengeArgs: ['held_coin', 'value'] });

    expect(createBundleRegistry([bundle]).get('account-tally')).toBe(bundle);
  });

  it("accepts the account-tally fixture, whose one described circuit is not the module's own", () => {
    const fixture = accountTallyBundle({
      artefactUrl: 'http://artefacts.example.com/account-tally',
      base: accountBundle,
    });

    expect(Object.keys(fixture.circuits)).toEqual([TALLY_CIRCUIT]);
    expect(createBundleRegistry([fixture]).get(fixture.id)).toBe(fixture);
  });

  describe('resolve', () => {
    it("resolves an account of the vendored build to 'account' from the roster's verifier key hashes", () => {
      const registry = createBundleRegistry([tallyBundle]);

      expect(registry.resolve(onChainKeys(DEPLOYED_OPERATIONS))).toBe(
        accountBundle,
      );
    });

    it("resolves every circuit of the generated module's expectedVk table to 'account'", () => {
      const registry = createBundleRegistry([tallyBundle]);

      expect(registry.resolve(new Map(Object.entries(expectedVk)))).toBe(
        accountBundle,
      );
    });

    it('picks the bundle whose roster is exactly the on-chain set over one whose roster is a superset', () => {
      const registry = createBundleRegistry([tallyBundle, counterBundle]);

      expect(
        registry.resolve(
          onChainKeys(tallyBundle.operations, tallyBundle.verifierKeys),
        ),
      ).toBe(tallyBundle);
      expect(
        registry.resolve(
          onChainKeys(counterBundle.operations, counterBundle.verifierKeys),
        ),
      ).toBe(counterBundle);
    });

    it('picks the smallest covering roster when no roster is exact, whatever the registration order', () => {
      const partial = onChainKeys(
        [...DEPLOYED_OPERATIONS.slice(0, 3), TALLY_CIRCUIT],
        tallyBundle.verifierKeys,
      );

      expect(
        createBundleRegistry([counterBundle, tallyBundle]).resolve(partial),
      ).toBe(tallyBundle);
      expect(
        createBundleRegistry([tallyBundle, counterBundle]).resolve(partial),
      ).toBe(tallyBundle);
    });

    it('picks the first registered among covering rosters of one size, the default ahead of the host bundles', () => {
      const twin: AccountBundle = {
        ...tallyBundle,
        id: 'account-tally-twin',
        circuits: {},
      };
      const defaultSized: AccountBundle = {
        ...tallyBundle,
        id: 'account-default-sized',
        operations: DEPLOYED_OPERATIONS,
        verifierKeys: expectedVk,
        circuits: {},
      };
      const partial = onChainKeys(
        [...DEPLOYED_OPERATIONS.slice(0, 3), TALLY_CIRCUIT],
        tallyBundle.verifierKeys,
      );

      expect(createBundleRegistry([tallyBundle, twin]).resolve(partial)).toBe(
        tallyBundle,
      );
      expect(createBundleRegistry([twin, tallyBundle]).resolve(partial)).toBe(
        twin,
      );
      expect(
        createBundleRegistry([defaultSized]).resolve(
          onChainKeys(DEPLOYED_OPERATIONS.slice(0, 3)),
        ),
      ).toBe(accountBundle);
    });

    it('picks the default over a build with more circuits for an account whose install is unfinished', () => {
      const registry = createBundleRegistry([tallyBundle]);

      expect(
        registry.resolve(onChainKeys(DEPLOYED_OPERATIONS.slice(0, 5))),
      ).toBe(accountBundle);
    });

    it('refuses an account holding an operation no bundle pins, naming it', () => {
      const registry = createBundleRegistry([tallyBundle]);
      const onChain = new Map([
        ...onChainKeys(DEPLOYED_OPERATIONS),
        [COUNTER_CIRCUIT, COUNTER_VK],
      ]);

      expect(() => registry.resolve(onChain)).toThrow(
        AccountBundleUnknownError,
      );
      expect(() => registry.resolve(onChain)).toThrow(
        `no registered account bundle pins the verifier key of '${COUNTER_CIRCUIT}'`,
      );
    });

    it('refuses an account whose verifier key of a known operation differs from every pin', () => {
      const registry = createBundleRegistry();
      const onChain = new Map([
        ...onChainKeys(DEPLOYED_OPERATIONS),
        ['add_device_with_jubjub', 'ff'.repeat(32)],
      ]);

      expect(() => registry.resolve(onChain)).toThrow(
        "no registered account bundle pins the verifier key of 'add_device_with_jubjub'",
      );
    });

    it('refuses an account whose operations are pinned by no single bundle', () => {
      const registry = createBundleRegistry([
        { ...tallyBundle, id: 'tally-only' },
        {
          ...tallyBundle,
          id: 'counter-only',
          operations: [...DEPLOYED_OPERATIONS, COUNTER_CIRCUIT],
          verifierKeys: { ...expectedVk, [COUNTER_CIRCUIT]: COUNTER_VK },
          circuits: {},
        },
      ]);
      const onChain = new Map([
        [TALLY_CIRCUIT, TALLY_VK],
        [COUNTER_CIRCUIT, COUNTER_VK],
      ]);

      expect(() => registry.resolve(onChain)).toThrow(
        'no single registered account bundle pins every verifier key of the account',
      );
    });

    it('refuses an account holding no operation at all', () => {
      expect(() => createBundleRegistry().resolve(new Map())).toThrow(
        AccountBundleUnknownError,
      );
      expect(() => createBundleRegistry().resolve(new Map())).toThrow(
        'The account holds no operation to recognise its build by.',
      );
    });
  });
});
