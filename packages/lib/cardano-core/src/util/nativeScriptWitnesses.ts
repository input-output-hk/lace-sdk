import { Address, CredentialType } from '../Cardano/Address';
import { AssetId } from '../Cardano/types/Asset';
import { CertificateType } from '../Cardano/types/Certificate';
import { GovernanceActionType } from '../Cardano/types/Governance';
import { isNativeScript } from '../Cardano/types/Script';
import { Script as SerializableScript } from '../Serialization/Scripts';

import type { Credential } from '../Cardano/Address';
import type { Certificate } from '../Cardano/types/Certificate';
import type { GovernanceAction } from '../Cardano/types/Governance';
import type { Script } from '../Cardano/types/Script';
import type { SubTransactionBody, TxBody } from '../Cardano/types/Transaction';
import type { TxIn } from '../Cardano/types/Utxo';
import type { Hash28ByteBase16 } from '@lace-lib/cardano-crypto';

/** A transaction body or a sub transaction body. */
type WitnessedBody = SubTransactionBody | TxBody;

/**
 * Tells what locks the output an input spends: the hash of the script that
 * locks it, null when no script does, or undefined when the output is not
 * known.
 */
export type SpentScriptHashResolver = (
  txIn: TxIn,
) => Hash28ByteBase16 | null | undefined;

/**
 * Gets the hash of the script that locks the outputs at an address.
 *
 * @param address The address, in bech32 or base58.
 * @returns The script hash of its payment credential, or null when a key
 *   locks it.
 */
export const spentScriptHash = (address: string): Hash28ByteBase16 | null => {
  const paymentPart = Address.fromString(address)?.getProps().paymentPart;
  return paymentPart?.type === CredentialType.ScriptHash
    ? paymentPart.hash
    : null;
};

/**
 * Gets the credentials a certificate must be witnessed for. A legacy stake
 * registration needs no witness, and the pool and MIR certificates name key
 * hashes only.
 *
 * @param certificate The certificate.
 * @returns The credentials it must be witnessed for.
 */
const certificateCredentials = (certificate: Certificate): Credential[] => {
  switch (certificate.__typename) {
    case CertificateType.VoteDelegation:
    case CertificateType.StakeVoteDelegation:
    case CertificateType.StakeRegistrationDelegation:
    case CertificateType.VoteRegistrationDelegation:
    case CertificateType.StakeVoteRegistrationDelegation:
    case CertificateType.Registration:
    case CertificateType.Unregistration:
    case CertificateType.StakeDeregistration:
    case CertificateType.StakeDelegation:
      return [certificate.stakeCredential];
    case CertificateType.RegisterDelegateRepresentative:
    case CertificateType.UnregisterDelegateRepresentative:
    case CertificateType.UpdateDelegateRepresentative:
      return [certificate.dRepCredential];
    case CertificateType.AuthorizeCommitteeHot:
    case CertificateType.ResignCommitteeCold:
      return [certificate.coldCredential];
    default:
      return [];
  }
};

/**
 * Gets the hash of the guardrail policy a governance action must be witnessed
 * for. Only parameter change and treasury withdrawal proposals carry one.
 *
 * @param action The governance action.
 * @returns The policy hash, or null when the action has none.
 */
const governanceActionPolicyHash = (
  action: GovernanceAction,
): string | null => {
  switch (action.__typename) {
    case GovernanceActionType.parameter_change_action:
    case GovernanceActionType.treasury_withdrawals_action:
      return action.policyHash;
    default:
      return null;
  }
};

/**
 * Gets the hashes of the scripts a body must be witnessed for, besides those
 * locking the outputs it spends: the script credentials of its withdrawals,
 * certificates, voters and guards, its minting policies and the policies of
 * its proposals. A top level
 * body also carries the guards its sub transactions require of it.
 *
 * @param body The transaction or sub transaction body.
 * @returns The script hashes.
 */
const bodyScriptHashes = (body: WitnessedBody): Set<string> => {
  const requiredTopLevelGuards =
    'subTransactions' in body
      ? (body.subTransactions ?? []).flatMap(subTransaction =>
          (subTransaction.body.requiredTopLevelGuards ?? []).map(
            ({ credential }) => credential,
          ),
        )
      : [];
  const credentials: Credential[] = [
    ...(body.withdrawals ?? []).map(({ stakeAddress }) =>
      Address.fromBech32(stakeAddress).asReward()!.getPaymentCredential(),
    ),
    ...(body.certificates ?? []).flatMap(certificateCredentials),
    ...(body.votingProcedures ?? []).map(({ voter }) => voter.credential),
    ...(body.guards ?? []),
    ...requiredTopLevelGuards,
  ];
  return new Set<string>([
    ...credentials
      .filter(({ type }) => type === CredentialType.ScriptHash)
      .map(({ hash }) => hash),
    ...[...(body.mint?.keys() ?? [])].map(AssetId.getPolicyId),
    ...(body.proposalProcedures ?? [])
      .map(({ governanceAction }) =>
        governanceActionPolicyHash(governanceAction),
      )
      .filter((hash): hash is string => hash !== null),
  ]);
};

/**
 * Gets the scripts a body can be witnessed with: the given ones, and for a
 * top level body also those its sub transactions carry, since the scripts of
 * a batch witness every level of it. A script given twice counts once.
 *
 * @param body The transaction or sub transaction body.
 * @param scripts The scripts of its own witness set and any others known.
 * @returns Every distinct script available to the body.
 */
export const batchWitnessScripts = (
  body: WitnessedBody,
  scripts: Script[] | undefined,
): Script[] => {
  const carried =
    'subTransactions' in body
      ? (body.subTransactions ?? []).flatMap(
          ({ witness }) => witness.scripts ?? [],
        )
      : [];
  if (carried.length === 0) return scripts ?? [];
  const seen = new Set<string>();
  return [...(scripts ?? []), ...carried].filter(script => {
    const hash = SerializableScript.fromCore(script).hash();
    if (seen.has(hash)) return false;
    seen.add(hash);
    return true;
  });
};

/**
 * Gets the native scripts a body must be witnessed for, whose keys its
 * signers must sign with: those an input it spends is locked by, and those
 * its withdrawals, certificates, voters, guards, minting policies and
 * proposal policies name, with the guards its sub transactions require of a
 * top level body. While an input spends an output that is not known, any
 * script may lock it, so every native script counts.
 *
 * @param props.body The transaction or sub transaction body.
 * @param props.scripts The scripts available to the body.
 * @param props.resolveSpentScriptHash Tells what locks the output each input
 *   spends.
 * @returns The native scripts the body needs.
 */
export const neededNativeScripts = ({
  body,
  scripts,
  resolveSpentScriptHash,
}: {
  body: WitnessedBody;
  scripts: Script[];
  resolveSpentScriptHash: SpentScriptHashResolver;
}): Script[] => {
  const nativeScripts = scripts.filter(isNativeScript);
  if (nativeScripts.length === 0) return nativeScripts;
  const hashes = bodyScriptHashes(body);
  for (const txIn of body.inputs) {
    const hash = resolveSpentScriptHash(txIn);
    if (hash === undefined) return nativeScripts;
    if (hash !== null) hashes.add(hash);
  }
  return nativeScripts.filter(script =>
    hashes.has(SerializableScript.fromCore(script).hash()),
  );
};
