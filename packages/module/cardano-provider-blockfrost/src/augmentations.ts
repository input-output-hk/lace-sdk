import type { Cardano } from '@lace-lib/cardano-core';
import type { BlockfrostConfig } from '@lace-lib/cardano-provider-core';

declare module '@lace-contract/cardano-context' {
  interface CardanoProviderConfig {
    blockfrostConfigs: Partial<Record<Cardano.NetworkMagic, BlockfrostConfig>>;
  }
}
