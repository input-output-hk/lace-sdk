import {
  AttestationError,
  VERITEE_PROOF_SERVER_MODES,
} from './midnight-proof-servers';

import type {
  AttestedProverProvider,
  AttestedProvingSession,
} from './attested-proving-service';
import type { AttestationProgressEvent } from './midnight-proof-servers';

/** Structural boundary for the pinned Veritee verifier; no private package imports. */
type VerificationPhase =
  | 'bind-channel'
  | 'fetch-expected-values'
  | 'obtain-evidence'
  | 'prove'
  | 'verify-locally'
  | 'warden-verify';
type LocalCheckId =
  | 'ak-extraction'
  | 'epoch-key-binding'
  | 'nonce-freshness'
  | 'pcr15-recompute'
  | 'pcrs-0-4-vs-record'
  | 'report-data-binding'
  | 'report-fields-vs-record'
  | 'snp-signature-chain'
  | 'tpm-quote-pcr-digest'
  | 'tpm-quote-signature';
type PhaseEvent =
  | {
      phase: 'verify-locally';
      status: 'check';
      check: { id: LocalCheckId; status: 'failed' | 'passed'; detail: string };
    }
  | { phase: VerificationPhase; status: 'completed'; detail?: string }
  | { phase: VerificationPhase; status: 'failed'; error: Error }
  | { phase: VerificationPhase; status: 'started' };
type VerifiedSession = {
  prove(request: {
    body: Uint8Array;
  }): Promise<{ status: number; body: Uint8Array }>;
  close(): Promise<void>;
};

/** Baked deployment and a snapshot of host-reviewed roots, passed to each fresh verifier. */
type VerifierConfig = {
  attestationHost: string;
  proofServerApiUrl: string;
  wardenUrl: string;
  applicationId: string;
  akxServerUrl?: string;
  pointerContractAddress: string;
  indexerUrl: string;
  amdRootCertificates: string[];
  wardenTlsCertificate: string;
  sessionTtlMs?: number;
};

/**
 * Trusted host implementation of the Veritee pipeline. Construct a fresh verifier
 * and its AKX dependencies from the supplied config on every call. Supply the
 * error classes from the same library instance so diagnostics retain their identity.
 */
export type VeriteeVerifier = {
  LocalCheckFailedError: abstract new (...args: never[]) => Error & {
    readonly checkId: LocalCheckId;
  };
  AttestationVerificationError: abstract new (...args: never[]) => Error & {
    readonly phase: VerificationPhase;
  };
  createVerifier(
    config: VerifierConfig,
    signal?: AbortSignal,
    /** Apply only to the channel binder's fetch to include safe HTTP diagnostics. */
    observeChannelFetch?: (fetchImpl: typeof fetch) => typeof fetch,
  ): {
    establishVerifiedSession(
      onPhase?: (event: PhaseEvent) => void,
    ): Promise<VerifiedSession>;
  };
};

/** Veritee vocabulary stays inside the Veritee implementation. */
export type VeriteeAttestationPhaseId = Exclude<VerificationPhase, 'prove'>;
export type VeriteeAttestationCheckId = Exclude<
  LocalCheckId,
  'nonce-freshness'
>;
/** Host-reviewed AMD root certificates used to verify Veritee attestation evidence. */
export type VeriteeTrustRoots = {
  readonly amdRootCertificates: readonly string[];
};

export class VeriteeAttestationError extends AttestationError {
  public constructor(
    readonly phase: VeriteeAttestationPhaseId,
    readonly checkId?: VeriteeAttestationCheckId,
  ) {
    super(
      'veritee',
      phase === 'obtain-evidence'
        ? 'evidence'
        : phase === 'fetch-expected-values'
        ? 'policy'
        : phase === 'bind-channel'
        ? 'channel'
        : 'appraisal',
      checkId
        ? `Veritee attestation failed: check "${checkId}" of phase "${phase}"`
        : `Veritee attestation failed at phase "${phase}"`,
    );
    this.name = 'VeriteeAttestationError';
  }
}

/** A baked config whose AKX endpoint is mandatory — Lace only ships the AKX flow. */
type VeriteeAttestationConfig = Omit<
  VerifierConfig,
  'amdRootCertificates' | 'indexerUrl'
> & {
  akxServerUrl: string;
};

/**
 * `pointerContractAddress` is the one on-chain constant: the pointer's
 * `current` cell names the attestation ledger, so a ledger redeploy is a
 * pointer update, not a Lace release. All Veritee deployments register on the
 * single preprod pointer, whatever network the proof server serves, so this
 * stays on preprod on every network. The caller resolves the ledger
 * indexer from Lace configuration at the start of each attestation run.
 *
 * `wardenTlsCertificate` is empty by design: a browser context cannot pin
 * the transport certificate, so the Warden is reached over public WebPKI
 * TLS — its verdict is defense-in-depth on top of the local checks, not a
 * trust root.
 */
const SHARED_VERITEE_DEPLOYMENT: Pick<
  VeriteeAttestationConfig,
  'pointerContractAddress' | 'wardenTlsCertificate' | 'wardenUrl'
> = {
  pointerContractAddress:
    'a58974f1cacda177edfea3bdc76c1cd48d5e3107b9a543b9d65cee6b454c9122',
  wardenUrl: 'https://warden.wastedp.io',
  wardenTlsCertificate: '',
};

const VERITEE_PREPROD_DEPLOYMENT: VeriteeAttestationConfig = {
  ...SHARED_VERITEE_DEPLOYMENT,
  proofServerApiUrl: 'https://api.proofserver.wastedp.io',
  attestationHost: 'attestation.proofserver.wastedp.io',
  akxServerUrl: 'https://attestation.proofserver.wastedp.io/tee_attestation',
  applicationId:
    'afe48970b7083e1b2855acce95a488e93a7c257a34f6275e77ac26f79ac7ad05',
};

const VERITEE_MAINNET_DEPLOYMENT: VeriteeAttestationConfig = {
  ...SHARED_VERITEE_DEPLOYMENT,
  proofServerApiUrl: 'https://api.proofserver.mainnet.wastedp.io',
  attestationHost: 'attestation.proofserver.mainnet.wastedp.io',
  akxServerUrl:
    'https://attestation.proofserver.mainnet.wastedp.io/tee_attestation',
  applicationId:
    '70402462424c122c65e2d3d2312757face3974940c9ac5d09249b61028350427',
};

const VERITEE_PREVIEW_DEPLOYMENT: VeriteeAttestationConfig = {
  ...SHARED_VERITEE_DEPLOYMENT,
  proofServerApiUrl: 'https://api.proofserver.preview.wastedp.io',
  attestationHost: 'attestation.proofserver.preview.wastedp.io',
  akxServerUrl:
    'https://attestation.proofserver.preview.wastedp.io/tee_attestation',
  applicationId:
    'b294b8879607f7d0f5cca3808a4b64aab7992de2a73d1e55dbafb091efca25f2',
};

/**
 * Attestation parameters per network, matching `VERITEE_PROOF_SERVER_MODES`
 * entry for entry. Values are build-baked and reviewed like code; the
 * persisted mode carries only the URL, so nothing here can be injected via
 * feature-flag payloads.
 */
const VERITEE_ATTESTATION_CONFIGS: Partial<
  Record<string, VeriteeAttestationConfig>
> = {
  mainnet: VERITEE_MAINNET_DEPLOYMENT,
  preprod: VERITEE_PREPROD_DEPLOYMENT,
  preview: VERITEE_PREVIEW_DEPLOYMENT,
};

// Drift assertion (spec §2.2): every baked tee-delegated mode must have its
// attestation parameters here, for the same proof server — throwing at
// module load beats silently offering a mode that cannot attest.
for (const [networkId, mode] of Object.entries(VERITEE_PROOF_SERVER_MODES)) {
  if (!mode) continue;
  const config = VERITEE_ATTESTATION_CONFIGS[networkId];
  if (config?.proofServerApiUrl !== mode.url) {
    throw new Error(
      `VERITEE_PROOF_SERVER_MODES[${networkId}] ("${mode.url}") has no matching entry in VERITEE_ATTESTATION_CONFIGS`,
    );
  }
}

/** veritee-spec phases 1–5 of the AKX flow, in execution order. */
const VERITEE_ATTESTATION_PHASES: readonly VeriteeAttestationPhaseId[] = [
  'obtain-evidence',
  'fetch-expected-values',
  'verify-locally',
  'warden-verify',
  'bind-channel',
];

const PHASE_MAP: Record<
  Exclude<VerificationPhase, 'prove'>,
  VeriteeAttestationPhaseId
> = {
  'obtain-evidence': 'obtain-evidence',
  'fetch-expected-values': 'fetch-expected-values',
  'verify-locally': 'verify-locally',
  'warden-verify': 'warden-verify',
  'bind-channel': 'bind-channel',
};

/**
 * `nonce-freshness` belongs to the library's SPKI-pin flow, which Lace never
 * runs (the AKX evidence provider always yields epoch-key evidence) — it has
 * no contract ID, so its events are dropped rather than mislabeled.
 */
const mapCheckId = (id: LocalCheckId): VeriteeAttestationCheckId | undefined =>
  id === 'nonce-freshness' ? undefined : id;

const mapPhaseEvent = (
  event: PhaseEvent,
): AttestationProgressEvent | undefined => {
  if (event.status === 'check') {
    const id = mapCheckId(event.check.id);
    if (!id) return undefined;
    return {
      type: 'check',
      check: { id, status: event.check.status, detail: event.check.detail },
    };
  }
  // The service owns the `proving` step: it emits `started` before the
  // payload leaves and `completed`/`failed` on the result. The library also
  // reports its own `prove` phase inside that window; forwarding it would
  // double the row and leave its `status=200` detail stuck on it.
  if (event.phase === 'prove') return undefined;
  const phase = PHASE_MAP[event.phase];
  switch (event.status) {
    case 'started':
      return { type: 'phase', phase, status: 'started' };
    case 'completed':
      return {
        type: 'phase',
        phase,
        status: 'completed',
        ...(event.detail === undefined ? {} : { detail: event.detail }),
      };
    case 'failed':
      return {
        type: 'phase',
        phase,
        status: 'failed',
        detail: event.error.message,
      };
  }
};

const toVeriteeAttestationError = (
  error: unknown,
  fallbackPhase: VeriteeAttestationPhaseId,
  { LocalCheckFailedError, AttestationVerificationError }: VeriteeVerifier,
): VeriteeAttestationError => {
  const mapped =
    error instanceof LocalCheckFailedError
      ? new VeriteeAttestationError('verify-locally', mapCheckId(error.checkId))
      : error instanceof AttestationVerificationError
      ? new VeriteeAttestationError(
          error.phase === 'prove' ? fallbackPhase : PHASE_MAP[error.phase],
        )
      : new VeriteeAttestationError(fallbackPhase);
  mapped.cause = error;
  return mapped;
};

const describeChannelFailure = (error: unknown): string => {
  if (
    error instanceof Error &&
    error.name === 'AttestationVerificationError' &&
    error.cause instanceof Error
  )
    error = error.cause;
  const message = error instanceof Error ? error.message : '';
  // The pinned verifier flattens fetch errors into ChannelBindingError messages.
  // Match known signatures; never display arbitrary messages, URLs or proof bodies.
  if (
    (error instanceof Error && error.name === 'TimeoutError') ||
    /\b(timeout|timed out)\b/i.test(message)
  )
    return 'Encrypted proof request timed out';
  if (
    (error instanceof Error && error.name === 'AbortError') ||
    /\baborted\b/i.test(message)
  )
    return 'Encrypted proof request was aborted';
  const status = /returned HTTP ([1-5][0-9]{2})\b/.exec(message)?.[1];
  if (status) return `Attestation proxy returned HTTP ${status}`;
  if (message.includes('failed to reach '))
    return 'Encrypted proof request could not reach the attestation proxy';
  if (message.includes('proxy response failed authentication'))
    return 'Encrypted proof response failed authentication';
  if (
    message.includes('malformed HTTP tunnel response') ||
    message.includes('failed to parse JSON')
  )
    return 'Encrypted proof response could not be decoded';
  return 'Encrypted proof request failed (unclassified channel error)';
};

/**
 * `/prove` payloads travel as AEAD records tunneled through the AKX channel.
 * The enclave proxy forwards to `/prove` only, so the session offers nothing
 * else: the public API endpoint is never contacted from this flow.
 */
const createTunneledSession = (
  session: VerifiedSession,
  onEvent: (event: AttestationProgressEvent) => void,
  httpDiagnostics: ReturnType<typeof createChannelDiagnostics>,
): AttestedProvingSession => {
  const established = performance.now();
  let requests = 0;
  let inFlight = 0;
  let peakInFlight = 0;
  let firstFailure: string | undefined;
  let isClosed = false;
  const publishFailure = () => {
    if (!firstFailure || isClosed) return;
    onEvent({
      type: 'phase',
      phase: 'proving',
      status: 'failed',
      detail: [
        firstFailure,
        `Proof calls: ${requests}; peak overlapping calls: ${peakInFlight}.`,
        httpDiagnostics.summary(),
      ].join('\n'),
    });
  };
  return {
    prove: async payload => {
      const started = performance.now();
      const request = ++requests;
      inFlight++;
      peakInFlight = Math.max(peakInFlight, inFlight);
      const reportFailure = (detail: string) => {
        // The first failure can invalidate the session; later 404s must not replace it.
        firstFailure ??= `First failure: proof call #${request}: ${detail} (elapsed ${(
          (performance.now() - started) /
          1000
        ).toFixed(1)} s; started ${((started - established) / 1000).toFixed(
          1,
        )} s after initial handshake; ${
          inFlight - 1
        } other calls in flight at failure).`;
        publishFailure();
      };
      try {
        let response: Awaited<ReturnType<VerifiedSession['prove']>>;
        try {
          response = await session.prove({ body: payload });
        } catch (error) {
          reportFailure(describeChannelFailure(error));
          throw error;
        }
        if (response.status !== 200) {
          reportFailure(
            `Proof server returned HTTP ${response.status} inside the encrypted channel`,
          );
          throw new Error(
            `Proof server returned ${response.status} through the attested channel`,
          );
        }
        return response.body;
      } finally {
        inFlight--;
      }
    },
    close: async () => {
      isClosed = true;
      await session.close();
    },
  };
};

const PROXY_ERROR_REASONS = [
  'unknown or expired session',
  'session handshake not complete',
  'record authentication failed',
  'malformed tunnel request',
  'tunnel path is not allowed',
  'upstream DApp transport error',
] as const;

// Read only a small, bounded diagnostic copy; never consume the verifier's response.
const readProxyReason = async (response: Response): Promise<string> => {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    reader = response.clone().body?.getReader();
    if (!reader) return 'reason unavailable';
    const read = async () => {
      let text = '';
      let size = 0;
      const decoder = new TextDecoder();
      while (reader) {
        const { value, done: isDone } = await reader.read();
        if (isDone) return text.trim();
        size += value.length;
        if (size > 256) return undefined;
        text += decoder.decode(value, { stream: true });
      }
      return undefined;
    };
    const text = await Promise.race([
      read(),
      new Promise<undefined>(resolve => {
        timer = setTimeout(() => {
          resolve(undefined);
        }, 250);
      }),
    ]);
    return (
      PROXY_ERROR_REASONS.find(reason => reason === text) ??
      'reason unavailable'
    );
  } catch {
    return 'reason unavailable';
  } finally {
    clearTimeout(timer);
    void reader?.cancel().catch(() => undefined);
  }
};

const createChannelDiagnostics = () => {
  const history: string[] = [];
  let requests = 0;
  let inFlight = 0;
  let peak = 0;
  let handshake = 0;
  let established: number | undefined;
  let firstFailure: string | undefined;
  const record = (line: string) => {
    history.push(line);
    if (history.length > 12) history.shift();
  };
  const wrap: (fetchImpl: typeof fetch) => typeof fetch =
    fetchImpl => async (input, init) => {
      const path = new URL(
        typeof input === 'string' || input instanceof URL ? input : input.url,
      ).pathname;
      if (!path.endsWith('/proxy')) {
        const response = await fetchImpl(input, init);
        if (path.endsWith('/session/complete') && response.ok) {
          established = performance.now();
          handshake++;
        }
        return response;
      }
      const request = ++requests;
      const started = performance.now();
      const age =
        established === undefined
          ? 'unknown'
          : `${((started - established) / 1000).toFixed(3)} s`;
      inFlight++;
      peak = Math.max(peak, inFlight);
      const context = `handshake ${handshake}, age ${age}, ${
        inFlight - 1
      } other HTTP requests in flight`;
      record(`#${request} sent: ${context}.`);
      try {
        const response = await fetchImpl(input, init).finally(() => {
          inFlight--;
        });
        const line = `#${request} HTTP ${response.status} after ${(
          (performance.now() - started) /
          1000
        ).toFixed(3)} s`;
        record(line);
        if (!response.ok) {
          // Reserve first place at response arrival, before reading any diagnostic body.
          const isFirst = firstFailure === undefined;
          if (isFirst) firstFailure = `${line}; ${context}`;
          const reason = await readProxyReason(response);
          record(`#${request} proxy reason: ${reason}.`);
          if (isFirst) firstFailure = `${line}: ${reason}; ${context}`;
        }
        return response;
      } catch (error) {
        const line = `#${request} ${describeChannelFailure(error)} after ${(
          (performance.now() - started) /
          1000
        ).toFixed(3)} s`;
        firstFailure ??= `${line}; ${context}`;
        record(line);
        throw error;
      }
    };
  return {
    wrap,
    summary: () =>
      requests === 0
        ? 'HTTP request tracing unavailable for this verifier.'
        : [
            `Proxy requests: ${requests}; peak overlapping HTTP requests: ${peak}.`,
            ...(firstFailure ? [`First HTTP failure: ${firstFailure}.`] : []),
            'Recent HTTP events (client order; server arrival order is unknown):',
            ...history,
          ].join('\n'),
  };
};

type VeriteeAttestedProverProps = {
  networkId: string;
  proofServerApiUrl: string;
  trustRoots: VeriteeTrustRoots;
  /** Reads the attestation ledger's indexer URL at the start of each run. */
  getLedgerIndexerUrl: () => Promise<string>;
  verifier: VeriteeVerifier;
};

/**
 * {@link createVeriteeAttestedProver} with a deployment override that replaces
 * the baked deployment and skips its proof-server URL match. No public entry
 * re-exports it; only tests driving the verifier library's mock fixtures pass
 * the override.
 *
 * @internal
 */
export const createVeriteeAttestedProverWith = (
  {
    networkId,
    proofServerApiUrl,
    trustRoots,
    getLedgerIndexerUrl,
    verifier,
  }: VeriteeAttestedProverProps,
  testSeam?: {
    config?: Omit<VerifierConfig, 'amdRootCertificates' | 'indexerUrl'>;
  },
): AttestedProverProvider => {
  // The persisted mode may predate a per-network deployment change; its URL
  // must still name the proof server this network's baked config attests.
  const baked = VERITEE_ATTESTATION_CONFIGS[networkId];
  const deployment =
    testSeam?.config ??
    (baked?.proofServerApiUrl === proofServerApiUrl ? baked : undefined);
  if (!deployment) {
    throw new Error(
      `No baked Veritee attestation config on ${networkId} for proof server "${proofServerApiUrl}"`,
    );
  }
  if (
    !trustRoots?.amdRootCertificates?.length ||
    trustRoots.amdRootCertificates.some(root => root.trim().length === 0)
  ) {
    throw new AttestationError(
      'veritee',
      'policy',
      'Veritee requires explicit AMD trust roots',
    );
  }
  // Snapshot the supplied roots; later caller mutation cannot widen trust.
  const amdRootCertificates = [...trustRoots.amdRootCertificates];
  return {
    id: 'veritee',
    operations: ['prove'],
    phases: VERITEE_ATTESTATION_PHASES,
    establishAttestedSession: async (onEvent, signal) => {
      signal?.throwIfAborted();
      const config: VerifierConfig = {
        ...deployment,
        amdRootCertificates,
        indexerUrl: await getLedgerIndexerUrl(),
      };
      // A fresh verifier per run: re-verification is per-proof,
      // never the library's session-TTL cadence.
      const httpDiagnostics = createChannelDiagnostics();
      const operationVerifier = verifier.createVerifier(
        config,
        signal,
        httpDiagnostics.wrap,
      );
      let currentPhase: VeriteeAttestationPhaseId = 'obtain-evidence';
      try {
        const session = await operationVerifier.establishVerifiedSession(
          event => {
            if (event.status === 'started') signal?.throwIfAborted();
            if (event.status === 'started' && event.phase !== 'prove')
              currentPhase = PHASE_MAP[event.phase];
            const mapped = mapPhaseEvent(event);
            if (mapped) onEvent(mapped);
          },
        );
        return createTunneledSession(session, onEvent, httpDiagnostics);
      } catch (error) {
        throw toVeriteeAttestationError(error, currentPhase, verifier);
      }
    },
  };
};

/**
 * The real Veritee attestation driver: runs the verifier library's full
 * pipeline — evidence from `GET /enclave-key`, expected values from the
 * on-chain registration via the indexer, the nine local checks against
 * explicitly supplied AMD roots, Warden verification, and the AKX
 * attested-channel handshake — then hands back a session that tunnels
 * through that channel. Trust-root sourcing is separate from this adapter.
 * Only the deployment baked for `networkId` is accepted, and only
 * when `proofServerApiUrl` names its proof server.
 */
export const createVeriteeAttestedProver = (
  props: VeriteeAttestedProverProps,
): AttestedProverProvider => createVeriteeAttestedProverWith(props);
