import {
  CreationArtefactMismatchError,
  CreationLockMismatchError,
} from '@lace-contract/passport';

import { ACCOUNT_BUNDLE_ID } from './manifest';

import type {
  MaintenanceSignatureKind,
  MaintenanceVerifyingKey,
} from '@lace-contract/passport';

/** The signature schemes the ledger accepts a maintenance authority key in. */
export type AuthorityKeyKind = MaintenanceSignatureKind;

/**
 * The maintenance authority's signing key as the ledger represents it: its
 * signature kind and the hex-encoded secret. Mirrors the ledger's own
 * shape so the pending deployment can be persisted and carried over the
 * signer channel without the ledger's types.
 */
export type AuthorityKey = { tag: AuthorityKeyKind; value: string };

/**
 * What a retry needs to finish a deployment whose waves were interrupted:
 * the roster the account was planned with, the lock choice made when it
 * began, `verifierKeysDigest`, which names the pinned verifier keys the
 * roster is installed with so a retry under other pins is refused, the
 * boot salt the activation must present, the maintenance authority key
 * that signs the remaining waves, `handoverAuthority`, the authority the
 * account's roster key derives, which the last wave of an unlocked
 * account installs so its devices hold maintenance from then on, and
 * `keyEntries`, the creating device's envelope and registration as
 * 192-byte hex inbox entries, which deliver the account keys once the
 * device is active. `bundleId` names the account bundle the deployment
 * was started from, absent in a record written before builds were
 * registered, which names the default, and `constructorArgs` the values
 * of that bundle's declared constructor arguments as the canonical
 * strings the creation descriptor carried, absent when it declares none;
 * a resume finishes under them, never under what a later request names.
 * The authority key is the only secret the account record ever carries,
 * and only until activation rewrites the record without it; the flow
 * holds the same key in memory for as long as the waves run. The key
 * entries are ciphertexts, sealed to the device's reader key and to the
 * roster key.
 */
export type PendingDeployment = {
  operations: string[];
  lockAccount: boolean;
  verifierKeysDigest: string;
  saltHex: string;
  authorityKey: AuthorityKey;
  handoverAuthority: MaintenanceVerifyingKey;
  keyEntries: string[];
  bundleId?: string;
  constructorArgs?: string[];
};

/**
 * What a flow other than the creation is shown of an unfinished creation
 * over the hosted signer: the creating device's key entries alone, whose
 * landing tells a sign-in the account is usable. The authority key, the
 * handover authority, the boot salt, the roster, its verifier key digest
 * and the lock choice stay with the signer and the creation that started
 * it.
 */
export type PendingCreationMarker = Pick<PendingDeployment, 'keyEntries'>;

/** Whether a record's pending creation carries the whole deployment, not only its marker. */
export const isPendingDeployment = (
  pending: PendingCreationMarker | PendingDeployment,
): pending is PendingDeployment => 'authorityKey' in pending;

/**
 * The refusal of a creation that resumes an unfinished one under another
 * lock choice than `recorded`, the one it was started with, which the
 * message names so a retry can repeat it.
 */
export const lockChoiceMismatch = (
  recorded: boolean,
): CreationLockMismatchError =>
  new CreationLockMismatchError(
    `The unfinished Passport account creation was started with lockAccount ${recorded}; resume it with the same lock choice.`,
  );

/** What a creation was started from, as a deployment or a descriptor names it: its bundle and constructor arguments. */
type CreationBuild = Pick<PendingDeployment, 'bundleId' | 'constructorArgs'>;

/** The bundle a creation names, the default when it names none. */
const creationBundleId = ({ bundleId }: CreationBuild): string =>
  bundleId ?? ACCOUNT_BUNDLE_ID;

/** Whether two creations name the same bundle and the same constructor arguments, value for value. */
export const isSameCreationBuild = (
  left: CreationBuild,
  right: CreationBuild,
): boolean =>
  creationBundleId(left) === creationBundleId(right) &&
  (left.constructorArgs ?? []).join(',') ===
    (right.constructorArgs ?? []).join(',');

/**
 * The refusal of a creation that resumes an unfinished one from another
 * bundle, or with other constructor arguments, than `recorded`, the ones
 * it was started with; the message names the bundle so a retry can
 * repeat it.
 */
export const creationBuildMismatch = (
  recorded: CreationBuild,
): CreationArtefactMismatchError =>
  new CreationArtefactMismatchError(
    `The unfinished Passport account creation was started from account bundle '${creationBundleId(
      recorded,
    )}' with its recorded constructor arguments; resume it from the same bundle with the same arguments.`,
  );
