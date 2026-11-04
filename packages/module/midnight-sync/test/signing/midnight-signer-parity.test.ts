import * as stubData from '@lace-contract/midnight-context/src/stub-data';
import { AuthenticationCancelledError } from '@lace-contract/signer';
import { HexBytes } from '@lace-lib/util';
import { BehaviorSubject, firstValueFrom, of, Subject } from 'rxjs';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { MidnightInMemoryTransactionSigner } from '../../src/signing/midnight-in-memory-transaction-signer';
import { teeAttestationProgress$ } from '../../src/store/send-proof-progress';
import {
  createClient,
  createFakeWorkers,
  startParams,
  until,
} from '../worker/engine-client-fakes';
import {
  facadeState,
  fakeEngines,
  finalized,
  nightCoin,
  PASSWORD,
  sealedAccount,
  settings,
  useFastKeyDerivation,
} from '../worker/engine-host-fakes';

import type { MidnightRemoteEngineClient } from '../../src/worker/engine-client';
import type {
  AttestationProgressEvent,
  MidnightAccountProps,
  MidnightEnginesByAccountId,
  MidnightSignRequest,
  MidnightWallet,
  SendProofProgressEvent,
} from '@lace-contract/midnight-context';
import type { SignerAuth } from '@lace-contract/signer';
import type { InMemoryWalletAccount } from '@lace-contract/wallet-repo';
import type { FacadeState } from '@midnightntwrk/wallet-sdk/facade';
import type { Observable, Subscription } from 'rxjs';

vi.mock('../../src/store/dependencies', async importOriginal => {
  const fakes = await import('../worker/engine-host-fakes');
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    createStartMidnightAccountWallet: fakes.fakeEngines.createStart,
  };
});

type Account = InMemoryWalletAccount<MidnightAccountProps>;

const serialise = (tokenKind: string, receiverAddress: string, type: string) =>
  HexBytes.fromUTF8(
    JSON.stringify({
      transfers: [{ amount: '5', receiverAddress, tokenKind, type }],
    }),
  );

const requests: Record<string, MidnightSignRequest> = {
  'an unshielded transfer': {
    serializedTx: serialise(
      'unshielded',
      stubData.midnightUnshieldedAddress,
      '0'.repeat(64),
    ),
  },
  'a shielded transfer': {
    serializedTx: serialise(
      'shielded',
      stubData.midnightShieldedAddress,
      '0'.repeat(64),
    ),
  },
  'a DUST designation': {
    flowType: 'dust-designation',
    serializedTx: serialise(
      'unshielded',
      stubData.midnightDustAddress,
      '0'.repeat(64),
    ),
  },
};

const progressEvent = {
  type: 'tee-attestation',
} as unknown as AttestationProgressEvent;

// Each fake engine builds its own ledger objects, so only their kind can match across the two modes.
const comparable = (value: unknown): unknown => {
  if (value === null || typeof value !== 'object') return value;
  if ('__wbg_ptr' in value) return { ledger: value.constructor.name };
  if (Array.isArray(value)) return value.map(comparable);
  if (value instanceof Date) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, comparable(item)]),
  );
};

// The engine calls a signing makes, in order, with their arguments; the same in both modes means the same pipeline.
const engineCalls = (engine: MidnightWallet) =>
  (
    [
      'transferTransaction',
      'signRecipe',
      'registerNightUtxosForDustGeneration',
      'balanceUnprovenTransaction',
      'finalizeRecipe',
    ] as const
  ).flatMap(method =>
    vi
      .mocked(engine[method] as (...args: unknown[]) => unknown)
      .mock.calls.map(args => ({
        method,
        args: args
          .filter(argument => typeof argument !== 'function')
          .map(comparable),
      })),
  );

describe('test:engine-client-signer-parity', () => {
  let a: Account;
  const subscriptions: Subscription[] = [];
  const transaction = finalized();

  beforeAll(async () => {
    useFastKeyDerivation();
    a = await sealedAccount({ walletId: 'wallet-a' });
  });
  beforeEach(() => {
    fakeEngines.reset();
    useFastKeyDerivation();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-22T12:00:00Z'));
  });
  afterEach(() => {
    for (const subscription of subscriptions.splice(0))
      subscription.unsubscribe();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // Both engines hold the same state and prove into the same transaction, reporting one progress event.
  const prepare = (engine: MidnightWallet) => {
    vi.mocked(engine.finalizeRecipe).mockImplementation(
      (_recipe, onProgress) => {
        onProgress?.(progressEvent);
        return of(transaction) as never;
      },
    );
    return engine;
  };

  const workerMode = async (state = facadeState()) => {
    const workers = createFakeWorkers();
    const client = createClient(workers);
    const engines: MidnightRemoteEngineClient[] = [];
    subscriptions.push(
      client
        .startAccountEngine(startParams(a))
        .subscribe(engine => engines.push(engine)),
    );
    await until(() => engines.length === 1);
    const workerSide = fakeEngines.current(a.accountId);
    workerSide.state$.next(state);
    prepare(workerSide.engine);
    return { workers, remote: engines[0], workerSide: workerSide.engine };
  };

  // The page-mode engine: the same fake engine, started in-process by a host the signer never talks to.
  const inProcessEngine = async (state: FacadeState) => {
    const workers = createFakeWorkers();
    await workers.worker.host.attach({
      clientId: 'page-mode-stand-in',
      account: a,
      password: PASSWORD.slice(),
      settings: settings(),
    });
    const fake = fakeEngines.current(a.accountId);
    fake.state$.next(state);
    return prepare(fake.engine);
  };

  const signerOver = (
    engines: MidnightEnginesByAccountId,
    authenticate: () => Observable<boolean> = () => of(true),
  ) =>
    new MidnightInMemoryTransactionSigner({
      accountId: a.accountId,
      auth: { authenticate } as unknown as SignerAuth,
      wallets$: new BehaviorSubject(engines),
    });

  const progressOf = async (sign: () => Promise<unknown>) => {
    const events: SendProofProgressEvent[] = [];
    const subscription = teeAttestationProgress$.subscribe(event =>
      events.push(event),
    );
    try {
      await sign();
    } finally {
      subscription.unsubscribe();
    }
    return events.map(event =>
      event.type === 'begin'
        ? { type: event.type, accountId: event.accountId }
        : { type: event.type, event: event.event },
    );
  };

  it.each(Object.entries(requests))(
    'signs %s in Worker mode with the result, engine calls and progress of page mode',
    async (_, request) => {
      const state = facadeState({ availableCoins: [nightCoin(10n)] });
      const inProcess = await inProcessEngine(state);
      const pageCalls = () => engineCalls(inProcess);
      let pageResult: unknown;
      const pageProgress = await progressOf(async () => {
        pageResult = await firstValueFrom(
          signerOver({ [a.accountId]: inProcess }).sign(request),
        );
      });
      const { remote, workerSide } = await workerMode(state);
      let workerResult: unknown;
      const workerProgress = await progressOf(async () => {
        workerResult = await firstValueFrom(
          signerOver({ [a.accountId]: remote }).sign(request),
        );
      });

      expect(workerResult).toEqual(pageResult);
      expect(workerResult).toEqual({
        serializedTx: HexBytes.fromByteArray(transaction.serialize()),
      });
      expect(engineCalls(workerSide)).toEqual(pageCalls());
      expect(workerProgress).toEqual(pageProgress);
      expect(workerProgress).toEqual([
        { type: 'begin', accountId: a.accountId },
        {
          type: 'progress',
          event: {
            type: 'phase',
            phase: 'transaction-preparing',
            status: 'started',
          },
        },
        { type: 'progress', event: progressEvent },
      ]);
    },
  );

  it('authenticates on the page before it dispatches anything to the worker', async () => {
    const { workers, remote } = await workerMode();
    const confirm = new Subject<boolean>();
    const signing = firstValueFrom(
      signerOver({ [a.accountId]: remote }, () => confirm).sign(
        requests['an unshielded transfer'],
      ),
    );
    const dispatched = () =>
      workers.connections[0].calls.some(
        ({ method }) => method === 'signTransaction',
      );

    await until(() => confirm.observed);
    const isDispatchedBeforeConfirmation = dispatched();
    confirm.next(true);
    await signing;

    expect(isDispatchedBeforeConfirmation).toBe(false);
    expect(dispatched()).toBe(true);
  });

  it('dispatches nothing to the worker when the user cancels the authentication', async () => {
    const { workers, remote } = await workerMode();

    await expect(
      firstValueFrom(
        signerOver({ [a.accountId]: remote }, () => of(false)).sign(
          requests['an unshielded transfer'],
        ),
      ),
    ).rejects.toBeInstanceOf(AuthenticationCancelledError);
    expect(
      workers.connections[0].calls.some(
        ({ method }) => method === 'signTransaction',
      ),
    ).toBe(false);
  });
});
