import type { Cardano } from '@lace-lib/cardano-core';

/** The transaction body fields `toLedgerTx` carries to the device. */
const LEDGER_MAPPED_BODY_FIELDS: ReadonlySet<string> = new Set<
  keyof Cardano.TxBody
>([
  'auxiliaryDataHash',
  'certificates',
  'collateralReturn',
  'collaterals',
  'donation',
  'fee',
  'inputs',
  'mint',
  'networkId',
  'outputs',
  'referenceInputs',
  'requiredExtraSignatures',
  'scriptIntegrityHash',
  'totalCollateral',
  'treasuryValue',
  'validityInterval',
  'votingProcedures',
  'withdrawals',
]);

/**
 * Gets the fields of a transaction body that the Ledger request drops. The
 * device hashes the body it is sent, so with any of them it would sign a
 * different transaction: sub transactions, guards in credential form,
 * required top level guards, direct deposits, account balance intervals,
 * proposals and protocol updates. Guards in the key hash form are required
 * signers and are carried; in credential form, key hashes included, the
 * request would write them differently.
 *
 * @param body The transaction body.
 * @returns The names of the fields the device would not see.
 */
export const getUnmappedBodyFields = (body: Cardano.TxBody): string[] =>
  Object.entries(body)
    .filter(
      ([field, value]) =>
        value !== undefined && !LEDGER_MAPPED_BODY_FIELDS.has(field),
    )
    .map(([field]) => field);
