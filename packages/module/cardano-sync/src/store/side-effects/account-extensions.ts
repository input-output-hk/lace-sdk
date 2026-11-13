// How the custody account feature hooks into Cardano sync: a custody account
// discovers its one contract address and fetches its UTxOs by that address,
// and a custody operation's pending activity records its transaction's
// validity bound. The stable SDK build resolves account-extensions.stable.ts
// instead, which hooks none of it.
// Keep the two files' exports in step, apart from the names the variant
// declares on stable-omits lines; the SDK's stable variant parity check
// enforces it.
import {
  cardanoCustodyActivityMetadataOf,
  isCardanoCustodyAccount,
} from '@lace-contract/cardano-context';

import {
  fetchCustodyAccountUtxos,
  handleCustodyAccount,
} from './custody-accounts';

import type { Activity } from '@lace-contract/activities';
import type { Cardano } from '@lace-lib/cardano-core';

/** Whether the account is of a kind a feature adds: a custody account. */
export const isExtensionAccount = isCardanoCustodyAccount;

/** Address discovery for an account of a kind a feature adds. */
export const extensionAccountAddressDiscovery = handleCustodyAccount;

/** The UTxO fetch of an account of a kind a feature adds. */
export const extensionAccountUtxos = fetchCustodyAccountUtxos;

/**
 * The upper validity bound of the transaction a feature's pending activity
 * records: a custody operation's.
 */
export const extensionActivityValidityBound = (
  activity: Activity,
): Cardano.Slot | undefined =>
  cardanoCustodyActivityMetadataOf(activity)?.invalidHereafter;
