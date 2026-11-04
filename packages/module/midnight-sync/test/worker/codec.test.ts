import {
  MidnightAccountId,
  MidnightSDKNetworkIds,
} from '@lace-contract/midnight-context';
import * as stubData from '@lace-contract/midnight-context/src/stub-data';
import * as ledger from '@midnight-ntwrk/ledger-v8';
import { describe, expect, it } from 'vitest';

import {
  decodeMidnightFinalizedTx,
  decodeMidnightRecipe,
  encodeMidnightFinalizedTx,
  encodeMidnightRecipe,
  midnightEngineGeneration,
} from '../../src/worker/codec';

import type {
  OpaqueMidnightFinalizedTx,
  OpaqueMidnightRecipe,
} from '../../src/worker/codec';
import type { BalancingRecipe } from '@midnightntwrk/wallet-sdk/facade';

const networkId = MidnightSDKNetworkIds.Preview;
const origin = {
  accountId: MidnightAccountId(stubData.walletId, 0, networkId),
  engineGeneration: 'engine-generation',
};

// An unshielded NIGHT spend and output, so that the transaction has identifiers and, once bound, a hash.
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
// A transaction without contract calls proves without asking the prover for anything.
const unbound = async () =>
  unproven().prove(
    {
      check: async () => [],
      prove: async () => {
        throw new Error('nothing to prove');
      },
    },
    ledger.CostModel.initialCostModel(),
  );
const finalized = () => unproven().mockProve();

type AnyTransaction = ledger.Transaction<
  ledger.Signaturish,
  ledger.Proofish,
  ledger.Bindingish
>;
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const facts = (transaction: AnyTransaction) => ({
  bytes: hex(transaction.serialize()),
  identifiers: transaction.identifiers(),
});
// Every ledger transaction a recipe holds, by field.
const transactionsOf = (recipe: BalancingRecipe) =>
  Object.fromEntries(
    Object.entries(recipe)
      .filter(
        (entry): entry is [string, AnyTransaction] =>
          entry[1] instanceof ledger.Transaction,
      )
      .map(([field, transaction]) => [field, facts(transaction)]),
  );

const variants: [string, () => Promise<BalancingRecipe>][] = [
  [
    'UNPROVEN_TRANSACTION',
    async () => ({ type: 'UNPROVEN_TRANSACTION', transaction: unproven() }),
  ],
  [
    'UNBOUND_TRANSACTION without a balancing transaction',
    async () => ({
      type: 'UNBOUND_TRANSACTION',
      baseTransaction: await unbound(),
    }),
  ],
  [
    'UNBOUND_TRANSACTION with a balancing transaction',
    async () => ({
      type: 'UNBOUND_TRANSACTION',
      baseTransaction: await unbound(),
      balancingTransaction: unproven(),
    }),
  ],
  [
    'FINALIZED_TRANSACTION',
    async () => ({
      type: 'FINALIZED_TRANSACTION',
      originalTransaction: finalized(),
      balancingTransaction: unproven(),
    }),
  ],
];

describe('midnight-codec-round-trip', () => {
  it.each(variants)(
    '%s keeps every transaction byte for byte, with its identifiers',
    async (_variant, build) => {
      const recipe = await build();
      const value = encodeMidnightRecipe(recipe, origin);

      // A ledger object loses its methods in a structured clone; the value must not.
      const decoded = decodeMidnightRecipe(structuredClone(value));

      expect(value).toMatchObject({ ...origin, type: recipe.type });
      expect(decoded.type).toBe(recipe.type);
      expect(transactionsOf(decoded)).toEqual(transactionsOf(recipe));
      for (const { identifiers } of Object.values(transactionsOf(recipe)))
        expect(identifiers.length).toBeGreaterThan(0);
    },
  );

  it('keeps a proved transaction byte for byte, with its identifiers and activity hash', () => {
    const transaction = finalized();
    const value = encodeMidnightFinalizedTx(transaction, origin);

    const decoded = decodeMidnightFinalizedTx(structuredClone(value));

    expect(value).toMatchObject({
      ...origin,
      activityHash: transaction.transactionHash(),
    });
    expect(facts(decoded)).toEqual(facts(transaction));
    expect(decoded.transactionHash()).toBe(transaction.transactionHash());
  });

  it('holds no ledger object', async () => {
    const [, build] = variants[3];
    const values = [
      encodeMidnightRecipe(await build(), origin),
      encodeMidnightFinalizedTx(finalized(), origin),
    ];
    for (const value of values)
      for (const field of Object.values(value))
        expect(typeof field === 'string' || field instanceof Uint8Array).toBe(
          true,
        );
  });

  describe('refuses bytes of another kind than the value claims', () => {
    it.each([
      [
        'an unproven transaction holding a proved one',
        async () =>
          ({
            ...origin,
            type: 'UNPROVEN_TRANSACTION',
            transaction: finalized().serialize(),
          } as OpaqueMidnightRecipe),
        /transaction is not a \(signature, pre-proof, pre-binding\) transaction/,
      ],
      [
        'an unbound base holding an unproven transaction',
        async () =>
          ({
            ...origin,
            type: 'UNBOUND_TRANSACTION',
            baseTransaction: unproven().serialize(),
          } as OpaqueMidnightRecipe),
        /baseTransaction is not a \(signature, proof, pre-binding\) transaction/,
      ],
      [
        'a dApp transaction holding an unbound one',
        async () =>
          ({
            ...origin,
            type: 'FINALIZED_TRANSACTION',
            originalTransaction: (await unbound()).serialize(),
            balancingTransaction: unproven().serialize(),
          } as OpaqueMidnightRecipe),
        /originalTransaction is not a \(signature, proof, binding\) transaction/,
      ],
      [
        'a balancing transaction holding a proved one',
        async () =>
          ({
            ...origin,
            type: 'FINALIZED_TRANSACTION',
            originalTransaction: finalized().serialize(),
            balancingTransaction: finalized().serialize(),
          } as OpaqueMidnightRecipe),
        /balancingTransaction is not a \(signature, pre-proof, pre-binding\) transaction/,
      ],
    ])('in a recipe: %s', async (_case, value, message) => {
      const forged = await value();
      expect(() => decodeMidnightRecipe(forged)).toThrow(message);
    });

    it('in a proved transaction holding an unproven one', () => {
      const transaction = unproven();
      const forged = {
        ...origin,
        transaction: transaction.serialize(),
        activityHash: 'hash',
      } as OpaqueMidnightFinalizedTx;
      expect(() => decodeMidnightFinalizedTx(forged)).toThrow(
        /transaction is not a \(signature, proof, binding\) transaction/,
      );
    });

    it('in a proved transaction whose activity hash is another transaction’s', () => {
      const forged = {
        ...encodeMidnightFinalizedTx(finalized(), origin),
        activityHash: finalized().transactionHash(),
      } as OpaqueMidnightFinalizedTx;
      expect(() => decodeMidnightFinalizedTx(forged)).toThrow(
        /activity hash .* is not its transaction's/,
      );
    });
  });

  describe('refuses a value the SDK did not return', () => {
    it('such as the engine recipe itself', () => {
      const engineRecipe = {
        type: 'UNPROVEN_TRANSACTION',
        transaction: unproven(),
      } as unknown as OpaqueMidnightRecipe;
      expect(() => decodeMidnightRecipe(engineRecipe)).toThrow(
        'Expected a Midnight transaction value returned by the SDK',
      );
    });

    it('such as a recipe holding a ledger object instead of bytes', () => {
      const value = {
        ...origin,
        type: 'UNPROVEN_TRANSACTION',
        transaction: unproven(),
      } as unknown as OpaqueMidnightRecipe;
      expect(() => decodeMidnightRecipe(value)).toThrow(
        "Expected the Midnight transaction value's transaction as bytes",
      );
    });

    it('such as a recipe of an unknown type', () => {
      const value = {
        ...origin,
        type: 'SIGNED',
      } as unknown as OpaqueMidnightRecipe;
      expect(() => decodeMidnightRecipe(value)).toThrow(
        'got recipe type SIGNED',
      );
    });

    it.each([undefined, null, 'bytes', { transaction: new Uint8Array() }])(
      'such as %o for a proved transaction',
      value => {
        expect(() =>
          decodeMidnightFinalizedTx(value as OpaqueMidnightFinalizedTx),
        ).toThrow('Expected a Midnight transaction value returned by the SDK');
      },
    );

    it('and an engine recipe of an unknown type when encoding', () => {
      expect(() =>
        encodeMidnightRecipe({ type: 'SIGNED' } as never, origin),
      ).toThrow('Unknown Midnight recipe type SIGNED');
    });
  });
});

describe('midnightEngineGeneration', () => {
  it('keeps one generation per engine object and gives each new engine its own', () => {
    const engine = {};
    const replacement = {};

    const generation = midnightEngineGeneration(engine);

    expect(generation).toMatch(/^[\da-f]{32}$/);
    expect(midnightEngineGeneration(engine)).toBe(generation);
    expect(midnightEngineGeneration(replacement)).not.toBe(generation);
  });
});
