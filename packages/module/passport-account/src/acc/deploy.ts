import {
  AccountContractMissingError,
  AuthorityNotRetiredError,
  CreationArtefactMismatchError,
} from '@lace-contract/passport';
import { ByteArray, HexBytes } from '@lace-lib/util';

import {
  assertSubmitted,
  submitTx,
  submitWithDustRetry,
} from '../infra/submit';

import {
  Contract,
  ledger as decodeLedger,
  expectedVk,
  pureCircuits,
} from './acc-module';
import { JubjubDevice } from './signer';
import {
  assertVerifierKeyHeader,
  verifierKeyInsert,
} from './verifier-key-insert';
import { planDeployWaves, planResumeWaves } from './wave-plan';

import type { JubjubPoint, Witnesses } from './acc-module';
import type { PendingDeployment } from './pending-deployment';
import type { DeployWave, VerifierKeySizes } from './wave-plan';
import type { Sleep } from '../infra/submit';
import type { PassportAuthoriser } from '@lace-contract/passport';
import type * as NetworkIdModule from '@midnight-ntwrk/midnight-js-network-id';
import type * as Ledger from '@midnightntwrk/ledger-v9';
import type { SigningKey } from '@midnightntwrk/ledger-v9';

export type { PendingDeployment } from './pending-deployment';

/** Gated circuit bases the contract exports once per authorisation arm. */
const GATED_CIRCUIT_BASES = [
  'withdraw_unshielded',
  'append_inbox',
  'withdraw_shielded',
  'withdraw_shielded_to_contract',
  'rotate_enc_key',
  'add_device',
  'remove_device',
] as const;

/** Every impure circuit of the jubjub arm, activation included. */
const JUBJUB_ARM_CIRCUITS = [
  'activate_initial_device',
  ...GATED_CIRCUIT_BASES,
].map(base => `${base}_with_jubjub`);

/** Permissionless deposit circuits shared by all arms. */
const SHARED_CIRCUITS = ['deposit_unshielded', 'deposit_shielded'];

/** The grant lifecycle circuits, authorised by a jubjub device. */
const GRANT_LIFECYCLE_BASES = [
  'issue_grant',
  'revoke_grant',
  'revoke_all_grants',
] as const;

/** The withdrawals a grantee may run under a grant from a jubjub owner. */
const GRANT_WITHDRAWAL_BASES = [
  'withdraw_unshielded',
  'withdraw_shielded',
  'withdraw_shielded_to_contract',
] as const;

/** The scoped grant circuits of the jubjub arm. */
const GRANT_CIRCUITS = [
  ...GRANT_LIFECYCLE_BASES.map(base => `${base}_with_jubjub`),
  ...GRANT_WITHDRAWAL_BASES.map(base => `${base}_with_grant_jubjub`),
];

/**
 * The complete operation set this module deploys, in installation order:
 * the deposits, the jubjub device arm and the jubjub grant circuits. The
 * compiled contract also carries k256 and P-256 arms and the recovery
 * circuits; none of their verifier keys are installed, so on an account
 * deployed here only jubjub devices can ever authorise.
 */
const DEPLOYED_OPERATIONS = [
  ...SHARED_CIRCUITS,
  ...JUBJUB_ARM_CIRCUITS,
  ...GRANT_CIRCUITS,
];

const ACTIVATE_INITIAL_DEVICE_CIRCUIT = 'activate_initial_device_with_jubjub';

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
 * they are used.
 */
export type AccProviders = {
  publicDataProvider: unknown;
  zkConfigProvider: unknown;
  proofProvider: unknown;
  privateStateProvider: unknown;
  walletProvider: unknown;
  midnightProvider: unknown;
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
  data: Parameters<typeof decodeLedger>[0];
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
export const accountWitnesses: Witnesses<AccountPrivateState> = {
  held_coin: (context, color) => {
    const key = HexBytes.fromByteArray(color);
    const stored = context.privateState.coins[key];
    if (!stored) {
      throw new Error(
        `held_coin witness: no coin for color ${key} in the local store`,
      );
    }
    return [
      context.privateState,
      {
        nonce: ByteArray.fromHex(HexBytes(stored.nonceHex)),
        color: ByteArray.fromHex(HexBytes(stored.colorHex)),
        value: BigInt(stored.value),
        mt_index: BigInt(stored.mtIndex),
      },
    ];
  },
};

/** The private state a handle starts from: no captured coins yet. */
export const initialAccountPrivateState = (): AccountPrivateState => ({
  coins: {},
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
    signingKey: SigningKey;
    initialPrivateState: AccountPrivateState;
  };
};

type CreateUnprovenAccountDeployTx = (
  providers: AccProviders,
  options: {
    compiledContract: unknown;
    initialPrivateState: AccountPrivateState;
    args: [Uint8Array, Uint8Array, JubjubPoint, Uint8Array, bigint];
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
  providers: AccProviders;
  /** The initial device; its public key seeds the boot commitment. */
  authoriser: PassportAuthoriser;
  /** Raw 32-byte X25519 public key the constructor stores as `enc_key`. */
  encPublicKey: Uint8Array;
  /**
   * Whether to retire the contract maintenance authority in the last
   * wave. Required with no default: the choice trades upgradability for
   * custody and must be made explicitly. See {@link deployAccount}.
   */
  lockAccount: boolean;
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
};

export type ResumeAccountDeploymentProps = {
  providers: AccProviders;
  /** The initial device; its public key is what the activation presents. */
  authoriser: PassportAuthoriser;
  /** Hex address of the contract the interrupted deployment created. */
  address: string;
  pending: PendingDeployment;
  /** Randomness for the private-state id; defaults to Web Crypto. */
  randomBytes?: RandomBytes;
  /** Waits between chain polls; defaults to a real timer. */
  sleep?: Sleep;
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

const transactionTtl = (): Date => new Date(Date.now() + DEPLOY_TX_TTL_MS);

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
 * Names the verifier keys this build installs: the lowercase hex sha256
 * over each roster operation's name and the sha256 pin of its verifier
 * key, in installation order. A deployment records it once the deploy
 * lands, and a resume compares it before any wave, so an account never
 * holds verifier keys of two builds.
 */
const deployedVerifierKeysDigest = async (): Promise<string> => {
  const pins = DEPLOYED_OPERATIONS.map(operation => {
    const pin = expectedVk[operation];
    if (!pin) throw new Error(`No verifier key pin for '${operation}'`);
    return `${operation}:${pin}`;
  });
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(pins.join('\n')) as BufferSource,
  );
  return HexBytes.fromByteArray(new Uint8Array(digest));
};

/**
 * The verifier key of every roster operation, downloaded through the zk
 * config provider so each one is checked against its pin and its header,
 * and the sizes the wave plan is computed from. The plan follows the
 * real keys, so a roster or key-size change re-plans itself.
 */
const loadVerifierKeys = async (
  providers: AccProviders,
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

type ChainStateProps = {
  providers: AccProviders;
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

type InstallWavesProps = ChainStateProps & {
  networkId: NetworkIdApi;
  waves: DeployWave[];
  verifierKeys: Map<string, Uint8Array>;
  authorityKey: SigningKey;
  sleep: Sleep;
};

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
 * applied update advances it, and a wave that retires the authority
 * installs the unsatisfiable committee at the counter its own application
 * leaves behind.
 */
const installWaves = async ({
  providers,
  ledger,
  address,
  networkId,
  waves,
  verifierKeys,
  authorityKey,
  sleep,
}: InstallWavesProps): Promise<void> => {
  const chain = { providers, ledger, address };
  for (const [index, wave] of waves.entries()) {
    const { maintenanceAuthority } = await readContractState(chain);
    const counter = maintenanceAuthority.counter;
    const updates: Ledger.SingleUpdate[] = wave.operations.map(operation =>
      verifierKeyInsert(
        ledger,
        operation,
        verifierKeyOf(verifierKeys, operation),
      ),
    );
    if (wave.retiresAuthority) {
      updates.push(
        new ledger.ReplaceAuthority(
          new ledger.ContractMaintenanceAuthority([], 1, counter + 1n),
        ),
      );
    }
    const update = new ledger.MaintenanceUpdate(address, updates, counter);
    const signed = update.addSignature(
      0n,
      ledger.signData(authorityKey, update.dataToSign),
    );
    const waveTx = ledger.Transaction.fromParts(
      networkId.getNetworkId(),
      undefined,
      undefined,
      ledger.Intent.new(transactionTtl()).addMaintenanceUpdate(signed),
    );
    assertSubmitted(
      `Verifier key wave ${index + 1} of ${waves.length}`,
      await submitTx(providers, { unprovenTx: waveTx }),
    );
    await awaitAuthorityCounter(chain, counter + 1n, sleep);
  }
};

type ActivationProps = {
  providers: AccProviders;
  findContract: FindDeployedAccountContract;
  compiledContract: unknown;
  address: string;
  publicKey: JubjubPoint;
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

const compileAccountContract = (
  CompiledContract: Awaited<ReturnType<typeof importChainModules>>[3],
): unknown =>
  CompiledContract.make('account', Contract).pipe(
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
 * Deploys a fresh Account Custody Contract carrying the deposits, the
 * jubjub device arm and the jubjub grant circuits, and returns its
 * address, the boot salt, and the activation call.
 *
 * The constructor cannot insert the initial device entry (the contract
 * address does not exist yet inside it), so it stores a salted boot
 * commitment over the authoriser's public key with no device entry yet;
 * `activate` presents the same key and salt to install the real entry
 * once every wave is in.
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
 *
 * The maintenance authority's signing key is total custody: it can
 * replace any operation's verifier key and release the account's assets
 * around the device seam. `lockAccount` decides its fate, explicitly:
 *
 * - `true`: the last wave also replaces the authority with an
 *   unsatisfiable one (empty committee at threshold 1). No maintenance
 *   update can ever be signed again, so the device seam becomes the only
 *   way to move the account's assets. The cost is that the account can
 *   never receive a future arm's circuits.
 * - `false`: the deploy-time authority stays live on-chain, but this
 *   implementation discards its signing key once the account is
 *   activated; the key is held only for the duration of the flow and in
 *   the pending record a retry reads. Keeping the authority live is the
 *   caller's informed choice, accepted knowing the key amounts to full
 *   custody wherever it survives.
 */
export const deployAccount = async ({
  providers,
  authoriser,
  encPublicKey,
  lockAccount,
  onDeployed,
  randomBytes = defaultRandomBytes,
  sleep = defaultSleep,
}: DeployAccountProps): Promise<DeployedAccount> => {
  const [contracts, ledger, networkId, CompiledContract] =
    await importChainModules();

  const publicKey = await authoriser.devicePublicKey();
  const salt = randomBytes(SALT_LENGTH);
  const bootCommitment = pureCircuits.derive_boot_commitment_with_jubjub(
    salt,
    publicKey,
  );
  const recoveryPublicKey = JubjubDevice.generate().pk;
  const recoveryWrap = new Uint8Array(RECOVERY_WRAP_LENGTH);
  const privateStateId = privateStateIdFrom(randomBytes);
  const compiledContract = compileAccountContract(CompiledContract);

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
    ],
  });
  const fullState = ledger.ContractState.deserialize(
    deployData.public.initialContractState.serialize(),
  );

  const { keys: verifierKeys, sizes } = await loadVerifierKeys(
    providers,
    DEPLOYED_OPERATIONS,
  );
  const verifierKeysDigest = await deployedVerifierKeysDigest();
  const [deployWave, ...maintenanceWaves] = planDeployWaves(
    DEPLOYED_OPERATIONS,
    sizes,
    { retireAuthority: lockAccount },
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
    ledger.Intent.new(transactionTtl()).addDeploy(deploy),
  );
  assertSubmitted(
    'Account deploy',
    await submitTx(providers, { unprovenTx: deployTx }),
  );

  const authorityKey = deployData.private.signingKey;
  await onDeployed(address, {
    operations: [...DEPLOYED_OPERATIONS],
    lockAccount,
    verifierKeysDigest,
    saltHex: HexBytes.fromByteArray(salt),
    authorityKey,
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
    sleep,
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
 * Finishes a deployment whose waves were interrupted. The operations the
 * contract already holds are read from chain, the waves still missing
 * are planned from the pending roster and submitted, and the account is
 * returned with its activation call; a deployment that only missed its
 * activation plans no wave at all. A deployment the chain shows already
 * activated, because the creation died between its activation and its
 * final record write, installs nothing and is returned as activated. The
 * lock choice is the one made when the deployment began; a locked
 * deployment the chain shows activated is checked to have retired its
 * authority, since the flow retires it before it activates. A deployment
 * recorded under other verifier key pins than this build installs is
 * refused before the chain is read.
 *
 * @throws {@link CreationArtefactMismatchError} when the recorded
 * verifier key digest is missing or is not this build's.
 * @throws {@link AuthorityNotRetiredError} when the deployment was to lock
 * the account and the chain shows it activated with the authority live.
 * @throws {@link AuthorityRetiredError} when operations are missing but
 * the authority has already been retired, which no update can mend.
 * @throws {@link AccountContractMissingError} when the address holds no
 * live contract.
 */
export const resumeAccountDeployment = async ({
  providers,
  authoriser,
  address,
  pending,
  randomBytes = defaultRandomBytes,
  sleep = defaultSleep,
}: ResumeAccountDeploymentProps): Promise<DeployedAccount> => {
  if (pending.verifierKeysDigest !== (await deployedVerifierKeysDigest())) {
    throw new CreationArtefactMismatchError(
      `The unfinished creation of the account at ${address} was started under other verifier key pins than this build installs, so it cannot be resumed.`,
    );
  }
  const [contracts, ledger, networkId, CompiledContract] =
    await importChainModules();

  const publicKey = await authoriser.devicePublicKey();
  const chain = { providers, ledger, address };
  const provided = await readProvidedState(chain);
  const isActivated = decodeLedger(provided.data).booted;
  const onChain = ledger.ContractState.deserialize(provided.serialize());
  const isAuthorityRetired =
    onChain.maintenanceAuthority.committee.length === 0;
  if (isActivated && pending.lockAccount && !isAuthorityRetired) {
    throw new AuthorityNotRetiredError(
      `The account at ${address} was created to be locked and is activated, but its maintenance authority is still live.`,
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
      isAuthorityRetired,
      retireAuthority: pending.lockAccount,
    });
    await installWaves({
      ...chain,
      networkId,
      waves,
      verifierKeys,
      authorityKey: pending.authorityKey,
      sleep,
    });
  }

  return toDeployedAccount({
    providers,
    findContract:
      contracts.findDeployedContract as unknown as FindDeployedAccountContract,
    compiledContract: compileAccountContract(CompiledContract),
    address,
    publicKey,
    salt: ByteArray.fromHex(HexBytes(pending.saltHex)),
    privateStateId: privateStateIdFrom(randomBytes),
    isActivated,
  });
};
