import { util } from '@lace-lib/cardano-key-management';

import type { Cardano } from '@lace-lib/cardano-core';
import type {
  AccountKeyDerivationPath,
  GroupedAddress,
  SpentOutputAddressMap,
  TxInKeyPathMap,
} from '@lace-lib/cardano-key-management';

const pathKey = ({ role, index }: AccountKeyDerivationPath) =>
  `${role}.${index}`;

/**
 * Own derivation paths a transaction requires solely through its native
 * scripts: paths signature detection reports once the witness scripts are
 * considered, minus those already required by inputs, certificates,
 * withdrawals, required extra signatures, or voting procedures. The addresses
 * of the spent outputs tell which script locks each foreign input.
 *
 * Signers whose device protocol cannot request extra script witnesses use the
 * result to fail fast instead of returning an incompletely witnessed
 * transaction.
 *
 * The DRep key hash is deliberately omitted from both detection passes:
 * passing it to only one would skew the comparison, and script key hashes are
 * only ever matched against payment and stake credentials, never the DRep key.
 */
export const getScriptOnlyKeyPaths = ({
  txBody,
  knownAddresses,
  txInKeyPathMap,
  scripts,
  spentOutputAddresses,
}: {
  txBody: Cardano.TxBody;
  knownAddresses: GroupedAddress[];
  txInKeyPathMap: TxInKeyPathMap;
  scripts: Cardano.Script[] | undefined;
  spentOutputAddresses?: SpentOutputAddressMap;
}): AccountKeyDerivationPath[] => {
  const pathsWithScripts = util.ownSignatureKeyPaths(
    txBody,
    knownAddresses,
    txInKeyPathMap,
    undefined,
    scripts,
    spentOutputAddresses,
  );
  const pathsWithoutScripts = new Set(
    util
      .ownSignatureKeyPaths(txBody, knownAddresses, txInKeyPathMap)
      .map(pathKey),
  );
  return pathsWithScripts.filter(
    path => !pathsWithoutScripts.has(pathKey(path)),
  );
};
