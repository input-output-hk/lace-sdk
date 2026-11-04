/**
 * The CIP-30 `partialSign: false` gate: the first signature this account
 * cannot produce, or `undefined` when it can produce them all.
 *
 * Runs before consent, in one authoritative pass (the caller injects
 * `resolveInput`), so a refusal never lands after the user has approved.
 * Public-key only: every check is on key hashes and derivation paths from the
 * account xpub.
 *
 * A signature counts as producible iff its key hash is in `witnessKeyHashes`,
 * the signer's own prediction: the key paths its key agent signs, or the paths
 * its device request names. Witnesses already in the request are not
 * counted, so a request carrying a counterparty's signature is refused; such a
 * dApp co-signs with `partialSign: true`.
 */
import {
  Cardano,
  Serialization,
  util as KeyManagementUtil,
} from '@lace-lib/vendor';

import {
  isNativeScriptExact,
  isNativeScriptSatisfied,
  timelockMetWithin,
} from './native-script-evaluation';
import { getOwnKeyHashes } from './own-key-hashes';
import { bodyKeyHashObligations } from './witness-obligations';

import type { Crypto, GroupedAddress } from '@lace-lib/vendor';

/**
 * The first reason an account cannot sign a transaction in full, in the order
 * `findForeignSignatureRequirement` checks them. CIP-30 answers every one with
 * `TxSignError.ProofGeneration`; lace-next's `@lace-next/core` documents each
 * member and must accept every one.
 */
export type ForeignSignatureRequirement =
  | 'committee-certificate'
  | 'foreign-drep-credential'
  | 'foreign-input'
  | 'foreign-required-signer'
  | 'foreign-stake-credential'
  | 'foreign-voter'
  | 'foreign-withdrawal'
  | 'unsatisfiable-script'
  | 'unsupported-required-signer'
  | 'unwitnessed-own-key';

/**
 * Upper bound on `resolveInput` round-trips per gate call. The unknown-input
 * count comes from dApp CBOR, so without a cap a hostile transaction could
 * drive unbounded provider traffic before the user is prompted; past the cap
 * the gate refuses.
 */
const MAX_PROVIDER_RESOLVED_INPUTS = 30;

/** What the SDK's `checkStakeCredentialCertificates` takes per account. */
type StakeKeySignerData = Parameters<
  typeof KeyManagementUtil.checkStakeCredentialCertificates
>[0][number];

const paymentCredentialOf = (
  address: Cardano.Address,
): Cardano.Credential | undefined =>
  address.asBase()?.getPaymentCredential() ??
  address.asEnterprise()?.getPaymentCredential() ??
  address.asPointer()?.getPaymentCredential();

const parseAddress = (value: string): Cardano.Address | undefined =>
  Cardano.Address.fromString(value) ?? undefined;

/**
 * The SDK's per-account stake data, one entry per DISTINCT reward account and
 * only for accounts whose stake key this wallet can derive — an entry without a
 * `stakeKeyDerivationPath` would claim a signature it cannot produce.
 *
 * `toHash` is typed `Hash28ByteBase16` while the SDK's own field is
 * `Ed25519KeyHashHex`; both are the same 28-byte hex, and the SDK's internal
 * copy of this function passes the value straight through untyped.
 */
const getSignersData = (
  knownAddresses: readonly GroupedAddress[],
): StakeKeySignerData[] => {
  const seen = new Set<Cardano.RewardAccount>();
  const result: StakeKeySignerData[] = [];
  for (const groupedAddress of knownAddresses) {
    if (seen.has(groupedAddress.rewardAccount)) continue;
    seen.add(groupedAddress.rewardAccount);
    const { stakeKeyDerivationPath } = groupedAddress;
    if (stakeKeyDerivationPath === undefined) continue;
    const stakeKeyHash = Cardano.RewardAccount.toHash(
      groupedAddress.rewardAccount,
    ) as unknown as Crypto.Ed25519KeyHashHex;
    result.push({
      derivationPath: stakeKeyDerivationPath,
      poolId: Cardano.PoolId.fromKeyHash(stakeKeyHash),
      rewardAccount: groupedAddress.rewardAccount,
      stakeKeyHash,
    });
  }
  return result;
};

/** Inputs and collaterals absent from the local UTxO set, de-duplicated. */
const getUnknownInputs = (
  { collaterals = [], inputs }: Pick<Cardano.TxBody, 'collaterals' | 'inputs'>,
  utxoSet: readonly Cardano.Utxo[],
): Cardano.TxIn[] => {
  const seen = new Set<string>();
  return [...inputs, ...collaterals].filter(txIn => {
    const outpoint = `${txIn.txId}#${txIn.index}`;
    if (seen.has(outpoint)) return false;
    seen.add(outpoint);
    return utxoSet.every(
      ([candidate]) =>
        candidate.txId !== txIn.txId || candidate.index !== txIn.index,
    );
  });
};

const hasCommitteeCertificates = ({ certificates }: Cardano.TxBody): boolean =>
  (certificates ?? []).some(
    certificate =>
      certificate.__typename ===
        Cardano.CertificateType.AuthorizeCommitteeHot ||
      certificate.__typename === Cardano.CertificateType.ResignCommitteeCold,
  );

/**
 * True unless the input's resolved output sits at a script address whose native
 * script the signer satisfies on its own, so no other party has to witness it.
 * An UNRESOLVABLE input stays foreign — the gate fails closed. A provider
 * failure is not an answer: `resolveInput` rejects and so does the gate.
 */
const isForeignInput = async (
  txIn: Cardano.TxIn,
  resolveInput: (txIn: Cardano.TxIn) => Promise<Cardano.Address | undefined>,
  ownedScriptHashes: ReadonlySet<string>,
): Promise<boolean> => {
  const address = await resolveInput(txIn);
  if (!address) return true;
  const paymentCredential = paymentCredentialOf(address);
  return !(
    paymentCredential?.type === Cardano.CredentialType.ScriptHash &&
    ownedScriptHashes.has(paymentCredential.hash)
  );
};

/**
 * The first reason this account cannot sign `tx` in full, or `undefined` when
 * every signature it needs is one this account can produce. Reasons are
 * checked in the order below; the earliest match wins.
 *
 * @param dRepKeyHash - this account's own DRep key hash. The SDK reads a
 *   missing hash like a foreign credential, so a placeholder would refuse the
 *   account's own governance transaction as `foreign-drep-credential`.
 * @param witnessKeyHashes - the key hashes this account's signer witnesses for
 *   `tx`. A device that builds its request from the body alone (Ledger) omits
 *   an own key only a native script names.
 * @param resolveInput - resolves an input outside `utxoSet`; `undefined` means
 *   unresolvable and counts as foreign. Called at most
 *   `MAX_PROVIDER_RESOLVED_INPUTS` times, and not at all unless a native script
 *   makes an unknown input worth resolving.
 */
export const findForeignSignatureRequirement = async ({
  dRepKeyHash,
  knownAddresses,
  resolveInput,
  tx,
  utxoSet,
  witnessKeyHashes,
}: {
  dRepKeyHash: Crypto.Ed25519KeyHashHex;
  knownAddresses: readonly GroupedAddress[];
  resolveInput: (txIn: Cardano.TxIn) => Promise<Cardano.Address | undefined>;
  tx: Cardano.Tx;
  utxoSet: readonly Cardano.Utxo[];
  witnessKeyHashes: ReadonlySet<string>;
}): Promise<ForeignSignatureRequirement | undefined> => {
  const ownKeyHashes = getOwnKeyHashes(knownAddresses);

  const nativeScripts = (tx.witness.scripts ?? []).filter(element =>
    Cardano.isNativeScript(element),
  );
  const isTimelockMet = timelockMetWithin(tx.body.validityInterval);
  // An inexact script fails closed: its hash below would be another script's.
  if (
    nativeScripts.some(
      script =>
        !isNativeScriptExact(script) ||
        !isNativeScriptSatisfied(script, {
          hasKeyWitness: keyHash => witnessKeyHashes.has(keyHash),
          isTimelockMet,
        }),
    )
  ) {
    return 'unsatisfiable-script';
  }

  // Every native script passed above, so each one the signer completes alone;
  // an unknown input is exempt only when it spends one of them.
  const ownedScriptHashes = new Set<string>(
    nativeScripts.map(script =>
      Serialization.NativeScript.fromCore(script).hash(),
    ),
  );
  const unknownInputs = getUnknownInputs(tx.body, utxoSet);
  if (unknownInputs.length > 0) {
    if (ownedScriptHashes.size === 0) return 'foreign-input';
    if (unknownInputs.length > MAX_PROVIDER_RESOLVED_INPUTS)
      return 'foreign-input';
    const foreign = await Promise.all(
      unknownInputs.map(async txIn =>
        isForeignInput(txIn, resolveInput, ownedScriptHashes),
      ),
    );
    if (foreign.includes(true)) return 'foreign-input';
  }

  // An own key the signer will not witness is unsupported, not foreign: the
  // SDK maps a required signer to a path only via payment and stake
  // credentials, so the own DRep key is witnessed only when an own-DRep
  // certificate or vote already requests role 3.
  for (const keyHash of tx.body.requiredExtraSignatures ?? []) {
    if (witnessKeyHashes.has(keyHash)) continue;
    if (ownKeyHashes.has(keyHash) || keyHash === dRepKeyHash) {
      return 'unsupported-required-signer';
    }
    return 'foreign-required-signer';
  }

  // A withdrawal is own when this account holds its stake key or controls it
  // through an own native script. Checked here because the SDK's withdrawal
  // check is unreachable from outside it.
  for (const { stakeAddress } of tx.body.withdrawals ?? []) {
    const isOwnRewardAccount = knownAddresses.some(
      known =>
        known.rewardAccount === stakeAddress &&
        known.stakeKeyDerivationPath !== undefined,
    );
    if (isOwnRewardAccount) continue;
    const credential = parseAddress(String(stakeAddress))
      ?.asReward()
      ?.getPaymentCredential();
    if (
      credential?.type === Cardano.CredentialType.ScriptHash &&
      ownedScriptHashes.has(credential.hash)
    ) {
      continue;
    }
    return 'foreign-withdrawal';
  }

  if (
    KeyManagementUtil.checkStakeCredentialCertificates(
      getSignersData(knownAddresses),
      tx.body,
    ).requiresForeignSignatures
  ) {
    return 'foreign-stake-credential';
  }
  if (
    KeyManagementUtil.getDRepCredentialKeyPaths({
      dRepKeyHash,
      txBody: tx.body,
    }).requiresForeignSignatures
  ) {
    return 'foreign-drep-credential';
  }
  if (
    KeyManagementUtil.getVotingProcedureKeyPaths({
      dRepKeyHash,
      groupedAddresses: [...knownAddresses],
      txBody: tx.body,
    }).requiresForeignSignatures
  ) {
    return 'foreign-voter';
  }
  if (hasCommitteeCertificates(tx.body)) return 'committee-certificate';

  // Every key the body needs must be one the signer produces. The checks above
  // name the common cases; what reaches here is an own key the device request
  // encodes as a hash (a stake-pool vote under the account's stake key), or a
  // pool operator the SDK's certificate check does not look at.
  for (const keyHash of bodyKeyHashObligations(tx.body)) {
    if (witnessKeyHashes.has(keyHash)) continue;
    return ownKeyHashes.has(keyHash) || keyHash === dRepKeyHash
      ? 'unwitnessed-own-key'
      : 'foreign-stake-credential';
  }

  return undefined;
};
