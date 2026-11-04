import { ArtefactIntegrityError } from '@lace-contract/passport';

import { accManifest } from './manifest';
import { sha256Hex } from './sha256';

import type { AccCircuitManifestEntry } from './manifest';

/**
 * Fetches the raw bytes at a URL. Injected so the platform decides the
 * transport: fetch in the browser, fs or http in node, fixtures in tests.
 */
export type FetchBytes = (url: string) => Promise<Uint8Array>;

/**
 * Thrown when circuit assets are requested for a circuit the manifest
 * does not pin, so a typo or a stale caller fails before any download.
 */
export class UnknownCircuitError extends Error {
  public readonly code = 'unknown-circuit' as const;

  public constructor(circuit: string) {
    super(`Unknown Account Custody Contract circuit: ${circuit}`);
    this.name = 'UnknownCircuitError';
  }
}

/** Integrity pins keyed by circuit name: a bundle's manifest circuits or a called contract's pins. */
type CircuitPins = Readonly<Record<string, AccCircuitManifestEntry>>;

export type LoadCircuitAssetsProps = {
  /** Root URL of the hosted artefact bundle (holds zkir/ and keys/). */
  artefactUrl: string;
  /** Proving circuit whose assets to download, which the pins must list. */
  circuit: string;
  /** Transport used to download each asset. */
  fetchBytes: FetchBytes;
  /** Integrity pins to verify against; defaults to the vendored manifest's. */
  pins?: CircuitPins;
};

/** The downloadable ZK assets of one proving circuit, integrity-verified. */
export type AccCircuitAssets = {
  zkir: Uint8Array;
  proverKey: Uint8Array;
  verifierKey: Uint8Array;
};

const fetchVerified = async (
  url: string,
  expectedSha256: string,
  fetchBytes: FetchBytes,
): Promise<Uint8Array> => {
  const bytes = await fetchBytes(url);
  const actualSha256 = await sha256Hex(bytes);
  if (actualSha256 !== expectedSha256) {
    throw new ArtefactIntegrityError(
      `sha256 mismatch for ${url}: expected ${expectedSha256}, got ${actualSha256}`,
    );
  }
  return bytes;
};

export type LoadVerifierKeyProps = {
  /** Root URL of the hosted artefact bundle (holds zkir/ and keys/). */
  artefactUrl: string;
  /** Impure circuit whose verifier key to download. */
  circuit: string;
  /** Transport used to download the key. */
  fetchBytes: FetchBytes;
  /** Expected sha256 hex digest of the key bytes. */
  expectedSha256: string;
};

/**
 * Downloads the verifier key of one Account Custody Contract impure
 * circuit from the hosted artefact bundle, verified against the given
 * sha256 pin. Deployment needs the verifier key of every impure circuit
 * to assemble the initial contract state, while proving assets exist
 * only for the circuits this module submits proofs for.
 * Throws {@link ArtefactIntegrityError} on a digest mismatch.
 */
export const loadVerifierKey = async ({
  artefactUrl,
  circuit,
  fetchBytes,
  expectedSha256,
}: LoadVerifierKeyProps): Promise<Uint8Array> => {
  const base = artefactUrl.endsWith('/')
    ? artefactUrl.slice(0, -1)
    : artefactUrl;
  return fetchVerified(
    `${base}/keys/${circuit}.verifier`,
    expectedSha256,
    fetchBytes,
  );
};

/**
 * Downloads the circuit IR and the prover and verifier keys of one
 * proving circuit from the hosted artefact bundle at `artefactUrl`,
 * verifying every byte stream against the sha256 pins of its entry: an
 * account bundle's artefacts against its manifest, a called contract's
 * against its own pins. Throws {@link ArtefactIntegrityError} on any
 * digest mismatch and {@link UnknownCircuitError} for a circuit the pins
 * do not list.
 */
export const loadCircuitAssets = async ({
  artefactUrl,
  circuit,
  fetchBytes,
  pins = accManifest.circuits,
}: LoadCircuitAssetsProps): Promise<AccCircuitAssets> => {
  const entry = pins[circuit];
  if (!entry) throw new UnknownCircuitError(circuit);

  const base = artefactUrl.endsWith('/')
    ? artefactUrl.slice(0, -1)
    : artefactUrl;
  const [zkir, proverKey, verifierKey] = await Promise.all([
    fetchVerified(
      `${base}/zkir/${entry.name}.bzkir`,
      entry.zkirSha256,
      fetchBytes,
    ),
    fetchVerified(
      `${base}/${entry.keyLocation}.prover`,
      entry.proverKeySha256,
      fetchBytes,
    ),
    fetchVerified(
      `${base}/${entry.keyLocation}.verifier`,
      entry.verifierKeySha256,
      fetchBytes,
    ),
  ]);
  return { zkir, proverKey, verifierKey };
};
