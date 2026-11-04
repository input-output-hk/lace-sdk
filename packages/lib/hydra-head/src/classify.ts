import { decodeHydraHeadState } from './head-datum';
import {
  findHydraHeadVersion,
  isHydraDepositAddress,
  isHydraHeadAddress,
} from './registry';

import type {
  HydraHeadStateName,
  HydraTxClassification,
  HydraTxEndpoint,
} from './types';

/** Decoded state of a head UTxO, or undefined without a decodable datum. */
const readHeadState = ({
  address,
  inlineDatum,
}: HydraTxEndpoint): HydraHeadStateName | undefined => {
  const version = findHydraHeadVersion(address);
  if (version === undefined || !inlineDatum) return undefined;
  return decodeHydraHeadState(inlineDatum, version)?.state;
};

/**
 * Names a transaction that spends a head UTxO from the head state it spends
 * and the head state it produces, if any.
 */
const classifyHeadStep = (
  from: HydraHeadStateName | undefined,
  to: HydraHeadStateName | undefined,
  producesHead: boolean,
): HydraTxClassification => {
  switch (from) {
    case 'initial':
      if (!producesHead) return 'AbortTx';
      return to === 'open' ? 'CollectComTx' : 'HeadTx';
    case 'open':
      if (to === 'closed') return 'CloseTx';
      return to === 'open' ? 'DecrementTx' : 'HeadTx';
    case 'closed':
    case 'fanningOut':
      if (!producesHead) return 'FanoutTx';
      if (to === 'fanningOut') return 'PartialFanoutTx';
      return from === 'closed' && to === 'closed' ? 'ContestTx' : 'HeadTx';
    case 'final':
    case undefined:
      return 'HeadTx';
  }
};

/**
 * Names the Hydra action of a transaction from where its inputs and outputs
 * sit, without trusting metadata. A transaction spending a head UTxO and a
 * deposit is an increment; other head steps are told apart by the head
 * datums and fall back to `HeadTx` when those are missing. Without a head
 * UTxO, an output at a head address is an init, a spent deposit is a recover
 * and an output at a deposit address is a deposit.
 *
 * @param inputs - Spent inputs, resolved to the outputs they consume. Leave
 * out collateral and reference inputs.
 * @param outputs - Outputs of the transaction.
 * @returns the action, or undefined when no Hydra script address is involved.
 */
export const classifyHydraTxByAddresses = (
  inputs: readonly HydraTxEndpoint[],
  outputs: readonly HydraTxEndpoint[],
): HydraTxClassification | undefined => {
  const headInput = inputs.find(({ address }) => isHydraHeadAddress(address));
  const headOutput = outputs.find(({ address }) => isHydraHeadAddress(address));
  const hasDepositInput = inputs.some(({ address }) =>
    isHydraDepositAddress(address),
  );

  if (headInput) {
    if (hasDepositInput) return 'IncrementTx';
    return classifyHeadStep(
      readHeadState(headInput),
      headOutput && readHeadState(headOutput),
      headOutput !== undefined,
    );
  }
  if (headOutput) return 'InitTx';
  if (hasDepositInput) return 'RecoverTx';
  if (outputs.some(({ address }) => isHydraDepositAddress(address))) {
    return 'DepositTx';
  }
  return undefined;
};
