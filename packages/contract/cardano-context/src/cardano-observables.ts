import { BehaviorSubject } from 'rxjs';

import type { PendingRewardWithdrawals } from './apply-in-flight-utxo-adjustments';
import type {
  AccountRewardAccountDetailsMap,
  AccountUtxoMap,
  RequiredProtocolParameters,
} from './types';
import type { AnyAddress } from '@lace-contract/addresses';
import type { Cardano } from '@lace-lib/cardano-core';

/**
 * Observable for Cardano protocol parameters.
 * Updated by side effects that subscribe to the protocolParameters selector.
 */
export const cardanoProtocolParameters$ = new BehaviorSubject<
  RequiredProtocolParameters | undefined
>(undefined);

/**
 * Observable for Cardano network magic.
 * Updated by side effects that subscribe to the chainId selector.
 */
export const cardanoNetworkMagic$ = new BehaviorSubject<
  Cardano.NetworkMagic | undefined
>(undefined);

/**
 * Observable for the settled UTxOs a transaction of the account may spend: on
 * chain, spent by no in-flight transaction, not reserved as collateral;
 * accounts excluded from spending are absent.
 * Updated by side effects that subscribe to the
 * `selectSettledAvailableAccountUtxos` selector.
 */
export const cardanoSettledAvailableAccountUtxos$ =
  new BehaviorSubject<AccountUtxoMap>({});

/**
 * Observable for the reserved collateral a transaction can name: settled and
 * spent by no in-flight transaction.
 * Updated by side effects that subscribe to the
 * `selectSettledAccountUnspendableUtxos` selector.
 */
export const cardanoSettledAccountUnspendableUtxos$ =
  new BehaviorSubject<AccountUtxoMap>({});

/**
 * Observable for Cardano addresses.
 * Updated by side effects that subscribe to the addresses selector.
 */
export const cardanoAddresses$ = new BehaviorSubject<AnyAddress[]>([]);

/**
 * Observable for Cardano chain ID.
 * Updated by side effects that subscribe to the chainId selector.
 */
export const cardanoChainId$ = new BehaviorSubject<Cardano.ChainId | undefined>(
  undefined,
);

/**
 * Observable for reward account details (stake key registration status).
 * Updated by side effects that subscribe to the rewardAccountDetails selector.
 */
export const cardanoRewardAccountDetails$ =
  new BehaviorSubject<AccountRewardAccountDetailsMap>({});

/**
 * Observable for the rewards in-flight transactions withdraw, keyed by
 * `pendingRewardWithdrawalKey`.
 * Updated by side effects that subscribe to the
 * `selectPendingRewardWithdrawals` selector.
 */
export const cardanoPendingRewardWithdrawals$ =
  new BehaviorSubject<PendingRewardWithdrawals>(new Map());
