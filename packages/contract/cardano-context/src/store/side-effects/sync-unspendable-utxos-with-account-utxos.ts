import { AccountId } from '@lace-contract/wallet-repo';
import { combineLatest, EMPTY, mergeMap, of, type Observable } from 'rxjs';

import { utxoKey } from '../../util';

import type { SideEffect, CardanoContextAction } from '../../contract';

/**
 * Side effect that drops a reserved UTxO from accountUnspendableUtxos once
 * the account's ownership view (`selectCollateralOwnershipUtxos`) no longer
 * holds its outpoint, such as after a spend of it settles.
 *
 * The ownership view, not the settled set: the collateral flow reserves its
 * own transaction's output as soon as that transaction's entry offers it. The
 * reservation then holds through settlement, as the refetch that lets the
 * entry settle also lists the output, and goes if the entry expires.
 */
export const syncUnspendableUtxosWithAccountUtxos: SideEffect = (
  _,
  {
    cardanoContext: {
      selectCollateralOwnershipUtxos$,
      selectAccountUnspendableUtxos$,
    },
  },
  { actions },
) =>
  combineLatest([
    selectCollateralOwnershipUtxos$,
    selectAccountUnspendableUtxos$,
  ]).pipe(
    mergeMap(
      ([
        ownershipUtxos,
        accountUnspendableUtxos,
      ]): Observable<CardanoContextAction> => {
        const actionsToDispatch: CardanoContextAction[] = [];

        for (const accountId of Object.keys(accountUnspendableUtxos)) {
          const unspendableUtxos =
            accountUnspendableUtxos[AccountId(accountId)] ?? [];
          if (unspendableUtxos.length === 0) continue;

          const ownedUtxoKeys = new Set(
            (ownershipUtxos[AccountId(accountId)] ?? []).map(utxoKey),
          );
          const filteredUnspendable = unspendableUtxos.filter(utxo =>
            ownedUtxoKeys.has(utxoKey(utxo)),
          );

          if (filteredUnspendable.length !== unspendableUtxos.length) {
            actionsToDispatch.push(
              actions.cardanoContext.setAccountUnspendableUtxos({
                accountId: AccountId(accountId),
                utxos: filteredUnspendable,
              }),
            );
          }
        }

        return actionsToDispatch.length > 0 ? of(...actionsToDispatch) : EMPTY;
      },
    ),
  );
