export {
  isSameProofServerMode,
  getProofServerEndpoint,
} from '@lace-lib/vendor/midnight-proof-servers';
export type { ProofServerMode } from '@lace-lib/vendor/midnight-proof-servers';

import type { ProofServerMode } from '@lace-lib/vendor/midnight-proof-servers';

/** Local UI acknowledgement only; never an attestation or proving authorization.
 * Bump the version when the disclosure changes materially. */
export const proofServerDisclosureKey = (
  mode: ProofServerMode,
): string | undefined =>
  mode.kind === 'delegated' || mode.kind === 'tee-delegated'
    ? `v1:${mode.kind}:${mode.url}`
    : undefined;
