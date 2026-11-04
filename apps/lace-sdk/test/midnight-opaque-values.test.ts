import {
  MidnightAccountId,
  MidnightDustAddress,
  MidnightNetworkId,
  MidnightSDKNetworkIds,
  NIGHT_TOKEN_ID,
  toUnshieldedTokenType,
} from '@lace-contract/midnight-context';
import * as stubData from '@lace-contract/midnight-context/src/stub-data';
import { createScopedProofServerAccess } from '@lace-lib/vendor/proof-server-transport';
import * as ledger from '@midnight-ntwrk/ledger-v8';
import { UnshieldedAddress } from '@midnightntwrk/wallet-sdk-address-format';
import { BehaviorSubject, defer, NEVER, of, TimeoutError } from 'rxjs';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { buildMidnightTransfer } from '../src/build-midnight-transfer';
import { buildMidnightTransfers } from '../src/build-midnight-transfers';
import { discardMidnightTx } from '../src/discard-midnight-tx';
import {
  balanceMidnightSealedTransaction,
  balanceMidnightUnsealedTransaction,
  makeMidnightIntent,
  makeMidnightTransfer,
} from '../src/midnight-connector-transactions';
import {
  MidnightStaleTxError,
  MidnightSubmitTimeoutError,
} from '../src/midnight-errors';
import { proveMidnightTx } from '../src/prove-midnight-tx';
import { registerMidnightDust } from '../src/register-midnight-dust';
import { signMidnightTx } from '../src/sign-midnight-tx';
import { submitMidnightTx } from '../src/submit-midnight-tx';

import { pageModeEngineAccess } from './midnight-engine-access-fake';
import { toMidnightTxRecipe } from './midnight-opaque-fixtures';

import type { MidnightTxRecipe } from '../src/build-midnight-transfer';
import type { WalletWithMidnight } from '../src/midnight-wallet';
import type { MidnightFinalizedTx } from '../src/prove-midnight-tx';
import type {
  MidnightWallet,
  MidnightWalletsByAccountId,
} from '@lace-contract/midnight-context';
import type { Result } from '@lace-lib/util';
import type {
  BalancingRecipe,
  WalletFacade,
} from '@midnightntwrk/wallet-sdk/facade';

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
const recipient = UnshieldedAddress.codec
  .encode(networkId, new UnshieldedAddress(Buffer.alloc(32, 7)))
  .toString();
const nightOutput = {
  kind: 'unshielded' as const,
  type: NIGHT_TOKEN_ID,
  value: 1n,
  recipient,
};

// Real ledger transactions: an unshielded NIGHT spend, unproven, proved but unbound, and proved and bound.
const unproven = () => {
  const key = ledger.signatureVerifyingKey(ledger.sampleSigningKey());
  const token = ledger.nativeToken().raw;
  const intent = ledger.Intent.new(new Date(Date.now() + 3_600_000));
  intent.guaranteedUnshieldedOffer = ledger.UnshieldedOffer.new(
    [
      {
        value: 5n,
        owner: key,
        type: token,
        intentHash: ledger.sampleIntentHash(),
        outputNo: 0,
      },
    ],
    [{ value: 5n, owner: ledger.addressFromKey(key), type: token }],
    [],
  );
  return ledger.Transaction.fromParts(networkId, undefined, undefined, intent);
};
// Without contract calls, proving asks the prover for nothing.
const unbound = async () =>
  unproven().prove(
    { check: async () => [], prove: async () => new Uint8Array() },
    ledger.CostModel.initialCostModel(),
  );
const unprovenRecipe = (): BalancingRecipe => ({
  type: 'UNPROVEN_TRANSACTION',
  transaction: unproven(),
});

const hex = (transaction: { serialize: () => Uint8Array }) =>
  Buffer.from(transaction.serialize()).toString('hex');
const bytesOf = (recipe: BalancingRecipe) =>
  recipe.type === 'UNPROVEN_TRANSACTION'
    ? hex(recipe.transaction)
    : recipe.type === 'UNBOUND_TRANSACTION'
    ? hex(recipe.baseTransaction)
    : hex(recipe.originalTransaction);
const valueBytes = (value: MidnightFinalizedTx | MidnightTxRecipe) =>
  Buffer.from(
    'transaction' in value ? value.transaction : new Uint8Array(),
  ).toString('hex');

const createEngine = () => {
  const built = unprovenRecipe();
  const balanced = unprovenRecipe();
  const signed = unprovenRecipe();
  const proved = unproven().mockProve();
  return {
    accountId,
    networkId,
    built,
    balanced,
    signed,
    proved,
    address$: of({
      dust: MidnightDustAddress(
        'mn_dust_preview1wdvvhux7luy22g5w6qsr3qerf49h0curwzfa2fv7acx9x258gmpzzaa5672',
      ),
    }),
    state: () =>
      of({
        unshielded: {
          availableCoins: [
            {
              utxo: { type: NIGHT_TOKEN_ID, value: 5n },
              meta: { registeredForDustGeneration: false },
            },
          ],
          pendingCoins: [],
        },
        dust: { totalCoins: [], availableCoins: [] },
      }),
    transferTransaction: vi.fn(() => of(built)),
    initSwap: vi.fn(() => of(built)),
    registerNightUtxosForDustGeneration: vi.fn(() => of(built)),
    balanceUnprovenTransaction: vi.fn(() => of(balanced)),
    balanceFinalizedTransaction: vi.fn(
      (original: ledger.FinalizedTransaction) =>
        of({
          type: 'FINALIZED_TRANSACTION',
          originalTransaction: original,
          balancingTransaction: unproven(),
        }),
    ),
    balanceUnboundTransaction: vi.fn(
      (
        base: ledger.Transaction<
          ledger.SignatureEnabled,
          ledger.Proof,
          ledger.PreBinding
        >,
      ) => of({ type: 'UNBOUND_TRANSACTION', baseTransaction: base }),
    ),
    signRecipe: vi.fn((_recipe: BalancingRecipe) => of(signed)),
    finalizeRecipe: vi.fn((_recipe: BalancingRecipe) => of(proved)),
    revert: vi.fn((_recipe: BalancingRecipe) => of(undefined)),
    submitTransaction: vi.fn((_transaction: ledger.FinalizedTransaction) =>
      of('tx-id'),
    ),
  };
};
type Engine = ReturnType<typeof createEngine>;

const setup = () => {
  const engine = createEngine();
  const registry = new BehaviorSubject<MidnightWalletsByAccountId>({
    [accountId]: engine as unknown as MidnightWallet,
  });
  const wallet: WalletWithMidnight = {
    stateObservables: {
      wallets: {
        selectAll$: of([{ ...stubData.midnightWallet, accounts: [account] }]),
      },
      network: {
        selectAllActiveNetworkIds$: of([MidnightNetworkId(networkId)]),
      },
    } as unknown as WalletWithMidnight['stateObservables'],
    _loadModules: (async () => [
      pageModeEngineAccess(registry),
    ]) as unknown as WalletWithMidnight['_loadModules'],
  };
  const replaceEngine = () => {
    const replacement = createEngine();
    registry.next({});
    registry.next({ [accountId]: replacement as unknown as MidnightWallet });
    return replacement;
  };
  return { engine, wallet, replaceEngine };
};

// Every value field is bytes or text: nothing a structured clone could strip.
const expectPlainData = (value: object) => {
  for (const field of Object.values(value))
    expect(typeof field === 'string' || field instanceof Uint8Array).toBe(true);
};

const expectOriginOf = (
  value: MidnightFinalizedTx | MidnightTxRecipe,
  engine: Engine,
) => {
  expect(value.accountId).toBe(accountId);
  expect(value.engineGeneration).toBe(
    toMidnightTxRecipe(engine as unknown as MidnightWallet, engine.built)
      .engineGeneration,
  );
};

const builders: [
  string,
  (wallet: WalletWithMidnight) => Promise<Result<MidnightTxRecipe, Error>>,
  (engine: Engine) => BalancingRecipe,
][] = [
  [
    'buildMidnightTransfer',
    async wallet =>
      buildMidnightTransfer(wallet, { to: recipient, amount: 1n }),
    engine => engine.balanced,
  ],
  [
    'buildMidnightTransfers',
    async wallet =>
      buildMidnightTransfers(wallet, {
        kind: 'unshielded',
        outputs: [
          {
            to: recipient,
            amount: 1n,
            tokenId: toUnshieldedTokenType(NIGHT_TOKEN_ID, networkId),
          },
        ],
      }),
    engine => engine.balanced,
  ],
  [
    'registerMidnightDust',
    async wallet => registerMidnightDust(wallet),
    engine => engine.built,
  ],
];

const connectorHelpers: [
  string,
  (wallet: WalletWithMidnight) => Promise<Result<MidnightFinalizedTx, Error>>,
][] = [
  [
    'balanceMidnightSealedTransaction',
    async wallet =>
      balanceMidnightSealedTransaction(wallet, {
        tx: hex(unproven().mockProve()),
      }),
  ],
  [
    'balanceMidnightUnsealedTransaction',
    async wallet =>
      balanceMidnightUnsealedTransaction(wallet, {
        tx: hex(await unbound()),
      }),
  ],
  [
    'makeMidnightTransfer',
    async wallet =>
      makeMidnightTransfer(wallet, { desiredOutputs: [nightOutput] }),
  ],
  [
    'makeMidnightIntent',
    async wallet =>
      makeMidnightIntent(wallet, {
        desiredInputs: [
          { kind: 'unshielded', type: NIGHT_TOKEN_ID, value: 1n },
        ],
        desiredOutputs: [nightOutput],
        options: { intentId: 'random', payFees: false },
      }),
  ],
];

describe('midnight-opaque-helpers', () => {
  it.each(builders)(
    '%s returns the engine recipe as an opaque value of its account and engine',
    async (_name, build, expected) => {
      const { engine, wallet } = setup();

      const recipe = (await build(wallet)).unwrap();

      expectPlainData(recipe);
      expectOriginOf(recipe, engine);
      expect(recipe.type).toBe('UNPROVEN_TRANSACTION');
      expect(valueBytes(recipe)).toBe(bytesOf(expected(engine)));
    },
  );

  it('signMidnightTx gives the engine the decoded recipe and returns the signed one as a value', async () => {
    const { engine, wallet } = setup();
    const recipe = (
      await buildMidnightTransfer(wallet, { to: recipient, amount: 1n })
    ).unwrap();

    const signed = (await signMidnightTx(wallet, { recipe })).unwrap();

    const [[decoded]] = engine.signRecipe.mock.calls;
    expect(bytesOf(decoded)).toBe(bytesOf(engine.balanced));
    expectPlainData(signed);
    expectOriginOf(signed, engine);
    expect(valueBytes(signed)).toBe(bytesOf(engine.signed));
  });

  it('proveMidnightTx gives the engine the decoded recipe and returns the proved transaction with its activity hash', async () => {
    const { engine, wallet } = setup();
    const recipe = (
      await buildMidnightTransfer(wallet, { to: recipient, amount: 1n })
    ).unwrap();

    const transaction = (await proveMidnightTx(wallet, { recipe })).unwrap();

    const [[decoded]] = engine.finalizeRecipe.mock.calls;
    expect(bytesOf(decoded)).toBe(bytesOf(engine.balanced));
    expectPlainData(transaction);
    expectOriginOf(transaction, engine);
    expect(valueBytes(transaction)).toBe(hex(engine.proved));
    expect(transaction.activityHash).toBe(engine.proved.transactionHash());
  });

  it('discardMidnightTx gives the engine the decoded recipe', async () => {
    const { engine, wallet } = setup();
    const recipe = (
      await buildMidnightTransfer(wallet, { to: recipient, amount: 1n })
    ).unwrap();

    expect((await discardMidnightTx(wallet, { recipe })).isOk()).toBe(true);

    const [[decoded]] = engine.revert.mock.calls;
    expect(bytesOf(decoded)).toBe(bytesOf(engine.balanced));
  });

  it('submitMidnightTx gives the engine the decoded transaction', async () => {
    const { engine, wallet } = setup();
    const recipe = (
      await buildMidnightTransfer(wallet, { to: recipient, amount: 1n })
    ).unwrap();
    const transaction = (await proveMidnightTx(wallet, { recipe })).unwrap();

    expect((await submitMidnightTx(wallet, { transaction })).unwrap()).toEqual({
      txId: 'tx-id',
    });

    const [[decoded]] = engine.submitTransaction.mock.calls;
    expect(hex(decoded)).toBe(hex(engine.proved));
  });

  it("submitMidnightTx reports a timeout under the value's activity hash", async () => {
    const { engine, wallet } = setup();
    engine.submitTransaction.mockReturnValue(NEVER);
    const recipe = (
      await buildMidnightTransfer(wallet, { to: recipient, amount: 1n })
    ).unwrap();
    const transaction = (await proveMidnightTx(wallet, { recipe })).unwrap();

    const error = (
      await submitMidnightTx(wallet, { transaction, submitTimeout: 20 })
    ).unwrapErr();

    expect(error).toBeInstanceOf(MidnightSubmitTimeoutError);
    expect(error).toMatchObject({ activityHash: transaction.activityHash });
  });

  it.each(connectorHelpers)(
    '%s returns the proved transaction as an opaque value with its activity hash',
    async (_name, helper) => {
      const { engine, wallet } = setup();

      const transaction = (await helper(wallet)).unwrap();

      expectPlainData(transaction);
      expectOriginOf(transaction, engine);
      expect(valueBytes(transaction)).toBe(hex(engine.proved));
      expect(transaction.activityHash).toBe(engine.proved.transactionHash());
    },
  );

  it('runs build, sign, prove and submit on structured clones of the values', async () => {
    const { engine, wallet } = setup();
    const recipe = (
      await buildMidnightTransfer(wallet, { to: recipient, amount: 1n })
    ).unwrap();
    const signed = (
      await signMidnightTx(wallet, { recipe: structuredClone(recipe) })
    ).unwrap();
    const transaction = (
      await proveMidnightTx(wallet, { recipe: structuredClone(signed) })
    ).unwrap();

    expect(
      (
        await submitMidnightTx(wallet, {
          transaction: structuredClone(transaction),
        })
      ).isOk(),
    ).toBe(true);
    expect(bytesOf(engine.finalizeRecipe.mock.calls[0][0])).toBe(
      bytesOf(engine.signed),
    );
  });

  it('refuses a recipe of another account before calling the engine', async () => {
    const { engine, wallet } = setup();
    const otherAccount = MidnightAccountId(stubData.walletId, 1, networkId);
    const recipe = toMidnightTxRecipe(
      { ...engine, accountId: otherAccount } as unknown as MidnightWallet,
      engine.built,
    );

    const error = (await signMidnightTx(wallet, { recipe })).unwrapErr();

    expect(error.message).toBe(
      `This Midnight transaction belongs to account "${otherAccount}", not "${accountId}": pass the accountId it was built with`,
    );
    expect(engine.signRecipe).not.toHaveBeenCalled();
  });

  it('refuses an engine recipe passed where the opaque value belongs', async () => {
    const { engine, wallet } = setup();

    const error = (
      await discardMidnightTx(wallet, {
        recipe: engine.built as unknown as MidnightTxRecipe,
      })
    ).unwrapErr();

    expect(error.message).toBe(
      'Expected a Midnight transaction value returned by the SDK',
    );
    expect(engine.revert).not.toHaveBeenCalled();
  });
});

describe('midnight-duplicate-proof-refused', () => {
  // The engine finalizes through the proof server access every account engine uses, on a facade that reverts a
  // failed proof's transaction as the wallet facade does. The first proof waits for the test; a later one fails.
  const provingSetup = async () => {
    const { engine, wallet } = setup();
    let settle!: {
      resolve: (transaction: ledger.FinalizedTransaction) => void;
      reject: (error: Error) => void;
    };
    const prove = vi
      .fn<() => Promise<ledger.FinalizedTransaction>>()
      .mockImplementationOnce(
        async () =>
          new Promise((resolve, reject) => {
            settle = { resolve, reject };
          }),
      )
      .mockRejectedValue(new Error('proof server unavailable'));
    const revertTransaction = vi.fn();
    const access = createScopedProofServerAccess(
      () => ({ transport: {}, provingService: { prove } } as never),
    );
    const facade = {
      finalizeRecipe: async ({ transaction }: { transaction: never }) => {
        try {
          return await access.provingService.prove(transaction);
        } catch (error) {
          revertTransaction(transaction);
          throw error;
        }
      },
    } as unknown as WalletFacade;
    engine.finalizeRecipe.mockImplementation(recipe =>
      defer(async () => access.finalizeRecipe(facade, recipe)),
    );
    const recipe = (
      await buildMidnightTransfer(wallet, { to: recipient, amount: 1n })
    ).unwrap();
    return {
      engine,
      wallet,
      recipe,
      prove,
      revertTransaction,
      settle: () => settle,
    };
  };

  it.each([
    ['the same value', (value: MidnightTxRecipe) => value],
    [
      'a structured clone of the value',
      (value: MidnightTxRecipe) => structuredClone(value),
    ],
  ])(
    'refuses a second proof of %s while the first runs, before proving or releasing anything',
    async (_name, copy) => {
      const { engine, wallet, recipe, prove, revertTransaction, settle } =
        await provingSetup();
      const first = proveMidnightTx(wallet, { recipe });
      await vi.waitFor(() => {
        expect(prove).toHaveBeenCalledOnce();
      });

      const error = (
        await proveMidnightTx(wallet, { recipe: copy(recipe) })
      ).unwrapErr();

      expect(error.message).toBe('This transaction is already being finalized');
      expect(prove).toHaveBeenCalledOnce();
      expect(revertTransaction).not.toHaveBeenCalled();
      settle().resolve(engine.proved);
      expect((await first).isOk()).toBe(true);
    },
  );

  it('refuses a retry while a timed-out proof still runs, and proves it once that proof settles', async () => {
    const { engine, wallet, recipe, prove, revertTransaction, settle } =
      await provingSetup();

    const timedOut = (
      await proveMidnightTx(wallet, { recipe, proveTimeout: 20 })
    ).unwrapErr();
    const retry = (await proveMidnightTx(wallet, { recipe })).unwrapErr();

    expect(timedOut).toBeInstanceOf(TimeoutError);
    expect(retry.message).toBe('This transaction is already being finalized');
    expect(prove).toHaveBeenCalledOnce();
    expect(revertTransaction).not.toHaveBeenCalled();
    settle().resolve(engine.proved);
    prove.mockResolvedValue(engine.proved);
    await vi.waitFor(async () => {
      expect((await proveMidnightTx(wallet, { recipe })).isOk()).toBe(true);
    });
    expect(prove).toHaveBeenCalledTimes(2);
  });

  it.each(['succeeded', 'failed'] as const)(
    'proves a recipe again once its earlier proof has %s',
    async outcome => {
      const { engine, wallet, recipe, prove, settle } = await provingSetup();
      const first = proveMidnightTx(wallet, { recipe });
      await vi.waitFor(() => {
        expect(prove).toHaveBeenCalledOnce();
      });
      if (outcome === 'succeeded') settle().resolve(engine.proved);
      else settle().reject(new Error('proof failed'));
      expect((await first).isOk()).toBe(outcome === 'succeeded');
      prove.mockResolvedValue(engine.proved);

      expect((await proveMidnightTx(wallet, { recipe })).isOk()).toBe(true);
      expect(prove).toHaveBeenCalledTimes(2);
    },
  );
});

describe('midnight-stale-value-refused', () => {
  const uses: [
    string,
    (
      wallet: WalletWithMidnight,
      values: { recipe: MidnightTxRecipe; transaction: MidnightFinalizedTx },
    ) => Promise<Result<unknown, Error>>,
    keyof Pick<
      Engine,
      'finalizeRecipe' | 'revert' | 'signRecipe' | 'submitTransaction'
    >,
  ][] = [
    [
      'signMidnightTx',
      async (wallet, { recipe }) => signMidnightTx(wallet, { recipe }),
      'signRecipe',
    ],
    [
      'proveMidnightTx',
      async (wallet, { recipe }) => proveMidnightTx(wallet, { recipe }),
      'finalizeRecipe',
    ],
    [
      'discardMidnightTx',
      async (wallet, { recipe }) => discardMidnightTx(wallet, { recipe }),
      'revert',
    ],
    [
      'submitMidnightTx',
      async (wallet, { transaction }) =>
        submitMidnightTx(wallet, { transaction }),
      'submitTransaction',
    ],
  ];

  it.each(uses)(
    '%s refuses a value built before the account engine was replaced',
    async (_name, use, method) => {
      const { engine, wallet, replaceEngine } = setup();
      const recipe = (
        await buildMidnightTransfer(wallet, { to: recipient, amount: 1n })
      ).unwrap();
      const transaction = (await proveMidnightTx(wallet, { recipe })).unwrap();
      engine[method].mockClear();
      const replacement = replaceEngine();

      const error = (await use(wallet, { recipe, transaction })).unwrapErr();

      expect(error).toBeInstanceOf(MidnightStaleTxError);
      expect(error).toMatchObject({
        name: 'MidnightStaleTxError',
        code: 'midnight-stale-tx',
      });
      expect(error.message).toContain('build it again');
      expect(engine[method]).not.toHaveBeenCalled();
      expect(replacement[method]).not.toHaveBeenCalled();
    },
  );

  it.each(uses)(
    '%s refuses a value of a replaced engine whose bytes the ledger cannot read as stale, without decoding them',
    async (_name, use, method) => {
      const { wallet, replaceEngine } = setup();
      const recipe = (
        await buildMidnightTransfer(wallet, { to: recipient, amount: 1n })
      ).unwrap();
      const transaction = (await proveMidnightTx(wallet, { recipe })).unwrap();
      const replacement = replaceEngine();
      const garbled = <T extends object>(value: T): T =>
        Object.fromEntries(
          Object.entries(value).map(([key, field]) => [
            key,
            field instanceof Uint8Array ? new Uint8Array([0xde, 0xad]) : field,
          ]),
        ) as T;
      const deserialize = vi.spyOn(ledger.Transaction, 'deserialize');
      onTestFinished(() => {
        deserialize.mockRestore();
      });

      const error = (
        await use(wallet, {
          recipe: garbled(recipe),
          transaction: garbled(transaction),
        })
      ).unwrapErr();

      expect(error).toBeInstanceOf(MidnightStaleTxError);
      expect(deserialize).not.toHaveBeenCalled();
      expect(replacement[method]).not.toHaveBeenCalled();
    },
  );

  it.each(uses)(
    '%s accepts a value built by the engine that still runs the account',
    async (_name, use, method) => {
      const { engine, wallet } = setup();
      const recipe = (
        await buildMidnightTransfer(wallet, { to: recipient, amount: 1n })
      ).unwrap();
      const transaction = (await proveMidnightTx(wallet, { recipe })).unwrap();
      engine[method].mockClear();

      expect((await use(wallet, { recipe, transaction })).isOk()).toBe(true);
      expect(engine[method]).toHaveBeenCalledOnce();
    },
  );

  it('refuses a value of the same account from another SDK instance', async () => {
    const first = setup();
    const second = setup();
    const recipe = (
      await buildMidnightTransfer(first.wallet, { to: recipient, amount: 1n })
    ).unwrap();

    const error = (await signMidnightTx(second.wallet, { recipe })).unwrapErr();

    expect(error).toBeInstanceOf(MidnightStaleTxError);
    expect(second.engine.signRecipe).not.toHaveBeenCalled();
  });
});
