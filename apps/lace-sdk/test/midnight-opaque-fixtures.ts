// Test-only import of engine internals: the package deliberately does not export its codec.
// eslint-disable-next-line @nx/enforce-module-boundaries
import {
  encodeMidnightFinalizedTx,
  encodeMidnightRecipe,
  midnightEngineGeneration,
} from '../../../packages/module/midnight-sync/src/worker/codec';

import type { MidnightWallet } from '@lace-contract/midnight-context';
import type {
  OpaqueMidnightFinalizedTx,
  OpaqueMidnightRecipe,
} from '@lace-module/midnight-sync/sdk';
import type { FinalizedTransaction } from '@midnight-ntwrk/ledger-v8';
import type { BalancingRecipe } from '@midnightntwrk/wallet-sdk/facade';

const originOf = (
  engine: MidnightWallet,
): Parameters<typeof encodeMidnightRecipe>[1] => ({
  accountId: engine.accountId,
  engineGeneration: midnightEngineGeneration(engine),
});

/** The opaque value of a recipe the engine built, as the engine pipelines encode it. */
export const toMidnightTxRecipe = (
  engine: MidnightWallet,
  recipe: BalancingRecipe,
): OpaqueMidnightRecipe => encodeMidnightRecipe(recipe, originOf(engine));

/** The opaque value of a transaction the engine proved, as the engine pipelines encode it. */
export const toMidnightFinalizedTx = (
  engine: MidnightWallet,
  transaction: FinalizedTransaction,
): OpaqueMidnightFinalizedTx =>
  encodeMidnightFinalizedTx(transaction, originOf(engine));
