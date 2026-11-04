import { isRemoteMidnightEngine } from '@lace-contract/midnight-context';

import { remoteEngineClientOf } from './engine-client';
import {
  dustGenerationDetailsOf,
  midnightDustBalances,
  shieldedPublicKeysOfState,
  strictCompletionOfState,
} from './state-view';

import type { MidnightStateView } from './state-view';
import type {
  DustGenerationDetails,
  MidnightAccountPublicKeys,
  MidnightEngine,
} from '@lace-contract/midnight-context';
import type { FacadeState } from '@midnightntwrk/wallet-sdk/facade';
import type { Observable } from 'rxjs';

// Each reader of engine state reads through these functions, so that it has one code path for both kinds of engine:
// they take the in-process engine's state or the view a worker engine streams, and compute the same value from either.

/**
 * An engine state as a page reads it: the in-process engine's own state, or the view a worker engine computes from
 * its state. Both have `unshielded.availableCoins` and `unshielded.pendingCoins`.
 */
type MidnightStateSource = FacadeState | MidnightStateView;

const isStateView = (state: MidnightStateSource): state is MidnightStateView =>
  'shieldedPublicKeys' in state;

/**
 * The account's engine state, from an in-process engine or as the view a worker engine streams.
 *
 * @param engine - A running engine.
 */
export const midnightStateOf$ = (
  engine: MidnightEngine,
): Observable<MidnightStateSource> =>
  isRemoteMidnightEngine(engine)
    ? remoteEngineClientOf(engine).stateView$
    : engine.state();

/**
 * Generated DUST of every coin (`balance`), and of the coins no pending transaction spends (`available`).
 *
 * @param state - An engine state or its view.
 */
export const dustBalancesOf = (
  state: MidnightStateSource,
): { balance: bigint; available: bigint } =>
  isStateView(state)
    ? { balance: state.dust.balance, available: state.dust.available }
    : midnightDustBalances(state);

/**
 * The account's DUST generation; absent while it has no DUST coin.
 *
 * @param state - An engine state or its view.
 */
export const dustGenerationOf = (
  state: MidnightStateSource,
): DustGenerationDetails | undefined =>
  isStateView(state)
    ? state.dust.generation
    : dustGenerationDetailsOf(state.dust.totalCoins);

/**
 * The account's shielded coin and encryption public keys, as hex.
 *
 * @param state - An engine state or its view.
 */
export const shieldedPublicKeysOf = (
  state: MidnightStateSource,
): MidnightAccountPublicKeys =>
  isStateView(state)
    ? state.shieldedPublicKeys
    : shieldedPublicKeysOfState(state);

/**
 * Whether each sub-wallet has strictly caught up with the chain, in the same state as the balances read from it.
 *
 * @param state - An engine state or its view.
 */
export const strictCompletionOf = (
  state: MidnightStateSource,
): MidnightStateView['isStrictlyComplete'] =>
  isStateView(state)
    ? state.isStrictlyComplete
    : strictCompletionOfState(state);
