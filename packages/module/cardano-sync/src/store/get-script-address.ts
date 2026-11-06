// hoisted from @cardano-sdk/wallet
import { Cardano, nativeScriptPolicyId } from '@lace-lib/cardano-core';
import { AddressType } from '@lace-lib/cardano-key-management';
import { encodeBaseAddress, encodeRewardAddress } from '@lace-lib/core';

import type * as Crypto from '@lace-lib/cardano-crypto';
import type { GroupedAddress } from '@lace-lib/cardano-key-management';

/**
 * Method to derive the wallet's grouped address from the script and network ID.
 *
 * @param paymentScript - The native script to be used for the payment credential.
 * @param stakingScript - The native script to be used for the staking credential.
 * @param networkId - The network identifier.
 * @returns The derived grouped address.
 */
export const getScriptAddress = (
  paymentScript: Cardano.NativeScript,
  stakingScript: Cardano.NativeScript,
  networkId: Cardano.NetworkId,
): GroupedAddress => {
  const paymentScriptHash = nativeScriptPolicyId(
    paymentScript,
  ) as unknown as Crypto.Hash28ByteBase16;
  const stakingScriptHash = nativeScriptPolicyId(
    stakingScript,
  ) as unknown as Crypto.Hash28ByteBase16;

  const paymentScriptCredential = {
    hash: paymentScriptHash,
    type: Cardano.CredentialType.ScriptHash,
  };

  const stakeScriptCredential = {
    hash: stakingScriptHash,
    type: Cardano.CredentialType.ScriptHash,
  };

  return {
    accountIndex: 0,
    address: encodeBaseAddress(
      networkId,
      paymentScriptCredential,
      stakeScriptCredential,
    ),
    index: 0,
    networkId,
    rewardAccount: encodeRewardAddress(networkId, stakeScriptCredential),
    type: AddressType.External,
  };
};
