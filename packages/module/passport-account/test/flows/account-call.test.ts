import { AccountContractMissingError } from '@lace-contract/passport';
import { sha256 } from '@lace-lib/crypto';
import { HexBytes } from '@lace-lib/util';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  queryAccountByBuild,
  queryAccountLedger,
  queryAccountVerifierKeys,
  readAccountByBuild,
  readAccountLedger,
} from '../../src/flows/account-call';

import type { BundleRegistry } from '../../src/acc/bundle';
import type { IndexerClient } from '../../src/infra/indexer';
import type {
  AccountBundle,
  PassportNetworkConfig,
} from '@lace-contract/passport';

const ledgerMocks = vi.hoisted(() => ({
  deserialize: vi.fn(),
}));
const indexerMocks = vi.hoisted(() => ({
  createIndexerClient: vi.fn(),
}));

vi.mock('@midnightntwrk/ledger-v9', () => ({
  ContractState: { deserialize: ledgerMocks.deserialize },
}));
vi.mock('../../src/infra/indexer', () => ({
  createIndexerClient: indexerMocks.createIndexerClient,
}));

const address = 'ac'.repeat(32);
const serialized = new Uint8Array([1, 2, 3]);
const verifierKeys = new Map<string, Uint8Array>([
  ['deposit_unshielded', new Uint8Array(16).fill(1)],
  ['add_device_with_jubjub', new Uint8Array(16).fill(2)],
]);
const providedState = { serialize: vi.fn(() => serialized), data: 'state' };

/** The ledger class of a state holding `keys`. */
const onChainState = (keys: Map<string, Uint8Array>) => ({
  operations: () => [...keys.keys()],
  operation: (operation: string) => {
    const verifierKey = keys.get(operation);
    return verifierKey ? { verifierKey } : undefined;
  },
});

const queryContractState = vi.fn();
const indexer = { queryContractState } as unknown as IndexerClient;

describe('queryAccountVerifierKeys', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryContractState.mockResolvedValue(providedState);
    ledgerMocks.deserialize.mockReturnValue(onChainState(verifierKeys));
  });

  it('hashes the verifier key of every operation the ledger holds, keyed by operation name', async () => {
    await expect(queryAccountVerifierKeys(indexer, address)).resolves.toEqual(
      new Map(
        [...verifierKeys].map(([name, key]) => [
          name,
          HexBytes.fromByteArray(sha256(key)),
        ]),
      ),
    );
    expect(queryContractState).toHaveBeenCalledExactlyOnceWith(address);
    expect(ledgerMocks.deserialize).toHaveBeenCalledExactlyOnceWith(serialized);
  });

  it('names an operation the ledger lists without a verifier key', async () => {
    ledgerMocks.deserialize.mockReturnValue({
      ...onChainState(verifierKeys),
      operation: () => undefined,
    });

    await expect(queryAccountVerifierKeys(indexer, address)).rejects.toThrow(
      `The account at ${address} lists operation 'deposit_unshielded' without a verifier key.`,
    );
  });

  it('rejects with AccountContractMissingError when the indexer serves no contract', async () => {
    queryContractState.mockResolvedValue(null);

    await expect(queryAccountVerifierKeys(indexer, address)).rejects.toThrow(
      AccountContractMissingError,
    );
    expect(ledgerMocks.deserialize).not.toHaveBeenCalled();
  });
});

/** A build whose module decodes a state into `decoded`, as a flow sees it. */
const bundleDecoding = (decoded: unknown) => {
  const ledger = vi.fn(() => decoded);
  const bundle = {
    id: 'decoding',
    module: async () => ({ ledger }),
  } as unknown as AccountBundle;
  return { bundle, ledger };
};

const network = {
  indexerUrl: 'http://indexer.test/api',
  indexerWsUrl: 'ws://indexer.test/ws',
} as PassportNetworkConfig;

describe('queryAccountLedger', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryContractState.mockResolvedValue(providedState);
  });

  it("decodes the state the indexer serves with the module of the account's build", async () => {
    const decoded = { auth_nonce: 7n };
    const { bundle, ledger } = bundleDecoding(decoded);

    await expect(queryAccountLedger(indexer, address, bundle)).resolves.toBe(
      decoded,
    );
    expect(queryContractState).toHaveBeenCalledExactlyOnceWith(address);
    expect(ledger).toHaveBeenCalledExactlyOnceWith(providedState.data);
  });

  it('rejects with AccountContractMissingError before loading the module when the indexer serves no contract', async () => {
    queryContractState.mockResolvedValue(null);
    const module = vi.fn();
    const bundle = { id: 'decoding', module } as unknown as AccountBundle;

    await expect(queryAccountLedger(indexer, address, bundle)).rejects.toThrow(
      AccountContractMissingError,
    );
    expect(module).not.toHaveBeenCalled();
  });
});

describe('readAccountLedger', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryContractState.mockResolvedValue(providedState);
    indexerMocks.createIndexerClient.mockReturnValue(indexer);
  });

  it('reads the state through a fresh indexer client for the network and returns the client with the decoded ledger', async () => {
    const decoded = { auth_nonce: 7n };
    const { bundle, ledger } = bundleDecoding(decoded);

    await expect(readAccountLedger(address, network, bundle)).resolves.toEqual({
      indexer,
      ledgerState: decoded,
    });
    expect(indexerMocks.createIndexerClient).toHaveBeenCalledExactlyOnceWith({
      indexerUrl: network.indexerUrl,
      indexerWsUrl: network.indexerWsUrl,
    });
    expect(ledger).toHaveBeenCalledExactlyOnceWith(providedState.data);
  });
});

describe('readAccountByBuild', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryContractState.mockResolvedValue(providedState);
    ledgerMocks.deserialize.mockReturnValue(onChainState(verifierKeys));
    indexerMocks.createIndexerClient.mockReturnValue(indexer);
  });

  it('resolves the build from the verifier keys on chain and decodes the state with its module', async () => {
    const decoded = { auth_nonce: 7n };
    const { bundle, ledger } = bundleDecoding(decoded);
    const resolve = vi.fn(() => bundle);
    const bundles = { resolve } as unknown as BundleRegistry;

    await expect(
      readAccountByBuild(address, network, bundles),
    ).resolves.toEqual({ indexer, bundle, ledgerState: decoded });
    expect(queryContractState).toHaveBeenCalledExactlyOnceWith(address);
    expect(resolve).toHaveBeenCalledExactlyOnceWith(
      new Map(
        [...verifierKeys].map(([name, key]) => [
          name,
          HexBytes.fromByteArray(sha256(key)),
        ]),
      ),
    );
    expect(ledger).toHaveBeenCalledExactlyOnceWith(providedState.data);
  });

  it('propagates the refusal of a build no registered bundle covers without decoding', async () => {
    const refused = new Error('no bundle covers the account');
    const bundles = {
      resolve: () => {
        throw refused;
      },
    } as unknown as BundleRegistry;

    await expect(readAccountByBuild(address, network, bundles)).rejects.toBe(
      refused,
    );
  });
});

describe('queryAccountByBuild', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryContractState.mockResolvedValue(providedState);
    ledgerMocks.deserialize.mockReturnValue(onChainState(verifierKeys));
  });

  it('resolves the build and decodes the ledger from one read of the contract state', async () => {
    const decoded = { auth_nonce: 3n };
    const { bundle, ledger } = bundleDecoding(decoded);
    const bundles = { resolve: () => bundle } as unknown as BundleRegistry;

    await expect(
      queryAccountByBuild(indexer, address, bundles),
    ).resolves.toEqual({ bundle, ledgerState: decoded });
    expect(queryContractState).toHaveBeenCalledExactlyOnceWith(address);
    expect(ledger).toHaveBeenCalledExactlyOnceWith(providedState.data);
  });

  it('refuses an address the indexer serves no contract at', async () => {
    queryContractState.mockResolvedValue(null);
    const bundles = {
      resolve: vi.fn(),
    } as unknown as BundleRegistry;

    await expect(
      queryAccountByBuild(indexer, address, bundles),
    ).rejects.toBeInstanceOf(AccountContractMissingError);
    expect(bundles.resolve).not.toHaveBeenCalled();
  });
});
