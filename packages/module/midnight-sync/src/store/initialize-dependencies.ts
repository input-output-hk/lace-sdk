import { getTemenosBundledTrustRoots } from '@lace-lib/vendor/temenos-trust-roots';

import { createMidnightSideEffectDependencies } from './dependencies';
import { createStoreTemenosAttestedProver } from './temenos-attested-prover';

// The app attests tee-delegated proof servers with the verifier library's full
// AKX pipeline against the baked Temenos deployment.
export const initializeMidnightSideEffectDependencies =
  createMidnightSideEffectDependencies({
    createAttestedProver: ({
      networkId,
      proofServerApiUrl,
      getLedgerIndexerUrl,
    }) =>
      createStoreTemenosAttestedProver({
        networkId,
        proofServerApiUrl,
        getLedgerIndexerUrl,
        trustRoots: getTemenosBundledTrustRoots(),
      }),
  });
