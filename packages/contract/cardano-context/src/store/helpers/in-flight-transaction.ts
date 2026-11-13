import { ActivityType } from '@lace-contract/activities';
import { TokenId } from '@lace-contract/tokens';
import { Cardano } from '@lace-lib/cardano-core';
import { BigNumber, Timestamp } from '@lace-lib/util';

import { LOVELACE_TOKEN_ID } from '../../const';
import {
  isOwnAccountToken,
  pendingActivityExtensionMetadata,
} from '../../extensions';
import { inspectCardanoTxEffects } from '../../inspect-cardano-tx-effects';

import type { PendingActivityExtensionProps } from '../../extensions';
import type { CardanoTxEffects } from '../../inspect-cardano-tx-effects';
import type {
  CardanoInFlightEffects,
  CardanoPaymentAddress,
} from '../../types';
import type { CardanoTxId } from '../../value-objects';
import type { DecodedInFlightTransaction } from '../slice';
import type { Activity } from '@lace-contract/activities';
import type { AccountId } from '@lace-contract/wallet-repo';
import type { HexBytes } from '@lace-lib/util';

const outpointKey = (input: Pick<Cardano.TxIn, 'index' | 'txId'>): string =>
  `${input.txId}#${input.index}`;

/**
 * The in-flight effects of an inspected transaction: copies of what the chain
 * applies if it lands. That is its inputs, outputs and withdrawals, or, when
 * it is flagged `isValid` false, its collateral inputs and collateral return.
 * The node refuses a transaction whose flag disagrees with its scripts, so the
 * flag of an accepted one names the effects it lands with.
 */
export const inFlightEffectsOf = (
  effects: CardanoTxEffects,
): CardanoInFlightEffects =>
  effects.isValid
    ? {
        consumedInputs: [...effects.consumedInputs],
        producedOutputs: [...effects.producedOutputs],
        ...(effects.withdrawals.length > 0 && {
          withdrawals: [...effects.withdrawals],
        }),
      }
    : {
        consumedInputs: [...effects.collateralInputs],
        producedOutputs: effects.collateralReturn
          ? [effects.collateralReturn]
          : [],
      };

/**
 * The in-flight record of a signed transaction, read from its bytes alone with
 * no ownership resolution: what `recordInFlightTransaction` takes once a
 * provider accepted the bytes. `invalidHereafter` is the body's upper validity
 * bound, absent when the body sets none; the reducer then applies the cut-off
 * from the network tip.
 *
 * `chainId` names the network the bytes were submitted to, which keys the
 * entry. Throws when the CBOR is not a transaction, so a writer decides what a
 * decode failure means.
 */
export const inFlightTransactionOf = ({
  serializedTx,
  chainId,
  submittedAt = Timestamp(Date.now()),
}: {
  serializedTx: HexBytes;
  chainId: Cardano.ChainId;
  submittedAt?: Timestamp;
}): DecodedInFlightTransaction => {
  const effects = inspectCardanoTxEffects({
    accountAddresses: [],
    accountUtxos: [],
    serializedTx,
  });
  return {
    chainId,
    txId: effects.txId as CardanoTxId,
    effects: inFlightEffectsOf(effects),
    ...(effects.ttl !== undefined && {
      invalidHereafter: Cardano.Slot(effects.ttl),
    }),
    submittedAt,
  };
};

const addValue = (
  totals: Map<TokenId, bigint>,
  value: Cardano.Value,
  sign: -1n | 1n,
): void => {
  totals.set(
    LOVELACE_TOKEN_ID,
    (totals.get(LOVELACE_TOKEN_ID) ?? 0n) + sign * value.coins,
  );
  for (const [assetId, amount] of value.assets ?? []) {
    const tokenId = TokenId(assetId);
    totals.set(tokenId, (totals.get(tokenId) ?? 0n) + sign * amount);
  }
};

type PendingActivityOfParams = PendingActivityExtensionProps & {
  txId: Cardano.TransactionId;
  effects: CardanoInFlightEffects;
  accountId: AccountId;
  accountAddresses: readonly CardanoPaymentAddress[];
  /** The account's UTxOs to resolve inputs against: pass its widest own set. */
  accountUtxos: readonly Cardano.Utxo[];
  timestamp: Timestamp;
};

/**
 * The Pending display row of a transaction for one account, from the decoded
 * body effects. `undefined` unless the transaction touches the account: an
 * input resolves in `accountUtxos` or an output pays one of
 * `accountAddresses`.
 *
 * The balance change is the own outputs minus the own inputs per token,
 * leaving out zero nets and the tokens that only mark an account's own UTxOs
 * (`isOwnAccountToken`). The row carries no in-flight effects: the in-flight
 * store holds the spend, so `blockchainSpecific` is set only for the feature
 * metadata the extension props add, and absent otherwise.
 */
export const pendingActivityOf = ({
  txId,
  effects: { consumedInputs, producedOutputs },
  accountId,
  accountAddresses,
  accountUtxos,
  timestamp,
  ...extension
}: PendingActivityOfParams): Activity | undefined => {
  const ownAddresses = new Set<string>(accountAddresses);
  const ownUtxoByOutpoint = new Map(
    accountUtxos.map(utxo => [outpointKey(utxo[0]), utxo]),
  );
  const ownInputs = consumedInputs.flatMap(input => {
    const resolved = ownUtxoByOutpoint.get(outpointKey(input));
    return resolved ? [resolved] : [];
  });
  const ownOutputs = producedOutputs.filter(([, output]) =>
    ownAddresses.has(output.address),
  );
  if (ownInputs.length === 0 && ownOutputs.length === 0) return undefined;

  const netByTokenId = new Map<TokenId, bigint>();
  for (const [, output] of ownOutputs) addValue(netByTokenId, output.value, 1n);
  for (const [, output] of ownInputs) addValue(netByTokenId, output.value, -1n);

  const isAccountToken = isOwnAccountToken(accountAddresses);
  const tokenBalanceChanges: Activity['tokenBalanceChanges'] = [...netByTokenId]
    .filter(([tokenId, net]) => net !== 0n && !isAccountToken(tokenId))
    .map(([tokenId, net]) => ({ amount: BigNumber(net), tokenId }));

  const metadata = pendingActivityExtensionMetadata(extension);
  return {
    accountId,
    activityId: String(txId),
    ...(Object.keys(metadata).length > 0 && {
      blockchainSpecific: { Cardano: metadata },
    }),
    timestamp,
    tokenBalanceChanges,
    type: ActivityType.Pending,
  };
};
