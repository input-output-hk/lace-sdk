// The contracts the Bitcoin module implements and depends on in the apps, and
// the types its hooks are written against. Anything the SDK's module reaches
// takes its types from sdk-contracts.ts instead, so the SDK's builds never
// reach the apps' contracts.
import {
  activitiesStoreContract,
  activitiesItemCustomizationsAddonContract,
} from '@lace-contract/activities';
import { addressBookAddressValidatorAddonContract } from '@lace-contract/address-book';
import { addressesStoreContract } from '@lace-contract/addresses';
import {
  accountUICustomisationAddonContract,
  sendFlowSheetUICustomisationAddonContract,
} from '@lace-contract/app';
import {
  bitcoinFeeMarketProvider,
  bitcoinProviderContract,
} from '@lace-contract/bitcoin-context';
import { inMemoryIntegrationAddonContract } from '@lace-contract/in-memory';
import { combineContracts } from '@lace-contract/module';
import { networkStoreContract } from '@lace-contract/network';
import {
  addressValidatorAddonContract,
  baseTokenAddonContract,
  chainMinimumAmountTokenValidatorAddonContract,
  sendFlowStoreContract,
} from '@lace-contract/send-flow';
import { signerFactoryAddonContract } from '@lace-contract/signer';
import { syncStoreContract } from '@lace-contract/sync';
import { tokenIdMapperAddonContract } from '@lace-contract/token-pricing';
import { tokensStoreContract } from '@lace-contract/tokens';
import { txExecutorImplementationAddonContract } from '@lace-contract/tx-executor';
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
  accountUICustomisationAddonContract,
  sendFlowSheetUICustomisationAddonContract,
  tokensStoreContract,
  addressesStoreContract,
  syncStoreContract,
  activitiesItemCustomizationsAddonContract,
  txExecutorImplementationAddonContract,
  addressValidatorAddonContract,
  baseTokenAddonContract,
  chainMinimumAmountTokenValidatorAddonContract,
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
  sendFlowStoreContract,
] as const);

// Built part-wise, as blockchain-cardano's are: a `typeof bitcoinModule`
// reference would bring the module, and every addon it loads, back in.
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
