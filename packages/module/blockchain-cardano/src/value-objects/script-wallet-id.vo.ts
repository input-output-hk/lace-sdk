import { Serialization } from '@lace-lib/cardano-core';

import type { WalletId } from '@lace-contract/wallet-repo';
import type { Cardano } from '@lace-lib/cardano-core';
import type { Tagged } from 'type-fest';

export type ScriptWalletId = Tagged<string, 'ScriptWalletId'> & WalletId;
export const ScriptWalletId = {
  /** Compute a unique walletId from the script */
  fromScript: (script: Cardano.Script) =>
    Serialization.Script.fromCore(script).hash().slice(0, 32) as ScriptWalletId,
};
