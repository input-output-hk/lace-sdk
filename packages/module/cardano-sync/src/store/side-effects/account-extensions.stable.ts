// The stable SDK build resolves this file in place of account-extensions.ts:
// the stable SDK holds no account kind the canary features add, so every
// account syncs as a key or multi-signature account, and no pending activity
// records a feature's validity bound.
import { EMPTY } from 'rxjs';

import type { CardanoSyncAction } from '../../module';
import type { Activity } from '@lace-contract/activities';
import type { AnyAccount } from '@lace-contract/wallet-repo';
import type { Cardano } from '@lace-lib/cardano-core';
import type { Observable } from 'rxjs';

/** Whether the account is of a kind a feature adds: never. */
export const isExtensionAccount = (_account: AnyAccount): _account is never =>
  false;

/** Address discovery for an account of a kind a feature adds: none exists. */
export const extensionAccountAddressDiscovery = (
  _params: Record<string, unknown> & { account: never },
): Observable<CardanoSyncAction> => EMPTY;

/** The UTxO fetch of an account of a kind a feature adds: none exists. */
export const extensionAccountUtxos = (
  _params: Record<string, unknown> & { account: never },
): Observable<Cardano.Utxo[]> => EMPTY;

/** The validity bound a feature's pending activity records: none exists. */
export const extensionActivityValidityBound = (
  _activity: Activity,
): Cardano.Slot | undefined => undefined;
