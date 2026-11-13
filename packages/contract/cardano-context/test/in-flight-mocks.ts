import { Cardano } from '@lace-lib/cardano-core';
import { Timestamp } from '@lace-lib/util';

import {
  cardanoContextActions,
  cardanoContextReducers,
} from '../src/store/slice';

import type { CardanoInFlightEffects, CardanoTxId } from '../src';
import type { CardanoContextSliceState } from '../src/store/slice';

/**
 * `state` with an accepted transaction recorded in the in-flight store, as a
 * writer records it: on Preprod unless `chainId` names another network.
 */
export const recordInFlight = (
  state: CardanoContextSliceState,
  {
    txId,
    chainId = Cardano.ChainIds.Preprod,
    consumedInputs = [],
    producedOutputs = [],
    withdrawals,
    invalidHereafter,
    submittedAt = Timestamp(0),
  }: Partial<CardanoInFlightEffects> & {
    txId: Cardano.TransactionId;
    chainId?: Cardano.ChainId;
    invalidHereafter?: Cardano.Slot;
    submittedAt?: Timestamp;
  },
): CardanoContextSliceState =>
  cardanoContextReducers.cardanoContext(
    state,
    cardanoContextActions.cardanoContext.recordInFlightTransaction({
      chainId,
      txId: txId as CardanoTxId,
      effects: {
        consumedInputs,
        producedOutputs,
        ...(withdrawals && { withdrawals }),
      },
      ...(invalidHereafter !== undefined && { invalidHereafter }),
      submittedAt,
    }),
  );
