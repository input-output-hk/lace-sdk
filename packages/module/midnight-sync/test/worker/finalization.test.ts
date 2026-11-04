import { firstValueFrom, NEVER, of, Subject } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';

import {
  finalizeEngineRecipeExclusively,
  finalizeMidnightRecipeExclusively,
} from '../../src/worker/finalization';

import type { OpaqueMidnightRecipe } from '../../src/sdk';
import type { BalancingRecipe } from '@midnightntwrk/wallet-sdk/facade';
import type { Observable } from 'rxjs';

const bytes = (byte: number) => new Uint8Array([byte]);
// Each call makes a new value object, so equal fields stand for a copy of one value.
const value = (fields: object) =>
  ({
    accountId: 'account',
    engineGeneration: 'generation',
    ...fields,
  } as unknown as OpaqueMidnightRecipe);
const unproven = (byte = 1) =>
  value({ type: 'UNPROVEN_TRANSACTION', transaction: bytes(byte) });
const run = async <T>(
  engine: object,
  recipe: OpaqueMidnightRecipe,
  finalization: Observable<T>,
) =>
  firstValueFrom(
    finalizeMidnightRecipeExclusively(engine, recipe, () => finalization),
  );
const refusal = 'This transaction is already being finalized';

describe('finalizeMidnightRecipeExclusively', () => {
  it('refuses a copy of a recipe on the engine finalizing it, without starting another finalization', async () => {
    const engine = {};
    const running = new Subject<string>();
    const first = run(engine, unproven(), running);
    const again = vi.fn(() => of('again'));

    await expect(
      firstValueFrom(
        finalizeMidnightRecipeExclusively(
          engine,
          structuredClone(unproven()),
          again,
        ),
      ),
    ).rejects.toThrow(refusal);

    expect(again).not.toHaveBeenCalled();
    running.next('proved');
    await expect(first).resolves.toBe('proved');
  });

  it('finalizes the same recipe on another engine, and another recipe on the same engine', async () => {
    const engine = {};
    void run(engine, unproven(1), NEVER);

    await expect(run({}, unproven(1), of('other engine'))).resolves.toBe(
      'other engine',
    );
    await expect(run(engine, unproven(2), of('other recipe'))).resolves.toBe(
      'other recipe',
    );
  });

  it.each([
    [
      'proved',
      (running: Subject<string>) => {
        running.next('proved');
      },
    ],
    [
      'failed',
      (running: Subject<string>) => {
        running.error(new Error('proof failed'));
      },
    ],
  ])(
    'holds a recipe its caller stopped waiting for until the finalization has %s',
    async (_outcome, settle) => {
      const engine = {};
      const running = new Subject<string>();
      finalizeMidnightRecipeExclusively(engine, unproven(), () => running)
        .subscribe()
        .unsubscribe();

      await expect(run(engine, unproven(), of('retry'))).rejects.toThrow(
        refusal,
      );
      expect(running.observed).toBe(true);
      settle(running);

      expect(running.observed).toBe(false);
      await expect(run(engine, unproven(), of('retry'))).resolves.toBe('retry');
    },
  );

  it.each([
    ['UNBOUND_TRANSACTION', 'baseTransaction'],
    ['FINALIZED_TRANSACTION', 'originalTransaction'],
  ])(
    'identifies a %s recipe by its balancing transaction',
    async (type, other) => {
      const engine = {};
      const recipe = (otherByte: number, balancingByte: number) =>
        value({
          type,
          [other]: bytes(otherByte),
          balancingTransaction: bytes(balancingByte),
        });
      void run(engine, recipe(9, 1), NEVER);

      await expect(run(engine, recipe(8, 1), of('x'))).rejects.toThrow(refusal);
      await expect(run(engine, recipe(9, 2), of('x'))).resolves.toBe('x');
    },
  );

  it('does not hold an unbound recipe without a balancing transaction, which proves nothing', async () => {
    const engine = {};
    const recipe = value({
      type: 'UNBOUND_TRANSACTION',
      baseTransaction: bytes(9),
    });
    void run(engine, recipe, NEVER);

    await expect(run(engine, recipe, of('bound'))).resolves.toBe('bound');
  });

  it('releases a recipe whose finalization fails to start', async () => {
    const engine = {};

    await expect(
      firstValueFrom(
        finalizeMidnightRecipeExclusively(engine, unproven(), () => {
          throw new Error('engine stopped');
        }),
      ),
    ).rejects.toThrow('engine stopped');

    await expect(run(engine, unproven(), of('retry'))).resolves.toBe('retry');
  });
});

describe('finalizeEngineRecipeExclusively', () => {
  const decoded = (fields: object) => fields as unknown as BalancingRecipe;
  const transactionOf = (byte: number) => ({ serialize: () => bytes(byte) });

  it("refuses a recipe's opaque value while the engine finalizes the decoded recipe, keyed on the bytes of the transaction it proves", async () => {
    const engine = {};
    const running = new Subject<string>();
    const first = firstValueFrom(
      finalizeEngineRecipeExclusively(
        engine,
        decoded({
          type: 'UNPROVEN_TRANSACTION',
          transaction: transactionOf(1),
        }),
        () => running,
      ),
    );

    await expect(run(engine, unproven(1), of('again'))).rejects.toThrow(
      refusal,
    );
    await expect(run(engine, unproven(2), of('other'))).resolves.toBe('other');
    running.next('proved');
    await expect(first).resolves.toBe('proved');
    await expect(run(engine, unproven(1), of('after'))).resolves.toBe('after');
  });

  it('holds nothing for a decoded recipe whose finalization proves no transaction', async () => {
    const engine = {};
    const recipe = decoded({
      type: 'UNBOUND_TRANSACTION',
      baseTransaction: transactionOf(3),
    });
    void firstValueFrom(
      finalizeEngineRecipeExclusively(engine, recipe, () => NEVER),
    );

    await expect(
      firstValueFrom(
        finalizeEngineRecipeExclusively(engine, recipe, () => of('bound')),
      ),
    ).resolves.toBe('bound');
  });
});
