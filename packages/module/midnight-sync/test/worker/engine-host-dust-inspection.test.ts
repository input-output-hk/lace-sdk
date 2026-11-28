import { SerialisedWalletState } from '@lace-contract/midnight-context';
import { Option } from 'effect';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  checkpoint,
  fakeEngines,
  facadeState,
  PASSWORD,
  sealedAccount,
  settings,
  useFastKeyDerivation,
} from './engine-host-fakes';
import { createHost } from './engine-host-setup';

vi.mock('../../src/store/dependencies', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createStartMidnightAccountWallet: fakeEngines.createStart,
}));
vi.mock('@midnightntwrk/wallet-sdk/dust/v2', () => ({
  coreStateOf: (dust: unknown) => Option.fromNullable(dust),
}));
vi.mock('../../src/store/dust-sync', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getPendingDustNullifiersForReset: (snapshot: string) =>
    JSON.parse(snapshot) as string[],
}));

describe('worker Dust reset inspection', () => {
  beforeAll(useFastKeyDerivation);
  beforeEach(() => {
    fakeEngines.reset();
  });

  it('combines the attached account’s live reservations and checkpoint without exposing another account', async () => {
    const { host, stores } = createHost();
    const account = await sealedAccount();
    const other = await sealedAccount({ walletId: 'other' });
    await host.attach({
      clientId: 'page',
      account,
      password: PASSWORD.slice(),
      settings: settings(),
    });
    const state = facadeState();
    Object.assign(state.dust, {
      syncKind: 'projections',
      pendingDust: [{ nullifier: 'live' }],
    });
    fakeEngines.current(account.accountId).state$.next(state);
    const saved = checkpoint(account);
    saved.serializedState.dust = SerialisedWalletState(
      JSON.stringify(['saved']),
    );
    stores.get('memory')!.documents.set(account.accountId, saved);
    const hidden = checkpoint(other);
    hidden.serializedState.dust = SerialisedWalletState(
      'unreadable other account',
    );
    stores.get('memory')!.documents.set(other.accountId, hidden);
    const request = {
      clientId: 'page',
      networkId: account.blockchainSpecific.networkId,
      accountIds: [account.accountId],
      storage: 'memory' as const,
    };
    await expect(host.inspectDustSyncReset(request)).resolves.toEqual({
      [account.accountId]: ['saved', 'live'],
    });
    for (const unauthorized of [
      { ...request, clientId: 'other' },
      { ...request, storage: 'indexeddb' as const },
      { ...request, accountIds: [other.accountId] },
    ])
      await expect(
        host.inspectDustSyncReset(unauthorized),
      ).rejects.toMatchObject({ reason: 'not-attached' });
  });
});
