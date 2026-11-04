import {
  loadCircuitAssets,
  loadVerifierKey,
  UnknownCircuitError,
} from '../acc/artefact-loader';

import { createManifestKeyMaterialResolver } from './http-prover';
import { applyNetworkId } from './network-id';

import type { FetchBytes } from '../acc/artefact-loader';
import type { AccCircuitAssets } from '../acc/artefact-loader';
import type { AccProviders, RandomBytes } from '../acc/deploy';
import type {
  AccountBundle,
  CalledContract,
  CalleeModule,
  FeeSponsor,
  PassportNetworkConfig,
  PassportProver,
} from '@lace-contract/passport';

/**
 * A flow stage a provider call makes observable: 'proving' when the proof
 * provider starts proving a transaction, 'sponsoring' when the wallet
 * provider hands it to the fee sponsor for balancing.
 */
export type MidnightProviderStage = 'proving' | 'sponsoring';

/** A ledger transaction as the providers pass it around: opaque bytes. */
type SerializableTx = { serialize: () => Uint8Array };

/**
 * The slice of a ledger unproven transaction the proof provider drives:
 * proving delegates to the ledger object itself, which calls back into
 * the given circuit-level proving provider.
 */
type ProvableTx = {
  prove: (
    provingProvider: unknown,
    costModel: unknown,
  ) => Promise<SerializableTx>;
};

/** A finalized ledger transaction, as the submission seam consumes it. */
type FinalizedTx = SerializableTx & { identifiers: () => string[] };

/**
 * The ledger era every provider seam serves. The framework reads it before
 * an operation starts and refuses a provider set that cannot carry a
 * transaction end to end, so a mismatch fails before any proof is paid for.
 */
const SERVED_ERAS = ['v9'] as const;

/** A transaction tagged with the ledger era it belongs to, as the seams pass it. */
type V9Tx<T> = { readonly version: 'v9'; readonly tx: T };

const v9 = <T>(tx: T): V9Tx<T> => ({ version: 'v9', tx });

/**
 * The submission surface of the wallet-sdk node client. Structural, so
 * tests inject a mock and the default lazily builds the real client.
 */
export type SubmissionService = {
  submitTransaction: (
    tx: { serialize: () => Uint8Array },
    waitForStatus?: 'Finalized' | 'InBlock' | 'Submitted',
  ) => Promise<unknown>;
  close: () => Promise<void>;
};

const ZSWAP_SEED_LENGTH = 32;

const defaultRandomBytes: RandomBytes = length =>
  crypto.getRandomValues(new Uint8Array(length));

const defaultFetchBytes: FetchBytes = async url => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Artefact download failed: url="${url}", status="${response.status} ${response.statusText}"`,
    );
  }
  return new Uint8Array(await response.arrayBuffer());
};

export type CreateMidnightProvidersProps = {
  /** Endpoints of the Midnight network the account lives on, with its called contracts. */
  network: PassportNetworkConfig;
  /** Prover the proof provider adapts; resolves its own key material. */
  prover: PassportProver;
  /** Fee sponsor the wallet provider delegates balancing to. */
  sponsor: FeeSponsor;
  /**
   * The bundle of the account the providers serve, whose pins and
   * artefact URL the ZK assets are downloaded by; defaults to the
   * vendored one, loaded only then, so the providers reach no generated
   * contract code until a flow runs.
   */
  bundle?: AccountBundle;
  /**
   * Every registered bundle, the default first, which the key material
   * lookup joins across by verifier key hash; defaults to `bundle` alone.
   */
  bundles?: readonly AccountBundle[];
  /**
   * The contracts the host registered for the bundles' circuits to call,
   * which the module provider executes and the key material lookup
   * proves into; none by default.
   */
  calledContracts?: readonly CalledContract[];
  /** Artefact download transport; defaults to the global fetch. */
  fetchBytes?: FetchBytes;
  /** Called when a provider call enters an observable flow stage. */
  onStage?: (stage: MidnightProviderStage) => void;
  /** Randomness for the ephemeral Zswap keys; defaults to Web Crypto. */
  randomBytes?: RandomBytes;
  /** Public data provider factory; defaults to midnight-js' indexer provider. */
  createPublicDataProvider?: () => Promise<unknown>;
  /** Submission service factory; defaults to the wallet-sdk node client. */
  createSubmissionService?: () => Promise<SubmissionService>;
};

/**
 * In-memory {@link AccProviders}.privateStateProvider. The account private
 * state only needs to outlive one deploy-and-activate flow, so nothing is
 * written to disk; contract-address scoping is a no-op because each flow
 * gets its own provider instance.
 */
const createInMemoryPrivateStateProvider = () => {
  const privateStates = new Map<string, unknown>();
  const signingKeys = new Map<string, unknown>();

  return {
    setContractAddress: (_address: string): void => undefined,
    set: async (privateStateId: string, state: unknown): Promise<void> => {
      privateStates.set(privateStateId, state);
    },
    get: async (privateStateId: string): Promise<unknown> =>
      privateStates.get(privateStateId) ?? null,
    remove: async (privateStateId: string): Promise<void> => {
      privateStates.delete(privateStateId);
    },
    clear: async (): Promise<void> => {
      privateStates.clear();
    },
    setSigningKey: async (address: string, key: unknown): Promise<void> => {
      signingKeys.set(address, key);
    },
    getSigningKey: async (address: string): Promise<unknown> =>
      signingKeys.get(address) ?? null,
    removeSigningKey: async (address: string): Promise<void> => {
      signingKeys.delete(address);
    },
    clearSigningKeys: async (): Promise<void> => {
      signingKeys.clear();
    },
  };
};

/**
 * Assembles the midnight-js providers {@link deployAccount} runs through,
 * swapping the platform seams in where the stock providers would expect a
 * full wallet:
 *
 * - zkConfigProvider downloads ZK assets through {@link loadCircuitAssets}
 *   from the bundle's artefact URL, the network's when it has none, so
 *   every byte is verified against the bundle's sha256 pins. A verifier
 *   key asked for alone is downloaded alone, so deploying an account
 *   fetches no prover key it does not prove with. A circuit this module
 *   never proves, such as a secp256k1 grant withdrawal, has no manifest
 *   entry: its verifier key asked for alone is verified against the
 *   bundle's own fingerprint, and it is skipped when verifier keys are
 *   listed.
 * - proofProvider adapts the {@link PassportProver} to the ledger's
 *   circuit-level proving interface, looking key material up across every
 *   registered bundle and the network's called contracts by verifier key
 *   hash, see {@link createManifestKeyMaterialResolver}.
 * - contractModuleProvider resolves the address a cross-contract call
 *   names to the generated module of the called contract registered for
 *   the network under it, and to nothing for any other address; the
 *   runtime checks the module against the chain itself.
 * - walletProvider delegates balancing to the {@link FeeSponsor}; the user
 *   holds no tokens, so the sponsor covers every fee. Its Zswap keys are
 *   ephemeral, generated per flow: the transactions move no coins, the
 *   keys only satisfy transaction construction and are discarded with the
 *   providers.
 * - midnightProvider submits each finalized transaction over the node RPC
 *   relay, opening and closing a connection per submission.
 *
 * `onStage` reports the proving and sponsoring stages as they start, so
 * the caller can surface flow progress that otherwise happens inside
 * midnight-js calls.
 */
export const createMidnightProviders = async ({
  network,
  prover,
  sponsor,
  bundle: givenBundle,
  bundles: givenBundles,
  calledContracts = [],
  fetchBytes = defaultFetchBytes,
  onStage,
  randomBytes = defaultRandomBytes,
  createPublicDataProvider,
  createSubmissionService,
}: CreateMidnightProvidersProps): Promise<AccProviders> => {
  await applyNetworkId(network.networkId);
  const ledger = await import('@midnightntwrk/ledger-v9');
  const bundle = givenBundle ?? (await import('../acc/bundle')).accountBundle;
  const bundles = givenBundles ?? [bundle];

  const zswapKeys = ledger.ZswapSecretKeys.fromSeed(
    randomBytes(ZSWAP_SEED_LENGTH),
  );
  const coinPublicKey = zswapKeys.coinPublicKey;
  const encryptionPublicKey = zswapKeys.encryptionPublicKey;
  zswapKeys.clear();

  const pins = bundle.manifest.circuits;
  const artefactUrl = bundle.artefactUrl ?? network.artefactUrl;
  const assetCache = new Map<string, Promise<AccCircuitAssets>>();
  const circuitAssets = async (circuit: string): Promise<AccCircuitAssets> => {
    let assets = assetCache.get(circuit);
    if (!assets) {
      assets = loadCircuitAssets({ artefactUrl, circuit, fetchBytes, pins });
      assetCache.set(circuit, assets);
    }
    return assets;
  };
  const isPinnedCircuit = (circuitId: string): boolean => circuitId in pins;

  const verifierKeyCache = new Map<string, Promise<Uint8Array>>();
  const verifierKeyPin = (circuitId: string): string => {
    const expectedSha256 =
      pins[circuitId]?.verifierKeySha256 ?? bundle.verifierKeys[circuitId];
    if (!expectedSha256) throw new UnknownCircuitError(circuitId);
    return expectedSha256;
  };
  const verifierKey = async (circuitId: string): Promise<Uint8Array> => {
    const cachedAssets = assetCache.get(circuitId);
    if (cachedAssets) return (await cachedAssets).verifierKey;
    let key = verifierKeyCache.get(circuitId);
    if (!key) {
      key = (async () =>
        loadVerifierKey({
          artefactUrl,
          circuit: circuitId,
          fetchBytes,
          expectedSha256: verifierKeyPin(circuitId),
        }))();
      verifierKeyCache.set(circuitId, key);
    }
    return key;
  };

  const zkConfigProvider = {
    getZKIR: async (circuitId: string) => (await circuitAssets(circuitId)).zkir,
    getProverKey: async (circuitId: string) =>
      (await circuitAssets(circuitId)).proverKey,
    getVerifierKey: async (circuitId: string) => verifierKey(circuitId),
    getVerifierKeys: async (circuitIds: string[]) =>
      Promise.all(
        circuitIds
          .filter(circuitId => isPinnedCircuit(circuitId))
          .map(
            async circuitId =>
              [circuitId, await verifierKey(circuitId)] as const,
          ),
      ),
    get: async (circuitId: string) => ({
      circuitId,
      ...(await circuitAssets(circuitId)),
    }),
  };

  const contractModuleProvider = {
    resolve: (
      calleeAddress: string,
    ): (() => Promise<CalleeModule>) | undefined =>
      calledContracts.find(
        contract =>
          contract.address.toLowerCase() === calleeAddress.toLowerCase(),
      )?.module,
  };

  const resolveKeyMaterial = createManifestKeyMaterialResolver({
    artefactUrl: network.artefactUrl,
    fetchBytes,
    bundles,
    calledContracts,
  });
  const provingProvider = {
    prove: async (
      preimage: Uint8Array,
      keyLocation: string,
      overwriteBindingInput?: bigint,
    ) => prover.prove(preimage, keyLocation, overwriteBindingInput),
    check: async (preimage: Uint8Array, keyLocation: string) =>
      ledger.parseCheckResult(await prover.check(preimage, keyLocation)),
    lookupKey: async (keyLocation: string) => resolveKeyMaterial(keyLocation),
  };
  const proofProvider = {
    supportedEras: SERVED_ERAS,
    proveTx: async ({ tx }: V9Tx<ProvableTx>) => {
      onStage?.('proving');
      return v9(
        await tx.prove(provingProvider, ledger.CostModel.initialCostModel()),
      );
    },
  };

  const walletProvider = {
    supportedEras: SERVED_ERAS,
    getCoinPublicKey: () => coinPublicKey,
    getEncryptionPublicKey: () => encryptionPublicKey,
    balanceTx: async ({ tx }: V9Tx<SerializableTx>) => {
      onStage?.('sponsoring');
      const balanced = await sponsor.balanceAndSign(tx.serialize());
      return v9(
        ledger.Transaction.deserialize(
          'signature',
          'proof',
          'binding',
          balanced,
        ),
      );
    },
  };

  const defaultSubmissionService = async (): Promise<SubmissionService> => {
    const { createNodeRelaySubmissionService } = await import('./node-relay');
    return createNodeRelaySubmissionService(network.nodeUrl);
  };
  const midnightProvider = {
    supportedEras: SERVED_ERAS,
    submitTx: async ({ tx }: V9Tx<FinalizedTx>) => {
      const service = await (
        createSubmissionService ?? defaultSubmissionService
      )();
      try {
        await service.submitTransaction(tx, 'InBlock');
        return tx.identifiers().at(-1);
      } finally {
        await service.close();
      }
    },
  };

  const defaultPublicDataProvider = async (): Promise<unknown> => {
    const { indexerPublicDataProvider } = await import(
      '@midnight-ntwrk/midnight-js-indexer-public-data-provider'
    );
    return indexerPublicDataProvider({
      queryURL: network.indexerUrl,
      subscriptionURL: network.indexerWsUrl,
    });
  };
  const publicDataProvider = await (
    createPublicDataProvider ?? defaultPublicDataProvider
  )();

  return {
    publicDataProvider,
    zkConfigProvider,
    proofProvider,
    privateStateProvider: createInMemoryPrivateStateProvider(),
    walletProvider,
    midnightProvider,
    contractModuleProvider,
  };
};
