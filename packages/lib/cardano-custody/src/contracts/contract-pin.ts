import { isHash28Hex } from '../hex';
import { fail, ok } from '../result';

import { definitionName, nestedSchemas, schemaProblem } from './blueprint-data';

import type { CustodyResult } from '../result';
import type {
  CardanoContractDefinitions,
  CardanoContractSchema,
} from './blueprint-data';
import type { Hash28ByteBase16 } from '@lace-lib/cardano-crypto';

/**
 * Another contract a custody account may call, as the signer knows it: a
 * label to show, the validator's script hash and the CIP-57 schemas of its
 * spend and mint handlers, so consent names the contract and decodes its
 * redeemers and datums with field names.
 */
export interface CardanoContractPin {
  readonly label: string;
  readonly scriptHash: Hash28ByteBase16;
  readonly spend?: {
    readonly redeemer: CardanoContractSchema;
    readonly datum?: CardanoContractSchema;
  };
  readonly mint?: { readonly redeemer: CardanoContractSchema };
  readonly definitions: CardanoContractDefinitions;
}

/** Which validator of a blueprint to pin, and how consent names it. */
export interface CardanoContractPinRequest {
  /** The blueprint title without its purpose suffix, e.g. `account.account`. */
  readonly validator: string;
  /** The name consent shows for the contract; it must not be blank. */
  readonly label: string;
  /** The one handler to pin; required for a title without a purpose suffix. */
  readonly purpose?: 'mint' | 'spend';
  /** The deployed script hash, as lower-case hex of 28 bytes. */
  readonly scriptHash?: string;
}

/** The handler of a validator a pin describes. */
type ContractPurpose = NonNullable<CardanoContractPinRequest['purpose']>;

/**
 * Why a blueprint gave no pin. `unknown-validator` also covers a validator
 * with neither a spend nor a mint handler of the asked purpose. A validator
 * with parameters, or without a hash, needs the deployed script hash, else
 * it is refused as `missing-script-hash`. A validator titled without a
 * purpose suffix needs the purpose, else it is refused as `missing-purpose`.
 * Such a validator is a spend validator exactly when the blueprint gives it
 * a datum, so a purpose that contradicts the datum is refused as
 * `mismatched-purpose`.
 */
export type CardanoContractPinError =
  | {
      readonly code: 'malformed-blueprint';
      /** Dotted path of the offending field, e.g. `validators[2].hash`. */
      readonly field?: string;
      readonly reason: string;
    }
  | {
      readonly code: 'mismatched-purpose';
      readonly validator: string;
    }
  | {
      readonly code: 'mismatched-script-hash';
      readonly validator: string;
    }
  | {
      readonly code: 'missing-purpose';
      readonly validator: string;
    }
  | {
      readonly code: 'missing-script-hash';
      readonly validator: string;
    }
  | {
      readonly code: 'unknown-validator';
      readonly validator: string;
    }
  | { readonly code: 'empty-label' }
  | { readonly code: 'invalid-script-hash' };

/**
 * One handler of a blueprint validator, e.g. `account.account.spend`. A
 * title without a purpose suffix, as `<module>.<function>` in blueprints of
 * older Aiken versions, gives a handler without a purpose.
 */
interface BlueprintHandler {
  readonly validator: string;
  readonly purpose?: string;
  readonly hash?: Hash28ByteBase16;
  readonly parameterised: boolean;
  readonly redeemer?: unknown;
  readonly datum?: unknown;
  readonly field: string;
}

/** The parts of a blueprint a pin is made from, its definitions unchecked. */
interface Blueprint {
  readonly handlers: readonly BlueprintHandler[];
  readonly definitions: Readonly<Record<string, unknown>>;
}

/** A `$ref` met while checking a schema, with the field that holds it. */
interface Reference {
  readonly pointer: string;
  readonly field: string;
}

/** Raised inside the reader only; `contractPinOf` turns it into a result. */
class Malformed extends Error {
  public constructor(readonly reason: string, readonly field?: string) {
    super(reason);
  }
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Checks a schema and every schema nested in it, so the decoder only meets
 * shapes it supports, and adds each `$ref` it holds to `references`.
 */
const checkSchema = (
  schema: unknown,
  field: string,
  references: Reference[],
): CardanoContractSchema => {
  const problem = schemaProblem(schema);
  if (problem) {
    throw new Malformed(
      `expected ${problem.expected}`,
      problem.key === undefined ? field : `${field}.${problem.key}`,
    );
  }
  const checked = schema as CardanoContractSchema;
  if (checked.$ref !== undefined) {
    references.push({ pointer: checked.$ref, field: `${field}.$ref` });
  }
  for (const [path, nested] of nestedSchemas(checked)) {
    checkSchema(nested, `${field}.${path}`, references);
  }
  return checked;
};

/**
 * The blueprint definitions, unchecked: they are shared by every validator
 * and may hold types a pin never reaches, such as parameter types.
 */
const readDefinitions = (value: unknown): Readonly<Record<string, unknown>> => {
  if (value === undefined) return {};
  if (!isPlainObject(value)) {
    throw new Malformed('expected an object of schemas', 'definitions');
  }
  return value;
};

/**
 * The definitions the given references reach, followed transitively and each
 * checked as a schema, refusing a reference that names no definition.
 */
const reachedDefinitions = (
  definitions: Readonly<Record<string, unknown>>,
  references: readonly Reference[],
): CardanoContractDefinitions => {
  const reached: Record<string, CardanoContractSchema> = {};
  const pending = [...references];
  for (let next = pending.pop(); next; next = pending.pop()) {
    const name = definitionName(next.pointer);
    if (name === undefined) {
      throw new Malformed(
        'expected a reference into the definitions',
        next.field,
      );
    }
    if (!Object.hasOwn(definitions, name)) {
      throw new Malformed(`expected a definition named ${name}`, next.field);
    }
    if (Object.hasOwn(reached, name)) continue;
    reached[name] = checkSchema(
      definitions[name],
      `definitions.${name}`,
      pending,
    );
  }
  return reached;
};

/**
 * Splits a handler title `<module>.<name>.<purpose>` at its last dot. A
 * title with a single dot is a `<module>.<function>` validator of an older
 * Aiken version, which carries no purpose.
 */
const readHandler = (value: unknown, field: string): BlueprintHandler => {
  if (!isPlainObject(value) || typeof value.title !== 'string') {
    throw new Malformed('expected a validator with a title', field);
  }
  const { title, hash, parameters } = value;
  if (hash !== undefined && !isHash28Hex(hash)) {
    throw new Malformed(
      'expected the lower-case hex of a 28-byte hash',
      `${field}.hash`,
    );
  }
  if (parameters !== undefined && !Array.isArray(parameters)) {
    throw new Malformed('expected a list of parameters', `${field}.parameters`);
  }
  const purposeAt = title.lastIndexOf('.');
  const hasPurpose = purposeAt > title.indexOf('.');
  return {
    validator: hasPurpose ? title.slice(0, purposeAt) : title,
    ...(hasPurpose && { purpose: title.slice(purposeAt + 1) }),
    hash: hash as Hash28ByteBase16 | undefined,
    parameterised: parameters !== undefined && parameters.length > 0,
    redeemer: value.redeemer,
    datum: value.datum,
    field,
  };
};

/** The handlers and definitions of a blueprint, refusing a malformed one. */
const readBlueprint = (blueprint: unknown): Blueprint => {
  if (!isPlainObject(blueprint) || !Array.isArray(blueprint.validators)) {
    throw new Malformed('expected a blueprint with a list of validators');
  }
  return {
    handlers: blueprint.validators.map((value: unknown, index) =>
      readHandler(value, `validators[${index}]`),
    ),
    definitions: readDefinitions(blueprint.definitions),
  };
};

/** The schema of a handler argument, `{ title?, schema }` in the blueprint. */
const schemaOf = (
  argument: unknown,
  field: string,
  references: Reference[],
): CardanoContractSchema => {
  if (!isPlainObject(argument) || !isPlainObject(argument.schema)) {
    throw new Malformed('expected an argument with a schema', field);
  }
  return checkSchema(argument.schema, `${field}.schema`, references);
};

/**
 * The script hash of a pin: the deployed hash the caller gives for a
 * validator with parameters or without a hash, otherwise the hash every
 * handler shares, which a given hash must equal.
 */
const scriptHashOf = (
  handlers: readonly BlueprintHandler[],
  validator: string,
  scriptHash: Hash28ByteBase16 | undefined,
): CustodyResult<Hash28ByteBase16, CardanoContractPinError> => {
  const hashes = new Set(handlers.map(handler => handler.hash));
  if (
    hashes.has(undefined) ||
    handlers.some(handler => handler.parameterised)
  ) {
    return scriptHash === undefined
      ? fail({ code: 'missing-script-hash', validator })
      : ok(scriptHash);
  }
  const [blueprintHash] = hashes;
  if (
    hashes.size > 1 ||
    blueprintHash === undefined ||
    (scriptHash !== undefined && scriptHash !== blueprintHash)
  ) {
    return fail({ code: 'mismatched-script-hash', validator });
  }
  return ok(blueprintHash);
};

/**
 * The pin of one validator from its handlers' hashes and schemas, given the
 * deployed script hash once it is known to be well formed.
 */
const pinOf = (
  { handlers, definitions }: Blueprint,
  { validator, label, purpose }: CardanoContractPinRequest,
  deployedHash: Hash28ByteBase16 | undefined,
): CustodyResult<CardanoContractPin, CardanoContractPinError> => {
  const ofValidator = handlers.filter(
    handler => handler.validator === validator,
  );
  const unsuffixed = ofValidator.filter(
    handler => handler.purpose === undefined,
  );
  if (purpose === undefined && unsuffixed.length > 0) {
    return fail({ code: 'missing-purpose', validator });
  }
  if (
    unsuffixed.some(
      handler => (handler.datum !== undefined) !== (purpose === 'spend'),
    )
  ) {
    return fail({ code: 'mismatched-purpose', validator });
  }
  const handlerOf = (wanted: ContractPurpose) =>
    purpose === undefined || purpose === wanted
      ? ofValidator.find(handler => (handler.purpose ?? purpose) === wanted)
      : undefined;
  const spend = handlerOf('spend');
  const mint = handlerOf('mint');
  if (!spend && !mint) return fail({ code: 'unknown-validator', validator });

  const scriptHash = scriptHashOf(ofValidator, validator, deployedHash);
  if (!scriptHash.ok) return scriptHash;

  const references: Reference[] = [];
  return ok({
    label,
    scriptHash: scriptHash.value,
    ...(spend && {
      spend: {
        redeemer: schemaOf(
          spend.redeemer,
          `${spend.field}.redeemer`,
          references,
        ),
        ...(spend.datum !== undefined && {
          datum: schemaOf(spend.datum, `${spend.field}.datum`, references),
        }),
      },
    }),
    ...(mint && {
      mint: {
        redeemer: schemaOf(mint.redeemer, `${mint.field}.redeemer`, references),
      },
    }),
    definitions: reachedDefinitions(definitions, references),
  });
};

/**
 * The pin of one validator of a CIP-57 blueprint, named by its title without
 * the purpose suffix (`account.account` for `account.account.spend`). It
 * collects the validator's spend and mint handlers, which must all carry the
 * same script hash, and keeps only the definitions their schemas reach.
 *
 * Blueprints of older Aiken versions title a validator `<module>.<function>`
 * with no purpose suffix; `purpose` then says which handler it is, a spend
 * validator with a datum and a redeemer or a mint policy with a redeemer,
 * and must agree with whether the blueprint gives a datum. With suffixed
 * titles, `purpose` narrows the pin to that one handler.
 *
 * The hash of a validator with parameters is that of the script with its
 * parameters applied, which only the caller knows, so `scriptHash` is then
 * required and pinned, as it is for a validator without a hash. Otherwise a
 * given `scriptHash` must equal the blueprint's.
 */
export const contractPinOf = (
  blueprint: unknown,
  request: CardanoContractPinRequest,
): CustodyResult<CardanoContractPin, CardanoContractPinError> => {
  const { label, scriptHash } = request;
  if (label.trim() === '') return fail({ code: 'empty-label' });
  if (scriptHash !== undefined && !isHash28Hex(scriptHash)) {
    return fail({ code: 'invalid-script-hash' });
  }
  try {
    return pinOf(
      readBlueprint(blueprint),
      request,
      scriptHash as Hash28ByteBase16 | undefined,
    );
  } catch (error) {
    if (error instanceof Malformed) {
      return fail({
        code: 'malformed-blueprint',
        reason: error.reason,
        ...(error.field !== undefined && { field: error.field }),
      });
    }
    throw error;
  }
};
