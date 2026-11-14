import { Cardano } from '@lace-lib/cardano-core';

import { itemPath } from '../codecs/plutus-data';
import { bytesToHex } from '../hex';
import { fail, ok } from '../result';

import type { CustodyResult } from '../result';
import type { HexBlob } from '@lace-lib/cardano-util';

/**
 * A CIP-57 data schema as a blueprint writes it. Every schema may carry a
 * title, description and comment. Beyond those, a `$ref` or `anyOf` schema
 * holds nothing else, and a `dataType` schema holds only the keys of its
 * kind: `index` and `fields` for a constructor, `items` for a list, `keys`
 * and `values` for a map, none for integers and bytes. A schema with nothing
 * but those annotations is opaque: it accepts any Plutus data, as the empty
 * schema and Aiken's `Data` definition do. Any other key, such as a
 * validation keyword or another applicator, fails rather than being ignored,
 * so no data the schema forbids is ever shown as matching it.
 */
export interface CardanoContractSchema {
  readonly title?: string;
  readonly description?: string;
  readonly dataType?: string;
  /** Constructor index, for `dataType: 'constructor'`. */
  readonly index?: number;
  /** Constructor fields in order, for `dataType: 'constructor'`. */
  readonly fields?: readonly CardanoContractSchema[];
  /** One schema for every item, or one per position for a tuple. */
  readonly items?: CardanoContractSchema | readonly CardanoContractSchema[];
  readonly keys?: CardanoContractSchema;
  readonly values?: CardanoContractSchema;
  readonly anyOf?: readonly CardanoContractSchema[];
  /** A JSON pointer into the blueprint definitions, e.g. `#/definitions/types~1Datum`. */
  readonly $ref?: string;
}

/** A constructor schema, which always carries its index and fields. */
type ConstructorSchema = CardanoContractSchema & {
  readonly index: number;
  readonly fields: readonly CardanoContractSchema[];
};

/** A blueprint's `definitions`, by name, which `$ref` pointers resolve against. */
export type CardanoContractDefinitions = Readonly<
  Record<string, CardanoContractSchema>
>;

/** A constructor field, named by its schema title when the blueprint gives one. */
export interface DecodedContractField {
  readonly name?: string;
  readonly value: DecodedContractData;
}

/** A map entry with its key and value decoded. */
export interface DecodedContractEntry {
  readonly key: DecodedContractData;
  readonly value: DecodedContractData;
}

/**
 * Plutus data decoded against a contract schema, as a labelled tree to
 * render. A constructor carries the title of its alternative, and `opaque`
 * holds data the schema leaves undescribed.
 */
export type DecodedContractData =
  | {
      readonly kind: 'bytes';
      readonly hex: HexBlob;
    }
  | {
      readonly kind: 'constructor';
      readonly name?: string;
      readonly index: number;
      readonly fields: readonly DecodedContractField[];
    }
  | {
      readonly kind: 'integer';
      readonly value: bigint;
    }
  | {
      readonly kind: 'list';
      readonly items: readonly DecodedContractData[];
    }
  | {
      readonly kind: 'map';
      readonly entries: readonly DecodedContractEntry[];
    }
  | {
      readonly kind: 'opaque';
      readonly data: Cardano.PlutusData;
    };

/** Plutus data that does not match the schema it was decoded against. */
export interface CardanoContractDataMismatch {
  readonly code: 'contract-data-mismatch';
  /** Where decoding stopped, e.g. `owner.keys[1]`; empty at the root. */
  readonly path: string;
  readonly expected: string;
}

/**
 * How many schema steps one path from the root may take. It bounds a `$ref`
 * cycle that consumes no data, and leaves room for data nested far deeper
 * than any contract needs.
 */
const MAX_SCHEMA_DEPTH = 256;

const DEFINITIONS_POINTER = '#/definitions/';

/** Raised inside the decoder only; `decodeContractData` turns it into a result. */
class Mismatch extends Error {
  public constructor(readonly path: string, readonly expected: string) {
    super(`Expected ${expected} at ${path || 'the root'}`);
  }
}

const SUPPORTED_DATA_TYPES = new Set([
  'bytes',
  'constructor',
  'integer',
  'list',
  'map',
]);

const ANNOTATION_KEYS = new Set(['$comment', 'description', 'title']);

/** The keys each kind of schema may hold besides its annotations. */
const KIND_KEYS: Readonly<Record<string, readonly string[]>> = {
  $ref: ['$ref'],
  anyOf: ['anyOf'],
  bytes: ['dataType'],
  constructor: ['dataType', 'index', 'fields'],
  integer: ['dataType'],
  list: ['dataType', 'items'],
  map: ['dataType', 'keys', 'values'],
};

const TEXT_KEYS = ['$comment', '$ref', 'dataType', 'description', 'title'];

const SCHEMA_LIST_KEYS = ['anyOf', 'fields'];

const SCHEMA_KEYS = ['keys', 'values'];

/** Where a schema is malformed or unsupported; `key` names the offending key. */
export interface SchemaProblem {
  readonly key?: string;
  readonly expected: string;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The problem with a list of schemas under `key`, naming the first bad item. */
const listProblem = (
  key: string,
  value: readonly unknown[],
): SchemaProblem | undefined => {
  const position = value.findIndex(item => !isPlainObject(item));
  return position === -1
    ? undefined
    : { key: itemPath(key, position), expected: 'a schema object' };
};

/**
 * The problem with the field titles of a constructor, which name its decoded
 * fields and their paths before each field is decoded.
 */
const fieldTitleProblem = (
  fields: readonly Record<string, unknown>[],
): SchemaProblem | undefined => {
  const position = fields.findIndex(
    field => field.title !== undefined && typeof field.title !== 'string',
  );
  return position === -1
    ? undefined
    : { key: `${itemPath('fields', position)}.title`, expected: 'a string' };
};

/** The kind of a schema: `$ref`, `anyOf` or its data type, in that order. */
const kindOf = (schema: Record<string, unknown>): string | undefined => {
  if (schema.$ref !== undefined) return '$ref';
  if (schema.anyOf !== undefined) return 'anyOf';
  return schema.dataType as string | undefined;
};

/**
 * What is unsupported about a schema whose keys are well typed, if anything:
 * a kind the decoder does not know, or a key its kind does not allow.
 */
const kindProblem = (
  schema: Record<string, unknown>,
): SchemaProblem | undefined => {
  const dataType = schema.dataType as string | undefined;
  const kind = kindOf(schema);
  if (kind === undefined) {
    return Object.keys(schema).every(key => ANNOTATION_KEYS.has(key))
      ? undefined
      : { expected: 'a schema with a data type, anyOf or $ref' };
  }
  if (kind === dataType && !SUPPORTED_DATA_TYPES.has(dataType)) {
    return { expected: `a supported schema, not data type ${dataType}` };
  }
  const extra = Object.keys(schema).find(
    key => !ANNOTATION_KEYS.has(key) && !KIND_KEYS[kind].includes(key),
  );
  if (extra !== undefined) {
    return {
      key: extra,
      expected: `absent beside ${kind === dataType ? 'data type ' : ''}${kind}`,
    };
  }
  if (
    dataType === 'constructor' &&
    (schema.index === undefined || schema.fields === undefined)
  ) {
    return { expected: 'a constructor schema with index and fields' };
  }
  return undefined;
};

/**
 * What is wrong with one schema node, without following its nested schemas:
 * the type of each key it uses, and whether its shape is one the decoder
 * supports.
 */
export const schemaProblem = (schema: unknown): SchemaProblem | undefined => {
  if (!isPlainObject(schema)) return { expected: 'a schema object' };
  const text = TEXT_KEYS.find(
    key => schema[key] !== undefined && typeof schema[key] !== 'string',
  );
  if (text) return { key: text, expected: 'a string' };
  const { index, items } = schema;
  if (
    index !== undefined &&
    !(Number.isSafeInteger(index) && (index as number) >= 0)
  ) {
    return { key: 'index', expected: 'a non-negative integer' };
  }
  for (const key of SCHEMA_LIST_KEYS) {
    const value = schema[key];
    if (value === undefined) continue;
    if (!Array.isArray(value)) return { key, expected: 'a list of schemas' };
    const problem = listProblem(key, value);
    if (problem) return problem;
  }
  if (Array.isArray(schema.fields)) {
    const problem = fieldTitleProblem(schema.fields);
    if (problem) return problem;
  }
  if (Array.isArray(items)) {
    const problem = listProblem('items', items);
    if (problem) return problem;
  } else if (items !== undefined && !isPlainObject(items)) {
    return { key: 'items', expected: 'a schema or a list of schemas' };
  }
  const single = SCHEMA_KEYS.find(
    key => schema[key] !== undefined && !isPlainObject(schema[key]),
  );
  if (single) return { key: single, expected: 'a schema' };
  return kindProblem(schema);
};

/** The schemas nested in a well-typed schema node, by their key path. */
export const nestedSchemas = (
  schema: CardanoContractSchema,
): ReadonlyArray<readonly [string, CardanoContractSchema]> => {
  const { fields = [], anyOf = [], items, keys, values } = schema;
  const listed = (
    key: string,
    schemas: readonly CardanoContractSchema[],
  ): Array<readonly [string, CardanoContractSchema]> =>
    schemas.map((nested, index) => [itemPath(key, index), nested] as const);
  const single = (
    key: string,
    nested: CardanoContractSchema | undefined,
  ): Array<readonly [string, CardanoContractSchema]> =>
    nested === undefined ? [] : [[key, nested]];
  return [
    ...listed('fields', fields),
    ...listed('anyOf', anyOf),
    ...(Array.isArray(items)
      ? listed('items', items as readonly CardanoContractSchema[])
      : single('items', items as CardanoContractSchema | undefined)),
    ...single('keys', keys),
    ...single('values', values),
  ];
};

const fieldPath = (path: string, name: string): string =>
  path === '' ? name : `${path}.${name}`;

const describe = (schema: CardanoContractSchema): string =>
  schema.title ?? 'a value';

/**
 * The definition name a `$ref` points at, unescaping `~1` to `/` and `~0` to
 * `~`, or undefined for a pointer outside the blueprint definitions.
 */
export const definitionName = (reference: string): string | undefined =>
  reference.startsWith(DEFINITIONS_POINTER)
    ? reference
        .slice(DEFINITIONS_POINTER.length)
        .replaceAll('~1', '/')
        .replaceAll('~0', '~')
    : undefined;

/** The definition a `$ref` names. */
const resolveReference = (
  reference: string,
  definitions: CardanoContractDefinitions,
  path: string,
): CardanoContractSchema => {
  const name = definitionName(reference);
  if (name === undefined) {
    throw new Mismatch(
      path,
      `a reference into the definitions, not ${reference}`,
    );
  }
  if (!Object.hasOwn(definitions, name)) {
    throw new Mismatch(path, `a definition named ${name}`);
  }
  return definitions[name];
};

/** Where a decode stands: the definitions, the data path and the schema depth. */
interface Walk {
  readonly definitions: CardanoContractDefinitions;
  readonly path: string;
  readonly depth: number;
}

/** The walk one schema step further, optionally at a new data path. */
const deeper = (walk: Walk, path = walk.path): Walk => ({
  ...walk,
  path,
  depth: walk.depth + 1,
});

/** Whether an `anyOf` alternative is a constructor matched by its index. */
const isInlineConstructor = (
  schema: CardanoContractSchema,
): schema is CardanoContractSchema & { readonly index: number } =>
  schema.dataType === 'constructor' && Number.isSafeInteger(schema.index);

/** How a mismatch names an `anyOf` alternative. */
const alternativeName = (schema: CardanoContractSchema): string =>
  isInlineConstructor(schema)
    ? `constructor ${schema.index}`
    : schema.title ?? schema.dataType ?? schema.$ref ?? 'data';

/**
 * Picks the constructor alternative whose index the data carries, and
 * otherwise the first other alternative the data matches.
 */
const decodeAnyOf = (
  schema: CardanoContractSchema,
  data: Cardano.PlutusData,
  walk: Walk,
): DecodedContractData => {
  const alternatives = schema.anyOf ?? [];
  if (Cardano.util.isConstrPlutusData(data)) {
    const match = alternatives.find(
      alternative =>
        isInlineConstructor(alternative) &&
        BigInt(alternative.index) === data.constructor,
    );
    if (match) return decodeSchema(match, data, deeper(walk));
  }
  for (const alternative of alternatives) {
    if (isInlineConstructor(alternative)) continue;
    try {
      return decodeSchema(alternative, data, deeper(walk));
    } catch (error) {
      if (!(error instanceof Mismatch)) throw error;
    }
  }
  throw new Mismatch(
    walk.path,
    `${describe(schema)} as one of ${alternatives
      .map(alternativeName)
      .join(', ')}`,
  );
};

/** Decodes a constructor, naming each field by its schema title or position. */
const decodeConstructor = (
  schema: ConstructorSchema,
  data: Cardano.PlutusData,
  walk: Walk,
): DecodedContractData => {
  const { index, fields: fieldSchemas } = schema;
  if (
    !Cardano.util.isConstrPlutusData(data) ||
    data.constructor !== BigInt(index) ||
    data.fields.items.length !== fieldSchemas.length
  ) {
    throw new Mismatch(
      walk.path,
      `${describe(schema)} as constructor ${index} with ${
        fieldSchemas.length
      } fields`,
    );
  }
  return {
    kind: 'constructor',
    ...(schema.title !== undefined && { name: schema.title }),
    index,
    fields: fieldSchemas.map((field, position) => {
      const name = field.title;
      const path =
        name === undefined
          ? itemPath(walk.path, position)
          : fieldPath(walk.path, name);
      return {
        ...(name !== undefined && { name }),
        value: decodeSchema(
          field,
          data.fields.items[position],
          deeper(walk, path),
        ),
      };
    }),
  };
};

/** Decodes a list against one item schema, or a tuple by position. */
const decodeList = (
  schema: CardanoContractSchema,
  data: Cardano.PlutusData,
  walk: Walk,
): DecodedContractData => {
  if (!Cardano.util.isPlutusList(data)) {
    throw new Mismatch(walk.path, `${describe(schema)} as a list`);
  }
  const { items = {} } = schema;
  if (Array.isArray(items)) {
    const tuple = items as readonly CardanoContractSchema[];
    if (data.items.length !== tuple.length) {
      throw new Mismatch(
        walk.path,
        `${describe(schema)} as a list of ${tuple.length} items`,
      );
    }
    return {
      kind: 'list',
      items: tuple.map((item, position) =>
        decodeSchema(
          item,
          data.items[position],
          deeper(walk, itemPath(walk.path, position)),
        ),
      ),
    };
  }
  const item = items as CardanoContractSchema;
  return {
    kind: 'list',
    items: data.items.map((value, position) =>
      decodeSchema(item, value, deeper(walk, itemPath(walk.path, position))),
    ),
  };
};

/** Decodes a map, each key and value against its own schema. */
const decodeMap = (
  schema: CardanoContractSchema,
  data: Cardano.PlutusData,
  walk: Walk,
): DecodedContractData => {
  if (!Cardano.util.isPlutusMap(data)) {
    throw new Mismatch(walk.path, `${describe(schema)} as a map`);
  }
  const { keys = {}, values = {} } = schema;
  return {
    kind: 'map',
    entries: [...data.data.entries()].map(([key, value], position) => {
      const entryPath = itemPath(walk.path, position);
      return {
        key: decodeSchema(keys, key, deeper(walk, `${entryPath}.key`)),
        value: decodeSchema(values, value, deeper(walk, `${entryPath}.value`)),
      };
    }),
  };
};

/** Decodes one value against one schema, throwing `Mismatch` where they part. */
const decodeSchema = (
  schema: CardanoContractSchema,
  data: Cardano.PlutusData,
  walk: Walk,
): DecodedContractData => {
  if (walk.depth > MAX_SCHEMA_DEPTH) {
    throw new Mismatch(
      walk.path,
      `a schema nested at most ${MAX_SCHEMA_DEPTH} steps deep`,
    );
  }
  const problem = schemaProblem(schema);
  if (problem) {
    throw new Mismatch(
      walk.path,
      problem.key === undefined
        ? problem.expected
        : `a schema whose ${problem.key} is ${problem.expected}`,
    );
  }
  if (schema.$ref !== undefined) {
    return decodeSchema(
      resolveReference(schema.$ref, walk.definitions, walk.path),
      data,
      deeper(walk),
    );
  }
  if (schema.anyOf !== undefined) return decodeAnyOf(schema, data, walk);
  switch (schema.dataType) {
    case undefined:
      return { kind: 'opaque', data };
    case 'constructor':
      return decodeConstructor(schema as ConstructorSchema, data, walk);
    case 'integer':
      if (!Cardano.util.isPlutusBigInt(data)) {
        throw new Mismatch(walk.path, `${describe(schema)} as an integer`);
      }
      return { kind: 'integer', value: data };
    case 'bytes':
      if (!Cardano.util.isPlutusBoundedBytes(data)) {
        throw new Mismatch(walk.path, `${describe(schema)} as bytes`);
      }
      return { kind: 'bytes', hex: bytesToHex(data) };
    case 'list':
      return decodeList(schema, data, walk);
    case 'map':
      return decodeMap(schema, data, walk);
    default:
      throw new Mismatch(
        walk.path,
        `a supported schema, not data type ${schema.dataType}`,
      );
  }
};

/**
 * Decodes Plutus data against a CIP-57 schema, resolving `$ref` against the
 * blueprint definitions. Supports constructors, integers, bytes, lists,
 * tuples, maps, `anyOf` and opaque data. A mismatch names the path where
 * the data parted from the schema.
 */
export const decodeContractData = (
  schema: CardanoContractSchema,
  definitions: CardanoContractDefinitions,
  data: Cardano.PlutusData,
): CustodyResult<DecodedContractData, CardanoContractDataMismatch> => {
  try {
    return ok(decodeSchema(schema, data, { definitions, path: '', depth: 0 }));
  } catch (error) {
    if (error instanceof Mismatch) {
      return fail({
        code: 'contract-data-mismatch',
        path: error.path,
        expected: error.expected,
      });
    }
    throw error;
  }
};
