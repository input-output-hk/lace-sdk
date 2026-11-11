import type { ProofCircuitProvider } from './midnight-proof-servers';
import type * as ledger from '@midnight-ntwrk/ledger-v8';

// The circuit-level proving provider over any circuit provider: the one piece of the proof-server transport that a
// page needs without the ledger. It stays a module of its own, with no value import of the ledger or the wallet SDK,
// so that the SDK's Midnight entry can hold it in a Worker-mode page's static import closure.

// Key locations under this prefix are reserved for the ledger's protocol
// circuits (zswap, dust); the proof server holds their key material.
const BUILT_IN_CIRCUIT_PREFIX = 'midnight/';

/** What a failed key material lookup does. */
export type ProvingProviderOptions = {
  /**
   * `'fallback'` (the default, the dApp connector's behaviour) proves any
   * circuit whose lookup fails without key material. `'propagate'` does so
   * only for the ledger's built-in circuits, which dApp providers do not
   * serve, and rejects with the provider's error for any other circuit.
   */
  onKeyMaterialError?: 'fallback' | 'propagate';
};

/**
 * Circuit payloads shared by the wallet, connector and headless SDK. Without
 * a key material provider every circuit is proved with the material the
 * proof server holds; `onKeyMaterialError` decides what a failed lookup does.
 */
export const createProvingProviderFromCircuits = (
  circuits: ProofCircuitProvider,
  keyMaterialProvider?: Record<
    'getProverKey' | 'getVerifierKey' | 'getZKIR',
    (keyLocation: string) => Promise<Uint8Array>
  >,
  { onKeyMaterialError = 'fallback' }: ProvingProviderOptions = {},
): ledger.ProvingProvider => {
  const keyMaterial = async (keyLocation: string) => {
    if (!keyMaterialProvider) return undefined;
    try {
      const [proverKey, verifierKey, ir] = await Promise.all([
        keyMaterialProvider.getProverKey(keyLocation),
        keyMaterialProvider.getVerifierKey(keyLocation),
        keyMaterialProvider.getZKIR(keyLocation),
      ]);
      return { proverKey, verifierKey, ir };
    } catch (error) {
      if (
        onKeyMaterialError === 'fallback' ||
        keyLocation.startsWith(BUILT_IN_CIRCUIT_PREFIX)
      )
        return undefined;
      throw error;
    }
  };
  return {
    check: async (serializedPreimage, keyLocation) =>
      circuits.check({
        serializedPreimage,
        keyLocation,
        keyMaterial: await keyMaterial(keyLocation),
      }),
    prove: async (serializedPreimage, keyLocation, overwriteBindingInput) =>
      circuits.prove({
        serializedPreimage,
        keyLocation,
        overwriteBindingInput,
        keyMaterial: await keyMaterial(keyLocation),
      }),
  };
};
