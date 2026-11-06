// The stable SDK build resolves this file in place of augmentations.ts: the
// stable SDK runs Cardano alone, so its config names no other chain's
// explorer.
import type { networkReducers } from './store/slice';
import type { Cardano } from '@lace-lib/cardano-core';
import type { StateFromReducersMapObject } from '@reduxjs/toolkit';

declare module '@lace-contract/module' {
  interface AppConfig {
    cexplorerUrls: Record<Cardano.NetworkMagic, string>;
  }

  interface State extends StateFromReducersMapObject<typeof networkReducers> {}
}
