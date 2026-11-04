import { createHash, randomBytes } from 'node:crypto';

import {
  MidnightAccountId,
  MidnightNetworkId,
  MidnightSDKNetworkIds,
  NIGHT_TOKEN_ID,
} from '@lace-contract/midnight-context';
import * as stubData from '@lace-contract/midnight-context/src/stub-data';
import { WalletId } from '@lace-contract/wallet-repo';
import { SecretBox } from '@lace-lib/core';
import { HexBytes } from '@lace-lib/util';
import * as ledger from '@midnight-ntwrk/ledger-v8';
import { Roles } from '@midnightntwrk/wallet-sdk/hd';
import { BehaviorSubject, EMPTY, Observable, of, ReplaySubject } from 'rxjs';
import { vi } from 'vitest';

import { createCircuitProviderFromTransport } from '../../src/store/proof-server-transport';

import type { MidnightEngineOptions } from '../../src/store/dependencies';
import type { MidnightEngineSettings } from '../../src/worker/protocol';
import type {
  MidnightAccountProps,
  MidnightSDKNetworkId,
  MidnightWallet,
  MidnightWalletAddress,
  SerializedMidnightWallet,
  StartMidnightAccountWalletParams,
} from '@lace-contract/midnight-context';
import type { CollectionStorage } from '@lace-contract/storage';
import type { InMemoryWalletAccount } from '@lace-contract/wallet-repo';
import type { ProofServerTransport } from '@lace-lib/vendor/midnight-proof-servers';
import type {
  BalancingRecipe,
  FacadeState,
  UtxoWithMeta,
} from '@midnightntwrk/wallet-sdk/facade';
import type { Subject } from 'rxjs';

// The SBV1 key derivation is Argon2id at 19 MiB, which would dominate these tests; the cipher and its
// authentication stay real, so a wrong password still fails to open a key.
const fastKey = (password: Uint8Array, salt: Uint8Array, length: number) =>
  new Uint8Array(
    createHash('sha256').update(password).update(salt).digest(),
  ).slice(0, length);

export const useFastKeyDerivation = () => {
  SecretBox.setArgon2idImplementation(async (password, salt, { dkLen }) =>
    fastKey(password, salt, dkLen),
  );
};

/** Holds every key derivation until `release`, so that a test can act while an attach checks its password. */
export const holdKeyDerivation = () => {
  let markEntered!: () => void;
  let release!: () => void;
  const entered = new Promise<void>(resolve => {
    markEntered = resolve;
  });
  const released = new Promise<void>(resolve => {
    release = resolve;
  });
  SecretBox.setArgon2idImplementation(async (password, salt, { dkLen }) => {
    markEntered();
    await released;
    return fastKey(password, salt, dkLen);
  });
  return {
    entered,
    release: () => {
      useFastKeyDerivation();
      release();
    },
  };
};

export const PASSWORD = new TextEncoder().encode('correct horse battery');
export const WRONG_PASSWORD = new TextEncoder().encode('wrong password');

// Undeployed, so that the stub addresses are valid for the default account.
export const networkId = stubData.networkId;

export const sealedAccount = async ({
  walletId = 'wallet-a',
  accountIndex = 0,
  network = networkId,
  password = PASSWORD,
  seeds = [randomBytes(32), randomBytes(32), randomBytes(32)],
}: {
  walletId?: string;
  accountIndex?: number;
  network?: MidnightSDKNetworkId;
  password?: Uint8Array;
  /** The night, DUST and zswap key seeds the account seals. */
  seeds?: readonly [Uint8Array, Uint8Array, Uint8Array];
} = {}): Promise<InMemoryWalletAccount<MidnightAccountProps>> => {
  const key = async (seed: Uint8Array) =>
    HexBytes.fromByteArray(await SecretBox.seal(seed, password));
  const [night, dust, zswap] = await Promise.all(seeds.map(key));
  const path = (role: (typeof Roles)[keyof typeof Roles]) => ({
    accountIndex,
    index: 0,
    role,
  });
  return {
    blockchainName: 'Midnight',
    accountId: MidnightAccountId(WalletId(walletId), accountIndex, network),
    networkType: 'testnet',
    blockchainNetworkId: MidnightNetworkId(network),
    accountType: 'InMemory',
    walletId: WalletId(walletId),
    metadata: { name: `${walletId} #${accountIndex}` },
    blockchainSpecific: {
      accountIndex,
      networkId: network,
      nightExternalKey: {
        encryptedKey: night,
        derivationPath: path(Roles.NightExternal),
      },
      dustKey: { encryptedKey: dust, derivationPath: path(Roles.Dust) },
      zswapKey: { encryptedKey: zswap, derivationPath: path(Roles.Zswap) },
    },
  } as InMemoryWalletAccount<MidnightAccountProps>;
};

export const settings = (
  overrides: Partial<MidnightEngineSettings> = {},
): MidnightEngineSettings => ({
  config: {
    indexerAddress: 'https://indexer.example/api/v3/graphql',
    nodeAddress: 'https://node.example',
    proofServer: { kind: 'local-host', url: 'http://127.0.0.1:6300' },
  },
  attestedProver: false,
  storage: 'memory',
  ...overrides,
});

/** One log for the order of engine stops and storage writes across accounts. */
export const events: string[] = [];

export const createMemoryStore = (kind: string) => {
  const documents = new Map<string, SerializedMidnightWallet>();
  const store: CollectionStorage<SerializedMidnightWallet> = {
    get: docId => {
      const document = documents.get(docId);
      return document ? of(document) : EMPTY;
    },
    getAll: () => of([...documents.values()]),
    observeAll: () => of([...documents.values()]),
    setAll: () => {
      throw new Error('setAll is deprecated');
    },
    upsert: document => {
      documents.set(String(document.accountId), document);
      return of(undefined);
    },
    removeWhere: predicate => {
      events.push(`${kind}:removeWhere`);
      for (const [docId, document] of documents)
        if (predicate(document)) documents.delete(docId);
      return of(undefined);
    },
    clear: () => {
      events.push(`${kind}:clear`);
      documents.clear();
      return of(undefined);
    },
  };
  return { store, documents };
};

export const checkpoint = (
  account: InMemoryWalletAccount<MidnightAccountProps>,
): SerializedMidnightWallet =>
  ({
    accountId: account.accountId,
    walletId: account.walletId,
    networkId: account.blockchainSpecific.networkId,
    serializedState: {},
  } as SerializedMidnightWallet);

const transactionNetwork = MidnightSDKNetworkIds.Preview;
const signingKey = ledger.sampleSigningKey();
export const verifyingKey = ledger.signatureVerifyingKey(signingKey);

export const unproven = () => {
  const token = ledger.nativeToken().raw;
  const intent = ledger.Intent.new(new Date(Date.now() + 3_600_000));
  intent.guaranteedUnshieldedOffer = ledger.UnshieldedOffer.new(
    [
      {
        value: 5n,
        owner: verifyingKey,
        type: token,
        intentHash: ledger.sampleIntentHash(),
        outputNo: 0,
      },
    ],
    [{ value: 5n, owner: ledger.addressFromKey(verifyingKey), type: token }],
    [],
  );
  return ledger.Transaction.fromParts(
    transactionNetwork,
    undefined,
    undefined,
    intent,
  );
};
export const finalized = () => unproven().mockProve();
// A transaction without contract calls proves without asking the prover for anything.
export const unbound = async () =>
  unproven().prove(
    {
      check: async () => [],
      prove: async () => {
        throw new Error('nothing to prove');
      },
    },
    ledger.CostModel.initialCostModel(),
  );
export const unprovenRecipe = (): BalancingRecipe => ({
  type: 'UNPROVEN_TRANSACTION',
  transaction: unproven(),
});

export const nightCoin = (
  value: bigint,
  registeredForDustGeneration = false,
): UtxoWithMeta =>
  ({
    utxo: {
      value,
      owner: ledger.addressFromKey(verifyingKey),
      type: NIGHT_TOKEN_ID,
      intentHash: ledger.sampleIntentHash(),
      outputNo: 0,
    },
    meta: { ctime: new Date(0), registeredForDustGeneration },
  } as UtxoWithMeta);

type DustCoin = {
  generatedNow: bigint;
  maxCap: bigint;
  rate: bigint;
  dtime?: Date;
  maxCapReachedAt?: Date;
};

const syncState = (complete: boolean) => ({
  progress: { isStrictlyComplete: () => complete },
});

export const facadeState = ({
  availableCoins = [nightCoin(10n)],
  pendingCoins = [] as UtxoWithMeta[],
  dustCoins = [] as DustCoin[],
  spendableDust = 100n,
  synced = { unshielded: false, shielded: false, dust: false },
}: {
  availableCoins?: UtxoWithMeta[];
  pendingCoins?: UtxoWithMeta[];
  dustCoins?: DustCoin[];
  spendableDust?: bigint;
  synced?: { unshielded: boolean; shielded: boolean; dust: boolean };
} = {}): FacadeState =>
  ({
    unshielded: {
      availableCoins,
      pendingCoins,
      state: syncState(synced.unshielded),
    },
    dust: {
      totalCoins: dustCoins,
      availableCoins: dustCoins,
      pendingCoins: [],
      balance: () => spendableDust,
      state: syncState(synced.dust),
    },
    shielded: {
      coinPublicKey: { toHexString: () => 'c0' },
      encryptionPublicKey: { toHexString: () => 'e0' },
      state: syncState(synced.shielded),
    },
  } as unknown as FacadeState);

export const accountAddress: MidnightWalletAddress = {
  shielded: stubData.midnightShieldedAddress,
  unshielded: stubData.midnightUnshieldedAddress,
  dust: stubData.midnightDustAddress,
};

/** A running engine as the start function hands it out, with the controls the tests drive it through. */
export type FakeEngine = {
  readonly engine: MidnightWallet;
  /** The proof server's byte transport behind the engine's circuit provider. */
  readonly proofServerTransport: ProofServerTransport;
  readonly params: StartMidnightAccountWalletParams;
  readonly options: MidnightEngineOptions;
  readonly state$: Subject<FacadeState>;
  readonly syncProgress$: Subject<unknown>;
  readonly address$: Subject<MidnightWalletAddress>;
  readonly coinsByTokenType$: Subject<unknown>;
  readonly transactionHistory$: Subject<unknown[]>;
  stopped: boolean;
  tornDown: boolean;
};

const createFakeEngine = (
  params: StartMidnightAccountWalletParams,
  options: MidnightEngineOptions,
): FakeEngine => {
  const { account } = params;
  // A withheld stream emits only what the test pushes, as the streams of an engine still restoring its state do.
  const stream = <T>(initial: T): Subject<T> => {
    if (!fakeEngines.withholdValues) return new BehaviorSubject(initial);
    return new ReplaySubject<T>(1);
  };
  const state$ = stream(facadeState());
  // The engine's shape, so that page-side readers such as the watcher can consume it too.
  const syncProgress$ = stream<unknown>({
    shielded: 0,
    unshielded: 0,
    dust: 0,
    isStrictlyComplete: { shielded: false, unshielded: false, dust: false },
  });
  const address$ = stream(accountAddress);
  const coinsByTokenType$ = stream<unknown>({ shielded: {}, unshielded: {} });
  const transactionHistory$ = stream<unknown[]>([]);
  const proofServerTransport: ProofServerTransport = {
    check: vi.fn(async () => new Uint8Array([0xc1])),
    prove: vi.fn(async () => new Uint8Array([0xb1])),
  };
  const fake: FakeEngine = {
    proofServerTransport,
    params,
    options,
    state$,
    syncProgress$,
    address$,
    coinsByTokenType$,
    transactionHistory$,
    stopped: false,
    tornDown: false,
    engine: {
      accountId: account.accountId,
      walletId: account.walletId,
      networkId: account.blockchainSpecific.networkId,
      nightVerifyingKey: verifyingKey,
      address$,
      areKeysAvailable$: params.keyManager.areKeysAvailable$,
      coinsByTokenType$,
      syncProgress$,
      transactionHistory$,
      state: () => state$,
      proofCircuitProvider:
        createCircuitProviderFromTransport(proofServerTransport),
      transferTransaction: vi.fn(() => of(unprovenRecipe())),
      initSwap: vi.fn(() => of(unprovenRecipe())),
      registerNightUtxosForDustGeneration: vi.fn(() => of(unprovenRecipe())),
      balanceUnprovenTransaction: vi.fn((transaction: unknown) =>
        of({ type: 'UNPROVEN_TRANSACTION', transaction }),
      ),
      balanceFinalizedTransaction: vi.fn((originalTransaction: unknown) =>
        of({
          type: 'FINALIZED_TRANSACTION',
          originalTransaction,
          balancingTransaction: unproven(),
        }),
      ),
      balanceUnboundTransaction: vi.fn((baseTransaction: unknown) =>
        of({
          type: 'UNBOUND_TRANSACTION',
          baseTransaction,
          balancingTransaction: unproven(),
        }),
      ),
      signRecipe: vi.fn((recipe: BalancingRecipe) => of(recipe)),
      finalizeRecipe: vi.fn(() => of(finalized())),
      revert: vi.fn(() => of(undefined)),
      submitTransaction: vi.fn(
        (transaction: { transactionHash: () => string }) =>
          of(transaction.transactionHash()),
      ),
      estimateTransactionFee: vi.fn(() => of(7n)),
      calculateTransactionFee: vi.fn(() => of(6n)),
      signData: vi.fn(() => of({ signature: 'signature', verifyingKey })),
      getTransactionHistoryEntryByHash: vi.fn((hash: string) =>
        of({ hash, status: 'SUCCESS' }),
      ),
      stop: vi.fn(() => {
        fake.stopped = true;
        events.push(`stop:${account.accountId}`);
        return of(undefined);
      }),
    } as unknown as MidnightWallet,
  };
  return fake;
};

/** Stands in for the module's engine start; each test file mocks `createStartMidnightAccountWallet` with it. */
export const fakeEngines = {
  started: [] as FakeEngine[],
  failNextStart: undefined as unknown,
  /** While set, a started engine is handed out only once it resolves. */
  hold: undefined as Promise<void> | undefined,
  /** While set, a started engine's address, coins, sync progress, history and state emit only what the test pushes. */
  withholdValues: false,
  createStart:
    (_dependencies: unknown, options: MidnightEngineOptions) =>
    (params: StartMidnightAccountWalletParams) =>
      new Observable<MidnightWallet>(subscriber => {
        if (fakeEngines.failNextStart !== undefined) {
          const error = fakeEngines.failNextStart;
          fakeEngines.failNextStart = undefined;
          subscriber.error(error);
          return;
        }
        const fake = createFakeEngine(params, options);
        fakeEngines.started.push(fake);
        events.push(`start:${params.account.accountId}`);
        void (fakeEngines.hold ?? Promise.resolve()).then(() => {
          if (!fake.tornDown) subscriber.next(fake.engine);
        });
        return () => {
          fake.tornDown = true;
        };
      }),
  reset: () => {
    fakeEngines.started.length = 0;
    fakeEngines.failNextStart = undefined;
    fakeEngines.hold = undefined;
    fakeEngines.withholdValues = false;
    events.length = 0;
  },
  of: (accountId: string) =>
    fakeEngines.started.filter(
      ({ engine }) => String(engine.accountId) === accountId,
    ),
  current: (accountId: string) => {
    const all = fakeEngines.of(accountId);
    return all[all.length - 1];
  },
};

/** Fails when a value holds anything a structured clone would strip or refuse: a class instance or a function. */
export const assertPlainData = (value: unknown, path = 'value'): void => {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'function') throw new Error(`${path} is a function`);
    return;
  }
  if (value instanceof Uint8Array || value instanceof Date) return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      assertPlainData(item, `${path}[${index}]`);
    });
    return;
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null)
    throw new Error(
      `${path} is an instance of ${String(prototype.constructor.name)}`,
    );
  for (const [key, item] of Object.entries(value))
    assertPlainData(item, `${path}.${key}`);
};
