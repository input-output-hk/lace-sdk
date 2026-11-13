import {
  CardanoNetworkId,
  UTXO_SYNC_CONFIRMATION_DEPTH,
} from '@lace-contract/cardano-context';
import { whileActive } from '@lace-contract/wallet-active-state';
import {
  EMPTY,
  catchError,
  combineLatest,
  defer,
  from,
  map,
  mergeMap,
  of,
  scan,
} from 'rxjs';

import { nextAttempts } from './ask-once-per-tip';

import type { Attempts, TipCandidate } from './ask-once-per-tip';
import type { SideEffect } from '../../module';
import type {
  CardanoNetworkInfo,
  DecodedInFlightTransaction,
  InFlightTransactionKey,
} from '@lace-contract/cardano-context';

/** An entry due a lookup, with its network's stored tip slot. */
type Candidate = TipCandidate & { entry: DecodedInFlightTransaction };

/**
 * The entries without a lookup whose network's stored tip is past their
 * upper validity bound by `UTXO_SYNC_CONFIRMATION_DEPTH`.
 */
const candidatesOf = (
  inFlight: Readonly<
    Record<InFlightTransactionKey, DecodedInFlightTransaction>
  >,
  networkInfo: Partial<Record<CardanoNetworkId, CardanoNetworkInfo>>,
): Candidate[] =>
  (
    Object.entries(inFlight) as [
      InFlightTransactionKey,
      DecodedInFlightTransaction,
    ][]
  ).flatMap(([key, entry]) => {
    if (entry.invalidHereafter === undefined || entry.lookup !== undefined)
      return [];
    const tip = networkInfo[CardanoNetworkId(entry.chainId.networkMagic)]?.tip;
    return tip &&
      tip.slot > entry.invalidHereafter + UTXO_SYNC_CONFIRMATION_DEPTH
      ? [{ key, entry, tipSlot: tip.slot }]
      : [];
  });

/**
 * Asks the provider whether the chain holds each in-flight transaction that
 * may no longer land, and records the answer on its entry with
 * `cardanoContext.recordInFlightTransactionLookup`. The reconcile reads it:
 * a transaction the provider does not hold can no longer settle, and one it
 * holds counts as shown.
 *
 * The provider is the proof because only it covers every case: an account
 * with a busy address whose history does not reach back to the submission, a
 * restored wallet, an account whose sync fails, an account with no address
 * yet, and a transaction no own account shows.
 *
 * An entry is asked once its network's stored tip is past its upper validity
 * bound by `UTXO_SYNC_CONFIRMATION_DEPTH`, the lag the wallet allows its
 * provider, so a transaction the provider does not hold then can no longer be
 * included. The tip slot is read before the request and recorded with the
 * answer: when the provider answered, its index had reached that slot, less
 * the lag.
 *
 * Each entry is asked once per tip slot of its network. An answer stops the
 * questions; a failed request records nothing and is asked again once the tip
 * moves, so a provider that cannot answer costs one request per tip poll. An
 * entry without a bound is never asked: it expires with its parent, or gets
 * its cut-off from `setTip` first. `whileActive` (ADR 29) stops it while the
 * wallet is locked.
 */
export const lookUpInFlightTransactions: SideEffect = (
  _,
  { cardanoContext: { selectInFlightTransactions$, selectAllNetworkInfo$ } },
  { actions, cardanoProvider: { checkTransaction }, isWalletActive$, logger },
) =>
  combineLatest([selectInFlightTransactions$, selectAllNetworkInfo$]).pipe(
    map(([inFlight, networkInfo]) => candidatesOf(inFlight, networkInfo)),
    scan<Candidate[], Attempts<Candidate>>(nextAttempts, {
      attempted: new Map(),
      due: [],
    }),
    mergeMap(({ due }) => from(due)),
    mergeMap(({ key, entry, tipSlot }) => {
      const askAgainLater = (error: unknown) => {
        logger.warn(
          `[cardano-sync] the provider did not answer for in-flight transaction ${key}; asking again at its network's next tip`,
          error,
        );
        return EMPTY;
      };
      return defer(() =>
        checkTransaction(entry.txId, { chainId: entry.chainId }),
      ).pipe(
        mergeMap(result =>
          result.isOk()
            ? of(
                actions.cardanoContext.recordInFlightTransactionLookup({
                  key,
                  lookup: { tipSlot, inclusion: result.value },
                }),
              )
            : askAgainLater(result.error),
        ),
        catchError(askAgainLater),
      );
    }),
    whileActive(isWalletActive$),
  );
