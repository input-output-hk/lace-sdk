import './augmentations';

import { BITCOIN_FEATURE_FLAG } from '@lace-contract/bitcoin-context';
import { inferModuleContext, ModuleName } from '@lace-contract/module';

import { dependsOnContracts, implementsContracts } from './sdk-contracts';
import store from './store';

export { DUST_THRESHOLD, getExtendedPubKeys } from './common';
export { signBitcoinTransactionWithSeed } from './signing/sign-bitcoin-transaction-with-seed';
export {
  BitcoinTxBuildError,
  BitcoinTxBuildErrorCode,
  buildBitcoinPayment,
} from './tx-builder';
export type { BuildBitcoinPaymentParams } from './tx-builder';
export { bitcoinAccountWallets$, SyncStatus } from './wallet';
export type { BitcoinWallet } from './wallet';

/**
 * Bitcoin accounts: their addresses, tokens and sync, in-memory wallet
 * creation and signing, without any user interface or send flow. Loads when
 * `BITCOIN_FEATURE_FLAG` is enabled, and needs a Bitcoin provider module such
 * as `m.bitcoinProviderMaestro` and a fee market module such as
 * `m.bitcoinMempoolFeeMarket`.
 */
export default inferModuleContext({
  moduleName: ModuleName('blockchain-bitcoin'),
  implements: implementsContracts,
  dependsOn: dependsOnContracts,
  feature: {
    willLoad: featureFlags =>
      featureFlags.some(flag => flag.key === BITCOIN_FEATURE_FLAG),
    metadata: { name: 'Bitcoin', description: 'Bitcoin blockchain support' },
  },
  store,
  addons: {
    loadInMemoryWalletIntegration: async () =>
      import('./in-memory-wallet-integration'),
    loadAddressBookAddressValidators: async () =>
      import('./exposed-modules/address-book-address-validator'),
    loadTokenIdMapper: async () => import('./exposed-modules/token-id-mapper'),
    loadSignerFactory: async () => import('./exposed-modules/signer-factory'),
  },
});
