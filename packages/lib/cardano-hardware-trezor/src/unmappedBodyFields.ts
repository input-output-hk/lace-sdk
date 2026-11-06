import type { Cardano } from '@lace-lib/cardano-core';

/** The transaction body fields `txToTrezor` carries to the device. */
const TREZOR_MAPPED_BODY_FIELDS: ReadonlySet<string> = new Set<
  keyof Cardano.TxBody
>([
  'auxiliaryDataHash',
  'certificates',
  'collateralReturn',
  'collaterals',
  'fee',
  'inputs',
  'mint',
  'networkId',
  'outputs',
  'referenceInputs',
  'requiredExtraSignatures',
  'scriptIntegrityHash',
  'totalCollateral',
  'validityInterval',
  'withdrawals',
]);

/**
 * Gets the fields of a transaction body that the Trezor request drops. The
 * device hashes the body it is sent, so with any of them it would sign a
 * different transaction: sub transactions, guards in credential form,
 * required top level guards, direct deposits, account balance intervals,
 * votes, proposals, treasury fields and protocol updates. Guards in the key hash form
 * are required signers and are carried; in credential form, key hashes
 * included, the request would write them differently.
 *
 * @param body The transaction body.
 * @returns The names of the fields the device would not see.
 */
export const getUnmappedBodyFields = (body: Cardano.TxBody): string[] =>
  Object.entries(body)
    .filter(
      ([field, value]) =>
        value !== undefined && !TREZOR_MAPPED_BODY_FIELDS.has(field),
    )
    .map(([field]) => field);
