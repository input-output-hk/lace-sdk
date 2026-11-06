import {
  Cardano,
  batchWitnessScripts,
  neededNativeScripts,
  spentScriptHash,
} from '@lace-lib/cardano-core';
import * as Crypto from '@lace-lib/cardano-crypto';
import { isNotNil } from '@lace-lib/cardano-util';
import isEqual from 'lodash/isEqual.js';
import uniqBy from 'lodash/uniqBy.js';
import uniqWith from 'lodash/uniqWith.js';

import { TxInId } from '../types';

import { DREP_KEY_DERIVATION_PATH } from './key';

import type {
  AccountKeyDerivationPath,
  GroupedAddress,
  SpentOutputAddressMap,
  TxInKeyPathMap,
} from '../types';
import type { SpentScriptHashResolver } from '@lace-lib/cardano-core';

/**
 * A transaction body or a sub transaction body. The vkey witnesses of either
 * sign its own id, the hash of the body, and the keys they must cover are
 * those its own body needs.
 */
export type SignableTxBody = Cardano.SubTransactionBody | Cardano.TxBody;

export type StakeKeySignerData = {
  poolId: Cardano.PoolId;
  rewardAccount: Cardano.RewardAccount;
  stakeKeyHash: Crypto.Ed25519KeyHashHex;
  derivationPath: AccountKeyDerivationPath;
};

/** Return type of functions that inspect transaction parts for signatures */
type SignatureCheck = {
  /** Signature derivation paths */
  derivationPaths: AccountKeyDerivationPath[];
  /** Whether foreign signatures (not owned by wallet) are needed */
  requiresForeignSignatures: boolean;
};

/** Checks whether the transaction withdrawals contain foreign signatures and returns known derivation paths  */
const checkWithdrawals = (
  { withdrawals }: Pick<Cardano.TxBody, 'withdrawals'>,
  accounts: StakeKeySignerData[],
): SignatureCheck => {
  const signatureCheck: SignatureCheck = {
    derivationPaths: [],
    requiresForeignSignatures: false,
  };
  if (withdrawals) {
    for (const withdrawal of withdrawals) {
      const account = accounts.find(
        acct => acct.rewardAccount === withdrawal.stakeAddress,
      );
      if (account) {
        signatureCheck.derivationPaths.push(account.derivationPath);
      } else {
        signatureCheck.requiresForeignSignatures = true;
      }
    }
  }

  return signatureCheck;
};

const checkStakeKeyHashCertificate = (
  certificate: Cardano.Certificate,
  accounts: StakeKeySignerData[],
): SignatureCheck => {
  const signatureCheck: SignatureCheck = {
    derivationPaths: [],
    requiresForeignSignatures: false,
  };
  switch (certificate.__typename) {
    case Cardano.CertificateType.VoteDelegation:
    case Cardano.CertificateType.StakeVoteDelegation:
    case Cardano.CertificateType.StakeRegistrationDelegation:
    case Cardano.CertificateType.VoteRegistrationDelegation:
    case Cardano.CertificateType.StakeVoteRegistrationDelegation:
    case Cardano.CertificateType.Registration:
    case Cardano.CertificateType.Unregistration:
    case Cardano.CertificateType.StakeDeregistration:
    case Cardano.CertificateType.StakeDelegation: {
      const account = accounts.find(
        acct =>
          certificate.stakeCredential.type === Cardano.CredentialType.KeyHash &&
          acct.stakeKeyHash ===
            (certificate.stakeCredential
              .hash as unknown as Crypto.Ed25519KeyHashHex),
      );
      if (account) {
        signatureCheck.derivationPaths = [account.derivationPath];
      } else {
        signatureCheck.requiresForeignSignatures = true;
      }
    }
  }
  return signatureCheck;
};

const checkPoolRegistrationCertificate = (
  certificate: Cardano.Certificate,
  accounts: StakeKeySignerData[],
): SignatureCheck => {
  const signatureCheck: SignatureCheck = {
    derivationPaths: [],
    requiresForeignSignatures: false,
  };
  if (certificate.__typename === Cardano.CertificateType.PoolRegistration) {
    for (const owner of certificate.poolParameters.owners) {
      const account = accounts.find(acct => acct.rewardAccount === owner);
      if (account) {
        signatureCheck.derivationPaths.push(account.derivationPath);
      } else {
        signatureCheck.requiresForeignSignatures = true;
      }
    }
  }
  return signatureCheck;
};

const checkPoolRetirementCertificate = (
  certificate: Cardano.Certificate,
  accounts: StakeKeySignerData[],
): SignatureCheck => {
  const signatureCheck: SignatureCheck = {
    derivationPaths: [],
    requiresForeignSignatures: false,
  };
  if (certificate.__typename === Cardano.CertificateType.PoolRetirement) {
    const account = accounts.find(acct => acct.poolId === certificate.poolId);
    if (account) {
      signatureCheck.derivationPaths.push(account.derivationPath);
    } else {
      signatureCheck.requiresForeignSignatures = true;
    }
  }
  return signatureCheck;
};

const checkMirCertificate = (
  certificate: Cardano.Certificate,
  accounts: StakeKeySignerData[],
): SignatureCheck => {
  const signatureCheck: SignatureCheck = {
    derivationPaths: [],
    requiresForeignSignatures: false,
  };
  if (certificate.__typename === Cardano.CertificateType.MIR) {
    if (certificate.kind === Cardano.MirCertificateKind.ToStakeCreds) {
      const account = accounts.find(
        acct =>
          Crypto.Hash28ByteBase16(acct.stakeKeyHash) ===
          certificate.stakeCredential!.hash,
      );
      if (account) {
        signatureCheck.derivationPaths.push(account.derivationPath);
      } else {
        signatureCheck.requiresForeignSignatures = true;
      }
    } else {
      signatureCheck.requiresForeignSignatures = true;
    }
  }
  return signatureCheck;
};

/**
 * Inspect certificates against own stake credentials. Determines the signature derivation paths, and wether there
 * are certificates it cannot sign (foreign signatures).
 */
export const checkStakeCredentialCertificates = (
  accounts: StakeKeySignerData[],
  { certificates }: Pick<Cardano.TxBody, 'certificates'>,
): SignatureCheck => {
  const signatureCheck: SignatureCheck = {
    derivationPaths: [],
    requiresForeignSignatures: false,
  };

  if (!certificates?.length) {
    return signatureCheck;
  }

  for (const certificate of certificates) {
    const stakeKeyHashCheck = checkStakeKeyHashCertificate(
      certificate,
      accounts,
    );
    signatureCheck.requiresForeignSignatures ||=
      stakeKeyHashCheck.requiresForeignSignatures;
    signatureCheck.derivationPaths.push(...stakeKeyHashCheck.derivationPaths);

    const poolOwnerCheck = checkPoolRegistrationCertificate(
      certificate,
      accounts,
    );
    signatureCheck.requiresForeignSignatures ||=
      poolOwnerCheck.requiresForeignSignatures;
    signatureCheck.derivationPaths.push(...poolOwnerCheck.derivationPaths);

    const poolIdCheck = checkPoolRetirementCertificate(certificate, accounts);
    signatureCheck.requiresForeignSignatures ||=
      poolIdCheck.requiresForeignSignatures;
    signatureCheck.derivationPaths.push(...poolIdCheck.derivationPaths);

    const mirCheck = checkMirCertificate(certificate, accounts);
    signatureCheck.requiresForeignSignatures ||=
      mirCheck.requiresForeignSignatures;
    signatureCheck.derivationPaths.push(...mirCheck.derivationPaths);

    // StakeRegistration and GenesisKeyDelegation do not require signing
  }

  signatureCheck.derivationPaths = uniqWith(
    signatureCheck.derivationPaths,
    isEqual,
  );
  return signatureCheck;
};

const getSignersData = (
  groupedAddresses: GroupedAddress[],
): StakeKeySignerData[] =>
  uniqBy(groupedAddresses, 'rewardAccount')
    .map(groupedAddress => {
      const stakeKeyHash = Cardano.RewardAccount.toHash(
        groupedAddress.rewardAccount,
      ) as unknown as Crypto.Ed25519KeyHashHex;
      const poolId = Cardano.PoolId.fromKeyHash(stakeKeyHash);
      return {
        derivationPath: groupedAddress.stakeKeyDerivationPath,
        poolId,
        rewardAccount: groupedAddress.rewardAccount,
        stakeKeyHash,
      };
    })
    .filter(
      (acct): acct is StakeKeySignerData => acct.derivationPath !== undefined,
    );

/**
 * Gets whether withdrawals or any certificate in the provided certificate list requires a stake key signature.
 *
 * @param groupedAddresses The known grouped addresses.
 * @param txBody The transaction body.
 */
const getStakeCredentialKeyPaths = (
  groupedAddresses: GroupedAddress[],
  txBody: SignableTxBody,
) => {
  let requiresForeignSignatures = false;
  const paths: AccountKeyDerivationPath[] = [];
  const uniqueAccounts = getSignersData(groupedAddresses);

  const withdrawalCheck = checkWithdrawals(txBody, uniqueAccounts);
  requiresForeignSignatures ||= withdrawalCheck.requiresForeignSignatures;
  paths.push(...withdrawalCheck.derivationPaths);

  const stakeCredentialCertificatesCheck = checkStakeCredentialCertificates(
    uniqueAccounts,
    txBody,
  );
  requiresForeignSignatures ||=
    stakeCredentialCertificatesCheck.requiresForeignSignatures;
  paths.push(...stakeCredentialCertificatesCheck.derivationPaths);

  return { derivationPaths: new Set(paths), requiresForeignSignatures };
};

/**
 * Depending on transaction `voting_procedures = { + voter => { + gov_action_id => voting_procedure } }`
 * ; Constitutional Committee Hot KeyHash: 0
 * ; Constitutional Committee Hot ScriptHash: 1
 * ; DRep KeyHash: 2
 * ; DRep ScriptHash: 3
 * ; StakingPool KeyHash: 4
 * voter =
 *   [ 0, addr_keyhash
 *   // 1, scripthash
 *   // 2, addr_keyhash
 *   // 3, scripthash
 *   // 4, addr_keyhash
 *   ]
 */
export const getVotingProcedureKeyPaths = ({
  groupedAddresses,
  dRepKeyHash,
  txBody,
}: {
  groupedAddresses: GroupedAddress[];
  dRepKeyHash?: Crypto.Ed25519KeyHashHex;
  txBody: SignableTxBody;
}): SignatureCheck => {
  const signatureCheck: SignatureCheck = {
    derivationPaths: [],
    requiresForeignSignatures: false,
  };

  const accounts = getSignersData(groupedAddresses);

  for (const { voter } of txBody.votingProcedures || []) {
    switch (voter.__typename) {
      case Cardano.VoterType.dRepKeyHash: {
        if (dRepKeyHash && voter.credential.hash === dRepKeyHash) {
          signatureCheck.derivationPaths.push(DREP_KEY_DERIVATION_PATH);
        } else {
          signatureCheck.requiresForeignSignatures = true;
        }
        break;
      }
      case Cardano.VoterType.stakePoolKeyHash: {
        const account = accounts.find(
          acct => acct.stakeKeyHash === voter.credential.hash,
        );
        if (account) {
          signatureCheck.derivationPaths.push(account.derivationPath);
        } else {
          signatureCheck.requiresForeignSignatures = true;
        }
        break;
      }
      default:
        // case Cardano.VoterType.ccHotKeyHash:
        // case Cardano.VoterType.ccHotScriptHash:
        // case Cardano.VoterType.dRepScriptHash:
        signatureCheck.requiresForeignSignatures = true;
        break;
    }
  }

  return signatureCheck;
};

/**
 * Search for the key hashes provided in the requiredSigners in our current set of known addresses.
 *
 * @param groupedAddresses The known grouped addresses.
 * @param keyHashes The list of required signers key hashes (or undefined if none).
 * @returns A set of derivation paths if any of the key hashes is found.
 */
const getRequiredSignersKeyPaths = (
  groupedAddresses: GroupedAddress[],
  keyHashes?: Crypto.Ed25519KeyHashHex[],
): AccountKeyDerivationPath[] => {
  const paths: AccountKeyDerivationPath[] = [];

  if (!keyHashes) return paths;

  for (const keyHash of keyHashes) {
    for (const address of groupedAddresses) {
      const paymentCredential = Cardano.Address.fromBech32(address.address)
        ?.asBase()
        ?.getPaymentCredential().hash;
      const stakeCredential = Cardano.RewardAccount.toHash(
        address.rewardAccount,
      );

      if (paymentCredential && paymentCredential.toString() === keyHash) {
        paths.push({ index: address.index, role: Number(address.type) });
      }

      if (
        stakeCredential &&
        address.stakeKeyDerivationPath &&
        stakeCredential.toString() === keyHash
      ) {
        paths.push(address.stakeKeyDerivationPath);
      }
    }
  }

  return paths;
};

/**
 * Gets the key hashes of the key hash guards. Script hash guards are
 * satisfied by running a script and need no signature.
 *
 * @param guards The guard credentials (or undefined if none).
 * @returns The key hashes of the key hash guards.
 */
const guardKeyHashes = (
  guards?: Cardano.Credential[],
): Crypto.Ed25519KeyHashHex[] =>
  (guards ?? [])
    .filter(({ type }) => type === Cardano.CredentialType.KeyHash)
    .map(({ hash }) => hash as unknown as Crypto.Ed25519KeyHashHex);

const checkStakeCredential = (
  address: GroupedAddress,
  keyHash: Crypto.Ed25519KeyHashHex,
): SignatureCheck =>
  address.stakeKeyDerivationPath &&
  Cardano.RewardAccount.toHash(address.rewardAccount) === keyHash
    ? {
        derivationPaths: [address.stakeKeyDerivationPath],
        requiresForeignSignatures: false,
      }
    : { derivationPaths: [], requiresForeignSignatures: true };

const checkPaymentCredential = (
  address: GroupedAddress,
  keyHash: Crypto.Ed25519KeyHashHex,
) => {
  const paymentCredential = Cardano.Address.fromBech32(address.address)
    ?.asBase()
    ?.getPaymentCredential();
  if (paymentCredential?.hash === keyHash) {
    return {
      derivationPaths: [{ index: address.index, role: Number(address.type) }],
      requiresForeignSignatures: false,
    };
  }

  return { derivationPaths: [], requiresForeignSignatures: true };
};

const combineSignatureChecks = (
  a: SignatureCheck,
  b: SignatureCheck,
): SignatureCheck => ({
  derivationPaths: [...a.derivationPaths, ...b.derivationPaths],
  requiresForeignSignatures:
    a.requiresForeignSignatures || b.requiresForeignSignatures,
});

const processSignatureScript = (
  script: Cardano.RequireSignatureScript,
  groupedAddresses: GroupedAddress[],
): SignatureCheck => {
  let signatureCheck: SignatureCheck = {
    derivationPaths: [],
    requiresForeignSignatures: false,
  };

  for (const address of groupedAddresses) {
    if (address.stakeKeyDerivationPath) {
      signatureCheck = combineSignatureChecks(
        signatureCheck,
        checkStakeCredential(address, script.keyHash),
      );
    }
    signatureCheck = combineSignatureChecks(
      signatureCheck,
      checkPaymentCredential(address, script.keyHash),
    );
  }

  return signatureCheck;
};

const getNativeScriptKeyPaths = (
  groupedAddresses: GroupedAddress[],
  nativeScripts?: Cardano.Script[],
): SignatureCheck => {
  const signatureCheck: SignatureCheck = {
    derivationPaths: [],
    requiresForeignSignatures: false,
  };
  if (!nativeScripts?.length) return signatureCheck;

  const processScript = (script: Cardano.Script): SignatureCheck => {
    if (!Cardano.isNativeScript(script)) {
      return { derivationPaths: [], requiresForeignSignatures: false };
    }

    switch (script.kind) {
      case Cardano.NativeScriptKind.RequireSignature: {
        return processSignatureScript(script, groupedAddresses);
      }
      case Cardano.NativeScriptKind.RequireAllOf:
      case Cardano.NativeScriptKind.RequireAnyOf:
      case Cardano.NativeScriptKind.RequireNOf: {
        const scriptWithScripts = script as
          | Cardano.RequireAllOfScript
          | Cardano.RequireAnyOfScript;
        return scriptWithScripts.scripts.reduce<SignatureCheck>(
          (acc, subScript) =>
            combineSignatureChecks(acc, processScript(subScript)),
          { derivationPaths: [], requiresForeignSignatures: false },
        );
      }
      case Cardano.NativeScriptKind.RequireTimeBefore:
      case Cardano.NativeScriptKind.RequireTimeAfter:
        return { derivationPaths: [], requiresForeignSignatures: false };
      case Cardano.NativeScriptKind.RequireGuard: {
        // Guards are witnessed at the transaction body level (key 14); key-hash guards also
        // surface through requiredExtraSignatures. Checking own addresses here is defensive.
        const guardScript = script;
        return guardScript.credential.type === Cardano.CredentialType.KeyHash
          ? processSignatureScript(
              {
                __type: Cardano.ScriptType.Native,
                keyHash: guardScript.credential
                  .hash as unknown as Crypto.Ed25519KeyHashHex,
                kind: Cardano.NativeScriptKind.RequireSignature,
              },
              groupedAddresses,
            )
          : { derivationPaths: [], requiresForeignSignatures: false };
      }
    }
  };

  return nativeScripts.reduce<SignatureCheck>(
    (acc, script) => combineSignatureChecks(acc, processScript(script)),
    signatureCheck,
  );
};

/**
 * Tells what locks the output each input of a body spends. An own input
 * spends an output locked by an own key. Any other input spends the output
 * at its resolved address, or one not known when it was not resolved.
 *
 * @param txInKeyPathMap The key paths of the inputs that spend own outputs.
 * @param spentOutputAddresses The resolved addresses of the spent outputs.
 * @returns The resolver.
 */
const spentScriptHashResolver =
  (
    txInKeyPathMap: TxInKeyPathMap,
    spentOutputAddresses: SpentOutputAddressMap,
  ): SpentScriptHashResolver =>
  txIn => {
    const id = TxInId(txIn);
    if (txInKeyPathMap[id]) return null;
    const address = spentOutputAddresses[id];
    return address === undefined ? undefined : spentScriptHash(address);
  };

/** Check if there are certificates that require DRep credentials and if we own them */
export const getDRepCredentialKeyPaths = ({
  dRepKeyHash,
  txBody,
}: {
  dRepKeyHash?: Crypto.Ed25519KeyHashHex;
  txBody: SignableTxBody;
}): SignatureCheck => {
  const signature: SignatureCheck = {
    derivationPaths: [],
    requiresForeignSignatures: false,
  };

  for (const certificate of txBody.certificates || []) {
    if (
      certificate.__typename ===
        Cardano.CertificateType.UnregisterDelegateRepresentative ||
      certificate.__typename ===
        Cardano.CertificateType.UpdateDelegateRepresentative ||
      certificate.__typename ===
        Cardano.CertificateType.RegisterDelegateRepresentative
    ) {
      if (
        certificate.dRepCredential.type === Cardano.CredentialType.ScriptHash ||
        !dRepKeyHash ||
        certificate.dRepCredential.hash !== dRepKeyHash
      ) {
        // Scripts are foreign
        signature.requiresForeignSignatures = true;
      } else {
        // There's only one drep key that the wallet owns.
        signature.derivationPaths = [DREP_KEY_DERIVATION_PATH];
      }
    }
  }

  return signature;
};

/**
 * Maps the inputs and collaterals of a transaction body, or the inputs of a
 * sub transaction body, that spend outputs at own addresses to the key path
 * of the address.
 *
 * @param txBody The transaction or sub transaction body.
 * @param knownAddresses The known grouped addresses.
 * @param inputResolver Resolves each input to the output it spends.
 * @returns The key path of every input that spends an own output.
 */
export const createTxInKeyPathMap = async (
  txBody: SignableTxBody,
  knownAddresses: GroupedAddress[],
  inputResolver: Cardano.InputResolver,
) => {
  const result: TxInKeyPathMap = {};
  const txInputs = [
    ...txBody.inputs,
    ...('collaterals' in txBody && txBody.collaterals
      ? txBody.collaterals
      : []),
  ];
  await Promise.all(
    txInputs.map(async txIn => {
      const resolution = await inputResolver.resolveInput(txIn);
      if (!resolution) return;
      const ownAddress = knownAddresses.find(
        ({ address }) => address === resolution.address,
      );
      if (!ownAddress) return;
      result[TxInId(txIn)] = {
        index: ownAddress.index,
        role: Number(ownAddress.type),
      };
    }),
  );

  return result;
};

/**
 * Maps the inputs of a transaction body, or of a sub transaction body, to the
 * address of the output each spends, so a signer knows which script locks it.
 * An input the resolver does not know is left out.
 *
 * @param txBody The transaction or sub transaction body.
 * @param inputResolver Resolves each input to the output it spends.
 * @returns The address of every resolved spent output.
 */
export const createSpentOutputAddresses = async (
  txBody: SignableTxBody,
  inputResolver: Cardano.InputResolver,
): Promise<SpentOutputAddressMap> => {
  const result: SpentOutputAddressMap = {};
  await Promise.all(
    txBody.inputs.map(async txIn => {
      const resolution = await inputResolver.resolveInput(txIn);
      if (resolution) result[TxInId(txIn)] = resolution.address;
    }),
  );
  return result;
};

/**
 * Gets the native scripts whose keys a body must be signed with. A script
 * counts only when the body needs it, and a top level body may find it in the
 * witness sets of its sub transactions. An input that spends neither an own
 * output nor one in `spentOutputAddresses` may be locked by any script, so
 * while there is one every native script counts.
 *
 * @param txBody The transaction or sub transaction body.
 * @param txInKeyPathMap The key paths of the inputs that spend own outputs.
 * @param scripts The scripts of the witness set.
 * @param spentOutputAddresses The resolved addresses of the spent outputs.
 * @returns The native scripts the body needs.
 */
export const neededSigningScripts = (
  txBody: SignableTxBody,
  txInKeyPathMap: TxInKeyPathMap,
  scripts?: Cardano.Script[],
  spentOutputAddresses: SpentOutputAddressMap = {},
): Cardano.Script[] =>
  neededNativeScripts({
    body: txBody,
    resolveSpentScriptHash: spentScriptHashResolver(
      txInKeyPathMap,
      spentOutputAddresses,
    ),
    scripts: batchWitnessScripts(txBody, scripts),
  });

/**
 * Assumes that a single stake key is used for all addresses (index=0)
 *
 * Accepts a transaction body or a sub transaction body, whose own inputs,
 * withdrawals, certificates, votes, required signers and key hash guards
 * name the keys its id must be signed with. The keys of a native script
 * count only when the body needs that script; a top level body may find it
 * in the witness sets of its sub transactions. An input that spends neither
 * an own output nor one in `spentOutputAddresses` may be locked by any
 * script, so while there is one every native script counts.
 *
 * @returns {AccountKeyDerivationPath[]} derivation paths for keys to sign transaction with
 */
export const ownSignatureKeyPaths = (
  txBody: SignableTxBody,
  knownAddresses: GroupedAddress[],
  txInKeyPathMap: TxInKeyPathMap,
  dRepKeyHash?: Crypto.Ed25519KeyHashHex,
  scripts?: Cardano.Script[],
  spentOutputAddresses: SpentOutputAddressMap = {},
): AccountKeyDerivationPath[] => {
  // TODO: add `proposal_procedure` witnesses.

  const paymentKeyPaths = Object.values(txInKeyPathMap).filter(isNotNil);
  return uniqWith(
    [
      ...paymentKeyPaths,
      ...getStakeCredentialKeyPaths(knownAddresses, txBody).derivationPaths,
      ...getDRepCredentialKeyPaths({ dRepKeyHash, txBody }).derivationPaths,
      ...getRequiredSignersKeyPaths(knownAddresses, [
        ...(txBody.requiredExtraSignatures ?? []),
        ...guardKeyHashes(txBody.guards),
      ]),
      ...getVotingProcedureKeyPaths({
        dRepKeyHash,
        groupedAddresses: knownAddresses,
        txBody,
      }).derivationPaths,
      ...getNativeScriptKeyPaths(
        knownAddresses,
        neededSigningScripts(
          txBody,
          txInKeyPathMap,
          scripts,
          spentOutputAddresses,
        ),
      ).derivationPaths,
    ],
    isEqual,
  );
};
