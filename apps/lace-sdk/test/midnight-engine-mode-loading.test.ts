import { MidnightNetworkId } from '@lace-contract/midnight-context';
import * as fixture from '@lace-contract/midnight-context/src/stub-data';
import { BehaviorSubject, of } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildMidnightTransfer,
  observeMidnightBalances,
  signMidnightData,
  signMidnightTx,
} from '../src/midnight';

import { pageModeEngineAccess } from './midnight-engine-access-fake';
import { decodeLedgerFakes, ledgerFake } from './midnight-ledger-fakes';
import { toMidnightTxRecipe } from './midnight-opaque-fixtures';
import {
  addMidnightAccount,
  createFakeEngineHost,
  createMidnightWallet,
  installFakeBrowser,
} from './midnight-worker-fakes';

// Test-only engine boundary: the package deliberately does not export its internals.
// eslint-disable-next-line @nx/enforce-module-boundaries
import type * as PageSignerFactory from '../../../packages/module/midnight-sync/src/exported-modules/signer-factory';
// eslint-disable-next-line @nx/enforce-module-boundaries
import type * as PageInit from '../../../packages/module/midnight-sync/src/store/sdk-init';
import type * as PageOperations from '../src/midnight-page-operations';
import type { WalletWithMidnight } from '../src/midnight-wallet';
import type {
  MidnightWallet,
  MidnightWalletsByAccountId,
} from '@lace-contract/midnight-context';
import type { AnyWallet } from '@lace-contract/wallet-repo';
import type { BalancingRecipe } from '@midnightntwrk/wallet-sdk/facade';

// Test-only engine boundary: the package deliberately does not export its internals.

// What each engine mode loads on the page. Worker mode must never load the engine's code: page mode's store init
// (which holds the engine and its WebAssembly) and the page operations (the engine-side functions). Page mode loads
// both, the operations once, on the first operation. The build check guards the emitted chunks; this guards the
// module graph the chunks are cut from.

const { loads } = vi.hoisted(() => ({
  loads: { pageInit: 0, pageOperations: 0, pageSignerFactory: 0 },
}));
vi.mock(
  '../../../packages/module/midnight-sync/src/exported-modules/signer-factory',
  async importActual => {
    loads.pageSignerFactory += 1;
    return importActual<typeof PageSignerFactory>();
  },
);
vi.mock(
  '../../../packages/module/midnight-sync/src/store/sdk-init',
  async importActual => {
    loads.pageInit += 1;
    return importActual<typeof PageInit>();
  },
);
vi.mock('../src/midnight-page-operations', async importActual => {
  loads.pageOperations += 1;
  return importActual<typeof PageOperations>();
});

vi.setConfig({ testTimeout: 30_000 });
const { accountId } = fixture;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// A page-mode instance as the helpers see it: the engine runs in this JavaScript context, behind the engine addon.
const pageModeAccount = fixture.midnightAccount;
const recipe = {
  type: 'UNPROVEN_TRANSACTION',
  transaction: ledgerFake({ id: 'built' }),
} as unknown as BalancingRecipe;
const signed = {
  type: 'UNPROVEN_TRANSACTION',
  transaction: ledgerFake({ id: 'signed' }),
} as unknown as BalancingRecipe;
const pageModeWallet = () => {
  const engine = {
    accountId,
    networkId: fixture.networkId,
    transferTransaction: vi.fn(() => of(recipe)),
    balanceUnprovenTransaction: vi.fn(() => of(recipe)),
    signRecipe: vi.fn(() => of(signed)),
  } as unknown as MidnightWallet;
  const engines$ = new BehaviorSubject<MidnightWalletsByAccountId>({
    [accountId]: engine,
  });
  const wallet: WalletWithMidnight = {
    stateObservables: {
      wallets: {
        selectAll$: of([
          {
            ...fixture.midnightWallet,
            accounts: [pageModeAccount],
          } as AnyWallet,
        ]),
      },
      network: {
        selectAllActiveNetworkIds$: of([MidnightNetworkId(fixture.networkId)]),
      },
    } as unknown as WalletWithMidnight['stateObservables'],
    _loadModules: (async () => [
      pageModeEngineAccess(engines$),
    ]) as unknown as WalletWithMidnight['_loadModules'],
  };
  return { wallet, engine };
};

describe('test:midnight-engine-mode-loading', () => {
  it('Worker mode: the helpers run through the worker and the page loads neither the engine init nor the page operations', async () => {
    const { host, asHost } = createFakeEngineHost();
    installFakeBrowser(asHost());
    const wallet = await createMidnightWallet({ worker: true });
    await addMidnightAccount(wallet);

    const signed = await signMidnightData(wallet, {
      accountId,
      data: '00ff80',
      options: { encoding: 'hex', keyType: 'unshielded' },
      startTimeout: 10_000,
    });
    const built = await buildMidnightTransfer(wallet, {
      accountId,
      to: fixture.midnightUnshieldedAddress,
      amount: 1n,
      startTimeout: 10_000,
    });
    const balances = await new Promise(resolve => {
      const subscription = observeMidnightBalances(wallet, {
        accountId,
        startTimeout: 10_000,
      }).subscribe(value => {
        subscription.unsubscribe();
        resolve(value);
      });
    });

    expect(signed.isOk()).toBe(true);
    expect(built.isOk()).toBe(true);
    expect(balances).toMatchObject({ accountId });
    expect(host.build).toHaveBeenCalledTimes(1);
    expect(loads).toEqual({
      pageInit: 0,
      pageOperations: 0,
      pageSignerFactory: 0,
    });
  });

  it('page mode: the first operation loads the page operations once, and later operations reuse them', async () => {
    decodeLedgerFakes();
    const { wallet, engine } = pageModeWallet();
    const before = { ...loads };

    const built = await buildMidnightTransfer(wallet, {
      to: fixture.midnightUnshieldedAddress,
      amount: 1n,
    });
    const signedRecipe = await signMidnightTx(wallet, {
      recipe: built.unwrap(),
    });

    expect(signedRecipe.unwrap()).toEqual(toMidnightTxRecipe(engine, signed));
    expect(engine.signRecipe).toHaveBeenCalledWith(recipe);
    expect(loads.pageOperations).toBe(before.pageOperations + 1);
    // No store was created here: page mode's init is the module's, not the helpers'.
    expect(loads.pageInit).toBe(before.pageInit);
  });
});
