import { CircuitNotRegisteredError } from '@lace-contract/passport';

import { pureCircuits } from './acc-module';

import type { AccountModule, CircuitDescriptor } from '@lace-contract/passport';
import type { JubjubPoint } from '@midnight-ntwrk/compact-runtime';

/**
 * The call-site facts every challenge binds: which account the call
 * executes against and the auth nonce it will consume (read before the
 * contract increments it), so a signature authorises exactly one call on
 * exactly one account.
 */
export type CallContext = {
  contractAddress: Uint8Array;
  authNonce: bigint;
};

/**
 * A jubjub-arm challenge builder: the per-circuit challenge preimage hash,
 * closed over the account address, the circuit's arguments, and the
 * observed auth nonce. The signer varies only the announcement and the
 * grind nonce.
 */
export type ChallengeBuilder = (
  sigR: JubjubPoint,
  grindNonce: bigint,
) => Uint8Array;

/**
 * What the issue-grant challenge binds beyond the call context: the grant
 * id and the salted digest of the plaintext scope, so the device signs the
 * whole scope through one element.
 */
export type IssueGrantBinding = {
  grantId: Uint8Array;
  scopeDigest: Uint8Array;
};

const address = (context: CallContext) => ({
  bytes: context.contractAddress,
});

/**
 * Per-circuit challenge builders for the jubjub-gated circuits this module
 * calls. The preimage layout is produced by the contract's own exported
 * pure circuits: a per-circuit domain separation tag, the account address,
 * the signature announcement, the device public key, the circuit's
 * arguments in declaration order, the auth nonce, and the grind nonce.
 * The grant lifecycle circuits sit in the same tag family as the device
 * circuits; the issue challenge carries the grant id and the scope digest
 * rather than the scope's fields. The encryption key circuits bind the
 * key `enc_key` is replaced with and the entry appended to the inbox.
 * `activate_initial_device_with_jubjub` is permissionless and has no
 * challenge.
 */
export const jubjubChallenges = {
  /** Challenge over the new device's derived entry. */
  addDevice:
    (
      context: CallContext,
      pk: JubjubPoint,
      newEntry: Uint8Array,
    ): ChallengeBuilder =>
    (sigR, grindNonce) =>
      pureCircuits.challenge_add_device_with_jubjub(
        address(context),
        sigR,
        pk,
        newEntry,
        context.authNonce,
        grindNonce,
      ),

  /** Challenge over the removed device's stored entry. */
  removeDevice:
    (
      context: CallContext,
      pk: JubjubPoint,
      entry: Uint8Array,
    ): ChallengeBuilder =>
    (sigR, grindNonce) =>
      pureCircuits.challenge_remove_device_with_jubjub(
        address(context),
        sigR,
        pk,
        entry,
        context.authNonce,
        grindNonce,
      ),

  /** Challenge over the grant id and the salted digest of its scope. */
  issueGrant:
    (
      context: CallContext,
      pk: JubjubPoint,
      binding: IssueGrantBinding,
    ): ChallengeBuilder =>
    (sigR, grindNonce) =>
      pureCircuits.challenge_issue_grant_with_jubjub(
        address(context),
        sigR,
        pk,
        binding.grantId,
        binding.scopeDigest,
        context.authNonce,
        grindNonce,
      ),

  /** Challenge over the revoked grant's id. */
  revokeGrant:
    (
      context: CallContext,
      pk: JubjubPoint,
      grantId: Uint8Array,
    ): ChallengeBuilder =>
    (sigR, grindNonce) =>
      pureCircuits.challenge_revoke_grant_with_jubjub(
        address(context),
        sigR,
        pk,
        grantId,
        context.authNonce,
        grindNonce,
      ),

  /** Challenge over the raw X25519 public key `enc_key` is replaced with. */
  rotateEncKey:
    (
      context: CallContext,
      pk: JubjubPoint,
      newKey: Uint8Array,
    ): ChallengeBuilder =>
    (sigR, grindNonce) =>
      pureCircuits.challenge_rotate_enc_key_with_jubjub(
        address(context),
        sigR,
        pk,
        newKey,
        context.authNonce,
        grindNonce,
      ),

  /** Challenge over the 192-byte inbox entry appended. */
  appendInbox:
    (
      context: CallContext,
      pk: JubjubPoint,
      entry: Uint8Array,
    ): ChallengeBuilder =>
    (sigR, grindNonce) =>
      pureCircuits.challenge_append_inbox_with_jubjub(
        address(context),
        sigR,
        pk,
        entry,
        context.authNonce,
        grindNonce,
      ),

  /** Challenge over the call context alone; the circuit takes no argument. */
  revokeAllGrants:
    (context: CallContext, pk: JubjubPoint): ChallengeBuilder =>
    (sigR, grindNonce) =>
      pureCircuits.challenge_revoke_all_grants_with_jubjub(
        address(context),
        sigR,
        pk,
        context.authNonce,
        grindNonce,
      ),
};

/** What the challenge of a described circuit is built from: the module, the descriptor and the call. */
type DescriptorChallengeProps = {
  /** The pure circuits of the bundle module that compiled the circuit. */
  pureCircuits: AccountModule['pureCircuits'];
  /** The circuit the call runs, as the refusal names it. */
  circuit: string;
  /** The bundle's descriptor of that circuit. */
  descriptor: CircuitDescriptor;
  /** The call's arguments, in the order the descriptor declares them. */
  args: readonly unknown[];
  /** The call's witness values, in the order the descriptor declares them. */
  witnessValues: readonly unknown[];
};

/**
 * Builds the challenge of one call once the device key is at hand, from
 * the call context and the device public key the signature is checked
 * against.
 */
export type ContextChallenge = (
  context: CallContext,
  pk: JubjubPoint,
) => ChallengeBuilder;

/** A challenge pure circuit as a bundle module exports it. */
type ChallengeCircuit = (...values: unknown[]) => Uint8Array;

/**
 * The pure circuit a bundle module exports under `name`, or undefined
 * when it exports none; an inherited property such as `constructor` is
 * no circuit.
 */
const exportedCircuit = (
  circuits: AccountModule['pureCircuits'],
  name: string,
): ChallengeCircuit | undefined => {
  const value = Object.hasOwn(circuits, name) ? circuits[name] : undefined;
  return typeof value === 'function' ? (value as ChallengeCircuit) : undefined;
};

/**
 * The value a challenge argument names: the call argument at the
 * position of its descriptor, or the witness value at the position of
 * its witness descriptor.
 */
const challengeValue = (
  { circuit, descriptor, args, witnessValues }: DescriptorChallengeProps,
  name: string,
): unknown => {
  const argument = descriptor.args.findIndex(
    candidate => candidate.name === name,
  );
  const witness = descriptor.witnesses.findIndex(
    candidate => candidate.name === name,
  );
  const value =
    argument >= 0
      ? args[argument]
      : witness >= 0
      ? witnessValues[witness]
      : undefined;
  if (value === undefined) {
    throw new CircuitNotRegisteredError(
      `Circuit ${circuit} has no value for challenge argument '${name}' its descriptor names.`,
    );
  }
  return value;
};

/**
 * The challenge of a circuit a bundle describes, over the pure circuit
 * its descriptor names, which follows the contract's convention for
 * every gated circuit: the account address, the signature announcement,
 * the device public key, the values the descriptor's challenge arguments
 * name in its order, the auth nonce and the grind nonce. The module's
 * own circuits keep the builders above; this one lets a device sign a
 * call to any circuit a registered build adds. The pure circuit and the
 * values are resolved here, before the device key is asked for, so a
 * call the module cannot challenge is refused without a ceremony.
 *
 * @throws {@link CircuitNotRegisteredError} naming the circuit when the
 * module exports no pure circuit under the descriptor's challenge name,
 * or a challenge argument names no value of the call.
 */
export const descriptorChallenge = (
  props: DescriptorChallengeProps,
): ContextChallenge => {
  const { pureCircuits: circuits, circuit, descriptor } = props;
  const challenge = exportedCircuit(circuits, descriptor.challenge);
  if (!challenge) {
    throw new CircuitNotRegisteredError(
      `Circuit ${circuit} names challenge '${descriptor.challenge}', which its bundle module does not export.`,
    );
  }
  const values = descriptor.challengeArgs.map(name =>
    challengeValue(props, name),
  );
  return (context, pk) => (sigR, grindNonce) =>
    challenge(
      address(context),
      sigR,
      pk,
      ...values,
      context.authNonce,
      grindNonce,
    );
};
