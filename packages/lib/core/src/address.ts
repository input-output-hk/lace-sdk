/**
 * CIP-19 Cardano address encoding: credentials to bech32, via `@lace-lib/cardano-core`'s
 * `*Address.fromCredentials(...).toAddress().toBech32()` through the `@lace-lib/vendor`
 * seam (ADR 37) — and the reverse read of an address's payment credential. Callers pass `Cardano.Credential` / `Cardano.CredentialType` (reachable
 * through the seam) directly — core does not mirror them.
 *
 * Returns intersect the SDK Tagged address types with the blockchain-agnostic `Address`
 * (ADR 13): the result is assignable both to `Cardano.PaymentAddress`/`Cardano.RewardAccount`
 * (for SDK APIs) and to `Address` (for Lace storage), so neither side needs a cast.
 */
import { Cardano } from '@lace-lib/vendor';

import type { Address } from './value-objects/address.vo';

/** Encode a base address (payment + stake credentials) to bech32. */
export const encodeBaseAddress = (
  networkId: number,
  payment: Cardano.Credential,
  stake: Cardano.Credential,
): Address & Cardano.PaymentAddress =>
  Cardano.BaseAddress.fromCredentials(
    networkId as Cardano.NetworkId,
    payment,
    stake,
  )
    .toAddress()
    .toBech32() as Address & Cardano.PaymentAddress;

/**
 * The payment credential of a base, enterprise or pointer address; `undefined`
 * for anything else (reward, Byron, unparseable).
 */
export const getPaymentCredential = (
  address: Cardano.PaymentAddress,
): Cardano.Credential | undefined => {
  const parsed = Cardano.Address.fromString(address);
  if (!parsed) return undefined;
  return (
    parsed.asBase()?.getPaymentCredential() ??
    parsed.asEnterprise()?.getPaymentCredential() ??
    parsed.asPointer()?.getPaymentCredential()
  );
};

/** Encode a reward (stake) address to bech32. */
export const encodeRewardAddress = (
  networkId: number,
  stake: Cardano.Credential,
): Address & Cardano.RewardAccount =>
  Cardano.RewardAddress.fromCredentials(networkId as Cardano.NetworkId, stake)
    .toAddress()
    .toBech32() as Address & Cardano.RewardAccount;
