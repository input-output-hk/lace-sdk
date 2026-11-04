import type { MidnightSDKTestNetworkId } from './const';
import type { midnightContextReducers } from './store/slice';
import type {
  MidnightEngineAccess,
  MidnightSideEffectsDependencies,
  MidnightSpecificInMemoryWalletData,
} from './types';
import type { DynamicallyLoadedInit } from '@lace-contract/module';
import type { StateFromReducersMapObject } from '@reduxjs/toolkit';

declare module '@lace-contract/module' {
  interface State
    extends StateFromReducersMapObject<typeof midnightContextReducers> {}
  interface SideEffectDependencies extends MidnightSideEffectsDependencies {}
  interface AppConfig {
    defaultMidnightTestnetNetworkId: MidnightSDKTestNetworkId;
  }
  interface LaceAddons {
    /** The running engines of the loading app instance, and their recorded start failures. */
    readonly loadMidnightEngine: DynamicallyLoadedInit<MidnightEngineAccess>;
  }
}

declare module '@lace-contract/wallet-repo' {
  interface BlockchainSpecificInMemoryWalletData {
    Midnight?: MidnightSpecificInMemoryWalletData;
  }
}
