import { UseCounter } from '@lace-contract/passport';
import { HexBytes } from '@lace-lib/util';

import { assertSubmitted, submitWithDustRetry } from '../infra/submit';

import { accountBundle } from './bundle';
import { accountWitnesses, initialAccountPrivateState } from './deploy';
import { authArgs } from './signer';
import { resolveUseCounter } from './use-counter';

import type { Contract } from './acc-module';
import type { AccountPrivateState, AccProviders } from './deploy';
import type { DeviceLedgerState } from './use-counter';
import type {
  AccAddress,
  AccountBundle,
  PassportAuthoriser,
} from '@lace-contract/passport';

const PRIVATE_STATE_ID_LENGTH = 8;

/** The found-contract handle surface gated calls are submitted through. */
export type GatedContractHandle = {
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
) => Promise<GatedContractHandle>;

/**
 * The generated module of a build, narrowed to the contract class every
 * build of the account shares the shape of: the witnesses are the
 * account's, whatever circuits the build adds.
 */
type HandleModule = { Contract: typeof Contract };

/**
 * What a handle is connected with: the `bundle` whose compiled contract
 * runs the circuits, the vendored account by default, and the
 * `privateState` the handle starts from, holding no coin by default.
 */
type AccountHandleOptions = {
  bundle?: AccountBundle;
  privateState?: AccountPrivateState;
};

/**
 * The slice of midnight-js' finalized call data a flow reads back: the
 * id of the transaction that carried the call and the circuit's return
 * value.
 */
type FinalizedCallData = {
  public?: { txId?: unknown };
  private?: { result?: unknown };
};

/**
 * Connects to a deployed Account Custody Contract and returns the handle
 * gated calls run through, compiled from the account bundle's module over
 * the account witnesses. The private state starts without the account
 * encryption secret: the device-management and grant lifecycle circuits
 * consume no witnesses, and a call that spends a coin seeds only that
 * coin, so no key material is held in memory for longer than its call.
 */
export const connectAccountHandle = async (
  providers: AccProviders,
  contractAddress: string,
  {
    bundle = accountBundle,
    privateState = initialAccountPrivateState(),
  }: AccountHandleOptions = {},
): Promise<GatedContractHandle> => {
  const [contracts, CompiledContract, module] = await Promise.all([
    import('@midnight-ntwrk/midnight-js-contracts'),
    import('@midnight-ntwrk/compact-js/effect/CompiledContract'),
    bundle.module() as Promise<unknown> as Promise<HandleModule>,
  ]);
  const compiledContract = CompiledContract.make(
    bundle.id,
    module.Contract,
  ).pipe(CompiledContract.withWitnesses(accountWitnesses));
  const findContract =
    contracts.findDeployedContract as unknown as FindDeployedAccountContract;
  return findContract(providers, {
    contractAddress,
    compiledContract,
    privateStateId: `account-${HexBytes.fromByteArray(
      crypto.getRandomValues(new Uint8Array(PRIVATE_STATE_ID_LENGTH)),
    )}`,
    initialPrivateState: privateState,
  });
};

/**
 * The slice of the decoded Account Custody Contract ledger state a gated
 * call reads: the device fields the use-counter rescan probes plus the
 * auth nonce the challenge binds.
 */
export type GatedCallLedgerState = DeviceLedgerState & {
  readonly auth_nonce: bigint;
};

export type ExecuteGatedCallProps = {
  /** Deployed-contract handle the call is submitted through. */
  handle: GatedContractHandle;
  /** Device key that authorises the call. */
  authoriser: PassportAuthoriser;
  /**
   * Fully qualified circuit name, e.g. `add_device_with_jubjub`: one of
   * the module's own, or one the account's bundle describes; only a
   * circuit the bundle's manifest pins has key material to prove with.
   */
  circuit: string;
  /**
   * The circuit's own arguments in declaration order, from the single
   * entry of a device call to the grant id, scope fields and salt of an
   * issue call; the auth args are appended after them.
   */
  args: readonly unknown[];
  /**
   * The witness values the challenge binds, in the order the circuit's
   * descriptor declares them; the module's own circuits bind none.
   */
  witnessValues?: readonly unknown[];
  /**
   * The bundle describing `circuit`, for a circuit that is not one of the
   * module's own, so the authoriser builds the challenge its descriptor
   * names.
   */
  bundleId?: string;
  /** Address of the account the call executes against. */
  address: AccAddress;
  /** Decoded ledger state, read before the call so the signature binds the auth nonce the contract will consume. */
  ledgerState: GatedCallLedgerState;
  /** Counter the device last knew about; anchors the rescan. */
  knownUseCounter?: UseCounter;
};

/**
 * What one accepted gated call leaves behind: the counter the device
 * holds after it, the id of the transaction that carried it, when the
 * handle reports one, and the circuit's return value, undefined for a
 * circuit that returns nothing.
 */
export type AcceptedGatedCall = {
  advancedCounter: UseCounter;
  txId?: string;
  result: unknown;
};

/** The transaction id and return value the finalized call data carries. */
const callOutcome = (
  finalized: unknown,
): Pick<AcceptedGatedCall, 'result' | 'txId'> => {
  const data = finalized as FinalizedCallData | null | undefined;
  const txId = data?.public?.txId;
  return {
    ...(typeof txId === 'string' ? { txId } : {}),
    result: data?.private?.result,
  };
};

/**
 * Executes one authorised circuit call against a deployed Account Custody
 * Contract: resolves the device's current use counter from the ledger,
 * has the authoriser sign the call over the observed auth nonce, submits
 * the circuit with the authorising material appended as its trailing
 * arguments (pk, use counter, announcement, closing scalar, grind nonce),
 * and returns the counter the device holds after the accepted call, the
 * consumed one plus one, with what the call left behind.
 *
 * A transaction that lands with a failing status rejects instead of
 * returning: the contract applied nothing, so no counter may advance and
 * no roster change may be recorded for it.
 */
export const executeGatedCall = async ({
  handle,
  authoriser,
  circuit,
  args,
  witnessValues = [],
  bundleId,
  address,
  ledgerState,
  knownUseCounter,
}: ExecuteGatedCallProps): Promise<AcceptedGatedCall> => {
  const call = handle.callTx[circuit];
  if (!call) {
    throw new Error(`Account contract handle has no circuit '${circuit}'`);
  }

  const { useCounter } = await resolveUseCounter({
    ledgerState,
    authoriser,
    address,
    knownUseCounter,
  });
  const authorisation = await authoriser.authorise({
    account: address,
    circuit,
    args,
    witnessValues,
    authNonce: ledgerState.auth_nonce,
    useCounter,
    ...(bundleId === undefined ? {} : { bundleId }),
  });

  const finalized = await submitWithDustRetry(async () =>
    call(...args, ...authArgs(authorisation)),
  );
  assertSubmitted(`Call to ${circuit}`, finalized);
  return {
    advancedCounter: UseCounter(useCounter + 1n),
    ...callOutcome(finalized),
  };
};
