import {
  AccAddress,
  AccountContractMissingError,
  DeviceEpoch,
  UseCounter,
} from '@lace-contract/passport';

import { connectAccountHandle, executeGatedCall } from '../acc/gated-call';
import { sha256Hex } from '../acc/sha256';
import { createIndexerClient } from '../infra/indexer';
import { createMidnightProviders } from '../infra/providers';

import type { Ledger } from '../acc/acc-module';
import type { BundleRegistry } from '../acc/bundle';
import type { AccountPrivateState } from '../acc/deploy';
import type { AcceptedGatedCall } from '../acc/gated-call';
import type { IndexerClient } from '../infra/indexer';
import type { MidnightProviderStage } from '../infra/providers';
import type {
  AccountBundle,
  PassportAccountInfo,
  PassportDependencies,
  PassportDevice,
  PassportNetworkConfig,
} from '@lace-contract/passport';

/** Contract aborts meaning the authorising key was rejected. */
const NOT_AUTHORISED_ABORTS = [
  'failed assert: invalid signature',
  'failed assert: device key',
];

/**
 * Raised by the caller checks in require_authorised and by the target
 * check in _do_remove_device: the same string for two different failures.
 */
export const UNKNOWN_ENTRY_ABORT = 'failed assert: unknown device entry';

/** Whether a contract abort message says the authorising key was rejected. */
export const isNotAuthorisedAbort = (message: string): boolean =>
  NOT_AUTHORISED_ABORTS.some(abort => message.includes(abort));

/**
 * What an accepted gated call leaves behind: the counter and entry
 * commitment the local device holds after it, with the transaction id
 * and return value the call reported.
 */
export type AcceptedAccountCall = AcceptedGatedCall & {
  localCommitmentHex: string;
};

/** The account's ledger state as the indexer serves it, with the client that read it. */
export type AccountLedger = {
  indexer: IndexerClient;
  ledgerState: Ledger;
};

/**
 * The contract state the indexer serves at `address`, which must exist.
 *
 * @throws {@link AccountContractMissingError} when the indexer serves no
 * contract at the address.
 */
const queryAccountState = async (indexer: IndexerClient, address: string) => {
  const state = await indexer.queryContractState(address);
  if (!state) {
    throw new AccountContractMissingError(
      `No live Account Custody Contract found at ${address}.`,
    );
  }
  return state;
};

/**
 * The ledger state of the account at `address`, decoded by the module of
 * `bundle`, the build the account was deployed from. Each build lays its
 * ledger out in its own order, so an account's state reads correctly
 * only through the module compiled with it.
 *
 * @throws {@link AccountContractMissingError} when the indexer serves no
 * contract at the address.
 */
export const queryAccountLedger = async (
  indexer: IndexerClient,
  address: string,
  bundle: AccountBundle,
): Promise<Ledger> => {
  const state = await queryAccountState(indexer, address);
  return (await bundle.module()).ledger(state.data) as Ledger;
};

/**
 * The operations the account at `address` holds verifier keys for, which
 * are the circuits the chain will accept a call to.
 *
 * @throws {@link AccountContractMissingError} when the indexer serves no
 * contract at the address.
 */
export const queryAccountOperations = async (
  indexer: IndexerClient,
  address: string,
): Promise<readonly string[]> =>
  (await queryAccountState(indexer, address)).operations().map(String);

/**
 * The sha256 of the verifier key `state` holds for each of its
 * operations, as lowercase hex keyed by operation name. The indexer hands
 * back a compact-runtime state, which bridges to the ledger class by
 * serialisation, as the ledger class alone exposes the keys.
 */
const verifierKeysOf = async (
  provided: Awaited<ReturnType<typeof queryAccountState>>,
  address: string,
): Promise<Map<string, string>> => {
  const { ContractState } = await import('@midnightntwrk/ledger-v9');
  const onChain = ContractState.deserialize(provided.serialize());
  return new Map(
    await Promise.all(
      onChain.operations().map(async operation => {
        const name = String(operation);
        const verifierKey = onChain.operation(operation)?.verifierKey;
        if (!verifierKey) {
          throw new Error(
            `The account at ${address} lists operation '${name}' without a verifier key.`,
          );
        }
        return [name, await sha256Hex(verifierKey)] as const;
      }),
    ),
  );
};

/**
 * The sha256 of the verifier key the account at `address` holds for each
 * of its operations, as lowercase hex keyed by operation name, which is
 * what names the build the account was deployed from.
 *
 * @throws {@link AccountContractMissingError} when the indexer serves no
 * contract at the address.
 */
export const queryAccountVerifierKeys = async (
  indexer: IndexerClient,
  address: string,
): Promise<Map<string, string>> =>
  verifierKeysOf(await queryAccountState(indexer, address), address);

/**
 * The account at `address` as one read of its contract state describes
 * it: the registered build its verifier keys resolve to and its ledger
 * state decoded by that build's module. A build no registered bundle
 * covers is refused with AccountBundleUnknownError.
 *
 * @throws {@link AccountContractMissingError} when the indexer serves no
 * contract at the address.
 */
export const queryAccountByBuild = async (
  indexer: IndexerClient,
  address: string,
  bundles: BundleRegistry,
): Promise<{ bundle: AccountBundle; ledgerState: Ledger }> => {
  const state = await queryAccountState(indexer, address);
  const bundle = bundles.resolve(await verifierKeysOf(state, address));
  return {
    bundle,
    ledgerState: (await bundle.module()).ledger(state.data) as Ledger,
  };
};

/**
 * Reads the account's ledger state, decoded by `bundle`'s module, through
 * a fresh indexer client, which is returned with it so a flow can read
 * the state again after a call.
 */
export const readAccountLedger = async (
  address: string,
  { indexerUrl, indexerWsUrl }: PassportNetworkConfig,
  bundle: AccountBundle,
): Promise<AccountLedger> => {
  const indexer = createIndexerClient({ indexerUrl, indexerWsUrl });
  return {
    indexer,
    ledgerState: await queryAccountLedger(indexer, address, bundle),
  };
};

/**
 * Reads the account at `address` as the chain describes it: the
 * registered build its verifier keys resolve to and its ledger state
 * decoded by that build's module, with the indexer client that read them.
 * A build no registered bundle covers is refused with
 * AccountBundleUnknownError.
 *
 * @throws {@link AccountContractMissingError} when the indexer serves no
 * contract at the address.
 */
export const readAccountByBuild = async (
  address: string,
  { indexerUrl, indexerWsUrl }: PassportNetworkConfig,
  bundles: BundleRegistry,
): Promise<AccountLedger & { bundle: AccountBundle }> => {
  const indexer = createIndexerClient({ indexerUrl, indexerWsUrl });
  return { indexer, ...(await queryAccountByBuild(indexer, address, bundles)) };
};

export type SubmitAccountCallProps = {
  /** Gated circuit the call targets: one of the module's own, or one the account's bundle describes. */
  circuit: string;
  /** The circuit's own arguments in declaration order. */
  args: readonly unknown[];
  /** The witness values the challenge binds, in descriptor order; none for the module's own circuits. */
  witnessValues?: readonly unknown[];
  /** The private state the handle starts from, holding the coin a shielded leg spends; no coins by default. */
  privateState?: AccountPrivateState;
  /** Set for a circuit the account's bundle describes, so the authoriser builds the challenge its descriptor names. */
  bundleId?: string;
  account: PassportAccountInfo;
  /** The registered bundles, among which the account's names the artefacts the call is proved with. */
  bundles: BundleRegistry;
  localUseCounter: string | undefined;
  /** Ledger state read before the call, so the signature binds its auth nonce. */
  ledgerState: Ledger;
  /** Told as the transaction enters proving and sponsoring, when given. */
  onStage?: (stage: MidnightProviderStage) => void;
};

/**
 * Submits one gated call and reports the position it left the local
 * device in. The handle is compiled from the account bundle's module and
 * connected without the account encryption secret: the device and grant
 * lifecycle circuits read no private state, so deriving it here would
 * only widen the window the secret spends in memory, and a call that
 * spends a coin seeds that coin alone. The successor commitment is
 * computed against the epoch read before the call, which is the epoch the
 * accepted call ran under: a gated call never changes device_epoch (it is
 * only written at construction), so the pre-call epoch names the very
 * entry the contract inserted.
 */
export const submitAccountCall = async (
  {
    circuit,
    args,
    witnessValues,
    privateState,
    bundleId,
    account,
    bundles,
    localUseCounter,
    ledgerState,
    onStage,
  }: SubmitAccountCallProps,
  {
    passportAuthoriser,
    passportNetwork,
    passportProver,
    passportSponsor,
  }: PassportDependencies,
): Promise<AcceptedAccountCall> => {
  const bundle = bundles.get(account.bundleId);
  const providers = await createMidnightProviders({
    network: passportNetwork,
    prover: passportProver,
    sponsor: passportSponsor,
    bundle,
    bundles: bundles.bundles,
    calledContracts: bundles.calledContracts,
    ...(onStage ? { onStage } : {}),
  });
  const handle = await connectAccountHandle(providers, account.address, {
    bundle,
    ...(privateState ? { privateState } : {}),
  });
  const address = AccAddress(account.address);
  const accepted = await executeGatedCall({
    handle,
    authoriser: passportAuthoriser,
    circuit,
    args,
    ...(witnessValues ? { witnessValues } : {}),
    ...(bundleId === undefined ? {} : { bundleId }),
    address,
    ledgerState,
    knownUseCounter:
      localUseCounter === undefined
        ? undefined
        : UseCounter(BigInt(localUseCounter)),
  });
  return {
    ...accepted,
    localCommitmentHex: await passportAuthoriser.deviceCommitment(
      address,
      DeviceEpoch(ledgerState.device_epoch),
      accepted.advancedCounter,
    ),
  };
};

/**
 * The devices list with the local device's row moved to the commitment it
 * holds after an accepted call. An entry is single use: the call consumed
 * the one the row carried and the contract inserted its successor, so
 * leaving the row as it was would name an entry the on-chain set no
 * longer holds. Only existing rows are rewritten, so a removal that
 * dropped the local row does not resurrect it.
 */
export const withRefreshedLocalDevice = (
  devices: PassportDevice[],
  commitmentHex: string,
): PassportDevice[] =>
  devices.map(device =>
    device.isLocal ? { ...device, commitmentHex } : device,
  );
