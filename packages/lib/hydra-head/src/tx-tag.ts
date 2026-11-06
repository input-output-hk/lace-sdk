import { HYDRA_METADATA_LABEL } from './constants';

import type { HydraTxProtocol, HydraTxTag } from './types';
import type { Cardano } from '@lace-lib/cardano-core';

/** Metadata prefixes recognised as Hydra protocol generations. */
const PROTOCOLS: readonly HydraTxProtocol[] = ['HydraV1', 'HydraV2'];

/**
 * Splits a marker text such as `HydraV2/DepositTx` into protocol and name.
 *
 * @returns the tag, or undefined when the value is not text or does not
 * start with a Hydra protocol prefix followed by a transaction name.
 */
const parseTagText = (value: unknown): HydraTxTag | undefined => {
  if (typeof value !== 'string') return undefined;

  const separator = value.indexOf('/');
  if (separator === -1) return undefined;

  const protocol = PROTOCOLS.find(
    candidate => candidate === value.slice(0, separator),
  );
  const txName = value.slice(separator + 1);
  if (!protocol || txName.length === 0) return undefined;

  return { protocol, txName };
};

/**
 * Reads the Hydra marker from transaction metadata.
 *
 * The marker is a hint for discovering Hydra activity, not proof: anyone can
 * attach it to a transaction. Anything that affects balances must be anchored
 * on script addresses, tokens and datums instead.
 *
 * @returns the protocol and transaction name, or undefined when the label is
 * absent, is not text, or does not start with a Hydra protocol prefix.
 */
export const parseHydraTxTag = (
  metadata: ReadonlyMap<bigint, Cardano.Metadatum> | undefined,
): HydraTxTag | undefined => {
  return parseTagText(metadata?.get(HYDRA_METADATA_LABEL));
};
