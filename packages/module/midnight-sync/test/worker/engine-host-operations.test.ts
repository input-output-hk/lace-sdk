import {
  NIGHT_TOKEN_ID,
  toUnshieldedTokenType,
} from '@lace-contract/midnight-context';
import * as stubData from '@lace-contract/midnight-context/src/stub-data';
import { HexBytes } from '@lace-lib/util';
import * as ledger from '@midnight-ntwrk/ledger-v8';
import {
  Observable,
  Subject,
  firstValueFrom,
  map,
  of,
  throwError,
  timer,
} from 'rxjs';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  decodeMidnightFinalizedTx,
  encodeMidnightFinalizedTx,
  encodeMidnightRecipe,
  midnightEngineGeneration,
} from '../../src/worker/codec';

import {
  assertPlainData,
  facadeState,
  fakeEngines,
  finalized,
  nightCoin,
  networkId,
  PASSWORD,
  sealedAccount,
  settings,
  unbound,
  unprovenRecipe,
  useFastKeyDerivation,
  verifyingKey,
} from './engine-host-fakes';
import { createHost } from './engine-host-setup';

import type { FakeEngine } from './engine-host-fakes';
import type {
  OpaqueMidnightFinalizedTx,
  OpaqueMidnightRecipe,
} from '../../src/worker/codec';
import type {
  MidnightEngineHost,
  MidnightWorkerCaller,
} from '../../src/worker/protocol';
import type { Activity } from '@lace-contract/activities';
import type { BalancingRecipe } from '@midnightntwrk/wallet-sdk/facade';

vi.mock('../../src/store/dependencies', async importOriginal => {
  const fakes = await import('./engine-host-fakes');
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    createStartMidnightAccountWallet: fakes.fakeEngines.createStart,
  };
});

const reasonOf = async (call: Promise<unknown>) =>
  call.then(
    () => 'resolved',
    (error: unknown) => (error as { reason?: string }).reason ?? error,
  );

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const night = toUnshieldedTokenType(NIGHT_TOKEN_ID, networkId);
const transfer = {
  kind: 'transfer' as const,
  transfer: {
    kind: 'unshielded' as const,
    outputs: [
      { to: stubData.midnightUnshieldedAddress, tokenId: night, amount: 4n },
    ],
  },
};

describe('engine-host-operations', () => {
  let host: MidnightEngineHost;
  let caller: MidnightWorkerCaller;
  let running: FakeEngine;
  let derivePendingActivity: ReturnType<
    typeof createHost
  >['derivePendingActivity'];
  const origin = () => ({
    accountId: running.engine.accountId,
    engineGeneration: midnightEngineGeneration(running.engine),
  });
  const recipeValue = (recipe: BalancingRecipe = unprovenRecipe()) =>
    encodeMidnightRecipe(recipe, origin());
  const provedValue = () => encodeMidnightFinalizedTx(finalized(), origin());

  beforeAll(useFastKeyDerivation);
  beforeEach(async () => {
    fakeEngines.reset();
    const created = createHost();
    host = created.host;
    derivePendingActivity = created.derivePendingActivity;
    const account = await sealedAccount();
    await host.attach({
      clientId: 'tab-1',
      account,
      password: PASSWORD.slice(),
      settings: settings(),
    });
    caller = { clientId: 'tab-1', accountId: account.accountId };
    running = fakeEngines.started[0];
  });

  describe('build', () => {
    it('builds a transfer without its fee, balances it with DUST and returns the opaque recipe', async () => {
      const recipe = await host.build({ ...caller, tx: transfer });

      expect(() => {
        assertPlainData(recipe);
      }).not.toThrow();
      expect(recipe).toMatchObject({
        ...origin(),
        type: 'UNPROVEN_TRANSACTION',
      });
      const [[outputs, options]] = vi.mocked(running.engine.transferTransaction)
        .mock.calls;
      expect(outputs).toEqual([
        {
          type: 'unshielded',
          outputs: [
            expect.objectContaining({ type: NIGHT_TOKEN_ID, amount: 4n }),
          ],
        },
      ]);
      expect(options).toMatchObject({ payFees: false });
      expect(running.engine.balanceUnprovenTransaction).toBeCalledWith(
        expect.anything(),
        expect.objectContaining({ tokenKindsToBalance: ['dust'] }),
      );
    });

    it('releases the inputs a transfer reserved when its fee cannot be paid', async () => {
      vi.mocked(running.engine.balanceUnprovenTransaction).mockReturnValue(
        throwError(() => new Error('Insufficient DUST')),
      );

      await expect(host.build({ ...caller, tx: transfer })).rejects.toThrow(
        'Insufficient DUST',
      );
      expect(running.engine.revert).toBeCalledTimes(1);
    });

    it('reports a release that fails beside the fee failure', async () => {
      vi.mocked(running.engine.balanceUnprovenTransaction).mockReturnValue(
        throwError(() => new Error('Insufficient DUST')),
      );
      vi.mocked(running.engine.revert).mockReturnValue(
        throwError(() => new Error('revert failed')),
      );

      await expect(host.build({ ...caller, tx: transfer })).rejects.toThrow(
        'Insufficient DUST; the coins it reserved could not be released: revert failed',
      );
    });

    it('builds a shielded transfer to shielded addresses', async () => {
      await host.build({
        ...caller,
        tx: {
          kind: 'transfer',
          transfer: {
            kind: 'shielded',
            outputs: [
              {
                to: stubData.midnightShieldedAddress,
                tokenId: NIGHT_TOKEN_ID,
                amount: 2n,
              },
            ],
          },
        },
      });

      const [[outputs]] = vi.mocked(running.engine.transferTransaction).mock
        .calls;
      expect(outputs).toEqual([
        {
          type: 'shielded',
          outputs: [
            expect.objectContaining({ type: NIGHT_TOKEN_ID, amount: 2n }),
          ],
        },
      ]);
    });

    it('registers every available NIGHT coin to the account DUST address, balancing only a repeat registration', async () => {
      const first = await host.build({
        ...caller,
        tx: { kind: 'dust-registration' },
      });
      running.state$.next(
        facadeState({ availableCoins: [nightCoin(10n, true)] }),
      );
      await host.build({ ...caller, tx: { kind: 'dust-registration' } });

      expect(first).toMatchObject(origin());
      expect(
        running.engine.registerNightUtxosForDustGeneration,
      ).toBeCalledTimes(2);
      expect(running.engine.balanceUnprovenTransaction).toBeCalledTimes(1);
    });

    it('refuses a registration without NIGHT, and a new destination while the account is designated', async () => {
      running.state$.next(facadeState({ availableCoins: [] }));
      const empty = await reasonOf(
        host.build({ ...caller, tx: { kind: 'dust-registration' } }),
      );
      running.state$.next(
        facadeState({ availableCoins: [nightCoin(10n, true)] }),
      );

      expect(empty).toBe('nothing-to-register');
      await expect(
        host.build({
          ...caller,
          tx: {
            kind: 'dust-registration',
            dustAddress: stubData.midnightDustAddress,
          },
        }),
      ).rejects.toThrow('DUST destination cannot be changed');
      expect(
        running.engine.registerNightUtxosForDustGeneration,
      ).not.toBeCalled();
    });
  });

  describe('estimate', () => {
    it('prices a transfer without reserving anything', async () => {
      const estimate = await host.estimate({ ...caller, tx: transfer });

      expect(estimate).toEqual({ dustFee: 6n, availableDust: 100n });
      expect(running.engine.transferTransaction).not.toBeCalled();
    });

    it('prices a shielded transfer', async () => {
      await expect(
        host.estimate({
          ...caller,
          tx: {
            kind: 'transfer',
            transfer: {
              kind: 'shielded',
              outputs: [
                {
                  to: stubData.midnightShieldedAddress,
                  tokenId: NIGHT_TOKEN_ID,
                  amount: 2n,
                },
              ],
            },
          },
        }),
      ).resolves.toEqual({ dustFee: 6n, availableDust: 100n });
    });

    it('prices a first registration without DUST at zero and refuses a fee above the spendable DUST', async () => {
      running.state$.next(facadeState({ spendableDust: 0n }));
      const first = await host.estimate({
        ...caller,
        tx: { kind: 'dust-registration' },
      });
      running.state$.next(facadeState({ spendableDust: 1n }));

      expect(first).toEqual({ dustFee: 0n, availableDust: 0n });
      await expect(host.estimate({ ...caller, tx: transfer })).rejects.toThrow(
        'Insufficient spendable DUST',
      );
    });
  });

  describe('sign, prove, discard and submit', () => {
    it('signs a cloned opaque recipe and returns an opaque recipe of the same engine', async () => {
      const value = recipeValue();

      const signed = await host.sign({
        ...caller,
        recipe: structuredClone(value),
      });

      expect(signed).toEqual(value);
      const [[recipe]] = vi.mocked(running.engine.signRecipe).mock.calls;
      const transactionOf = (opaque: OpaqueMidnightRecipe) =>
        hex((opaque as unknown as { transaction: Uint8Array }).transaction);
      expect(transactionOf(encodeMidnightRecipe(recipe, origin()))).toBe(
        transactionOf(value),
      );
    });

    it('proves an opaque recipe, streams its progress under the caller operation id and returns the proved value', async () => {
      const event = {
        type: 'phase',
        phase: 'prove',
        status: 'started',
      } as const;
      vi.mocked(running.engine.finalizeRecipe).mockImplementation(
        (_, onProgress) => {
          onProgress?.(event);
          return of(finalized());
        },
      );
      const progress = vi.fn();
      host.streams(caller).progress$.subscribe(progress);

      const proved = await host.prove({
        ...caller,
        recipe: recipeValue(),
        operationId: 'op-1',
      });

      expect(() => {
        assertPlainData(proved);
      }).not.toThrow();
      expect(proved.activityHash).toBe(
        decodeMidnightFinalizedTx(proved).transactionHash(),
      );
      expect(proved).toMatchObject(origin());
      expect(progress).toBeCalledWith({ operationId: 'op-1', event });
    });

    it('refuses to prove a copy of a recipe that is already being proved', async () => {
      const proof = new Subject<ReturnType<typeof finalized>>();
      vi.mocked(running.engine.finalizeRecipe).mockReturnValue(proof);
      const value = recipeValue();

      const first = host.prove({ ...caller, recipe: value });
      const second = host.prove({ ...caller, recipe: structuredClone(value) });
      await expect(second).rejects.toThrow(
        'This transaction is already being finalized',
      );
      proof.next(finalized());

      await expect(first).resolves.toMatchObject(origin());
      expect(running.engine.finalizeRecipe).toBeCalledTimes(1);
    });

    it('discards an opaque recipe by releasing its coins', async () => {
      await expect(
        host.discard({ ...caller, recipe: recipeValue() }),
      ).resolves.toBeUndefined();
      expect(running.engine.revert).toBeCalledTimes(1);
    });

    it('derives the Pending activity from the proved transaction and the account coins, best effort', async () => {
      const activity = { activityId: 'hash' } as unknown as Activity;
      derivePendingActivity.mockReturnValueOnce(activity);
      running.state$.next(
        facadeState({
          availableCoins: [nightCoin(1n)],
          pendingCoins: [nightCoin(2n)],
        }),
      );
      const value = provedValue();

      const prepared = await host.preparePendingActivity({
        ...caller,
        transaction: value,
      });
      derivePendingActivity.mockImplementationOnce(() => {
        throw new Error('cannot derive');
      });

      expect(prepared).toBe(activity);
      const [[params]] = derivePendingActivity.mock.calls;
      expect(params).toMatchObject({
        accountId: caller.accountId,
        ownUserAddressHex: ledger.addressFromKey(verifyingKey),
        networkId,
      });
      expect(params.nightUtxos.map(({ utxo }) => utxo.value)).toEqual([1n, 2n]);
      expect(params.deserializedTx.transactionHash()).toBe(value.activityHash);
      await expect(
        host.preparePendingActivity({ ...caller, transaction: value }),
      ).resolves.toBeUndefined();
    });

    it('derives no Pending activity, instead of failing the submission, when the engine state cannot be read', async () => {
      vi.spyOn(running.engine, 'state').mockImplementation(() => {
        throw new Error('state unavailable');
      });

      await expect(
        host.preparePendingActivity({ ...caller, transaction: provedValue() }),
      ).resolves.toBeUndefined();
      expect(derivePendingActivity).not.toHaveBeenCalled();
    });

    it('submits a proved value and settles with its transaction id at finality', async () => {
      const value = provedValue();

      await expect(
        host.submit({ ...caller, transaction: structuredClone(value) }),
      ).resolves.toEqual({ txId: value.activityHash });
    });

    it.each([
      [
        'sign',
        async (recipe: OpaqueMidnightRecipe) =>
          host.sign({ ...caller, recipe }),
      ],
      [
        'prove',
        async (recipe: OpaqueMidnightRecipe) =>
          host.prove({ ...caller, recipe }),
      ],
      [
        'discard',
        async (recipe: OpaqueMidnightRecipe) =>
          host.discard({ ...caller, recipe }),
      ],
    ])(
      'refuses at %s a recipe of an earlier engine and one of another account',
      async (_, call) => {
        const stale = encodeMidnightRecipe(unprovenRecipe(), {
          ...origin(),
          engineGeneration: 'earlier',
        });
        const foreign = encodeMidnightRecipe(unprovenRecipe(), {
          accountId: stubData.accountId,
          engineGeneration: origin().engineGeneration,
        });

        await expect(reasonOf(call(stale))).resolves.toBe('stale-value');
        await expect(call(foreign)).rejects.toThrow(
          `belongs to account "${stubData.accountId}"`,
        );
      },
    );

    it.each([
      [
        'preparePendingActivity',
        async (transaction: OpaqueMidnightFinalizedTx) =>
          host.preparePendingActivity({ ...caller, transaction }),
      ],
      [
        'submit',
        async (transaction: OpaqueMidnightFinalizedTx) =>
          host.submit({ ...caller, transaction }),
      ],
    ])('refuses at %s a proved value of an earlier engine', async (_, call) => {
      const stale = encodeMidnightFinalizedTx(finalized(), {
        ...origin(),
        engineGeneration: 'earlier',
      });

      await expect(reasonOf(call(stale))).resolves.toBe('stale-value');
      expect(running.engine.submitTransaction).not.toBeCalled();
      expect(derivePendingActivity).not.toBeCalled();
    });
  });

  describe('data signing and history', () => {
    it('signs data bytes with the account key', async () => {
      await expect(
        host.signData({ ...caller, data: new Uint8Array([7]) }),
      ).resolves.toEqual({ signature: 'signature', verifyingKey });
      expect(running.engine.signData).toBeCalledWith(new Uint8Array([7]));
    });

    it('returns the history entry of a transaction hash as plain data', async () => {
      const entry = await host.transactionHistoryEntry({
        ...caller,
        hash: 'h1',
      });

      expect(entry).toEqual({ hash: 'h1', status: 'SUCCESS' });
      expect(() => {
        assertPlainData(entry);
      }).not.toThrow();
    });
  });

  describe('dApp connector builds', () => {
    it('balances, signs and proves a sealed transaction given as hex', async () => {
      const proved = await host.buildConnectorTransaction({
        ...caller,
        transaction: {
          kind: 'balance-sealed',
          tx: hex(finalized().serialize()),
          payFees: false,
        },
      });

      expect(proved).toMatchObject(origin());
      expect(running.engine.balanceFinalizedTransaction).toBeCalledWith(
        expect.anything(),
        expect.objectContaining({
          tokenKindsToBalance: ['shielded', 'unshielded'],
        }),
      );
      expect(running.engine.signRecipe).toBeCalledTimes(1);
      expect(running.engine.finalizeRecipe).toBeCalledTimes(1);
    });

    it('balances, signs and proves an unsealed transaction given as hex', async () => {
      const proved = await host.buildConnectorTransaction({
        ...caller,
        transaction: {
          kind: 'balance-unsealed',
          tx: hex((await unbound()).serialize()),
        },
      });

      expect(proved).toMatchObject(origin());
      expect(running.engine.balanceUnboundTransaction).toBeCalledWith(
        expect.anything(),
        expect.objectContaining({ tokenKindsToBalance: undefined }),
      );
    });

    it('builds, balances, signs and proves a connector transfer with unshielded outputs', async () => {
      await host.buildConnectorTransaction({
        ...caller,
        transaction: {
          kind: 'transfer',
          desiredOutputs: [
            {
              kind: 'unshielded',
              type: NIGHT_TOKEN_ID,
              value: 3n,
              recipient: stubData.midnightUnshieldedAddress,
            },
          ],
        },
      });

      expect(running.engine.transferTransaction).toBeCalledWith(
        [expect.objectContaining({ type: 'unshielded' })],
        expect.objectContaining({ payFees: false }),
      );
      expect(running.engine.balanceUnprovenTransaction).toBeCalledTimes(1);
      expect(running.engine.signRecipe).toBeCalledTimes(1);
    });

    it('proves a shielded connector transfer without fees unsigned and unbalanced', async () => {
      await host.buildConnectorTransaction({
        ...caller,
        transaction: {
          kind: 'transfer',
          desiredOutputs: [
            {
              kind: 'shielded',
              type: NIGHT_TOKEN_ID,
              value: 2n,
              recipient: stubData.midnightShieldedAddress,
            },
          ],
          payFees: false,
        },
      });

      expect(running.engine.balanceUnprovenTransaction).not.toBeCalled();
      expect(running.engine.signRecipe).not.toBeCalled();
      expect(running.engine.finalizeRecipe).toBeCalledTimes(1);
    });

    it('releases a connector recipe whose signing fails', async () => {
      vi.mocked(running.engine.signRecipe).mockReturnValue(
        throwError(() => new Error('signing failed')),
      );

      await expect(
        host.buildConnectorTransaction({
          ...caller,
          transaction: {
            kind: 'balance-sealed',
            tx: hex(finalized().serialize()),
          },
        }),
      ).rejects.toThrow('signing failed');
      expect(running.engine.revert).toBeCalledTimes(1);
      expect(running.engine.finalizeRecipe).not.toBeCalled();
    });

    it('gives proveTimeout to proving only: signing that outlasts it still ends in a proved transaction', async () => {
      vi.mocked(running.engine.signRecipe).mockImplementation(recipe =>
        timer(40).pipe(map(() => recipe)),
      );

      const proved = await host.buildConnectorTransaction({
        ...caller,
        transaction: {
          kind: 'balance-sealed',
          tx: hex(finalized().serialize()),
          proveTimeout: 20,
        },
      });

      expect(proved).toMatchObject(origin());
    });

    it('stops waiting for proving after proveTimeout with a prove-timeout refusal, and leaves the proving running', async () => {
      let isProvingCancelled = false;
      vi.mocked(running.engine.finalizeRecipe).mockReturnValue(
        new Observable<never>(() => () => {
          isProvingCancelled = true;
        }),
      );

      const reason = await reasonOf(
        host.buildConnectorTransaction({
          ...caller,
          transaction: {
            kind: 'balance-sealed',
            tx: hex(finalized().serialize()),
            proveTimeout: 20,
          },
        }),
      );

      expect(reason).toBe('prove-timeout');
      expect(isProvingCancelled).toBe(false);
    });

    it.each(['20', 0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31])(
      'refuses proveTimeout %s with a RangeError before reserving anything',
      async proveTimeout => {
        const refused = host.buildConnectorTransaction({
          ...caller,
          transaction: {
            kind: 'balance-sealed',
            tx: hex(finalized().serialize()),
            proveTimeout: proveTimeout as number,
          },
        });

        await expect(refused).rejects.toThrow(RangeError);
        await expect(refused).rejects.toThrow('proveTimeout');
        expect(running.engine.balanceFinalizedTransaction).not.toBeCalled();
      },
    );

    it('builds an intent, and refuses one whose outputs lack inputs of their kind before reserving anything', async () => {
      const output = {
        kind: 'unshielded' as const,
        type: NIGHT_TOKEN_ID,
        value: 3n,
        recipient: stubData.midnightUnshieldedAddress,
      };
      const refused = host.buildConnectorTransaction({
        ...caller,
        transaction: {
          kind: 'intent',
          desiredInputs: [],
          desiredOutputs: [output],
          payFees: true,
        },
      });
      await expect(refused).rejects.toThrow('without inputs of that kind');
      expect(running.engine.initSwap).not.toBeCalled();

      await host.buildConnectorTransaction({
        ...caller,
        transaction: {
          kind: 'intent',
          desiredInputs: [
            { kind: 'unshielded', type: NIGHT_TOKEN_ID, value: 3n },
          ],
          desiredOutputs: [output],
          payFees: false,
        },
      });
      expect(running.engine.initSwap).toBeCalledWith(
        { unshielded: { [NIGHT_TOKEN_ID]: 3n } },
        [expect.objectContaining({ type: 'unshielded' })],
        expect.objectContaining({ payFees: false }),
      );
      expect(running.engine.balanceUnprovenTransaction).not.toBeCalled();
    });
  });

  describe('signer pipeline', () => {
    const request = (tokenKind: 'shielded' | 'unshielded', type: string) => ({
      serializedTx: HexBytes.fromUTF8(
        JSON.stringify({
          transfers: [
            {
              amount: '5',
              receiverAddress:
                tokenKind === 'unshielded'
                  ? stubData.midnightUnshieldedAddress
                  : stubData.midnightShieldedAddress,
              tokenKind,
              type,
            },
          ],
        }),
      ),
    });

    it('builds, signs and proves an unshielded transfer, streaming progress, and returns the finalized hex', async () => {
      const event = {
        type: 'phase',
        phase: 'prove',
        status: 'completed',
      } as const;
      vi.mocked(running.engine.finalizeRecipe).mockImplementation(
        (_, onProgress) => {
          onProgress?.(event);
          return of(finalized());
        },
      );
      const progress = vi.fn();
      host.streams(caller).progress$.subscribe(progress);

      const result = await host.signTransaction({
        ...caller,
        request: { ...request('unshielded', night), flowType: 'send' },
        operationId: 'sign-1',
      });

      expect(typeof result.serializedTx).toBe('string');
      expect(
        ledger.Transaction.deserialize(
          'signature',
          'proof',
          'binding',
          Buffer.from(result.serializedTx, 'hex'),
        ).transactionHash(),
      ).toBeDefined();
      expect(running.engine.signRecipe).toBeCalledTimes(1);
      expect(progress).toBeCalledWith({ operationId: 'sign-1', event });
    });

    it("streams a call's proving progress to its own client alone, naming no client, while another client shares the account", async () => {
      const event = {
        type: 'phase',
        phase: 'prove',
        status: 'started',
      } as const;
      vi.mocked(running.engine.finalizeRecipe).mockImplementation(
        (_, onProgress) => {
          onProgress?.(event);
          return of(finalized());
        },
      );
      await host.attach({
        clientId: 'tab-2',
        account: await sealedAccount(),
        password: PASSWORD.slice(),
        settings: settings(),
      });
      const own = vi.fn();
      const other = vi.fn();
      host.streams(caller).progress$.subscribe(own);
      host.streams({ ...caller, clientId: 'tab-2' }).progress$.subscribe(other);

      await host.prove({
        ...caller,
        recipe: recipeValue(),
        operationId: 'op-1',
      });
      await host.signTransaction({
        ...caller,
        request: { ...request('unshielded', night), flowType: 'send' },
        operationId: 'sign-1',
      });

      expect(own).toBeCalledWith({ operationId: 'op-1', event });
      expect(own).toBeCalledWith({ operationId: 'sign-1', event });
      for (const [progress] of own.mock.calls)
        expect(Object.keys(progress as object).sort()).toEqual([
          'event',
          'operationId',
        ]);
      expect(other).not.toHaveBeenCalled();
    });

    it('registers NIGHT for a DUST designation', async () => {
      await host.signTransaction({
        ...caller,
        request: {
          serializedTx: HexBytes.fromUTF8(
            JSON.stringify({
              transfers: [
                {
                  amount: '0',
                  receiverAddress: stubData.midnightDustAddress,
                  tokenKind: 'unshielded',
                  type: night,
                },
              ],
            }),
          ),
          flowType: 'dust-designation',
        },
      });

      expect(
        running.engine.registerNightUtxosForDustGeneration,
      ).toBeCalledTimes(1);
      expect(running.engine.finalizeRecipe).toBeCalledTimes(1);
    });
  });

  describe('streams', () => {
    it('carries the engine streams and the state view the page readers use, as plain data tagged with the engine generation', async () => {
      const available = nightCoin(10n, true);
      const pending = nightCoin(3n);
      running.state$.next(
        facadeState({
          availableCoins: [available],
          pendingCoins: [pending],
          dustCoins: [
            {
              generatedNow: 4n,
              maxCap: 9n,
              rate: 2n,
              dtime: new Date(5000),
              maxCapReachedAt: new Date(8000),
            },
          ],
        }),
      );
      const streams = host.streams(caller);

      const [view, address, coins, history, keys] = await Promise.all([
        firstValueFrom(streams.stateView$),
        firstValueFrom(streams.address$),
        firstValueFrom(streams.coinsByTokenType$),
        firstValueFrom(streams.transactionHistory$),
        firstValueFrom(streams.areKeysAvailable$),
      ]);

      for (const { engineGeneration } of [view, address, coins, history, keys])
        expect(engineGeneration).toBe(origin().engineGeneration);
      expect(view.value).toEqual({
        unshielded: { availableCoins: [available], pendingCoins: [pending] },
        dust: {
          balance: 4n,
          available: 4n,
          generation: {
            currentValue: 4n,
            maxCap: 9n,
            rate: 2n,
            decayTime: 5000,
            maxCapReachedAt: 8000,
          },
        },
        shieldedPublicKeys: { coin: 'c0', encryption: 'e0' },
        isStrictlyComplete: { unshielded: false, shielded: false, dust: false },
      });
      for (const value of [view, address, coins, history])
        expect(() => {
          assertPlainData(value);
        }).not.toThrow();
      expect(keys.value).toBe(false);
      await expect(firstValueFrom(streams.status$)).resolves.toEqual({
        engineGeneration: origin().engineGeneration,
        resets: 0,
      });
    });

    it.each(['unshielded', 'shielded', 'dust'] as const)(
      "carries in the state view whether each sub-wallet has strictly caught up, read from that sub-wallet's own progress (%s)",
      async subWallet => {
        const synced = {
          unshielded: false,
          shielded: false,
          dust: false,
          [subWallet]: true,
        };
        running.state$.next(facadeState({ synced }));

        const view = await firstValueFrom(host.streams(caller).stateView$);

        expect(view.value.isStrictlyComplete).toEqual(synced);
      },
    );

    it('reports an engine whose stream fails, and replaces it on the next attach', async () => {
      const account = fakeEngines.started[0].params.account;
      const status = vi.fn();
      host.streams(caller).status$.subscribe(status);
      host.streams(caller).syncProgress$.subscribe({ error: status });

      running.syncProgress$.error(new Error('Account watch failure'));
      const reattached = await host.attach({
        clientId: 'tab-1',
        account,
        password: PASSWORD.slice(),
        settings: settings(),
      });

      expect(status).toBeCalledWith({
        engineGeneration: origin().engineGeneration,
        resets: 0,
        failure: 'Account watch failure',
      });
      expect(running.tornDown).toBe(true);
      expect(reattached.engineGeneration).toBe(
        midnightEngineGeneration(fakeEngines.started[1].engine),
      );
      expect(reattached.engineGeneration).not.toBe(origin().engineGeneration);
    });
  });

  it('refuses every operation to a client that is not attached', async () => {
    const outsider = { ...caller, clientId: 'tab-2' };
    const recipe = recipeValue();
    const transaction = provedValue();
    const calls = [
      host.build({ ...outsider, tx: transfer }),
      host.estimate({ ...outsider, tx: transfer }),
      host.sign({ ...outsider, recipe }),
      host.prove({ ...outsider, recipe }),
      host.discard({ ...outsider, recipe }),
      host.preparePendingActivity({ ...outsider, transaction }),
      host.submit({ ...outsider, transaction }),
      host.signData({ ...outsider, data: new Uint8Array([1]) }),
      host.buildConnectorTransaction({
        ...outsider,
        transaction: { kind: 'balance-sealed', tx: '00' },
      }),
      host.checkCircuit({
        ...outsider,
        serializedPreimage: new Uint8Array([1]),
        keyLocation: 'k',
      }),
      host.proveCircuit({
        ...outsider,
        serializedPreimage: new Uint8Array([1]),
        keyLocation: 'k',
      }),
      host.transactionHistoryEntry({ ...outsider, hash: 'h' }),
      host.signTransaction({
        ...outsider,
        request: { serializedTx: HexBytes('00') },
      }),
      host.resetAccount({ ...outsider, storage: 'memory' }),
      host.resyncAll({ clientId: outsider.clientId, storage: 'memory' }),
      host.deleteWallet({
        clientId: outsider.clientId,
        walletId: running.engine.walletId,
        storage: 'memory',
      }),
    ];

    const reasons = await Promise.all(calls.map(reasonOf));

    expect(new Set(reasons)).toEqual(new Set(['not-attached']));
    expect(reasons).toHaveLength(16);
    expect(running.stopped).toBe(false);
    expect(running.tornDown).toBe(false);
  });
});
