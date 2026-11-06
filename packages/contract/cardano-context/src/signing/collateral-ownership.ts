import { toCollateralOwnershipSets } from '@lace-lib/core/dapp-connector/signing';

import type { Cardano } from '@lace-lib/cardano-core';
import type { GroupedAddress } from '@lace-lib/cardano-key-management';
import type { CollateralOwnershipSets } from '@lace-lib/core/dapp-connector/signing';

export {
  collateralRefusalCase,
  type CollateralOwnershipSets,
} from '@lace-lib/core/dapp-connector/signing';

/**
 * The pre-consent authority in the shape `collateralRefusalCase` reads: the
 * account's own UTxOs and known addresses. The lib keys the UTxOs, so the
 * pre-consent check and the signing-boundary check cannot disagree about what
 * "the same UTxO" means.
 */
export const collateralOwnershipSets = ({
  ownershipUtxos,
  knownAddresses,
}: {
  ownershipUtxos: readonly Cardano.Utxo[];
  knownAddresses: readonly GroupedAddress[];
}): CollateralOwnershipSets =>
  toCollateralOwnershipSets({
    ownInputs: ownershipUtxos.map(([input]) => input),
    ownAddresses: knownAddresses.map(({ address }) => address),
  });
