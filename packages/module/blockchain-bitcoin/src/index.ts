import './augmentations';

import { activitiesItemCustomizationsAddonContract } from '@lace-contract/activities';
import { addressBookAddressValidatorAddonContract } from '@lace-contract/address-book';
import { addressesStoreContract } from '@lace-contract/addresses';
import {
  accountUICustomisationAddonContract,
  sendFlowSheetUICustomisationAddonContract,
} from '@lace-contract/app';
import { BITCOIN_FEATURE_FLAG } from '@lace-contract/bitcoin-context';
import { inMemoryIntegrationAddonContract } from '@lace-contract/in-memory';
import {
  combineContracts,
  inferModuleContext,
  ModuleName,
} from '@lace-contract/module';
import {
  addressValidatorAddonContract,
  baseTokenAddonContract,
  chainMinimumAmountTokenValidatorAddonContract,
} from '@lace-contract/send-flow';
import { syncStoreContract } from '@lace-contract/sync';
import { tokenIdMapperAddonContract } from '@lace-contract/token-pricing';
import { tokensStoreContract } from '@lace-contract/tokens';
import { txExecutorImplementationAddonContract } from '@lace-contract/tx-executor';

import { dependsOnContracts, implementsContracts } from './contracts';
import store from './store';

import type { LaceModuleMap } from '@lace-contract/module';

const feature = {
  metadata: { name: 'Bitcoin', description: '' },
  willLoad: (featureFlags: readonly { key: string }[]) =>
    featureFlags.map(({ key }) => key).includes(BITCOIN_FEATURE_FLAG),
};

const addons = {
  loadInMemoryWalletIntegration: async () =>
    import('./in-memory-wallet-integration'),
  loadAddressValidator: async () => import('./address-validator'),
  loadBaseToken: async () => import('./exposed-modules/base-token-selector'),
  loadChainMinimumAmountTokenValidator: async () =>
    import('./exposed-modules/chain-minimum-amount-token-validator'),
  loadTxExecutorImplementation: async () =>
    import('./tx-executor-implementation'),
  loadActivitiesItemUICustomisations: async () =>
    import('./exposed-modules/activities-item-ui-customisation'),
  loadAddressBookAddressValidators: async () =>
    import('./exposed-modules/address-book-address-validator'),
  loadTokenIdMapper: async () => import('./exposed-modules/token-id-mapper'),
  loadAccountUICustomisations: async () =>
    import('./exposed-modules/account-ui-customisation'),
  loadSendFlowSheetUICustomisations: async () =>
    import('./exposed-modules/send-flow-sheet-ui-customization'),
  loadSignerFactory: async () => import('./exposed-modules/signer-factory'),
};

const bitcoinModule = inferModuleContext({
  moduleName: ModuleName('blockchain-bitcoin'),
  implements: implementsContracts,
  dependsOn: dependsOnContracts,
  feature,
  addons,
  store,
});

// The guest sources Bitcoin signing from the host (@lace-module/bitcoin-host-pull's
// HostBitcoinSignerFactory), so its entry OMITS the in-process signer-factory
// addon — no InMemory seed ever runs guest-side for Bitcoin (ADR 36/46).
// Mirrors the blockchain-cardano guest variant.
const guestImplementsContracts = combineContracts([
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
] as const);

const { loadSignerFactory: _hostOwnedInGuest, ...guestAddons } = addons;
void _hostOwnedInGuest;

const guestModule = inferModuleContext({
  moduleName: ModuleName('blockchain-bitcoin'),
  implements: guestImplementsContracts,
  dependsOn: dependsOnContracts,
  feature,
  addons: guestAddons,
  store,
});

const moduleMap: LaceModuleMap = {
  'lace-extension': bitcoinModule,
  'lace-mobile': bitcoinModule,
  'lace-extension-guest': guestModule,
};

export default moduleMap;

export type {
  ActionCreators,
  AvailableAddons,
  Selectors,
  SideEffect,
} from './contracts';
