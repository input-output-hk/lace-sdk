import { assertProofServerRouting } from '@lace-lib/vendor/midnight-proof-servers';

import { MidnightWorkerError } from './protocol';

import type {
  MidnightCircuitRequest,
  MidnightEngineSettings,
} from './protocol';
import type { ProofCircuitProvider } from '@lace-contract/midnight-context';

/**
 * The seam every Worker-mode proof crosses: circuit requests in, results out. An account's engine proves through
 * the circuit provider its proof server URL gives, which builds the proof server's payload; a later prover (an
 * attested one, or one in the browser) plugs in as another port, without a function or a ledger object ever
 * crossing the worker boundary.
 */
type MidnightProverPort = ProofCircuitProvider;

/**
 * Refuses settings that Worker mode cannot prove with. An attested prover is an app-supplied function, which
 * cannot cross into the SDK-owned worker, and a proof server without a plain URL cannot be reached from it.
 *
 * @param settings - The settings a client attaches with.
 */
export const assertWorkerProofServer = ({
  attestedProver,
  config: { proofServer },
}: MidnightEngineSettings): void => {
  if (attestedProver || proofServer.kind === 'tee-delegated')
    throw new MidnightWorkerError(
      'attested-prover',
      'An attested prover cannot prove in the Midnight SharedWorker: Worker mode proves through a proof server given by URL',
    );
  assertProofServerRouting(proofServer, false);
};

/**
 * Checks a dApp circuit through the port, which builds the proof server's check payload from the preimage and the
 * circuit's ZKIR and parses its answer.
 *
 * @param port - The account's prover port.
 * @param request - The circuit, with the key material the page resolved.
 */
export const checkCircuitThroughPort = async (
  port: MidnightProverPort,
  { serializedPreimage, keyLocation, keyMaterial }: MidnightCircuitRequest,
): Promise<(bigint | undefined)[]> =>
  port.check({ serializedPreimage, keyLocation, keyMaterial });

/**
 * Proves a dApp circuit through the port and returns the proof bytes.
 *
 * @param port - The account's prover port.
 * @param request - The circuit, with the key material the page resolved and the binding input to overwrite.
 */
export const proveCircuitThroughPort = async (
  port: MidnightProverPort,
  {
    serializedPreimage,
    keyLocation,
    keyMaterial,
    overwriteBindingInput,
  }: MidnightCircuitRequest & { readonly overwriteBindingInput?: bigint },
): Promise<Uint8Array> =>
  port.prove({
    serializedPreimage,
    keyLocation,
    keyMaterial,
    overwriteBindingInput,
  });
