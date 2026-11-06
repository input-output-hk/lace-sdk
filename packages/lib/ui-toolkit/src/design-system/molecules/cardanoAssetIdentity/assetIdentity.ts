import { Cardano } from '@lace-lib/cardano-core';

/** Derive review identity from ledger bytes, never from display metadata. */
export const getCardanoAssetIdentity = (assetId: string) => {
  const id = Cardano.AssetId(assetId);
  const policyId = Cardano.AssetId.getPolicyId(id);
  const assetNameHex = Cardano.AssetId.getAssetName(id);
  return {
    assetId: id,
    policyId,
    assetNameHex,
    fingerprint: Cardano.AssetFingerprint.fromParts(policyId, assetNameHex),
  };
};
