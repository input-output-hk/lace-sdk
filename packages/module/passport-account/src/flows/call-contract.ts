import {
  AccAddress,
  CallArgumentInvalidError,
  CircuitNotRegisteredError,
  NotAuthorisedError,
} from '@lace-contract/passport';
import { HexBytes } from '@lace-lib/util';

import {
  BYTES32_HEX_PATTERN,
  calleeAddressesOf,
  DECIMAL_PATTERN,
  decodeArguments,
  normaliseArguments,
} from '../acc/arguments';
import { heldCoinPrivateState, toHeldCoin } from '../acc/deploy';

import {
  isNotAuthorisedAbort,
  readAccountLedger,
  submitAccountCall,
  UNKNOWN_ENTRY_ABORT,
  withRefreshedLocalDevice,
} from './account-call';
import { inKeySession } from './key-session';
import { completedRecord } from './stored-grants';

import type { AccountCallInput, FlowContext } from './types';
import type { AccountPrivateState } from '../acc/deploy';
import type {
  AccountBundle,
  CallContractWitnesses,
  CircuitDescriptor,
  HeldCoinWitness,
  PassportDevice,
  WitnessDescriptor,
} from '@lace-contract/passport';

/**
 * The call to make from the account: the circuit of its bundle, the
 * values of the circuit's declared arguments as strings in declaration
 * order, and the witnesses the circuit's descriptor lists.
 */
export type CallContractInput = AccountCallInput & {
  circuit: string;
  args: readonly string[];
  witnesses?: CallContractWitnesses;
};

/**
 * What an accepted contract call leaves behind: the circuit it ran, the
 * id of the transaction that carried it, the circuit's return value
 * rendered as a string (a decimal for an integer, hex for bytes, JSON for
 * a structure), absent for a circuit that returns nothing, the roster
 * with this device's row on its successor entry, and the advanced use
 * counter that entry sits at.
 */
export type ContractCallResult = {
  circuit: string;
  txId: string;
  result?: string;
  devices: PassportDevice[];
  localUseCounter: string;
};

/** What a call seeds the handle with: the witness values and the private state serving them. */
type CallWitnesses = {
  witnessValues: unknown[];
  privateState?: AccountPrivateState;
};

/**
 * The descriptor the account's bundle holds for `circuit`.
 *
 * @throws {@link CircuitNotRegisteredError} naming the circuit when the
 * bundle describes no such circuit.
 */
const describedCircuit = (
  bundle: AccountBundle,
  circuit: string,
): CircuitDescriptor => {
  if (!Object.hasOwn(bundle.circuits, circuit)) {
    throw new CircuitNotRegisteredError(
      `Account bundle '${bundle.id}' describes no circuit '${circuit}'.`,
    );
  }
  return bundle.circuits[circuit];
};

const invalidWitness = (
  circuit: string,
  witness: WitnessDescriptor,
  rule: string,
): CallArgumentInvalidError =>
  new CallArgumentInvalidError(
    `Witness '${witness.name}' of circuit '${circuit}' ${rule}`,
  );

/**
 * The held coin a descriptor's witness names, held to the shape of a coin
 * description: 32 bytes of hex for the nonce and the colour, decimals for
 * the value and the tree index.
 *
 * @throws {@link CallArgumentInvalidError} naming the witness when the
 * input lacks it or a field does not fit.
 */
const heldCoinOf = (
  circuit: string,
  witness: WitnessDescriptor,
  witnesses: CallContractWitnesses | undefined,
): HeldCoinWitness => {
  const coin = witnesses?.heldCoin;
  if (!coin) throw invalidWitness(circuit, witness, 'has no value.');
  if (
    !BYTES32_HEX_PATTERN.test(coin.nonceHex) ||
    !BYTES32_HEX_PATTERN.test(coin.colorHex)
  ) {
    throw invalidWitness(
      circuit,
      witness,
      'must name its nonce and colour as 32 bytes of hex each.',
    );
  }
  if (
    !DECIMAL_PATTERN.test(coin.value) ||
    !DECIMAL_PATTERN.test(coin.mtIndex)
  ) {
    throw invalidWitness(
      circuit,
      witness,
      'must give its value and tree index as decimal integers.',
    );
  }
  return coin;
};

/**
 * The witness values of the call in descriptor order, each the coin the
 * input holds for it, with the private state the contract's `held_coin`
 * witness serves them from; a circuit reading no witness seeds nothing.
 */
const callWitnesses = (
  circuit: string,
  descriptor: CircuitDescriptor,
  witnesses: CallContractWitnesses | undefined,
): CallWitnesses => {
  const coins = descriptor.witnesses.map(witness =>
    heldCoinOf(circuit, witness, witnesses),
  );
  return {
    witnessValues: coins.map(toHeldCoin),
    ...(coins.length > 0 ? { privateState: heldCoinPrivateState(coins) } : {}),
  };
};

/**
 * `value` as JSON can carry it: a bigint as a decimal string, bytes as
 * hex, a structure member by member.
 */
const toJsonValue = (value: unknown): unknown => {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Uint8Array) return HexBytes.fromByteArray(value);
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, member]) => [key, toJsonValue(member)]),
    );
  }
  return value;
};

/**
 * The circuit's return value as the call publishes it: a string of its
 * JSON-safe rendering, none for a circuit that returns nothing, which the
 * generated code reports as an empty tuple.
 */
const renderResult = (value: unknown): string | undefined => {
  if (value === undefined || (Array.isArray(value) && value.length === 0)) {
    return undefined;
  }
  const rendered = toJsonValue(value);
  return typeof rendered === 'string' ? rendered : JSON.stringify(rendered);
};

/**
 * Types a raw contract abort by the assert message the Account Custody
 * Contract raises for a rejected authorisation: an invalid signature, a
 * malformed device key, or a caller entry the on-chain set no longer
 * holds. Anything else, the called circuit's own asserts included, passes
 * through unchanged.
 */
const classifyContractAbort = (error: unknown): unknown => {
  const message = error instanceof Error ? error.message : String(error);
  return isNotAuthorisedAbort(message) || message.includes(UNKNOWN_ENTRY_ABORT)
    ? new NotAuthorisedError(message)
    : error;
};

/**
 * Calls a circuit the account's bundle describes, which is how an account
 * reaches a contract its build was compiled with. The bundle must hold a
 * descriptor for `circuit`, else CircuitNotRegisteredError; the arguments
 * are decoded by that descriptor, a contract argument against the
 * registered called contracts, with CallArgumentInvalidError
 * naming a value that does not fit and CalledContractNotRegisteredError an
 * address no called contract has; a witness the descriptor lists and the
 * input lacks is CallArgumentInvalidError naming it. All of that and the
 * ledger read happen before any prompt.
 *
 * In one key session naming the account, the bundle, the circuit, the
 * canonical arguments and the callee addresses, the local device
 * authorises the call over the challenge the descriptor names, with the
 * witness values bound into it, and the call runs through the bundle's
 * compiled contract, the private state seeded with the coin a shielded
 * leg spends and the providers carrying the module provider the runtime
 * resolves the callee through. The advanced counter is persisted to the
 * account record before the result is returned, so the next flow rescans
 * from a fresh anchor. A rejected authorisation rejects with
 * NotAuthorisedError; the called circuit's own refusals pass through as
 * the contract raises them. The transaction's proving and sponsoring
 * stages are reported through `onProgress`; the holdings are left to the
 * next read.
 */
export const callContract = async (
  {
    account,
    devices,
    localUseCounter,
    circuit,
    args,
    witnesses,
  }: CallContractInput,
  { seams, accountRecords, onProgress, bundles }: FlowContext,
): Promise<ContractCallResult> => {
  const bundle = bundles.get(account.bundleId);
  const descriptor = describedCircuit(bundle, circuit);
  const decoded = decodeArguments(
    descriptor.args,
    args,
    bundles.calledContracts,
  );
  const canonical = normaliseArguments(descriptor.args, args);
  const { witnessValues, privateState } = callWitnesses(
    circuit,
    descriptor,
    witnesses,
  );
  const { ledgerState } = await readAccountLedger(
    account.address,
    seams.passportNetwork,
    bundle,
  );
  try {
    return await inKeySession(
      seams.passportAuthoriser,
      {
        kind: 'call-contract',
        account: AccAddress(account.address),
        bundleId: bundle.id,
        circuit,
        args: canonical,
        callees: calleeAddressesOf(descriptor.args, canonical),
      },
      async () => {
        const record = await accountRecords.read();
        const accepted = await submitAccountCall(
          {
            circuit,
            args: decoded,
            witnessValues,
            ...(privateState ? { privateState } : {}),
            bundleId: bundle.id,
            account,
            bundles,
            localUseCounter,
            ledgerState,
            onStage: onProgress,
          },
          seams,
        );
        const counter = accepted.advancedCounter.toString();
        await accountRecords.write(
          completedRecord(account, counter, { grants: record?.grants }),
        );
        if (accepted.txId === undefined) {
          throw new Error(
            `The call to ${circuit} landed without a transaction id.`,
          );
        }
        const result = renderResult(accepted.result);
        return {
          circuit,
          txId: accepted.txId,
          ...(result === undefined ? {} : { result }),
          devices: withRefreshedLocalDevice(
            devices,
            accepted.localCommitmentHex,
          ),
          localUseCounter: counter,
        };
      },
    );
  } catch (error) {
    throw classifyContractAbort(error);
  }
};
