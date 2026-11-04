/**
 * The key hashes a transaction body asks to be witnessed, own or foreign: the
 * full-sign gate checks a signer covers each one before consent, and the
 * post-sign check verifies each one after.
 */
import { Cardano } from '@lace-lib/vendor';

const keyHashOf = (
  credential: { type: Cardano.CredentialType; hash: string } | undefined,
): string[] =>
  credential?.type === Cardano.CredentialType.KeyHash ? [credential.hash] : [];

/** Key hashes a certificate needs witnessed, per the ledger's rules. */
const certificateKeyHashes = (certificate: Cardano.Certificate): string[] => {
  switch (certificate.__typename) {
    case Cardano.CertificateType.StakeDeregistration:
    case Cardano.CertificateType.StakeDelegation:
    case Cardano.CertificateType.Registration:
    case Cardano.CertificateType.Unregistration:
    case Cardano.CertificateType.VoteDelegation:
    case Cardano.CertificateType.StakeVoteDelegation:
    case Cardano.CertificateType.StakeRegistrationDelegation:
    case Cardano.CertificateType.VoteRegistrationDelegation:
    case Cardano.CertificateType.StakeVoteRegistrationDelegation: {
      return keyHashOf(certificate.stakeCredential);
    }
    case Cardano.CertificateType.RegisterDelegateRepresentative:
    case Cardano.CertificateType.UpdateDelegateRepresentative:
    case Cardano.CertificateType.UnregisterDelegateRepresentative: {
      return keyHashOf(certificate.dRepCredential);
    }
    case Cardano.CertificateType.AuthorizeCommitteeHot:
    case Cardano.CertificateType.ResignCommitteeCold: {
      return keyHashOf(certificate.coldCredential);
    }
    case Cardano.CertificateType.PoolRegistration: {
      const { id, owners } = certificate.poolParameters;
      return [
        Cardano.PoolId.toKeyHash(id),
        ...owners.map(owner => Cardano.RewardAccount.toHash(owner)),
      ];
    }
    case Cardano.CertificateType.PoolRetirement: {
      return [Cardano.PoolId.toKeyHash(certificate.poolId)];
    }
    // A Shelley stake registration needs no witness; MIR and genesis delegation
    // need genesis keys, and Conway rejects both outright.
    case Cardano.CertificateType.StakeRegistration:
    case Cardano.CertificateType.MIR:
    case Cardano.CertificateType.GenesisKeyDelegation: {
      return [];
    }
  }
};

/** Key-hash obligations the body states on its own, own or foreign. */
export const bodyKeyHashObligations = (body: Cardano.TxBody): string[] => [
  ...(body.requiredExtraSignatures ?? []),
  ...(body.withdrawals ?? []).flatMap(({ stakeAddress }) =>
    keyHashOf(
      Cardano.Address.fromBech32(stakeAddress)
        ?.asReward()
        ?.getPaymentCredential(),
    ),
  ),
  ...(body.certificates ?? []).flatMap(certificate =>
    certificateKeyHashes(certificate),
  ),
  ...(body.votingProcedures ?? []).flatMap(({ voter }) =>
    keyHashOf(voter.credential),
  ),
];
