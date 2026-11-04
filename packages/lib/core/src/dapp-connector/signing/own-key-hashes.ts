import { Cardano } from '@lace-lib/vendor';

import type { GroupedAddress } from '@lace-lib/vendor';

const paymentCredentialOf = (
  address: Cardano.Address,
): Cardano.Credential | undefined =>
  address.asBase()?.getPaymentCredential() ??
  address.asEnterprise()?.getPaymentCredential() ??
  address.asPointer()?.getPaymentCredential();

/**
 * The key hashes this account holds: every known address's payment credential
 * (when it is a key hash, not a script) plus every reward-account hash.
 */
export const getOwnKeyHashes = (
  knownAddresses: readonly GroupedAddress[],
): ReadonlySet<string> => {
  const ownKeyHashes = new Set<string>();
  for (const { address, rewardAccount } of knownAddresses) {
    const parsed = Cardano.Address.fromString(String(address));
    const paymentCredential = parsed && paymentCredentialOf(parsed);
    if (paymentCredential?.type === Cardano.CredentialType.KeyHash) {
      ownKeyHashes.add(paymentCredential.hash);
    }
    if (rewardAccount) {
      ownKeyHashes.add(Cardano.RewardAccount.toHash(rewardAccount));
    }
  }
  return ownKeyHashes;
};
