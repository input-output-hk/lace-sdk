import {
  AkxChannelBinder,
  AkxEvidenceProvider,
  AttestationVerificationError,
  AttestationVerifier,
  LocalCheckFailedError,
  RealLedgerClient,
  RealLocalVerifier,
  RealWardenClient,
} from '@input-output-hk/temenos-attestation-verifier';
import { createTemenosAttestedProverWith } from '@lace-lib/vendor/temenos-attested-prover';

import type {
  VerifierConfig,
  VerifierDependencies,
} from '@input-output-hk/temenos-attestation-verifier';
import type { TemenosTrustRoots } from '@lace-lib/vendor/temenos-attested-prover';

export { TemenosAttestationError } from '@lace-lib/vendor/temenos-attested-prover';
export type {
  TemenosAttestationPhaseId,
  TemenosAttestationCheckId,
  TemenosTrustRoots,
} from '@lace-lib/vendor/temenos-attested-prover';

/**
 * The extension's Temenos driver with the verifier library's real
 * dependencies; the public SDK supplies its verifier through the host.
 *
 * @param testSeam - internal: only tests pass it, to swap in the library's mock
 *   dependencies and fixture deployment. No public entry re-exports this function.
 */
export const createStoreTemenosAttestedProver = (
  props: {
    networkId: string;
    proofServerApiUrl: string;
    trustRoots: TemenosTrustRoots;
    getLedgerIndexerUrl: () => Promise<string>;
  },
  testSeam?: {
    dependencies?: Partial<VerifierDependencies>;
    config?: Omit<VerifierConfig, 'amdRootCertificates' | 'indexerUrl'>;
  },
) =>
  createTemenosAttestedProverWith(
    {
      ...props,
      verifier: {
        LocalCheckFailedError,
        AttestationVerificationError,
        createVerifier: config => {
          const overrides = testSeam?.dependencies;
          return new AttestationVerifier(
            {
              evidenceProvider:
                overrides?.evidenceProvider ??
                AkxEvidenceProvider.fromConfig(config),
              ledgerClient:
                overrides?.ledgerClient ?? RealLedgerClient.fromConfig(config),
              localVerifier:
                overrides?.localVerifier ?? new RealLocalVerifier(),
              wardenClient:
                overrides?.wardenClient ?? RealWardenClient.fromConfig(config),
              channelBinder:
                overrides?.channelBinder ?? AkxChannelBinder.fromConfig(config),
            },
            config,
          );
        },
      },
    },
    testSeam,
  );
