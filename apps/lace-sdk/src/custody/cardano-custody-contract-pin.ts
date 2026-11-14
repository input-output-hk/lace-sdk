import { contractPinOf } from '@lace-lib/cardano-custody';

import { CardanoCustodyContractPinInvalidError } from './cardano-custody-errors';

import type {
  CardanoContractDefinitions,
  CardanoContractPin,
  CardanoContractPinError,
  CardanoContractPinRequest,
  CardanoContractSchema,
} from '@lace-lib/cardano-custody';

/**
 * Another contract an owner transaction may call, as a device signer knows
 * it: a label consent shows, the validator's script hash and the CIP-57
 * schemas of its spend and mint handlers, so consent names the contract and
 * decodes its redeemers and datums with field names.
 */
export type CardanoCustodyContractPin = CardanoContractPin;

/** Which validator of a blueprint to pin, and how consent names it. */
export type CardanoCustodyContractPinRequest = CardanoContractPinRequest;

/** A CIP-57 schema of a pinned contract's redeemer or datum. */
export type CardanoCustodyContractSchema = CardanoContractSchema;

/** The CIP-57 definitions a pin's schemas refer to, by name. */
export type CardanoCustodyContractDefinitions = CardanoContractDefinitions;

/** The SDK error for a pin the library refused. */
const contractPinErrorOf = (
  error: CardanoContractPinError,
): CardanoCustodyContractPinInvalidError => {
  switch (error.code) {
    case 'malformed-blueprint':
      return new CardanoCustodyContractPinInvalidError(
        error.code,
        undefined,
        error.field,
      );
    case 'empty-label':
    case 'invalid-script-hash':
      return new CardanoCustodyContractPinInvalidError(error.code);
    case 'mismatched-purpose':
    case 'mismatched-script-hash':
    case 'missing-purpose':
    case 'missing-script-hash':
    case 'unknown-validator':
      return new CardanoCustodyContractPinInvalidError(
        error.code,
        error.validator,
      );
  }
};

/**
 * Makes the pin of one validator of a contract's CIP-57 blueprint
 * (`plutus.json`), which `createLocalCardanoCustodyDeviceSigner` takes in
 * `contractPins`. Name the validator by its blueprint title without the
 * handler suffix, such as `order_book.order_book`. A validator with
 * parameters needs the deployed `scriptHash`, since its hash depends on the
 * parameters applied; any other given `scriptHash` must equal the
 * blueprint's. A blueprint of an older Aiken version, whose titles carry no
 * handler suffix, needs `purpose`.
 *
 * @throws {@link CardanoCustodyContractPinInvalidError} When the blueprint is
 *   malformed or gives no pin for the request.
 */
export const cardanoCustodyContractPinOf = (
  blueprint: unknown,
  request: CardanoCustodyContractPinRequest,
): CardanoCustodyContractPin => {
  const pinned = contractPinOf(blueprint, request);
  if (!pinned.ok) throw contractPinErrorOf(pinned.error);
  return pinned.value;
};
