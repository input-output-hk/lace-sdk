import { ActivityType } from '@lace-contract/activities';
import {
  NIGHT_TOKEN_ID,
  toUnshieldedTokenType,
} from '@lace-contract/midnight-context';
import * as fixture from '@lace-contract/midnight-context/src/stub-data';
import { BigNumber, Timestamp } from '@lace-lib/util';
import {
  applyMidnightSignedMessagePrefix,
  decodeMidnightSignData,
} from '@lace-lib/vendor/midnight-sign-data';
import { MidnightWorkerError } from '@lace-module/midnight-sync/sdk';
import { buildConnectorTransaction } from '@lace-module/midnight-sync/sdk-engine';
import { firstValueFrom, map, NEVER, of, TimeoutError, timer } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  balanceMidnightSealedTransaction,
  balanceMidnightUnsealedTransaction,
  buildMidnightTransfer,
  buildMidnightTransfers,
  discardMidnightTx,
  estimateMidnightFee,
  getMidnightProvingProvider,
  makeMidnightIntent,
  makeMidnightTransfer,
  MidnightEngineResetError,
  MidnightNothingToRegisterError,
  MidnightStaleTxError,
  MidnightSubmitInterruptedError,
  MidnightSubmitTimeoutError,
  MidnightWorkerStartupError,
  MidnightWorkerStoppedError,
  observeMidnightBalances,
  proveMidnightTx,
  registerMidnightDust,
  signMidnightData,
  signMidnightTx,
  submitMidnightTx,
} from '../src/midnight';
import { DEFAULT_PROVE_TIMEOUT_MS } from '../src/prove-midnight-tx';

import {
  addMidnightAccount,
  createFakeEngineHost,
  createMidnightWallet,
  installFakeBrowser,
  NODE_REJECTION_MESSAGE,
  nodeRejection,
  workerFinalizedTx,
  workerRecipe,
} from './midnight-worker-fakes';

import type { Activity } from '@lace-contract/activities';
import type { MidnightWallet } from '@lace-contract/midnight-context';

vi.setConfig({ testTimeout: 30_000 });
const { accountId, networkId } = fixture;
const unshieldedNight = toUnshieldedTokenType(NIGHT_TOKEN_ID, networkId);
const unshieldedOutput = {
  to: fixture.midnightUnshieldedAddress,
  tokenId: unshieldedNight,
  amount: 3n,
};
const pendingActivity: Activity = {
  accountId,
  activityId: 'worker-hash',
  timestamp: Timestamp(1000),
  tokenBalanceChanges: [
    { tokenId: unshieldedNight, amount: BigNumber(-3n) },
  ] as Activity['tokenBalanceChanges'],
  type: ActivityType.Pending,
};
const keyMaterialProvider = {
  getProverKey: vi.fn(async () => new Uint8Array([1])),
  getVerifierKey: vi.fn(async () => new Uint8Array([2])),
  getZKIR: vi.fn(async () => new Uint8Array([3])),
};

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A wallet in Worker mode whose account engine runs in a worker served by the fake host. */
const setup = async (
  configure?: (host: ReturnType<typeof createFakeEngineHost>['host']) => void,
) => {
  const fake = createFakeEngineHost();
  configure?.(fake.host);
  const browser = installFakeBrowser(fake.asHost());
  const wallet = await createMidnightWallet({ worker: true });
  await addMidnightAccount(wallet);
  return { ...fake, browser, wallet };
};

/** Resolves when `spy` has been called, leaving its call pending. */
const pendingCall = () => {
  let called!: () => void;
  const reached = new Promise<void>(resolve => {
    called = resolve;
  });
  return {
    reached,
    implementation: async () => {
      called();
      return new Promise<never>(() => undefined);
    },
  };
};

const lastCauseOf = (error: unknown): unknown =>
  error instanceof Error && error.cause !== undefined
    ? lastCauseOf(error.cause)
    : error;

const activityRowsOf = async (
  wallet: Awaited<ReturnType<typeof setup>>['wallet'],
) =>
  firstValueFrom(
    wallet.stateObservables.activities.selectByAccountId$.pipe(
      map(select => select({ accountId })),
    ),
  );

describe('test:midnight-worker-helpers', () => {
  it('buildMidnightTransfer builds the NIGHT transfer in the worker and returns its opaque recipe', async () => {
    const { host, wallet } = await setup();
    const ttl = new Date('2030-01-01T00:00:00.000Z');

    const recipe = await buildMidnightTransfer(wallet, {
      accountId,
      to: fixture.midnightUnshieldedAddress,
      amount: 3n,
      ttl,
    });

    expect(recipe.unwrap()).toEqual(workerRecipe());
    expect(host.build).toHaveBeenCalledWith({
      clientId: expect.any(String) as unknown,
      accountId,
      tx: {
        kind: 'transfer',
        transfer: { kind: 'unshielded', outputs: [unshieldedOutput], ttl },
      },
    });
  });

  it('buildMidnightTransfers builds the batch in the worker', async () => {
    const { host, wallet } = await setup();

    const recipe = await buildMidnightTransfers(wallet, {
      accountId,
      kind: 'unshielded',
      outputs: [unshieldedOutput],
    });

    expect(recipe.unwrap()).toEqual(workerRecipe());
    expect(host.build).toHaveBeenCalledWith(
      expect.objectContaining({
        tx: {
          kind: 'transfer',
          transfer: { kind: 'unshielded', outputs: [unshieldedOutput] },
        },
      }),
    );
  });

  it('registerMidnightDust builds the registration in the worker, refuses ttl before dispatch and maps a refusal to MidnightNothingToRegisterError', async () => {
    const { host, wallet } = await setup();

    const recipe = await registerMidnightDust(wallet, {
      accountId,
      dustAddress: fixture.midnightDustAddress,
    });
    const withTtl = await registerMidnightDust(wallet, {
      accountId,
      ttl: new Date() as never,
    });
    host.build.mockRejectedValueOnce(
      new MidnightWorkerError('nothing-to-register', 'no NIGHT'),
    );
    const empty = await registerMidnightDust(wallet, { accountId });

    expect(recipe.unwrap()).toEqual(workerRecipe());
    expect(host.build).toHaveBeenNthCalledWith(1, {
      clientId: expect.any(String) as unknown,
      accountId,
      tx: {
        kind: 'dust-registration',
        dustAddress: fixture.midnightDustAddress,
      },
    });
    expect(withTtl.isErr() && withTtl.error.message).toBe(
      'A DUST registration does not accept ttl: the engine sets its validity window',
    );
    expect(host.build).toHaveBeenCalledTimes(2);
    expect(empty.isErr() && empty.error).toBeInstanceOf(
      MidnightNothingToRegisterError,
    );
  });

  it('estimateMidnightFee estimates a transfer and a registration in the worker', async () => {
    const { host, wallet } = await setup();

    const transfer = await estimateMidnightFee(wallet, {
      kind: 'transfer',
      transfer: { accountId, kind: 'unshielded', outputs: [unshieldedOutput] },
    });
    const registration = await estimateMidnightFee(wallet, {
      kind: 'dust-registration',
      registration: { accountId },
    });

    expect(transfer.unwrap()).toEqual({ dustFee: 2n, availableDust: 9n });
    expect(registration.unwrap()).toEqual({ dustFee: 2n, availableDust: 9n });
    expect(host.estimate.mock.calls.map(([request]) => request.tx)).toEqual([
      {
        kind: 'transfer',
        transfer: { kind: 'unshielded', outputs: [unshieldedOutput] },
      },
      { kind: 'dust-registration' },
    ]);
  });

  it('signMidnightTx signs in the worker and maps a stale value to MidnightStaleTxError', async () => {
    const { host, wallet } = await setup();

    const signed = await signMidnightTx(wallet, {
      accountId,
      recipe: workerRecipe(),
    });
    host.sign.mockRejectedValueOnce(
      new MidnightWorkerError('stale-value', 'built by an earlier engine'),
    );
    const stale = await signMidnightTx(wallet, {
      accountId,
      recipe: workerRecipe(),
    });

    expect(signed.unwrap()).toEqual(workerRecipe());
    expect(host.sign).toHaveBeenNthCalledWith(1, {
      clientId: expect.any(String) as unknown,
      accountId,
      recipe: workerRecipe(),
    });
    expect(stale.isErr() && stale.error).toBeInstanceOf(MidnightStaleTxError);
  });

  it('proveMidnightTx proves in the worker, feeds its proving progress to onProgress and refuses a bad proveTimeout before dispatch', async () => {
    const { host, progress$, wallet } = await setup();
    host.prove.mockImplementation(async ({ operationId }) => {
      progress$.next({ operationId, event: { type: 'reset', steps: [] } });
      await new Promise(resolve => {
        setTimeout(resolve, 50);
      });
      return workerFinalizedTx();
    });
    const onProgress = vi.fn();

    const proved = await proveMidnightTx(wallet, {
      accountId,
      recipe: workerRecipe(),
      onProgress,
    });
    const refused = await proveMidnightTx(wallet, {
      accountId,
      recipe: workerRecipe(),
      proveTimeout: 0,
    });

    expect(proved.unwrap()).toEqual(workerFinalizedTx());
    expect(host.prove).toHaveBeenCalledOnce();
    expect(host.prove).toHaveBeenCalledWith({
      clientId: expect.any(String) as unknown,
      accountId,
      recipe: workerRecipe(),
      operationId: expect.any(String) as unknown,
    });
    expect(onProgress).toHaveBeenCalledWith({ type: 'reset', steps: [] });
    expect(refused.isErr() && refused.error).toBeInstanceOf(RangeError);
  });

  it('discardMidnightTx releases the recipe in the worker', async () => {
    const { host, wallet } = await setup();

    const discarded = await discardMidnightTx(wallet, {
      accountId,
      recipe: workerRecipe(),
    });

    expect(discarded.isOk()).toBe(true);
    expect(host.discard).toHaveBeenCalledWith({
      clientId: expect.any(String) as unknown,
      accountId,
      recipe: workerRecipe(),
    });
  });

  it('submitMidnightTx records the Pending activity the worker derives, then submits in the worker', async () => {
    const { host, wallet } = await setup(host => {
      host.preparePendingActivity.mockResolvedValue(pendingActivity as never);
    });

    const submitted = await submitMidnightTx(wallet, {
      accountId,
      transaction: workerFinalizedTx(),
    });

    expect(submitted.unwrap()).toEqual({ txId: 'worker-tx' });
    expect(host.preparePendingActivity).toHaveBeenCalledWith({
      clientId: expect.any(String) as unknown,
      accountId,
      transaction: workerFinalizedTx(),
    });
    expect(
      host.preparePendingActivity.mock.invocationCallOrder[0],
    ).toBeLessThan(host.submit.mock.invocationCallOrder[0]);
    expect(await activityRowsOf(wallet)).toEqual([
      expect.objectContaining({
        activityId: 'worker-hash',
        type: ActivityType.Pending,
      }),
    ]);
  });

  it('submitMidnightTx returns MidnightSubmitInterruptedError when the worker ends after dispatch, keeps the Pending row and never submits again', async () => {
    const submit = pendingCall();
    const { host, browser, wallet } = await setup(host => {
      host.preparePendingActivity.mockResolvedValue(pendingActivity as never);
      host.submit.mockImplementation(submit.implementation);
    });

    const result = submitMidnightTx(wallet, {
      accountId,
      transaction: workerFinalizedTx(),
    });
    await submit.reached;
    browser.killWorker();
    const error = (await result).unwrapErr();

    expect(error).toBeInstanceOf(MidnightSubmitInterruptedError);
    expect(error).toMatchObject({
      code: 'midnight-submit-interrupted',
      activityHash: 'worker-hash',
    });
    expect(host.submit).toHaveBeenCalledOnce();
    expect(await activityRowsOf(wallet)).toEqual([
      expect.objectContaining({ activityId: 'worker-hash' }),
    ]);
  });

  it('submitMidnightTx maps a submission refused while a reset waits to MidnightEngineResetError and removes the Pending row', async () => {
    const { wallet } = await setup(host => {
      host.preparePendingActivity.mockResolvedValue(pendingActivity as never);
      host.submit.mockRejectedValue(
        new MidnightWorkerError('reset-pending', 'a reset waits'),
      );
    });

    const submitted = await submitMidnightTx(wallet, {
      accountId,
      transaction: workerFinalizedTx(),
    });

    expect(submitted.isErr() && submitted.error).toBeInstanceOf(
      MidnightEngineResetError,
    );
    await vi.waitFor(async () => {
      expect(await activityRowsOf(wallet)).toEqual([]);
    });
  });

  it('submitMidnightTx maps a submission that no running engine took to MidnightStaleTxError and removes the Pending row', async () => {
    const { host, wallet } = await setup(host => {
      host.preparePendingActivity.mockResolvedValue(pendingActivity as never);
      host.submit.mockRejectedValue(
        new MidnightWorkerError('not-running', 'no engine runs'),
      );
    });

    const submitted = await submitMidnightTx(wallet, {
      accountId,
      transaction: workerFinalizedTx(),
    });

    expect(submitted.isErr() && submitted.error).toBeInstanceOf(
      MidnightStaleTxError,
    );
    expect(host.submit).toHaveBeenCalledOnce();
    await vi.waitFor(async () => {
      expect(await activityRowsOf(wallet)).toEqual([]);
    });
  });

  it('submitMidnightTx returns MidnightSubmitInterruptedError and keeps the Pending row when the engine is replaced during the submission', async () => {
    const { wallet } = await setup(host => {
      host.preparePendingActivity.mockResolvedValue(pendingActivity as never);
      host.submit.mockRejectedValue(
        new MidnightWorkerError('engine-replaced', 'replaced while it ran'),
      );
    });

    const submitted = await submitMidnightTx(wallet, {
      accountId,
      transaction: workerFinalizedTx(),
    });

    expect(submitted.isErr() && submitted.error).toBeInstanceOf(
      MidnightSubmitInterruptedError,
    );
    expect(await activityRowsOf(wallet)).toEqual([
      expect.objectContaining({ activityId: 'worker-hash' }),
    ]);
  });

  it("submitMidnightTx posts the submission without a Pending row when the worker's derivation outlasts its bound, and times finality from the post", async () => {
    const derivation = pendingCall();
    const submit = pendingCall();
    const { host, wallet } = await setup(host => {
      host.preparePendingActivity.mockImplementation(derivation.implementation);
      host.submit.mockImplementation(submit.implementation);
    });

    const submitted = await submitMidnightTx(wallet, {
      accountId,
      transaction: workerFinalizedTx(),
      submitTimeout: 100,
    });

    expect(submitted.isErr() && submitted.error).toBeInstanceOf(
      MidnightSubmitTimeoutError,
    );
    expect(host.submit).toHaveBeenCalledOnce();
    expect(
      host.preparePendingActivity.mock.invocationCallOrder[0],
    ).toBeLessThan(host.submit.mock.invocationCallOrder[0]);
    expect(await activityRowsOf(wallet)).toEqual([]);
  });

  it("submitMidnightTx submits without a Pending row when the worker's derivation never answers", async () => {
    const derivation = pendingCall();
    const { host, wallet } = await setup(host => {
      host.preparePendingActivity.mockImplementation(derivation.implementation);
    });

    const submitted = await submitMidnightTx(wallet, {
      accountId,
      transaction: workerFinalizedTx(),
      submitTimeout: 50,
    });

    expect(submitted.unwrap()).toEqual({ txId: 'worker-tx' });
    expect(host.submit).toHaveBeenCalledOnce();
    expect(await activityRowsOf(wallet)).toEqual([]);
  });

  it("submitMidnightTx returns the engine's error for a transaction the node rejects with the name, message and stack page mode returns, the node's reason in its cause, and removes the Pending row", async () => {
    const rejection = await nodeRejection();
    const { host, wallet } = await setup(host => {
      host.preparePendingActivity.mockResolvedValue(pendingActivity as never);
      host.submit.mockRejectedValue(rejection);
    });

    const submitted = await submitMidnightTx(wallet, {
      accountId,
      transaction: workerFinalizedTx(),
    });
    const error = submitted.isErr() ? submitted.error : undefined;

    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      name: rejection.name,
      message: rejection.message,
      stack: rejection.stack,
      cause: {
        cause: { failure: { cause: { message: NODE_REJECTION_MESSAGE } } },
      },
    });
    expect(error).not.toHaveProperty('code');
    expect(host.submit).toHaveBeenCalledOnce();
    await vi.waitFor(async () => {
      expect(await activityRowsOf(wallet)).toEqual([]);
    });
  });

  it('signMidnightData signs the prefixed message in the worker', async () => {
    const { host, wallet } = await setup();

    const signed = await signMidnightData(wallet, {
      accountId,
      data: '00ff80',
      options: { encoding: 'hex', keyType: 'unshielded' },
    });

    expect(signed.unwrap()).toEqual({
      data: '00ff80',
      signature: 'worker-signature',
      verifyingKey: 'worker-key',
    });
    expect(host.signData).toHaveBeenCalledWith({
      clientId: expect.any(String) as unknown,
      accountId,
      data: applyMidnightSignedMessagePrefix(
        decodeMidnightSignData('00ff80', 'hex'),
      ),
    });
  });

  it('the connector helpers build in the worker and check their input on the page before dispatch', async () => {
    const { host, wallet } = await setup();
    const desiredOutputs = [
      {
        kind: 'unshielded' as const,
        type: NIGHT_TOKEN_ID,
        value: 1n,
        recipient: fixture.midnightUnshieldedAddress,
      },
    ];
    const desiredInputs = [
      { kind: 'unshielded' as const, type: NIGHT_TOKEN_ID, value: 1n },
    ];

    const results = [
      await balanceMidnightSealedTransaction(wallet, {
        accountId,
        tx: 'abcd',
        options: { payFees: false },
      }),
      await balanceMidnightUnsealedTransaction(wallet, {
        accountId,
        tx: 'ef01',
      }),
      await makeMidnightTransfer(wallet, { accountId, desiredOutputs }),
      await makeMidnightIntent(wallet, {
        accountId,
        desiredInputs,
        desiredOutputs,
        options: { intentId: 1, payFees: true },
      }),
    ];
    const malformed = await balanceMidnightSealedTransaction(wallet, {
      accountId,
      tx: 'not hex',
    });

    expect(results.map(result => result.unwrap())).toEqual(
      Array.from({ length: 4 }, () => workerFinalizedTx()),
    );
    expect(
      host.buildConnectorTransaction.mock.calls.map(
        ([request]) => request.transaction,
      ),
    ).toEqual([
      {
        kind: 'balance-sealed',
        tx: 'abcd',
        payFees: false,
        proveTimeout: DEFAULT_PROVE_TIMEOUT_MS,
      },
      {
        kind: 'balance-unsealed',
        tx: 'ef01',
        proveTimeout: DEFAULT_PROVE_TIMEOUT_MS,
      },
      {
        kind: 'transfer',
        desiredOutputs,
        proveTimeout: DEFAULT_PROVE_TIMEOUT_MS,
      },
      {
        kind: 'intent',
        desiredInputs,
        desiredOutputs,
        payFees: true,
        proveTimeout: DEFAULT_PROVE_TIMEOUT_MS,
      },
    ]);
    expect(malformed.isErr() && malformed.error.message).toBe(
      'Expected a hexadecimal Midnight transaction',
    );
  });

  it('the connector helpers give proveTimeout to proving only in the worker: a build whose balancing outlasts it ends proved, and proving that outlasts it returns TimeoutError', async () => {
    const recipe = {
      type: 'UNPROVEN_TRANSACTION',
      transaction: { serialize: () => new Uint8Array([8]) },
    };
    const proved = {
      serialize: () => new Uint8Array([9]),
      transactionHash: () => 'worker-hash',
    };
    const slowly = () => timer(40).pipe(map(() => recipe));
    let finalizeRecipe = () => of(proved);
    // The worker's engine, which the host runs the engine-side connector build on.
    const engine = {
      accountId,
      networkId,
      transferTransaction: vi.fn(slowly),
      balanceUnprovenTransaction: vi.fn(slowly),
      finalizeRecipe: vi.fn(() => finalizeRecipe()),
      revert: vi.fn(() => of(undefined)),
    } as unknown as MidnightWallet;
    const { host, wallet } = await setup(fake => {
      fake.buildConnectorTransaction.mockImplementation(
        async ({ transaction }) =>
          firstValueFrom(buildConnectorTransaction(engine, transaction)),
      );
    });

    const built = await makeMidnightTransfer(wallet, {
      accountId,
      desiredOutputs: [],
      proveTimeout: 30,
    });
    finalizeRecipe = () => NEVER;
    const timedOut = await makeMidnightTransfer(wallet, {
      accountId,
      desiredOutputs: [],
      proveTimeout: 30,
    });

    expect(built.isOk() && built.value).toMatchObject({
      accountId,
      activityHash: 'worker-hash',
    });
    expect(timedOut.isErr() && timedOut.error).toBeInstanceOf(TimeoutError);
    expect(
      host.buildConnectorTransaction.mock.calls.map(
        ([request]) => request.transaction,
      ),
    ).toEqual([
      { kind: 'transfer', desiredOutputs: [], proveTimeout: 30 },
      { kind: 'transfer', desiredOutputs: [], proveTimeout: 30 },
    ]);
  });

  it('getMidnightProvingProvider checks and proves through the worker: check returns (bigint | undefined)[] and prove returns the proof bytes', async () => {
    const { host, wallet } = await setup();
    const preimage = new Uint8Array([9, 9]);

    const provider = (
      await getMidnightProvingProvider(wallet, {
        accountId,
        keyMaterialProvider,
      })
    ).unwrap();
    const checked: (bigint | undefined)[] = await provider.check(
      preimage,
      'my-circuit',
    );
    const proof: Uint8Array = await provider.prove(preimage, 'my-circuit', 5n);

    expect(checked).toEqual([1n, undefined]);
    expect(proof).toEqual(new Uint8Array([7, 8, 9]));
    const keyMaterial = {
      proverKey: new Uint8Array([1]),
      verifierKey: new Uint8Array([2]),
      ir: new Uint8Array([3]),
    };
    expect(host.checkCircuit).toHaveBeenCalledWith({
      clientId: expect.any(String) as unknown,
      accountId,
      serializedPreimage: preimage,
      keyLocation: 'my-circuit',
      keyMaterial,
    });
    expect(host.proveCircuit).toHaveBeenCalledWith({
      clientId: expect.any(String) as unknown,
      accountId,
      serializedPreimage: preimage,
      keyLocation: 'my-circuit',
      keyMaterial,
      overwriteBindingInput: 5n,
    });
  });

  it("getMidnightProvingProvider lets a ledger circuit whose key lookup fails prove with the proof server's material, and rejects any other failed lookup without dispatch", async () => {
    const { host, wallet } = await setup();
    const lookupFailure = new Error('no such circuit');
    const failing = {
      getProverKey: async () => {
        throw lookupFailure;
      },
      getVerifierKey: async () => new Uint8Array([2]),
      getZKIR: async () => new Uint8Array([3]),
    };
    const provider = (
      await getMidnightProvingProvider(wallet, {
        accountId,
        keyMaterialProvider: failing,
      })
    ).unwrap();

    await provider.check(new Uint8Array([1]), 'midnight/zswap/spend');
    const refusal = await provider
      .check(new Uint8Array([1]), 'my-circuit')
      .catch((error: unknown) => error);

    expect(host.checkCircuit).toHaveBeenCalledOnce();
    expect(host.checkCircuit.mock.calls[0][0]).toMatchObject({
      keyLocation: 'midnight/zswap/spend',
      keyMaterial: undefined,
    });
    expect(refusal).toBe(lookupFailure);
  });

  it('observeMidnightBalances reads the balances the worker engine publishes', async () => {
    const { wallet } = await setup();

    const balances = await firstValueFrom(
      observeMidnightBalances(wallet, { accountId }),
    );

    expect(balances).toMatchObject({
      accountId,
      night: { available: 5n, pending: 0n },
      dust: { balance: 7n, available: 3n },
    });
  });

  it('maps an engine replaced during a call to MidnightEngineResetError and a worker that ends during a call to MidnightWorkerStoppedError', async () => {
    const signData = pendingCall();
    const { host, browser, wallet } = await setup(host => {
      host.build.mockRejectedValueOnce(
        new MidnightWorkerError(
          'engine-replaced',
          'replaced while the call ran',
        ),
      );
      host.signData.mockImplementation(signData.implementation);
    });

    const replaced = await buildMidnightTransfers(wallet, {
      accountId,
      kind: 'unshielded',
      outputs: [unshieldedOutput],
    });
    const signing = signMidnightData(wallet, {
      accountId,
      data: '00',
      options: { encoding: 'hex', keyType: 'unshielded' },
    });
    await signData.reached;
    browser.killWorker();
    const stopped = await signing;

    expect(replaced.isErr() && replaced.error).toBeInstanceOf(
      MidnightEngineResetError,
    );
    expect(stopped.isErr() && stopped.error).toBeInstanceOf(
      MidnightWorkerStoppedError,
    );
    expect(stopped.isErr() && stopped.error).toMatchObject({
      code: 'midnight-worker-stopped',
    });
    expect(host.build).toHaveBeenCalledOnce();
  });

  it('maps a call that reached no running engine to MidnightEngineResetError on every helper but submitMidnightTx, as before', async () => {
    const notRunning = new MidnightWorkerError('not-running', 'no engine runs');
    const { wallet } = await setup(host => {
      host.build.mockRejectedValue(notRunning);
      host.signData.mockRejectedValue(notRunning);
      host.discard.mockRejectedValue(notRunning);
    });

    const results = await Promise.all([
      buildMidnightTransfers(wallet, {
        accountId,
        kind: 'unshielded',
        outputs: [unshieldedOutput],
      }),
      signMidnightData(wallet, {
        accountId,
        data: '00',
        options: { encoding: 'hex', keyType: 'unshielded' },
      }),
      discardMidnightTx(wallet, { accountId, recipe: workerRecipe() }),
    ]);

    for (const result of results)
      expect(result.isErr() && result.error).toBeInstanceOf(
        MidnightEngineResetError,
      );
  });

  it('returns MidnightWorkerStartupError when the browser cannot construct the worker', async () => {
    const { host, asHost } = createFakeEngineHost();
    installFakeBrowser(asHost());
    vi.stubGlobal(
      'SharedWorker',
      class {
        public constructor(_url: unknown, options: WorkerOptions) {
          void options.type;
          throw new DOMException('Blocked by the page policy', 'SecurityError');
        }
      },
    );
    const wallet = await createMidnightWallet({ worker: true });
    await addMidnightAccount(wallet);

    const signed = await signMidnightData(wallet, {
      accountId,
      data: '00',
      options: { encoding: 'hex', keyType: 'unshielded' },
      startTimeout: 10_000,
    });

    expect(signed.isErr() && signed.error).toBeInstanceOf(
      MidnightWorkerStartupError,
    );
    expect(host.attach).not.toHaveBeenCalled();
  });

  it("returns MidnightWorkerStartupError, whose last cause is the worker's load error message, when the worker cannot load the engine, and the next call starts a new worker that serves it", async () => {
    const { host, asHost } = createFakeEngineHost();
    let isLoadFailing = true;
    const browser = installFakeBrowser(asHost(), {
      loadHost: async () => {
        if (isLoadFailing) throw new Error('WebAssembly failed to load');
        return asHost();
      },
    });
    const wallet = await createMidnightWallet({ worker: true });
    await addMidnightAccount(wallet);
    const signData = async () =>
      signMidnightData(wallet, {
        accountId,
        data: '00',
        options: { encoding: 'hex', keyType: 'unshielded' },
        startTimeout: 10_000,
      });

    const failed = await signData();
    const failedWorkers = [...browser.workers];
    isLoadFailing = false;
    const signed = await signData();

    expect(failed.isErr() && failed.error).toBeInstanceOf(
      MidnightWorkerStartupError,
    );
    expect(failed.isErr() && failed.error).toMatchObject({
      code: 'midnight-worker-startup-failed',
    });
    expect(lastCauseOf(failed.isErr() && failed.error)).toBe(
      'WebAssembly failed to load',
    );
    expect(failedWorkers.map(({ isClosed }) => isClosed)).not.toContain(false);
    expect(signed.unwrap()).toMatchObject({ signature: 'worker-signature' });
    expect(browser.workers).toHaveLength(failedWorkers.length + 1);
    expect(browser.workers.at(-1)?.isClosed).toBe(false);
    expect(host.attach).toHaveBeenCalledOnce();
  });
});
