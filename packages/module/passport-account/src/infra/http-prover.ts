import { ArtefactIntegrityError } from '@lace-contract/passport';

import { loadCircuitAssets } from '../acc/artefact-loader';
import { ACCOUNT_BUNDLE_ID, accManifest } from '../acc/manifest';

import type { FetchBytes } from '../acc/artefact-loader';
import type { AccCircuitManifestEntry } from '../acc/manifest';
import type { PassportRegistry } from '../acc/registry';
import type {
  AccountBundle,
  CalledContract,
  PassportProver,
} from '@lace-contract/passport';
import type { ProvingKeyMaterial } from '@midnight-ntwrk/midnight-js-protocol/ledger';

/**
 * What the resolver needs of an account bundle: its id, to name it, its
 * manifest of pins and where its artefacts are served. Every registered
 * bundle satisfies it; the default is the vendored build's manifest alone,
 * so the prover the SDK entry exports carries no generated contract code.
 */
export type KeyMaterialBundle = Pick<
  AccountBundle,
  'artefactUrl' | 'id' | 'manifest'
>;

const vendoredBundle: KeyMaterialBundle = {
  id: ACCOUNT_BUNDLE_ID,
  manifest: accManifest,
};

/**
 * Thrown when the proof server rejects a request or does not answer before
 * the timeout. `status` carries the HTTP status code of the final response;
 * it is undefined when the request timed out before any response arrived.
 */
export class ProofServerError extends Error {
  public readonly code = 'proof-server' as const;

  public constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'ProofServerError';
  }
}

/**
 * A canonical contract key location taken apart: the contract address as
 * the location spells it, the circuit name, and the sha256 of the verifier
 * key the chain expects for it, absent from a location that pins none.
 */
type CanonicalLocation = {
  address: string;
  circuit: string;
  vkPin: string | undefined;
};

/**
 * Thrown when the ledger asks for the circuit of a contract the client holds
 * no key material for: a called contract that is not registered, or a
 * circuit no registered bundle or called contract pins. Without it the
 * proof server would receive the request with no circuit IR and answer a
 * bare 400. `registered` names what the prover does resolve, so the
 * message says which registration is missing.
 */
export class UnresolvedContractCircuitError extends Error {
  public readonly code = 'unresolved-contract-circuit' as const;
  public readonly contractAddress: string;
  public readonly circuit: string;
  public readonly verifierKeyHash: string | undefined;

  public constructor(
    { address, circuit, vkPin }: CanonicalLocation,
    registered: string,
  ) {
    super(
      `No key material for circuit "${circuit}" of contract ${address}` +
        `${vkPin === undefined ? '' : ` (vk=${vkPin})`}` +
        `: the prover resolves ${registered}.`,
    );
    this.name = 'UnresolvedContractCircuitError';
    this.contractAddress = address;
    this.circuit = circuit;
    this.verifierKeyHash = vkPin;
  }
}

/**
 * Subset of the Fetch API the prover uses. Injected so the platform picks
 * the transport and node tests run without a network.
 */
export type ProverFetch = (
  url: string,
  init: {
    method: 'POST';
    headers: Record<string, string>;
    body: Uint8Array;
    signal: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  arrayBuffer: () => Promise<ArrayBuffer>;
}>;

/**
 * Resolves a key location to the client-held key material of its circuit.
 * Returns undefined for locations the client holds no material for (the
 * protocol builtins); the proof server supplies those keys itself.
 */
export type KeyMaterialResolver = (
  keyLocation: string,
) => Promise<ProvingKeyMaterial | undefined>;

export type CreateManifestKeyMaterialResolverProps = {
  /**
   * Root URL of the network's artefact bundle (holds zkir/ and keys/),
   * which a bundle without an artefact URL of its own downloads from.
   */
  artefactUrl: string;
  /** Transport used to download each asset. */
  fetchBytes: FetchBytes;
  /** The registered account bundles, the default first; defaults to the vendored one alone. */
  bundles?: readonly KeyMaterialBundle[];
  /** The registered called contracts; none by default. */
  calledContracts?: readonly CalledContract[];
};

/**
 * Canonical contract key location: `contract:<address>/<circuit>?vk=<hash>`.
 * The ledger stamps every contract call's proof preimage with this form;
 * the vk query pin is the sha256 of the verifier key the chain expects.
 */
const CANONICAL_KEY_LOCATION =
  /^contract:([0-9a-f]+)\/([^?]+)(?:\?vk=([0-9a-f]+))?$/;

const parseCanonical = (keyLocation: string): CanonicalLocation | undefined => {
  const match = CANONICAL_KEY_LOCATION.exec(keyLocation);
  return match
    ? { address: match[1], circuit: match[2], vkPin: match[3] }
    : undefined;
};

/** Where one circuit's assets come from: its pins and the artefact root that serves them. */
type KeyMaterialSource = {
  pins: Readonly<Record<string, AccCircuitManifestEntry>>;
  artefactUrl: string;
};

const quoted = (names: readonly string[]): string =>
  names.map(name => `'${name}'`).join(', ');

/** What the resolver holds key material for, as an unresolved location reports it. */
const describeRegistered = (
  bundles: readonly KeyMaterialBundle[],
  calledContracts: readonly CalledContract[],
): string => {
  const callees =
    calledContracts.length === 0
      ? 'no called contract'
      : `the called contracts ${calledContracts
          .map(contract => `'${contract.label}' (${contract.address})`)
          .join(', ')}`;
  return `the circuits of the account bundles ${quoted(
    bundles.map(bundle => bundle.id),
  )} and of ${callees}`;
};

/**
 * The default {@link KeyMaterialResolver}: maps a key location onto the
 * registered account bundles and called contracts and downloads that
 * circuit's prover key, verifier key, and IR through
 * {@link loadCircuitAssets} from the artefact URL of the registration that
 * resolved it, so every byte is verified against that registration's own
 * sha256 pins.
 *
 * A canonical contract location whose address is a registered called
 * contract resolves through the contract's pins by circuit name, and its
 * embedded vk pin must match. Any other address is an account: with a vk
 * pin, the circuit resolves to the first registered bundle whose manifest
 * pins that verifier key hash under the circuit's name, so an account of
 * any registered build proves with its own artefacts; without one, to the
 * first bundle that lists the circuit. A vk pin no bundle listing the
 * circuit pins is a drifted artefact and throws
 * {@link ArtefactIntegrityError} before the proof server is asked. A
 * circuit nothing registered pins throws
 * {@link UnresolvedContractCircuitError}. A bare location resolves by name
 * in the default bundle, the first registered, and any other unlisted
 * location to undefined (a protocol builtin the proof server supplies
 * itself).
 */
export const createManifestKeyMaterialResolver = ({
  artefactUrl,
  fetchBytes,
  bundles = [vendoredBundle],
  calledContracts = [],
}: CreateManifestKeyMaterialResolverProps): KeyMaterialResolver => {
  const registered = describeRegistered(bundles, calledContracts);
  const [defaultBundle] = bundles;

  const bundleSource = (bundle: KeyMaterialBundle): KeyMaterialSource => ({
    pins: bundle.manifest.circuits,
    artefactUrl: bundle.artefactUrl ?? artefactUrl,
  });

  const calleeSource = (
    callee: CalledContract,
    location: CanonicalLocation,
  ): KeyMaterialSource => {
    const { circuit, vkPin } = location;
    const entry = callee.pins[circuit];
    if (!entry) throw new UnresolvedContractCircuitError(location, registered);
    if (vkPin !== undefined && vkPin !== entry.verifierKeySha256) {
      throw new ArtefactIntegrityError(
        `verifier key pin mismatch for ${circuit}: the chain expects ${vkPin}, called contract '${callee.label}' pins ${entry.verifierKeySha256}`,
      );
    }
    return { pins: callee.pins, artefactUrl: callee.artefactUrl };
  };

  const accountSource = (location: CanonicalLocation): KeyMaterialSource => {
    const { circuit, vkPin } = location;
    const listing = bundles.filter(bundle => bundle.manifest.circuits[circuit]);
    if (listing.length === 0) {
      throw new UnresolvedContractCircuitError(location, registered);
    }
    if (vkPin === undefined) return bundleSource(listing[0]);
    const pinned = listing.find(
      bundle => bundle.manifest.circuits[circuit].verifierKeySha256 === vkPin,
    );
    if (!pinned) {
      throw new ArtefactIntegrityError(
        `verifier key pin mismatch for ${circuit}: the chain expects ${vkPin}, the registered account bundles pin ${listing
          .map(
            bundle =>
              `${bundle.manifest.circuits[circuit].verifierKeySha256} ('${bundle.id}')`,
          )
          .join(', ')}`,
      );
    }
    return bundleSource(pinned);
  };

  const material = async (
    source: KeyMaterialSource,
    circuit: string,
  ): Promise<ProvingKeyMaterial> => {
    const assets = await loadCircuitAssets({
      artefactUrl: source.artefactUrl,
      circuit,
      fetchBytes,
      pins: source.pins,
    });
    return {
      proverKey: assets.proverKey,
      verifierKey: assets.verifierKey,
      ir: assets.zkir,
    };
  };

  return async keyLocation => {
    const location = parseCanonical(keyLocation);
    if (!location) {
      const entry = Object.values(defaultBundle.manifest.circuits).find(
        candidate =>
          candidate.keyLocation === keyLocation ||
          candidate.name === keyLocation,
      );
      return entry
        ? material(bundleSource(defaultBundle), entry.name)
        : undefined;
    }
    const callee = calledContracts.find(
      contract =>
        contract.address.toLowerCase() === location.address.toLowerCase(),
    );
    return material(
      callee ? calleeSource(callee, location) : accountSource(location),
      location.circuit,
    );
  };
};

/** Proving a circuit call can legitimately take minutes on large circuits. */
const TIMEOUT_MS = 300_000;

/** A 500/503 is transient (proof server busy or restarting); one retry. */
const RETRYABLE_STATUSES = new Set([500, 503]);

const defaultFetchBytes: FetchBytes = async url => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Artefact download failed: url="${url}", status="${response.status} ${response.statusText}"`,
    );
  }
  return new Uint8Array(await response.arrayBuffer());
};

/** Where `createHttpProver` gets key material, and the transports it uses. */
export type HttpProverOptions = {
  /**
   * Resolves key locations to key material. Defaults to
   * {@link createManifestKeyMaterialResolver} over `artefactUrl` and
   * `registry`.
   */
  resolveKeyMaterial?: KeyMaterialResolver;
  /**
   * Artefact bundle root of the network, which the default resolver
   * downloads the assets of a bundle without an artefact URL of its own
   * from. Alone, it resolves the default bundle's circuits.
   */
  artefactUrl?: string;
  /**
   * What the host registers, the same value it gives the module: the
   * default resolver proves for the default bundle, the registry's
   * bundles beside it and its called contracts. Nothing beside the
   * default by default.
   */
  registry?: PassportRegistry;
  /** Artefact download transport for the default resolver; defaults to fetch. */
  fetchBytes?: FetchBytes;
  /** Proof server transport; defaults to the global fetch. */
  fetchHttp?: ProverFetch;
};

/**
 * A {@link PassportProver} over the Midnight proof server's HTTP API,
 * wire-compatible with the stock midnight-js client: the key location is
 * resolved client-side to the circuit's key material (prover key and IR),
 * the serialized preimage plus that material is framed with the protocol
 * payload codecs, and the framed bytes are POSTed to /prove and /check as
 * application/octet-stream with nothing else. A location the resolver
 * does not know travels without key material; the proof server supplies
 * the protocol builtin keys itself. The protocol codec loads lazily so
 * platforms only pay for it when a proof is actually requested.
 *
 * @param baseUrl - The proof server's URL; requests go to `<baseUrl>/prove`
 *   and `<baseUrl>/check`.
 * @param options - Where key material comes from, and the transports. It
 *   throws without `resolveKeyMaterial` or an `artefactUrl`.
 */
export const createHttpProver = (
  baseUrl: string,
  options: HttpProverOptions = {},
): PassportProver => {
  const fetchHttp =
    options.fetchHttp ?? (globalThis.fetch as unknown as ProverFetch);
  const resolveKeyMaterial =
    options.resolveKeyMaterial ??
    (options.artefactUrl === undefined
      ? undefined
      : createManifestKeyMaterialResolver({
          artefactUrl: options.artefactUrl,
          fetchBytes: options.fetchBytes ?? defaultFetchBytes,
          bundles: [vendoredBundle, ...(options.registry?.bundles ?? [])],
          calledContracts: options.registry?.calledContracts ?? [],
        }));
  if (!resolveKeyMaterial) {
    throw new Error(
      'createHttpProver needs resolveKeyMaterial or an artefactUrl for the default manifest resolver.',
    );
  }

  const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  const loadPayloadCodec = async () =>
    import('@midnight-ntwrk/midnight-js-protocol/ledger');

  const request = async (url: string, payload: Uint8Array) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, TIMEOUT_MS);
    try {
      return await fetchHttp(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: payload,
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new ProofServerError(
          `Proof server request timed out after ${TIMEOUT_MS}ms: ${url}`,
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };

  const post = async (
    path: string,
    payload: Uint8Array,
  ): Promise<Uint8Array> => {
    const url = `${base}${path}`;
    for (let attempt = 0; ; attempt++) {
      const response = await request(url, payload);
      if (response.ok) return new Uint8Array(await response.arrayBuffer());
      if (attempt === 0 && RETRYABLE_STATUSES.has(response.status)) continue;
      throw new ProofServerError(
        `Proof server request failed: url="${url}", status="${response.status} ${response.statusText}"`,
        response.status,
      );
    }
  };

  return {
    prove: async (preimage, keyLocation, overwriteBindingInput) => {
      const [{ createProvingPayload }, keyMaterial] = await Promise.all([
        loadPayloadCodec(),
        resolveKeyMaterial(keyLocation),
      ]);
      return post(
        '/prove',
        createProvingPayload(preimage, overwriteBindingInput, keyMaterial),
      );
    },
    check: async (preimage, keyLocation) => {
      const [{ createCheckPayload }, keyMaterial] = await Promise.all([
        loadPayloadCodec(),
        resolveKeyMaterial(keyLocation),
      ]);
      return post('/check', createCheckPayload(preimage, keyMaterial?.ir));
    },
  };
};
