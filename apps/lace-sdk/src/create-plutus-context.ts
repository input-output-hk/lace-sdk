import { cardanoContextSelectors } from '@lace-contract/cardano-context';
import { serializeTransaction } from '@lace-lib/cardano-tx-builder';
import { Err, Ok } from '@lace-lib/util';
import { firstValueFrom } from 'rxjs';

import { cardanoProviderOf } from './cardano-provider-registry';

import type { WalletWithCardanoContext } from './create-tx-builder';
import type { CardanoProvider } from '@lace-contract/cardano-context';
import type { createModuleLoader, State } from '@lace-contract/module';
import type { Cardano } from '@lace-lib/cardano-core';
import type { PlutusContext, TxEvaluator } from '@lace-lib/cardano-tx-builder';
import type { Result } from '@lace-lib/util';

/**
 * Padding on every evaluated budget. The builder writes the final fee and
 * change after evaluation, so the transaction the node runs differs slightly
 * from the one it measured, and an under-declared budget fails phase 2 and
 * forfeits the collateral.
 */
const EVALUATION_MARGIN_PERCENT = 10n;

/**
 * Structural requirement: the wallet must have been created by
 * `createLaceWallet` with the Cardano modules loaded (blockchainCardano +
 * cardanoProviderBlockfrost).
 */
export type WalletWithCardanoProvider = Pick<
  WalletWithCardanoContext,
  'getState'
> & {
  /** @internal Not for direct SDK consumer use. */
  _loadModules: ReturnType<typeof createModuleLoader>;
};

const withEvaluationMargin = ({
  memory,
  steps,
}: Cardano.ExUnits): Cardano.ExUnits => ({
  memory: Number(
    (BigInt(memory) * (100n + EVALUATION_MARGIN_PERCENT) + 99n) / 100n,
  ),
  steps: Number(
    (BigInt(steps) * (100n + EVALUATION_MARGIN_PERCENT) + 99n) / 100n,
  ),
});

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const createProviderTxEvaluator = (
  cardanoProvider: Pick<CardanoProvider, 'evaluateTx'>,
  chainId: Cardano.ChainId,
): TxEvaluator => ({
  evaluate: async (tx, _resolvedInputs, serializedTx) => {
    const result = await firstValueFrom(
      cardanoProvider.evaluateTx(
        { tx: (serializedTx ?? serializeTransaction(tx)).toCbor() },
        { chainId },
      ),
    ).catch((error: unknown) => {
      throw new Error(`Transaction evaluation failed: ${messageOf(error)}`, {
        cause: error,
      });
    });
    if (result.isErr()) {
      const { message } = result.error;
      throw new Error(`Transaction evaluation failed: ${message}`, {
        cause: result.error,
      });
    }
    return (tx.witness.redeemers ?? []).map(({ purpose, index }) => {
      const measured = result.value.find(
        entry => entry.purpose === purpose && entry.index === index,
      );
      if (!measured) {
        throw new Error(
          `Transaction evaluation failed: the provider did not evaluate redeemer ${purpose}#${index}`,
        );
      }
      return { purpose, index, budget: withEvaluationMargin(measured.budget) };
    });
  },
});

/**
 * Creates the {@link PlutusContext} a `TransactionBuilder` needs to
 * build a transaction that runs Plutus scripts, from the wallet's Cardano
 * provider: the network's current cost models, and an evaluator that has the
 * provider measure each redeemer's execution units and declares them with a
 * 10 percent margin.
 *
 * The evaluator rejects when the provider fails or refuses to evaluate the
 * transaction, as it does when a script fails, with the provider's message,
 * and when the provider leaves a redeemer unmeasured. `build()` then rejects
 * with that error.
 *
 * The provider evaluates against the chain's UTxO set, so the spent,
 * reference and collateral inputs must be on chain: a chained transaction
 * that spends unconfirmed outputs cannot be evaluated. The cost models are
 * read once, when the context is created, so create a context for each build.
 *
 * Await `waitForNetworkInfo` first so the wallet knows its network.
 *
 * @param wallet - A wallet created by `createLaceWallet` with the Cardano
 *   modules loaded (see {@link WalletWithCardanoProvider}).
 * @returns `Ok` with the context to pass to `setPlutusContext`, or `Err` when
 *   the wallet has no Cardano provider or network yet, or the provider cannot
 *   read the protocol parameters. It never rejects.
 */
export const createPlutusContext = async (
  wallet: WalletWithCardanoProvider,
): Promise<Result<PlutusContext, Error>> => {
  const cardanoProvider = cardanoProviderOf(wallet);
  if (!cardanoProvider) {
    return Err(
      new Error(
        'Cardano provider not available: create the wallet with createLaceWallet and the Cardano modules loaded',
      ),
    );
  }

  const chainId = cardanoContextSelectors.cardanoContext.selectChainId(
    wallet.getState() as State,
  );
  if (!chainId) {
    return Err(
      new Error(
        'Cardano network not initialized: await waitForNetworkInfo before creating the Plutus context',
      ),
    );
  }

  try {
    const protocolParameters = await firstValueFrom(
      cardanoProvider.getProtocolParameters({ chainId }),
    );
    if (protocolParameters.isErr()) {
      return Err(
        new Error(
          `Protocol parameters not available: ${protocolParameters.error.message}`,
          { cause: protocolParameters.error },
        ),
      );
    }
    return Ok({
      costModels: protocolParameters.value.costModels,
      txEvaluator: createProviderTxEvaluator(cardanoProvider, chainId),
    });
  } catch (error) {
    return Err(
      new Error(`Protocol parameters not available: ${messageOf(error)}`, {
        cause: error,
      }),
    );
  }
};
