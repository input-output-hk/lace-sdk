/**
 * `@lace-lib/vendor/trezor-cardano` — the Trezor Cardano SIGNING tree, our own
 * port (`@lace-lib/cardano-hardware-trezor`), a HEAVY co-load group
 * ([ADR 37](../../../../docs/adr/37-host-supply-chain-isolation.md)).
 *
 * CONSUMER: the Cardano Trezor signer surface (`surfaces/trezor-signer.ts`),
 * which constructs a `TrezorKeyAgent` over the paired device's xpub and runs the
 * port's tx→device signing. The chain-agnostic Connect runtime is the SEPARATE
 * `/trezor-connect` entry (this tree's internal `@trezor/connect-web` import is
 * build-aliased to the SAME webextension copy the split hoists per document, so
 * the agent's Connect singleton is the one the surface init/dispose reach).
 *
 * ONE entry for the whole signing interop, typed in the ported domain layer:
 * the agent plus the crypto / key-management symbols the signer constructs it
 * from, and the `Serialization` codec the signer reads the transaction body's
 * CBOR with. The build resolves the port's `@lace-lib/cardano-*` imports to
 * the `@cardano-sdk/*` copies `/index` already carries, so a document still
 * holds ONE domain-layer copy (the ADR 37 point) while these declarations stay
 * the port's own.
 */
export { TrezorKeyAgent } from '@lace-lib/cardano-hardware-trezor';
export { Cardano, Serialization } from '@lace-lib/cardano-core';
export {
  Bip32PublicKeyHex,
  SodiumBip32Ed25519,
} from '@lace-lib/cardano-crypto';
export {
  CommunicationType,
  KeyPurpose,
} from '@lace-lib/cardano-key-management';
export type { SignTransactionContext } from '@lace-lib/cardano-key-management';
export { HexBlob } from '@lace-lib/cardano-util';
