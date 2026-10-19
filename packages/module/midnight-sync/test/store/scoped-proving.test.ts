import { midnightContextActions } from '@lace-contract/midnight-context';
import { midnightContextReducers } from '@lace-contract/midnight-context/src/store/slice';
import { AccountId } from '@lace-contract/wallet-repo';
import { WalletFacade } from '@midnightntwrk/wallet-sdk/facade';
import { EMPTY } from 'rxjs';
import { expect, it, vi } from 'vitest';

import { createAttestedProofServerAccess } from '../../src/store/attested-proving-service';
import { createScopedProofServerAccess } from '../../src/store/scoped-proving';
import {
  beginSendProofProgress,
  teeAttestationProgress$,
} from '../../src/store/send-proof-progress';

import type { AttestedProverProvider } from '../../src/store/attested-proving-service';
import type { DefaultConfiguration } from '@midnightntwrk/wallet-sdk/facade';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {
    resolve = done;
  });
  return { promise, resolve };
};

it('keeps the real send reducer pending when a concurrent dApp proof completes', async () => {
  const reducer = midnightContextReducers.midnightTeeAttestation;
  const actions = midnightContextActions.midnightContext;
  let state = reducer(undefined, { type: 'init' });
  const subscription = teeAttestationProgress$.subscribe(event => {
    state = reducer(
      state,
      event.type === 'begin'
        ? actions.teeAttestationProgressStarted(event)
        : actions.teeAttestationProgressUpdated(event),
    );
  });
  const close = vi.fn(async () => undefined);
  const provider: AttestedProverProvider = {
    id: 'fixture',
    phases: ['evidence'],
    operations: ['prove'],
    establishAttestedSession: async onProgress => {
      onProgress({ type: 'phase', phase: 'evidence', status: 'completed' });
      return { prove: async payload => payload, close };
    },
  };
  const walletFinished = deferred();
  const provingStarted = deferred();
  const finalized = {};
  // Stub the ledger's expensive proving call; the facade, attested service,
  // callback routing, subject and Redux reducer are the production code.
  const recipe = {
    type: 'UNPROVEN_TRANSACTION' as const,
    transaction: {
      prove: async () => {
        provingStarted.resolve();
        await walletFinished.promise;
        return { bind: () => finalized };
      },
    },
  } as unknown as Parameters<WalletFacade['finalizeRecipe']>[0];
  const configuration = {} as DefaultConfiguration;
  const access = createScopedProofServerAccess(onProgress =>
    createAttestedProofServerAccess(provider, onProgress),
  );
  const wallet = await WalletFacade.init({
    configuration,
    shielded: () => ({ revertTransaction: vi.fn() } as never),
    unshielded: () => ({ revertTransaction: vi.fn() } as never),
    dust: () => ({ revertTransaction: vi.fn() } as never),
    submissionService: () => ({} as never),
    pendingTransactionsService: () =>
      ({
        state: () => EMPTY,
        addPendingTransaction: vi.fn(async () => undefined),
      } as never),
    provingService: () => access.provingService,
  });
  try {
    const onProgress = beginSendProofProgress(AccountId('account-one'));
    const send = access.finalizeRecipe(wallet, recipe, onProgress);
    await provingStarted.promise;
    expect(state.status).toBe('running');
    const pending = state;
    await access.transport.prove(new Uint8Array([1]));
    expect(state).toBe(pending);
    // The dApp's facade finalization is also unscoped, not only /prove.
    await wallet.finalizeRecipe({
      type: 'UNPROVEN_TRANSACTION',
      transaction: { prove: async () => ({ bind: () => finalized }) },
    } as never);
    expect(state).toBe(pending);
    walletFinished.resolve();
    await expect(send).resolves.toBe(finalized);
    expect(state.status).toBe('succeeded');
    expect(close).toHaveBeenCalledTimes(3);
  } finally {
    walletFinished.resolve();
    subscription.unsubscribe();
  }
});

it('releases a failed transaction scope for retry without retaining its observer', async () => {
  const close = vi.fn(async () => undefined);
  const access = createScopedProofServerAccess(onProgress =>
    createAttestedProofServerAccess(
      {
        id: 'fixture',
        phases: [],
        operations: ['prove'],
        establishAttestedSession: async () => ({
          prove: async payload => payload,
          close,
        }),
      },
      onProgress,
    ),
  );
  const prove = vi
    .fn()
    .mockRejectedValueOnce(new Error('failed proof'))
    .mockResolvedValue({});
  const recipe = {
    type: 'UNPROVEN_TRANSACTION',
    transaction: { prove },
  } as unknown as Extract<
    Parameters<WalletFacade['finalizeRecipe']>[0],
    { type: 'UNPROVEN_TRANSACTION' }
  >;
  const facade = {
    finalizeRecipe: async () => access.provingService.prove(recipe.transaction),
  } as unknown as WalletFacade;
  const first = vi.fn();
  const second = vi.fn();
  await expect(access.finalizeRecipe(facade, recipe, first)).rejects.toThrow();
  const firstEvents = first.mock.calls.length;
  await access.finalizeRecipe(facade, recipe, second);
  expect(first).toHaveBeenCalledTimes(firstEvents);
  expect(second).toHaveBeenLastCalledWith({
    type: 'phase',
    phase: 'proving',
    status: 'completed',
  });
  expect(close).toHaveBeenCalledTimes(2);
});
