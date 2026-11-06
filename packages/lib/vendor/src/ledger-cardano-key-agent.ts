/**
 * `@lace-lib/vendor/ledger-cardano-key-agent` — the Ledger Cardano SIGNING tree,
 * a HEAVY co-load group
 * ([ADR 37](../../../../docs/adr/37-host-supply-chain-isolation.md)).
 *
 * CONSUMER: the Cardano signer surface (`surfaces/ledger-signer.ts`), which
 * builds a `LedgerKeyAgent` over the paired device and runs the SDK's
 * tx→device signing. This is the tree the light pairing / verify-address entries
 * (`/ledger-cardano-app`, `/webhid`) must NEVER pull (`LIGHT_ENTRY_EXCLUSIONS`) —
 * a pairing document has no reason to load the signer + its libsodium WASM.
 *
 * ONE entry for the whole signing interop: besides `LedgerKeyAgent` itself, the
 * signer constructs the agent from `@lace-lib/cardano-crypto`
 * (`Bip32PublicKeyHex`, `SodiumBip32Ed25519`) and
 * `@lace-lib/cardano-key-management` (`CommunicationType`, `KeyPurpose`, the
 * `SignTransactionContext` type), so those interop symbols are re-exported
 * HERE: the surface consumes a single vendor entry instead of four direct
 * `@lace-lib/cardano-*` dynamic imports. With `splitting: true` these dedupe
 * into shared chunks with `/index`, so there is one copy of each Cardano
 * package per document (the entrypoint-split point, ADR 37).
 */
export { LedgerKeyAgent } from '@lace-lib/cardano-hardware-ledger';
export {
  Bip32PublicKeyHex,
  SodiumBip32Ed25519,
} from '@lace-lib/cardano-crypto';
export {
  CommunicationType,
  KeyPurpose,
} from '@lace-lib/cardano-key-management';
export type { SignTransactionContext } from '@lace-lib/cardano-key-management';
