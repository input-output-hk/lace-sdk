// The contracts the SDK's Bitcoin module implements and depends on, and the
// types its store and in-memory wallet integration are written against.
import { activitiesStoreContract } from '@lace-contract/activities';
import { addressBookAddressValidatorAddonContract } from '@lace-contract/address-book';
import { addressesStoreContract } from '@lace-contract/addresses';
import {
  bitcoinFeeMarketProvider,
  bitcoinProviderContract,
} from '@lace-contract/bitcoin-context';
import { inMemoryIntegrationAddonContract } from '@lace-contract/in-memory';
import { combineContracts } from '@lace-contract/module';
import { networkStoreContract } from '@lace-contract/network';
import { signerFactoryAddonContract } from '@lace-contract/signer';
import { syncStoreContract } from '@lace-contract/sync';
import { tokenIdMapperAddonContract } from '@lace-contract/token-pricing';
import { tokensStoreContract } from '@lace-contract/tokens';
import { walletActiveStateDependencyContract } from '@lace-contract/wallet-active-state';
import { walletRepoStoreContract } from '@lace-contract/wallet-repo';

import type store from './store';
import type {
  ContractsActionCreators,
  ContractsSelectors,
  LaceSideEffect,
  ModuleAddons,
  ModuleStoreActionCreators,
  ModuleStoreSelectors,
} from '@lace-contract/module';

export const implementsContracts = combineContracts([
  inMemoryIntegrationAddonContract,
  tokensStoreContract,
  addressesStoreContract,
  syncStoreContract,
  addressBookAddressValidatorAddonContract,
  tokenIdMapperAddonContract,
  signerFactoryAddonContract,
] as const);

export const dependsOnContracts = combineContracts([
  bitcoinProviderContract,
  bitcoinFeeMarketProvider,
  networkStoreContract,
  walletRepoStoreContract,
  walletActiveStateDependencyContract,
  activitiesStoreContract,
  tokensStoreContract,
] as const);

export type Selectors = ContractsSelectors<typeof dependsOnContracts> &
  ContractsSelectors<typeof implementsContracts> &
  ModuleStoreSelectors<typeof store>;
export type ActionCreators = ContractsActionCreators<
  typeof dependsOnContracts
> &
  ContractsActionCreators<typeof implementsContracts> &
  ModuleStoreActionCreators<typeof store>;
export type SideEffect = LaceSideEffect<Selectors, ActionCreators>;
export type AvailableAddons = ModuleAddons<
  typeof implementsContracts,
  typeof dependsOnContracts
>;
