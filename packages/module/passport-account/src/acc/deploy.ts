import {
  AccountContractMissingError,
  AuthorityNotRetiredError,
  CreationArtefactMismatchError,
  MaintenanceAuthorityMismatchError,
} from '@lace-contract/passport';
import { ByteArray, HexBytes } from '@lace-lib/util';

import {
  assertSubmitted,
  submitTx,
  submitWithDustRetry,
} from '../infra/submit';

import { ACTIVATE_INITIAL_DEVICE_CIRCUIT } from './deployed-operations';
import { isSameAuthority } from './maintenance-authority';
import { ACCOUNT_BUNDLE_ID } from './manifest';
import { JubjubDevice } from './signer';
import {
  assertVerifierKeyHeader,
  verifierKeyInsert,
} from './verifier-key-insert';
import { planDeployWaves, planResumeWaves } from './wave-plan';

import type * as AccModule from './acc-module';
import type { PendingDeployment } from './pending-deployment';
import type { DeployWave, VerifierKeySizes } from './wave-plan';
import type { Sleep } from '../infra/submit';
import type {
  AccountBundle,
  MaintenanceVerifyingKey,
  PassportAuthoriser,
} from '@lace-contract/passport';
import type * as NetworkIdModule from '@midnight-ntwrk/midnight-js-network-id';
import type * as Ledger from '@midnightntwrk/ledger-v9';

export type { PendingDeployment } from './pending-deployment';

const SALT_LENGTH = 32;
const RECOVERY_WRAP_LENGTH = 64;
const PRIVATE_STATE_ID_LENGTH = 8;
/** Three days, the veto window published with the throwaway recovery. */
const VETO_WINDOW_SECONDS = 259_200n;
const DEPLOY_TX_TTL_MS = 60_000;
/** How long a landed wave may take to show in the indexer's state. */
const AUTHORITY_POLL_ATTEMPTS = 60;
const AUTHORITY_POLL_DELAY_MS = 2000;
/** How long a landed deploy may take to appear in the indexer at all. */
const INDEXED_POLL_ATTEMPTS = 30;

const defaultSleep: Sleep = async ms =>
  new Promise(resolve => {
    setTimeout(resolve, ms);
  });

/**
 * Source of cryptographic randomness: returns `length` fresh random bytes.
 * Injected so tests can fix the bytes; defaults to Web Crypto.
 */
export type RandomBytes = (length: number) => Uint8Array;

/**
 * The midnight-js providers the deployment runs through, assembled by the
 * caller and treated as opaque here: every member is only passed on to
 * midnight-js itself, except the two reads the waves make, narrowed where
 * they are used. `contractModuleProvider` is what a call resolves the
 * module of a called contract through.
 */
export type AccProviders = {
  publicDataProvider: unknown;
  zkConfigProvider: unknown;
  proofProvider: unknown;
  privateStateProvider: unknown;
  walletProvider: unknown;
  midnightProvider: unknown;
  contractModuleProvider: unknown;
};

/** The verifier key read the waves make through the zk config provider. */
type VerifierKeyProvider = {
  getVerifierKey: (circuitId: string) => Promise<Uint8Array>;
};

/**
 * The contract state as the public data provider hands it back: the
 * compact-runtime class, whose `data` the generated decoder reads and
 * whose serialisation bridges to the ledger class.
 */
type ProvidedContractState = {
  serialize: () => Uint8Array;
  data: Parameters<typeof AccModule.ledger>[0];
};

/** The state read the waves make through the public data provider. */
type ContractStateProvider = {
  queryContractState: (
    address: string,
  ) => Promise<ProvidedContractState | null | undefined>;
};

type LedgerModule = typeof Ledger;
type NetworkIdApi = typeof NetworkIdModule;

/** A wallet-held shielded coin, serialised so any provider can store it. */
type StoredCoin = {
  nonceHex: string;
  colorHex: string;
  value: string;
  mtIndex: string;
};

/** The qualified coin a stored description names, as a circuit takes it. */
type HeldCoin = {
  nonce: Uint8Array;
  color: Uint8Array;
  value: bigint;
  mt_index: bigint;
};

/** The coin a stored description names, as the contract's `held_coin` witness hands it to a spend. */
export const toHeldCoin = (stored: StoredCoin): HeldCoin => ({
  nonce: ByteArray.fromHex(HexBytes(stored.nonceHex)),
  color: ByteArray.fromHex(HexBytes(stored.colorHex)),
  value: BigInt(stored.value),
  mt_index: BigInt(stored.mtIndex),
});

/**
 * The wallet-local private state behind the contract's `held_coin`
 * witness: the captured coins, keyed by color. Coin descriptions live only
 * here and enter proofs as private inputs; they never reach public ledger
 * state. The account encryption secret is not part of it: the device
 * circuits consume no witnesses, and the shielded flows will open inbox
 * entries through the encryption key seam rather than by holding the
 * secret here.
 */
export type AccountPrivateState = {
  coins: Record<string, StoredCoin>;
};

/**
 * The contract's witness implementations over {@link AccountPrivateState}.
 * `held_coin` serves the exact qualified coin a shielded spend consumes;
 * a color the store has not captured cannot be spent by a conforming
 * client, so the witness refuses it.
 */
export const accountWitnesses: AccModule.Witnesses<AccountPrivateState> = {
  held_coin: (context, color) => {
    const key = HexBytes.fromByteArray(color);
    const stored = context.privateState.coins[key];
    if (!stored) {
      throw new Error(
        `held_coin witness: no coin for color ${key} in the local store`,
      );
    }
    return [context.privateState, toHeldCoin(stored)];
  },
};

/** The private state a handle starts from: no captured coins yet. */
export const initialAccountPrivateState = (): AccountPrivateState => ({
  coins: {},
});

/**
 * The private state a handle starts from when its call spends `coins`:
 * those coins alone, each keyed by its colour as the witness looks it up.
 */
export const heldCoinPrivateState = (
  coins: readonly StoredCoin[],
): AccountPrivateState => ({
  coins: Object.fromEntries(
    coins.map(coin => [coin.colorHex.toLowerCase(), coin]),
  ),
});

/**
 * The slice of the unproven-deploy pipeline result this flow reads: the
 * constructor's full contract state (bridged by serialisation between the
 * compact-runtime and ledger classes) and the freshly minted maintenance
 * authority key.
 */
type UnprovenAccountDeploy = {
  public: { initialContractState: { serialize: () => Uint8Array } };
  private: {
    signingKey: Ledger.SigningKey;
    initialPrivateState: AccountPrivateState;
  };
};

/**
 * The constructor arguments every build of the account takes, followed by
 * the ones its bundle declares: the boot commitment, `enc_key`, the
 * recovery public key, the recovery wrap and the veto window.
 */
type ConstructorArgs = [
  Uint8Array,
  Uint8Array,
  AccModule.JubjubPoint,
  Uint8Array,
  bigint,
  ...unknown[],
];

type CreateUnprovenAccountDeployTx = (
  providers: AccProviders,
  options: {
    compiledContract: unknown;
    initialPrivateState: AccountPrivateState;
    args: ConstructorArgs;
  },
) => Promise<UnprovenAccountDeploy>;

/** The found-contract handle surface the activation call goes through. */
type AccContractHandle = {
  callTx: Record<string, (...args: unknown[]) => Promise<unknown>>;
};

type FindDeployedAccountContract = (
  providers: AccProviders,
  options: {
    contractAddress: string;
    compiledContract: unknown;
    privateStateId: string;
    initialPrivateState: AccountPrivateState;
  },
) => Promise<AccContractHandle>;

export type DeployAccountProps = {
  /** Built for `bundle`, so its verifier keys download against that bundle's pins. */
  providers: AccProviders;
  /** The build to deploy: its compiled contract, roster, pins and constructor arguments. */
  bundle: AccountBundle;
  /**
   * The values of the bundle's declared constructor arguments as the
   * canonical strings the creation descriptor carries, in declaration
   * order, which the pending deployment records.
   */
  constructorArgs: readonly string[];
  /** The same arguments decoded as the constructor takes them, in the same order. */
  constructorValues: readonly unknown[];
  /** The initial device; its public key seeds the boot commitment. */
  authoriser: PassportAuthoriser;
  /** Raw 32-byte X25519 public key the constructor stores as `enc_key`. */
  encPublicKey: Uint8Array;
  /**
   * Whether the last wave retires the contract maintenance authority
   * rather than handing it to the account's devices. Required with no
   * default: the choice trades upgradability for custody and must be
   * made explicitly. See {@link deployAccount}.
   */
  lockAccount: boolean;
  /**
   * The maintenance authority the account's roster key derives, which
   * the last wave of an unlocked account installs.
   */
  handoverAuthority: MaintenanceVerifyingKey;
  /**
   * Called once the deploy has landed and before the next wave is
   * submitted, with what a retry needs to finish the deployment. The
   * caller persists it with the key entries it holds; the next wave waits
   * until it resolves.
   */
  onDeployed: (
    address: string,
    pending: Omit<PendingDeployment, 'keyEntries'>,
  ) => Promise<void>;
  /** Randomness for the boot salt and private-state id; defaults to Web Crypto. */
  randomBytes?: RandomBytes;
  /** Waits between chain polls; defaults to a real timer. */
  sleep?: Sleep;
  /** Resolves once the fee sponsor can balance; see {@link SponsorReady}. */
  sponsorReady?: SponsorReady;
};

export type ResumeAccountDeploymentProps = {
  /** Built for `bundle`, so its verifier keys download against that bundle's pins. */
  providers: AccProviders;
  /** The build the resume is asked under; it must be the one the deployment was started from. */
  bundle: AccountBundle;
  /** The initial device; its public key is what the activation presents. */
  authoriser: PassportAuthoriser;
  /** Hex address of the contract the interrupted deployment created. */
  address: string;
  pending: PendingDeployment;
  /** Randomness for the private-state id; defaults to Web Crypto. */
  randomBytes?: RandomBytes;
  /** Waits between chain polls; defaults to a real timer. */
  sleep?: Sleep;
  /** Resolves once the fee sponsor can balance; see {@link SponsorReady}. */
  sponsorReady?: SponsorReady;
};

export type DeployedAccount = {
  /** Hex address of the deployed Account Custody Contract. */
  address: string;
  /** Boot salt the activation must present alongside the device key. */
  salt: Uint8Array;
  /**
   * Whether the chain already holds the initial device entry. A fresh
   * deployment never does; a resumed one does when the interrupted
   * creation activated before it finished its record. The contract
   * refuses a second activation, so `activate` is not to be called then.
   */
  isActivated: boolean;
  /**
   * Submits `activate_initial_device_with_jubjub` with the authoriser's
   * public key and the deploy salt, installing the initial device entry.
   * Rejects when the transaction lands with a failing status, so a
   * circuit abort is never read as an activated account.
   */
  activate: () => Promise<unknown>;
};

/**
 * Resolves once the fee sponsor can balance without further setup. The
 * deploy and every maintenance wave expire {@link DEPLOY_TX_TTL_MS} after
 * they are built, and the sponsor balances them only after they are
 * built and proven, so each one awaits it first: a sponsor still syncing
 * its wallet would otherwise spend the expiry before it balances.
 */
type SponsorReady = () => Promise<void>;

const noSponsorSetup: SponsorReady = async () => undefined;

/** The expiry of a transaction built now, once the sponsor is ready. */
const transactionTtl = async (sponsorReady: SponsorReady): Promise<Date> => {
  await sponsorReady();
  return new Date(Date.now() + DEPLOY_TX_TTL_MS);
};

const defaultRandomBytes: RandomBytes = length =>
  crypto.getRandomValues(new Uint8Array(length));

const importChainModules = async () =>
  Promise.all([
    import('@midnight-ntwrk/midnight-js-contracts'),
    import('@midnightntwrk/ledger-v9'),
    import('@midnight-ntwrk/midnight-js-network-id'),
    import('@midnight-ntwrk/compact-js/effect/CompiledContract'),
  ]);

/**
 * The exports of a bundle's module a deployment uses, in the shapes the
 * generated account module gives them, which every build of the account
 * contract shares: the contract constructor, the pure circuit that
 * derives the boot commitment and the ledger decoder the boot flag is
 * read with.
 */
type DeployableModule = {
  Contract: typeof AccModule.Contract;
  ledger: typeof AccModule.ledger;
  pureCircuits: Pick<
    AccModule.PureCircuits,
    'derive_boot_commitment_with_jubjub'
  >;
};

const loadDeployableModule = async (
  bundle: AccountBundle,
): Promise<DeployableModule> =>
  (await bundle.module()) as unknown as DeployableModule;

/**
 * Names the verifier keys a bundle installs: the lowercase hex sha256
 * over each roster operation's name and the sha256 pin of its verifier
 * key, in installation order. A deployment records it once the deploy
 * lands, and a resume compares it before any wave, so an account never
 * holds verifier keys of two builds.
 */
const deployedVerifierKeysDigest = async (
  bundle: AccountBundle,
): Promise<string> => {
  const pins = bundle.operations.map(operation => {
    const pin = bundle.verifierKeys[operation];
    if (!pin) {
      throw new Error(
        `Account bundle '${bundle.id}' pins no verifier key for '${operation}'`,
      );
    }
    return `${operation}:${pin}`;
  });
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(pins.join('\n')) as BufferSource,
  );
  return HexBytes.fromByteArray(new Uint8Array(digest));
};

/**
 * The verifier key of each of `operations`, downloaded through the zk
 * config provider so each one is checked against its pin and its header,
 * and the sizes the wave plan is computed from. The plan follows the
 * real keys, so a roster or key-size change re-plans itself.
 */
export const loadVerifierKeys = async (
  providers: Pick<AccProviders, 'zkConfigProvider'>,
  operations: readonly string[],
): Promise<{ keys: Map<string, Uint8Array>; sizes: VerifierKeySizes }> => {
  const zkConfig = providers.zkConfigProvider as VerifierKeyProvider;
  const keys = new Map(
    await Promise.all(
      operations.map(async operation => {
        const key = await zkConfig.getVerifierKey(operation);
        assertVerifierKeyHeader(operation, key);
        return [operation, key] as const;
      }),
    ),
  );
  const sizes = new Map(
    [...keys].map(([operation, key]) => [operation, key.length]),
  );
  return { keys, sizes };
};

/**
 * Where the contract state is read from: the public data provider, the
 * ledger the state is decoded with and the contract address.
 */
type ChainStateProps = {
  providers: Pick<AccProviders, 'publicDataProvider'>;
  ledger: LedgerModule;
  address: string;
};

const queryContractState = async ({
  providers,
  address,
}: ChainStateProps): Promise<ProvidedContractState | null | undefined> =>
  (providers.publicDataProvider as ContractStateProvider).queryContractState(
    address,
  );

/** The contract state as the indexer serves it, which must exist. */
const readProvidedState = async (
  chain: ChainStateProps,
): Promise<ProvidedContractState> => {
  const state = await queryContractState(chain);
  if (!state) {
    throw new AccountContractMissingError(
      `No live Account Custody Contract found at ${chain.address}.`,
    );
  }
  return state;
};

/**
 * The contract state as it stands on chain, read as the ledger's class.
 * The public data provider hands back a compact-runtime state; the two
 * bridge by serialisation.
 */
const readContractState = async (
  chain: ChainStateProps,
): Promise<Ledger.ContractState> =>
  chain.ledger.ContractState.deserialize(
    (await readProvidedState(chain)).serialize(),
  );

/**
 * The contract maintenance authority as it stands on chain: its
 * committee, threshold and the counter the next update is built against.
 *
 * @throws {@link AccountContractMissingError} when the address holds no
 * live contract.
 */
export const readMaintenanceAuthority = async (
  chain: ChainStateProps,
): Promise<Ledger.ContractMaintenanceAuthority> =>
  (await readContractState(chain)).maintenanceAuthority;

/**
 * Blocks until the indexer serves the contract the deploy created. The
 * deploy is final once its submission settles, but the indexer can lag
 * the block it landed in, and the first wave reads the authority counter
 * from it.
 */
const awaitContractIndexed = async (
  chain: ChainStateProps,
  sleep: Sleep,
): Promise<void> => {
  for (let attempt = 0; attempt < INDEXED_POLL_ATTEMPTS; attempt++) {
    if (await queryContractState(chain)) return;
    await sleep(AUTHORITY_POLL_DELAY_MS);
  }
  throw new AccountContractMissingError(
    `The Account Custody Contract deployed at ${chain.address} never appeared in the indexer.`,
  );
};

/**
 * Blocks until the chain shows the counter a wave advanced the authority
 * to. The next update must be built against the advanced counter, and
 * the indexer can lag the block the wave landed in.
 */
const awaitAuthorityCounter = async (
  chain: ChainStateProps,
  expected: bigint,
  sleep: Sleep,
): Promise<void> => {
  for (let attempt = 0; attempt < AUTHORITY_POLL_ATTEMPTS; attempt++) {
    const { maintenanceAuthority } = await readContractState(chain);
    if (maintenanceAuthority.counter >= expected) return;
    await sleep(AUTHORITY_POLL_DELAY_MS);
  }
  throw new Error(
    `The maintenance authority counter of ${chain.address} never reached ${expected}`,
  );
};

/** What {@link submitMaintenanceUpdate} submits and through which providers. */
type SubmitMaintenanceUpdateProps = ChainStateProps & {
  providers: AccProviders;
  networkId: NetworkIdApi;
  /** The update as it was signed, built against the on-chain counter. */
  update: Ledger.MaintenanceUpdate;
  /** The committee's one signature over the update's data. */
  signature: Ledger.Signature;
  /** Names the update in a failure. */
  label: string;
  /** Waits between chain polls; defaults to a real timer. */
  sleep?: Sleep;
  /** Resolves once the fee sponsor can balance; see {@link SponsorReady}. */
  sponsorReady?: SponsorReady;
};

/**
 * Submits one maintenance update carrying the signature of the sole
 * committee member, at index 0, and blocks until the chain shows the
 * counter its application advanced the authority to, so the next update
 * or call is built against the advanced state.
 *
 * @throws when the update lands with a failing status, or when the
 * counter never advances within the polling window.
 */
export const submitMaintenanceUpdate = async ({
  providers,
  ledger,
  address,
  networkId,
  update,
  signature,
  label,
  sleep = defaultSleep,
  sponsorReady = noSponsorSetup,
}: SubmitMaintenanceUpdateProps): Promise<void> => {
  const transaction = ledger.Transaction.fromParts(
    networkId.getNetworkId(),
    undefined,
    undefined,
    ledger.Intent.new(await transactionTtl(sponsorReady)).addMaintenanceUpdate(
      update.addSignature(0n, signature),
    ),
  );
  assertSubmitted(
    label,
    await submitTx(providers, { unprovenTx: transaction }),
  );
  await awaitAuthorityCounter(
    { providers, ledger, address },
    update.counter + 1n,
    sleep,
  );
};

type InstallWavesProps = ChainStateProps & {
  providers: AccProviders;
  networkId: NetworkIdApi;
  waves: DeployWave[];
  verifierKeys: Map<string, Uint8Array>;
  authorityKey: Ledger.SigningKey;
  /** The committee the wave that replaces the authority installs. */
  successor: readonly MaintenanceVerifyingKey[];
  sleep: Sleep;
  sponsorReady: SponsorReady;
};

/**
 * The committee that succeeds the deploy-time authority: none for a
 * locked account, which retires it, or else the handover authority
 * alone, so every device holding the roster key can sign maintenance.
 */
const successorOf = ({
  lockAccount,
  handoverAuthority,
}: Pick<
  PendingDeployment,
  'handoverAuthority' | 'lockAccount'
>): MaintenanceVerifyingKey[] => (lockAccount ? [] : [handoverAuthority]);

/** Whether a committee on chain is exactly `expected`, member for member. */
const isCommittee = (
  committee: readonly MaintenanceVerifyingKey[],
  expected: readonly MaintenanceVerifyingKey[],
): boolean =>
  committee.length === expected.length &&
  committee.every((member, index) => isSameAuthority(member, expected[index]));

const verifierKeyOf = (
  verifierKeys: Map<string, Uint8Array>,
  operation: string,
): Uint8Array => {
  const key = verifierKeys.get(operation);
  if (!key) throw new Error(`No verifier key loaded for '${operation}'`);
  return key;
};

/**
 * Submits the maintenance waves in order, each one update carrying its
 * batch of verifier key inserts, signed by the maintenance authority key.
 * The counter is read from chain before every update because each
 * applied update advances it, and the wave that replaces the authority
 * installs the successor committee, threshold one, at the counter its
 * own application leaves behind.
 */
const installWaves = async ({
  providers,
  ledger,
  address,
  networkId,
  waves,
  verifierKeys,
  authorityKey,
  successor,
  sleep,
  sponsorReady,
}: InstallWavesProps): Promise<void> => {
  const chain = { providers, ledger, address };
  for (const [index, wave] of waves.entries()) {
    const { counter } = await readMaintenanceAuthority(chain);
    const updates: Ledger.SingleUpdate[] = wave.operations.map(operation =>
      verifierKeyInsert(
        ledger,
        operation,
        verifierKeyOf(verifierKeys, operation),
      ),
    );
    if (wave.replacesAuthority) {
      updates.push(
        new ledger.ReplaceAuthority(
          new ledger.ContractMaintenanceAuthority(
            [...successor],
            1,
            counter + 1n,
          ),
        ),
      );
    }
    const update = new ledger.MaintenanceUpdate(address, updates, counter);
    await submitMaintenanceUpdate({
      ...chain,
      networkId,
      update,
      signature: ledger.signData(authorityKey, update.dataToSign),
      label: `Verifier key wave ${index + 1} of ${waves.length}`,
      sleep,
      sponsorReady,
    });
  }
};

type ActivationProps = {
  providers: AccProviders;
  findContract: FindDeployedAccountContract;
  compiledContract: unknown;
  address: string;
  publicKey: AccModule.JubjubPoint;
  salt: Uint8Array;
  privateStateId: string;
  isActivated: boolean;
};

/**
 * Connects to the deployed contract and returns the account with its
 * activation call. The connection checks the pinned circuits' keys on
 * chain, so it runs only once every wave is in.
 */
const toDeployedAccount = async ({
  providers,
  findContract,
  compiledContract,
  address,
  publicKey,
  salt,
  privateStateId,
  isActivated,
}: ActivationProps): Promise<DeployedAccount> => {
  const found = await findContract(providers, {
    contractAddress: address,
    compiledContract,
    privateStateId,
    initialPrivateState: initialAccountPrivateState(),
  });
  return {
    address,
    salt,
    isActivated,
    activate: async () => {
      const finalized = await submitWithDustRetry(async () =>
        found.callTx[ACTIVATE_INITIAL_DEVICE_CIRCUIT](publicKey, salt),
      );
      assertSubmitted('Account activation', finalized);
      return finalized;
    },
  };
};

/** The bundle's contract compiled over the account witnesses, tagged by the bundle. */
const compileAccountContract = (
  CompiledContract: Awaited<ReturnType<typeof importChainModules>>[3],
  bundle: AccountBundle,
  module: DeployableModule,
): unknown =>
  CompiledContract.make(bundle.id, module.Contract).pipe(
    CompiledContract.withWitnesses(accountWitnesses),
  );

const privateStateIdFrom = (randomBytes: RandomBytes): string =>
  `account-${HexBytes.fromByteArray(randomBytes(PRIVATE_STATE_ID_LENGTH))}`;

/**
 * The state the deploy carries: the constructor's data and maintenance
 * authority with only the first wave's operations, each one's verifier
 * key set from the downloaded, header-checked bytes. The pipeline's own
 * state is not reused as is because compact-js fills verifier keys only
 * for the circuits the zk config provider lists, the manifest-pinned
 * ones, so the deposits would land without a key.
 */
const toDeployedState = ({
  ledger,
  fullState,
  operations,
  verifierKeys,
}: {
  ledger: LedgerModule;
  /** The constructor's full state, as the deploy pipeline built it. */
  fullState: Ledger.ContractState;
  /** The first wave's operations, in roster order. */
  operations: readonly string[];
  verifierKeys: Map<string, Uint8Array>;
}): Ledger.ContractState => {
  const deployedState = new ledger.ContractState();
  deployedState.data = fullState.data;
  deployedState.maintenanceAuthority = fullState.maintenanceAuthority;
  for (const name of operations) {
    const operation = fullState.operation(name);
    if (!operation) {
      throw new Error(`Compiled account contract has no operation '${name}'`);
    }
    operation.verifierKey = verifierKeyOf(verifierKeys, name);
    deployedState.setOperation(name, operation);
  }
  return deployedState;
};

/**
 * Deploys a fresh Account Custody Contract of the build `bundle` names,
 * its compiled contract carrying the roster the bundle installs, the
 * deposits, the jubjub device arm and the grant circuits of the default
 * build among them, and returns its address, the boot salt, and the
 * activation call.
 *
 * The constructor cannot insert the initial device entry (the contract
 * address does not exist yet inside it), so it stores a salted boot
 * commitment over the authoriser's public key with no device entry yet;
 * `activate` presents the same key and salt to install the real entry
 * once every wave is in. After the standard arguments the constructor
 * takes the ones the bundle declares, `constructorValues`, decoded by
 * the caller from the strings `constructorArgs` the pending deployment
 * records beside the bundle's id, so a resume finishes the build it
 * began.
 *
 * The constructor also publishes the account's recovery material: a
 * recovery public key, the wrap its secret is sealed under, and the veto
 * window a recovery must survive. This module offers no recovery, so it
 * publishes a throwaway: a fresh jubjub key whose secret is discarded
 * here and a three day window. No secret is sealed, so the wrap is left
 * empty: all zero bytes are the unambiguous "no container" encoding,
 * whereas random bytes would be indistinguishable on chain from a sealed
 * viewing secret. Nobody holds the secret, so the account is recoverable
 * by nobody, exactly as before the contract gained the field.
 *
 * The roster's verifier keys exceed what one transaction may carry, so
 * the deployment runs in waves: the deploy carries the budgeted prefix of
 * the roster, and each later wave is one maintenance update inserting
 * the next batch, signed by the maintenance authority the deploy minted.
 * `onDeployed` is called between the deploy and the first update with
 * what a retry needs ({@link PendingDeployment}), so an interruption
 * leaves a deployment {@link resumeAccountDeployment} can finish.
 * The deploy and every wave are built only once `sponsorReady`
 * resolves, so a sponsor's setup never runs down their expiry.
 *
 * The maintenance authority's signing key is total custody: it can
 * replace any operation's verifier key and release the account's assets
 * around the device seam. The deploy-time key only signs the waves: the
 * last wave always replaces it, and the key is dropped once the account
 * is activated, held until then only for the duration of the flow and in
 * the pending record a retry reads. `lockAccount` decides what replaces
 * it, explicitly:
 *
 * - `true`: an unsatisfiable authority (empty committee at threshold 1).
 *   No maintenance update can ever be signed again, so the device seam
 *   becomes the only way to move the account's assets. The cost is that
 *   the account can never receive a future arm's circuits.
 * - `false`: `handoverAuthority` alone at threshold 1, the authority the
 *   account's roster key derives. Every enrolled device that holds the
 *   roster key can then sign maintenance updates through the encryption
 *   key seam and grantees never can; a roster rotation rotates the
 *   authority with it, so a removed device loses its upgrade rights.
 */
export const deployAccount = async ({
  providers,
  bundle,
  constructorArgs,
  constructorValues,
  authoriser,
  encPublicKey,
  lockAccount,
  handoverAuthority,
  onDeployed,
  randomBytes = defaultRandomBytes,
  sleep = defaultSleep,
  sponsorReady = noSponsorSetup,
}: DeployAccountProps): Promise<DeployedAccount> => {
  const [[contracts, ledger, networkId, CompiledContract], module] =
    await Promise.all([importChainModules(), loadDeployableModule(bundle)]);

  const publicKey = await authoriser.devicePublicKey();
  const salt = randomBytes(SALT_LENGTH);
  const bootCommitment = module.pureCircuits.derive_boot_commitment_with_jubjub(
    salt,
    publicKey,
  );
  const recoveryPublicKey = JubjubDevice.generate().pk;
  const recoveryWrap = new Uint8Array(RECOVERY_WRAP_LENGTH);
  const privateStateId = privateStateIdFrom(randomBytes);
  const compiledContract = compileAccountContract(
    CompiledContract,
    bundle,
    module,
  );

  const createDeployTransaction =
    contracts.createUnprovenDeployTx as unknown as CreateUnprovenAccountDeployTx;
  const deployData = await createDeployTransaction(providers, {
    compiledContract,
    initialPrivateState: initialAccountPrivateState(),
    args: [
      bootCommitment,
      encPublicKey,
      recoveryPublicKey,
      recoveryWrap,
      VETO_WINDOW_SECONDS,
      ...constructorValues,
    ],
  });
  const fullState = ledger.ContractState.deserialize(
    deployData.public.initialContractState.serialize(),
  );

  const { keys: verifierKeys, sizes } = await loadVerifierKeys(
    providers,
    bundle.operations,
  );
  const verifierKeysDigest = await deployedVerifierKeysDigest(bundle);
  const [deployWave, ...maintenanceWaves] = planDeployWaves(
    bundle.operations,
    sizes,
  );

  const deploy = new ledger.ContractDeploy(
    toDeployedState({
      ledger,
      fullState,
      operations: deployWave.operations,
      verifierKeys,
    }),
  );
  const address = String(deploy.address);
  const deployTx = ledger.Transaction.fromParts(
    networkId.getNetworkId(),
    undefined,
    undefined,
    ledger.Intent.new(await transactionTtl(sponsorReady)).addDeploy(deploy),
  );
  assertSubmitted(
    'Account deploy',
    await submitTx(providers, { unprovenTx: deployTx }),
  );

  const authorityKey = deployData.private.signingKey;
  await onDeployed(address, {
    operations: [...bundle.operations],
    lockAccount,
    verifierKeysDigest,
    saltHex: HexBytes.fromByteArray(salt),
    authorityKey,
    handoverAuthority,
    bundleId: bundle.id,
    constructorArgs: [...constructorArgs],
  });
  await awaitContractIndexed({ providers, ledger, address }, sleep);
  await installWaves({
    providers,
    ledger,
    address,
    networkId,
    waves: maintenanceWaves,
    verifierKeys,
    authorityKey,
    successor: successorOf({ lockAccount, handoverAuthority }),
    sleep,
    sponsorReady,
  });

  return toDeployedAccount({
    providers,
    findContract:
      contracts.findDeployedContract as unknown as FindDeployedAccountContract,
    compiledContract,
    address,
    publicKey,
    salt,
    privateStateId,
    isActivated: false,
  });
};

/**
 * Whether the chain shows the deploy-time authority already replaced by
 * the committee the recorded lock choice installs, a retirement or a
 * handover that landed, rather than still live.
 *
 * @throws {@link MaintenanceAuthorityMismatchError} when the committee
 * is neither: the waves can no longer be signed and the record does not
 * describe this contract.
 */
const isDeployAuthorityReplaced = ({
  ledger,
  address,
  committee,
  pending,
}: {
  ledger: LedgerModule;
  address: string;
  committee: readonly MaintenanceVerifyingKey[];
  pending: PendingDeployment;
}): boolean => {
  if (isCommittee(committee, successorOf(pending))) return true;
  if (
    isCommittee(committee, [ledger.signatureVerifyingKey(pending.authorityKey)])
  ) {
    return false;
  }
  throw new MaintenanceAuthorityMismatchError(
    `The maintenance authority of the account at ${address} is neither the deploy-time key nor the one its unfinished creation installs, so it cannot be resumed.`,
  );
};

/**
 * Finishes a deployment whose waves were interrupted. The operations the
 * contract already holds are read from chain, the waves still missing
 * are planned from the pending roster and submitted, and the account is
 * returned with its activation call; a deployment that only missed its
 * activation plans no wave at all. A deployment the chain shows already
 * activated, because the creation died between its activation and its
 * final record write, installs nothing and is returned as activated once
 * the chain shows its authority replaced. The lock choice and the
 * handover authority are the ones recorded when the deployment began.
 * The chain's authority is read as the deploy-time key still live, or as
 * already replaced when it is the committee the recorded choice
 * installs, a retirement or a handover that landed. An activated
 * deployment whose deploy-time key is still live is refused under either
 * choice: the flow replaces the authority before it activates, so the
 * waves ran outside it and the verifier keys they installed are not
 * known to be this build's. A deployment recorded under another bundle
 * than the resume is asked under, a record written before builds were
 * registered naming the default, or under other verifier key pins than
 * that bundle installs, or without a handover authority, is refused
 * before the chain is read. The constructor arguments the record keeps
 * are the deployed contract's; a resume takes no others.
 *
 * @throws {@link CreationArtefactMismatchError} when the record names
 * another bundle than `bundle`, when the recorded verifier key digest is
 * missing or is not that bundle's, or when the record names no handover
 * authority.
 * @throws {@link MaintenanceAuthorityMismatchError} when the chain's
 * authority is neither the deploy-time key nor the recorded successor.
 * @throws {@link AuthorityNotRetiredError} when the chain shows the
 * account activated with the deploy-time authority still live, whether it
 * was to be locked or handed to its devices.
 * @throws {@link AuthorityRetiredError} when operations are missing but
 * the authority has already been replaced, which no update can mend.
 * @throws {@link AccountContractMissingError} when the address holds no
 * live contract.
 */
export const resumeAccountDeployment = async ({
  providers,
  bundle,
  authoriser,
  address,
  pending,
  randomBytes = defaultRandomBytes,
  sleep = defaultSleep,
  sponsorReady = noSponsorSetup,
}: ResumeAccountDeploymentProps): Promise<DeployedAccount> => {
  const recordedBundleId = pending.bundleId ?? ACCOUNT_BUNDLE_ID;
  if (recordedBundleId !== bundle.id) {
    throw new CreationArtefactMismatchError(
      `The unfinished creation of the account at ${address} was started from account bundle '${recordedBundleId}', so it cannot be resumed from '${bundle.id}'.`,
    );
  }
  if (
    pending.verifierKeysDigest !== (await deployedVerifierKeysDigest(bundle))
  ) {
    throw new CreationArtefactMismatchError(
      `The unfinished creation of the account at ${address} was started under other verifier key pins than this build of account bundle '${bundle.id}' installs, so it cannot be resumed.`,
    );
  }
  if (!pending.handoverAuthority) {
    throw new CreationArtefactMismatchError(
      `The unfinished creation of the account at ${address} names no maintenance authority to hand over to, so it cannot be resumed.`,
    );
  }
  const [[contracts, ledger, networkId, CompiledContract], module] =
    await Promise.all([importChainModules(), loadDeployableModule(bundle)]);

  const publicKey = await authoriser.devicePublicKey();
  const chain = { providers, ledger, address };
  const provided = await readProvidedState(chain);
  const isActivated = module.ledger(provided.data).booted;
  const onChain = ledger.ContractState.deserialize(provided.serialize());
  const isAuthorityReplaced = isDeployAuthorityReplaced({
    ledger,
    address,
    committee: onChain.maintenanceAuthority.committee,
    pending,
  });
  if (isActivated && !isAuthorityReplaced) {
    throw new AuthorityNotRetiredError(
      pending.lockAccount
        ? `The account at ${address} was created to be locked and is activated, but its maintenance authority is still live.`
        : `The account at ${address} was created to hand its maintenance authority to its devices, but is activated with the deploy-time authority still live.`,
    );
  }
  if (!isActivated) {
    const { keys: verifierKeys, sizes } = await loadVerifierKeys(
      providers,
      pending.operations,
    );
    const waves = planResumeWaves({
      operations: pending.operations,
      sizes,
      installed: onChain.operations().map(String),
      isAuthorityReplaced,
    });
    await installWaves({
      ...chain,
      networkId,
      waves,
      verifierKeys,
      authorityKey: pending.authorityKey,
      successor: successorOf(pending),
      sleep,
      sponsorReady,
    });
  }

  return toDeployedAccount({
    providers,
    findContract:
      contracts.findDeployedContract as unknown as FindDeployedAccountContract,
    compiledContract: compileAccountContract(CompiledContract, bundle, module),
    address,
    publicKey,
    salt: ByteArray.fromHex(HexBytes(pending.saltHex)),
    privateStateId: privateStateIdFrom(randomBytes),
    isActivated,
  });
};
