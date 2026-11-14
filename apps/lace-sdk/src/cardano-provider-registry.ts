import { EMPTY } from 'rxjs';

import type { CardanoProvider } from '@lace-contract/cardano-context';
import type {
  AnyLaceSideEffect,
  createModuleLoader,
} from '@lace-contract/module';

type ModuleLoader = ReturnType<typeof createModuleLoader>;

const cardanoProviderByLoader = new WeakMap<ModuleLoader, CardanoProvider>();

/**
 * Records the Cardano provider of the wallet whose store runs it, under the
 * wallet's module loader, so SDK functions given that wallet can reach it.
 * A wallet without the Cardano modules records nothing.
 */
export const registerCardanoProvider: AnyLaceSideEffect = (
  _actions,
  _state,
  { cardanoProvider, loadModules },
) => {
  if (cardanoProvider) {
    cardanoProviderByLoader.set(loadModules, cardanoProvider);
  }
  return EMPTY;
};

/**
 * The Cardano provider of a wallet created by `createLaceWallet`, or
 * `undefined` when the wallet has no Cardano provider module loaded.
 */
export const cardanoProviderOf = (wallet: {
  _loadModules: ModuleLoader;
}): CardanoProvider | undefined =>
  cardanoProviderByLoader.get(wallet._loadModules);
