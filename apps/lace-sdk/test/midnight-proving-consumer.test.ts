import {
  MidnightAccountId,
  MidnightNetworkId,
  MidnightSDKNetworkIds,
} from '@lace-contract/midnight-context';
import * as stubData from '@lace-contract/midnight-context/src/stub-data';
import { createWasmCircuitProvider } from '@lace-lib/vendor/wasm-proof-compute';
import * as v8 from '@midnightntwrk/ledger-v8';
import * as v9 from '@midnightntwrk/ledger-v9';
import { ProtocolVersion } from '@midnightntwrk/wallet-sdk-abstractions';
import { BehaviorSubject, of, TimeoutError } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { getMidnightProvingProvider } from '../src/midnight-proving-provider';

import { pageModeEngineAccess } from './midnight-engine-access-fake';

import type { WalletWithMidnight } from '../src/midnight-wallet';
import type {
  MidnightWallet,
  MidnightWalletsByAccountId,
} from '@lace-contract/midnight-context';

const networkId = MidnightSDKNetworkIds.Preview;
const accountId = MidnightAccountId(stubData.walletId, 0, networkId);
const account = {
  ...stubData.midnightAccount,
  accountId,
  blockchainNetworkId: MidnightNetworkId(networkId),
  blockchainSpecific: {
    ...stubData.midnightAccount.blockchainSpecific,
    networkId,
  },
};
const fixture = () => {
  const registry = new BehaviorSubject<MidnightWalletsByAccountId>({});
  const networks = new BehaviorSubject([MidnightNetworkId(networkId)]);
  const wallet: WalletWithMidnight = {
    stateObservables: {
      wallets: {
        selectAll$: new BehaviorSubject([
          { ...stubData.midnightWallet, accounts: [account] },
        ]),
      },
      network: { selectAllActiveNetworkIds$: networks },
    } as unknown as WalletWithMidnight['stateObservables'],
    _loadModules: (async () => [
      pageModeEngineAccess(registry),
    ]) as unknown as WalletWithMidnight['_loadModules'],
  };
  const transport = {
    check: vi.fn(async () => new Uint8Array([1])),
    prove: vi.fn(async () => new Uint8Array([2])),
  };
  const engine = {
    accountId,
    state: () =>
      of({ activeProtocolVersion: ProtocolVersion.MinSupportedVersion }),
    proofCircuitProvider: { check: transport.check, prove: transport.prove },
  } as unknown as MidnightWallet;
  registry.next({ [accountId]: engine });
  return { wallet, registry, networks, transport, engine };
};
const keyMaterialProvider = () => ({
  getProverKey: vi.fn(async () => new Uint8Array([3])),
  getVerifierKey: vi.fn(async () => new Uint8Array([4])),
  getZKIR: vi.fn(async () => new Uint8Array([5])),
});

afterEach(() => vi.unstubAllGlobals());

describe('public Midnight proving provider compatibility', () => {
  it.each([
    ['v8', v8],
    ['v9', v9],
  ] as const)('is accepted by the real %s ledger', async (_, ledger) => {
    const { wallet, transport } = fixture();
    const provider = (
      await getMidnightProvingProvider(wallet, {
        keyMaterialProvider: keyMaterialProvider(),
      })
    ).unwrap();
    // Empty transactions validate the provider contract without downloading keys or creating a proof.
    await expect(
      ledger.Transaction.fromParts('undeployed').prove(
        provider,
        ledger.CostModel.initialCostModel(),
      ),
    ).resolves.toBeDefined();
    expect(transport.check).not.toHaveBeenCalled();
    expect(transport.prove).not.toHaveBeenCalled();
  });

  it('looks up raw circuit material locally without consulting the engine again', async () => {
    const { wallet, registry, transport } = fixture();
    const provider = (
      await getMidnightProvingProvider(wallet, {
        keyMaterialProvider: keyMaterialProvider(),
      })
    ).unwrap();
    registry.next({});
    await expect(provider.lookupKey('contract')).resolves.toEqual({
      proverKey: new Uint8Array([3]),
      verifierKey: new Uint8Array([4]),
      ir: new Uint8Array([5]),
    });
    expect(transport.check).not.toHaveBeenCalled();
    expect(transport.prove).not.toHaveBeenCalled();
  });

  it('preserves lookup failures for contracts and fallback for built-in circuits', async () => {
    const { wallet } = fixture();
    const keys = keyMaterialProvider();
    const failure = new Error('missing circuit');
    keys.getZKIR.mockRejectedValue(failure);
    const provider = (
      await getMidnightProvingProvider(wallet, { keyMaterialProvider: keys })
    ).unwrap();
    await expect(provider.lookupKey('contract')).rejects.toBe(failure);
    await expect(
      provider.lookupKey('midnight/dust/spend'),
    ).resolves.toBeUndefined();
  });

  it('bounds a stalled lookup with proveTimeout', async () => {
    const { wallet } = fixture();
    const keys = keyMaterialProvider();
    keys.getZKIR.mockImplementation(async () => new Promise(() => {}));
    const provider = (
      await getMidnightProvingProvider(wallet, {
        keyMaterialProvider: keys,
        proveTimeout: 20,
      })
    ).unwrap();
    await expect(provider.lookupKey('contract')).rejects.toBeInstanceOf(
      TimeoutError,
    );
  });

  it('uses the current account epoch on every check and prove, including engine replacement', async () => {
    const { wallet, engine, registry } = fixture();
    const state = new BehaviorSubject({
      activeProtocolVersion: ProtocolVersion.MinSupportedVersion,
    });
    const check = vi.fn(
      async (
        _request: Parameters<
          MidnightWallet['proofCircuitProvider']['check']
        >[0],
      ) => [],
    );
    const prove = vi.fn(
      async (
        _request: Parameters<
          MidnightWallet['proofCircuitProvider']['prove']
        >[0],
      ) => new Uint8Array(),
    );
    engine.state = (() => state) as unknown as MidnightWallet['state'];
    engine.proofCircuitProvider = { check, prove };
    const provider = (
      await getMidnightProvingProvider(wallet, {
        keyMaterialProvider: keyMaterialProvider(),
      })
    ).unwrap();
    await provider.check(new Uint8Array(), 'c');
    expect(check.mock.calls[0]?.[0]).toMatchObject({ ledgerVersion: 'v8' });
    state.next({ activeProtocolVersion: ProtocolVersion.V9NativeForkVersion });
    await provider.prove(new Uint8Array(), 'c');
    expect(prove.mock.calls[0]?.[0]).toMatchObject({ ledgerVersion: 'v9' });
    registry.next({
      [accountId]: {
        ...engine,
        state: () =>
          of({ activeProtocolVersion: ProtocolVersion.MinSupportedVersion }),
      } as MidnightWallet,
    });
    await provider.prove(new Uint8Array(), 'c');
    expect(prove.mock.calls[1]?.[0]).toMatchObject({ ledgerVersion: 'v8' });
  });

  it.each(['check', 'prove'] as const)(
    '%s selects the real v9 DUST key material for local proving',
    async operation => {
      const fetch = vi.fn(
        async (_url: unknown) => new Response('', { status: 404 }),
      );
      vi.stubGlobal('fetch', fetch);
      const { wallet, engine } = fixture();
      engine.state = (() =>
        of({
          activeProtocolVersion: ProtocolVersion.V9NativeForkVersion,
        })) as MidnightWallet['state'];
      engine.proofCircuitProvider = createWasmCircuitProvider();
      const keys = keyMaterialProvider();
      keys.getZKIR.mockRejectedValue(new Error('built-in'));
      const provider = (
        await getMidnightProvingProvider(wallet, { keyMaterialProvider: keys })
      ).unwrap();
      // Stop at key selection: every download is refused and no proving work or network request runs.
      await expect(
        provider[operation](new Uint8Array(), 'midnight/dust/spend'),
      ).rejects.toThrow();
      expect(fetch).toHaveBeenCalled();
      expect(fetch.mock.calls.map(call => String(call[0]))).toEqual(
        expect.arrayContaining([
          expect.stringContaining('/dust/10/spend.prover'),
        ]),
      );
      expect(
        fetch.mock.calls.every(call => !String(call[0]).includes('/dust/9/')),
      ).toBe(true);
    },
  );
});
