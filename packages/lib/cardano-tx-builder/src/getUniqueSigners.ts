import {
  Cardano,
  batchWitnessScripts,
  neededNativeScripts,
  spentScriptHash,
} from '@lace-lib/cardano-core';

import type * as Crypto from '@lace-lib/cardano-crypto';

/**
 * Utility function that conditionally adds a value to a set.
 * Adds the value only if it is not `null` or `undefined`.
 *
 * @typeParam T - The type of the elements stored in the set.
 * @param set - The set to which the value will be added.
 * @param v - The value to conditionally add.
 */
const addIf = <T>(set: Set<T>, v: T | null | undefined) => {
  if (v != null) set.add(v);
};

/**
 * Adds a credential’s key hash to a set if the credential is of type `KeyHash`.
 *
 * @param out - The set that collects unique key hashes.
 * @param cred - The credential object to inspect.
 */
const addCredentialKeyHash = (out: Set<string>, cred?: Cardano.Credential) => {
  if (cred?.type === Cardano.CredentialType.KeyHash && cred.hash) {
    out.add(cred.hash);
  }
};

/**
 * Extracts the payment key hash from a Cardano address.
 *
 * Supports base, enterprise, and pointer address types. If the address
 * is provided as a Bech32 string, it will be automatically parsed.
 *
 * @param inputAddress - A Cardano address or Bech32 string.
 * @returns The key hash if present, otherwise `undefined`.
 */
const paymentKeyHashFromAddress = (
  inputAddress: Cardano.Address | string,
): Crypto.Ed25519KeyHashHex | undefined => {
  const addressObject =
    typeof inputAddress === 'string'
      ? Cardano.Address.fromBech32(inputAddress)
      : inputAddress;

  const asBase = addressObject.asBase();
  if (asBase) {
    const cred = asBase.getPaymentCredential();
    if (cred?.type === Cardano.CredentialType.KeyHash)
      return cred.hash as Crypto.Ed25519KeyHashHex;
  }

  const asEnterprise = addressObject.asEnterprise();
  if (asEnterprise) {
    const cred = asEnterprise.getPaymentCredential();
    if (cred?.type === Cardano.CredentialType.KeyHash)
      return cred.hash as Crypto.Ed25519KeyHashHex;
  }

  const asPointer = addressObject.asPointer();
  if (asPointer) {
    const cred = asPointer.getPaymentCredential();
    if (cred?.type === Cardano.CredentialType.KeyHash)
      return cred.hash as Crypto.Ed25519KeyHashHex;
  }

  return undefined;
};

/**
 * Adds all provided required signer key hashes to the set.
 *
 * @param out - The set that collects key hashes.
 * @param keyHashes - An optional list of required signer key hashes.
 */
const addRequiredSigners = (
  out: Set<string>,
  keyHashes?: Crypto.Ed25519KeyHashHex[],
) => {
  for (const kh of keyHashes ?? []) out.add(kh);
};

/**
 * Adds the key hashes of the key hash guards. Script hash guards are
 * satisfied by running a script and need no signature.
 *
 * @param out - The set that collects key hashes.
 * @param guards - An optional list of guard credentials.
 */
const addGuards = (out: Set<string>, guards?: Cardano.Credential[]) => {
  for (const guard of guards ?? []) addCredentialKeyHash(out, guard);
};

/**
 * Extracts and adds the payment key hashes of the outputs the given inputs
 * spend, found in the resolved UTxOs.
 *
 * @param out - The set that collects key hashes.
 * @param inputs - The inputs whose spent outputs need a signature.
 * @param resolvedInputs - The list of resolved UTxOs available for lookup.
 */
const addInputSigners = (
  out: Set<string>,
  inputs: Cardano.TxIn[],
  resolvedInputs: Cardano.Utxo[],
) => {
  for (const index of inputs) {
    const input = resolvedInputs.find(
      ([txIn]) => txIn.txId === index.txId && txIn.index === index.index,
    );

    if (!input) continue;

    const [, txOut] = input;
    addIf(out, paymentKeyHashFromAddress(txOut.address));
  }
};

/**
 * Extracts and adds key hashes from stake address withdrawals.
 *
 * @param out - The set that collects key hashes.
 * @param withdrawals - Optional list of withdrawals to process.
 */
const addWithdrawals = (
  out: Set<string>,
  withdrawals?: Cardano.Withdrawal[],
) => {
  for (const withdrawal of withdrawals ?? []) {
    const credential = Cardano.Address.fromString(withdrawal.stakeAddress)
      ?.asReward()
      ?.getPaymentCredential();
    addCredentialKeyHash(out, credential);
  }
};

/**
 * Extracts and adds key hashes from supported certificate types.
 *
 * Certificates with stake, DRep or committee cold credentials add their key
 * hash credential. A pool registration adds the pool operator and every
 * pool owner, and a pool retirement the pool operator. Unsupported
 * certificate types (like MIR) are ignored.
 *
 * @param out - The set that collects key hashes.
 * @param certs - Optional list of certificates to inspect.
 */
const addCertificates = (out: Set<string>, certs?: Cardano.Certificate[]) => {
  for (const certificate of certs ?? []) {
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
        addCredentialKeyHash(out, certificate.stakeCredential);
        break;
      }
      case Cardano.CertificateType.RegisterDelegateRepresentative:
      case Cardano.CertificateType.UnregisterDelegateRepresentative:
      case Cardano.CertificateType.UpdateDelegateRepresentative: {
        addCredentialKeyHash(out, certificate.dRepCredential);
        break;
      }
      case Cardano.CertificateType.AuthorizeCommitteeHot:
      case Cardano.CertificateType.ResignCommitteeCold: {
        addCredentialKeyHash(out, certificate.coldCredential);
        break;
      }
      case Cardano.CertificateType.PoolRegistration: {
        const { id, owners } = certificate.poolParameters;
        out.add(Cardano.PoolId.toKeyHash(id));
        for (const owner of owners) {
          out.add(Cardano.RewardAccount.toHash(owner));
        }
        break;
      }
      case Cardano.CertificateType.PoolRetirement: {
        out.add(Cardano.PoolId.toKeyHash(certificate.poolId));
        break;
      }
      // Unsupported certs. Our wallet tx builder won't support these.
      case Cardano.CertificateType.StakeRegistration:
      case Cardano.CertificateType.MIR:
      case Cardano.CertificateType.GenesisKeyDelegation:
      default:
        break;
    }
  }
};

/**
 * Extracts and adds key hashes from voting procedures.
 *
 * @param out - The set that collects key hashes.
 * @param votingProcedures - Optional list of voting procedures.
 */
const addVotingProcedures = (
  out: Set<string>,
  votingProcedures?: Cardano.VotingProcedures,
) => {
  const voters = votingProcedures?.map(({ voter }) => voter) ?? [];
  for (const voter of voters) {
    addCredentialKeyHash(out, voter.credential);
  }
};

/**
 * Recursively collects key hashes from all native scripts in a transaction.
 *
 * Handles nested script structures such as `RequireAllOf`, `RequireAnyOf`,
 * and `RequireNOf`, while skipping time-based scripts.
 *
 * @param out - The set that collects key hashes.
 * @param scripts - Optional list of scripts to process.
 */
const getNativeScriptKeyPaths = (
  out: Set<string>,
  scripts?: Cardano.Script[],
) => {
  const nativeScripts = scripts?.filter(
    Cardano.isNativeScript,
  ) as Cardano.NativeScript[];
  if (!nativeScripts?.length) return;

  for (const nativeScript of nativeScripts) {
    switch (nativeScript.kind) {
      case Cardano.NativeScriptKind.RequireSignature: {
        out.add(nativeScript.keyHash);
        break;
      }
      case Cardano.NativeScriptKind.RequireAllOf:
      case Cardano.NativeScriptKind.RequireAnyOf:
      case Cardano.NativeScriptKind.RequireNOf: {
        getNativeScriptKeyPaths(out, nativeScript.scripts);
        break;
      }
      case Cardano.NativeScriptKind.RequireTimeBefore:
      case Cardano.NativeScriptKind.RequireTimeAfter:
        break;
      case Cardano.NativeScriptKind.RequireGuard: {
        if (nativeScript.credential.type === Cardano.CredentialType.KeyHash) {
          out.add(nativeScript.credential.hash);
        }
        break;
      }
    }
  }
};

/**
 * Adds the signers a transaction or sub transaction body needs for its
 * required signers, key hash guards, withdrawals, certificates and votes.
 * Direct deposits and account balance intervals need none.
 *
 * @param out - The set that collects key hashes.
 * @param body - The transaction or sub transaction body to inspect.
 */
const addBodySigners = (out: Set<string>, body: Cardano.SubTransactionBody) => {
  addRequiredSigners(out, body.requiredExtraSignatures);
  addGuards(out, body.guards);
  addWithdrawals(out, body.withdrawals);
  addCertificates(out, body.certificates);
  addVotingProcedures(out, body.votingProcedures);
};

/**
 * Tells what locks the output each input spends, from the resolved UTxOs: the
 * script of a script address, no script for a key address, and not known for
 * an input the UTxOs do not hold.
 *
 * @param resolvedInputs - The resolved UTxOs.
 * @returns The resolver.
 */
const spentScriptHashResolver =
  (resolvedInputs: Cardano.Utxo[]) =>
  (txIn: Cardano.TxIn): Crypto.Hash28ByteBase16 | null | undefined => {
    const resolved = resolvedInputs.find(
      ([candidate]) =>
        candidate.txId === txIn.txId && candidate.index === txIn.index,
    );
    return resolved ? spentScriptHash(resolved[1].address) : undefined;
  };

/**
 * Computes and returns a set of **unique signer key hashes** required
 * to authorize the given transaction.
 *
 * It aggregates all potential signers derived from:
 * - Explicit required extra signatures and key hash guards
 * - Transaction inputs and collaterals
 * - Stake withdrawals
 * - Certificates (stake, DRep, committee or pool-related)
 * - Voting procedures
 * - Native scripts the body needs, from its witness set or those of its
 *   sub transactions: one locking an input it spends, or one its
 *   withdrawals, certificates, voters, guards, minting policies or the
 *   guards its sub transactions require of it name. While an input is not
 *   resolved any script may lock it, so every native script counts.
 *
 * @param tx - The transaction whose signers should be determined.
 * @param resolvedInputs - The list of resolved UTxOs referenced by the transaction.
 * @returns A set of unique key hash strings representing all required signers.
 */
export const getUniqueSignerKeyHashes = (
  tx: Cardano.Tx,
  resolvedInputs: Cardano.Utxo[],
): Set<string> => {
  const out = new Set<string>();
  addBodySigners(out, tx.body);
  addInputSigners(
    out,
    [...tx.body.inputs, ...(tx.body.collaterals ?? [])],
    resolvedInputs,
  );
  getNativeScriptKeyPaths(
    out,
    neededNativeScripts({
      body: tx.body,
      resolveSpentScriptHash: spentScriptHashResolver(resolvedInputs),
      scripts: batchWitnessScripts(tx.body, tx.witness.scripts),
    }),
  );

  return out;
};

/**
 * Computes the **unique signer key hashes** a sub transaction needs.
 *
 * The vkey witnesses of a sub transaction sign its own id, the hash of its
 * body, and the keys they must cover are those of its own body:
 * - Required extra signatures and key hash guards
 * - The inputs it spends (a sub transaction posts no collateral)
 * - Stake withdrawals
 * - Certificates (stake, DRep, committee or pool-related)
 * - Voting procedures
 * - Native scripts in its own witness set that its body needs, by the same
 *   rule as a top level body
 *
 * Its direct deposits and account balance intervals need no signature, and
 * the guards it requires of the enclosing transaction are signed there. The
 * enclosing transaction carries the sub transaction byte for byte, so its
 * parties sign it before it is batched.
 *
 * Native scripts read from reference inputs are not seen; callers add the
 * keys they require themselves.
 *
 * @param subTransaction - The sub transaction whose signers should be determined.
 * @param resolvedInputs - The resolved UTxOs its inputs spend, including
 *   outputs of sub transactions batched before it.
 * @returns A set of unique key hash strings representing all required signers.
 */
export const getUniqueSubTransactionSignerKeyHashes = (
  subTransaction: Cardano.SubTransaction,
  resolvedInputs: Cardano.Utxo[],
): Set<string> => {
  const out = new Set<string>();
  addBodySigners(out, subTransaction.body);
  addInputSigners(out, subTransaction.body.inputs, resolvedInputs);
  getNativeScriptKeyPaths(
    out,
    neededNativeScripts({
      body: subTransaction.body,
      resolveSpentScriptHash: spentScriptHashResolver(resolvedInputs),
      scripts: subTransaction.witness.scripts ?? [],
    }),
  );

  return out;
};
