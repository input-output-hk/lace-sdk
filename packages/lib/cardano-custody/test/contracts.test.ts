import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ACCOUNT_VALIDATOR_HASH,
  contractPinOf,
  encodeCustodyAccountRedeemer,
  encodeCustodyMintRedeemer,
} from '../src';
import { bytes, constr, list } from '../src/codecs/plutus-data';
import { decodeContractData } from '../src/contracts/blueprint-data';

import { fromCbor, toCbor } from './fixtures';

import type {
  CardanoContractDefinitions,
  CardanoContractPin,
  CardanoContractSchema,
} from '../src';
import type { Cardano } from '@lace-lib/cardano-core';

const BLUEPRINT_PATH = join(__dirname, '..', 'src', 'blueprint', 'plutus.json');
const custodyBlueprint = JSON.parse(readFileSync(BLUEPRINT_PATH, 'utf8')) as {
  definitions: CardanoContractDefinitions;
};

const MARKET_HASH = 'a1'.repeat(28);
const OTHER_HASH = 'b2'.repeat(28);
const SELLER = 'c3'.repeat(28);
const BUYER = 'd4'.repeat(28);

const ref = (name: string): CardanoContractSchema => ({
  $ref: `#/definitions/${name.replaceAll('~', '~0').replaceAll('/', '~1')}`,
});

const definitions: CardanoContractDefinitions = {
  Data: { title: 'Data', description: 'Any Plutus data.' },
  Int: { dataType: 'integer' },
  ByteArray: { dataType: 'bytes' },
  'market/Listing': {
    title: 'Listing',
    anyOf: [
      {
        title: 'Listing',
        dataType: 'constructor',
        index: 0,
        fields: [
          { title: 'seller', ...ref('ByteArray') },
          { title: 'price', ...ref('Int') },
          { title: 'tags', dataType: 'list', items: ref('ByteArray') },
          {
            title: 'royalties',
            dataType: 'map',
            keys: ref('ByteArray'),
            values: ref('Int'),
          },
          { title: 'note', ...ref('Data') },
        ],
      },
    ],
  },
  'market/Action': {
    title: 'Action',
    anyOf: [
      {
        title: 'Buy',
        dataType: 'constructor',
        index: 0,
        fields: [{ title: 'buyer', ...ref('ByteArray') }],
      },
      { title: 'Cancel', dataType: 'constructor', index: 1, fields: [] },
    ],
  },
  Tree: {
    title: 'Tree',
    anyOf: [
      {
        title: 'Leaf',
        dataType: 'constructor',
        index: 0,
        fields: [{ title: 'value', ...ref('Int') }],
      },
      {
        title: 'Node',
        dataType: 'constructor',
        index: 1,
        fields: [{ title: 'children', dataType: 'list', items: ref('Tree') }],
      },
    ],
  },
  Loop: ref('Loop'),
  Pair: { dataType: 'list', items: [ref('Int'), ref('ByteArray')] },
  IntOrBytes: { title: 'IntOrBytes', anyOf: [ref('Int'), ref('ByteArray')] },
  Unnamed: {
    anyOf: [
      { dataType: 'constructor', index: 3, fields: [ref('Int'), ref('Int')] },
    ],
  },
  'tilde~name': { dataType: 'integer' },
};

const handler = (
  title: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  title,
  hash: MARKET_HASH,
  redeemer: { title: 'redeemer', schema: {} },
  compiledCode: '00',
  ...extra,
});

const fixtureBlueprint = {
  preamble: { title: 'fixture/market', version: '0.0.0', plutusVersion: 'v3' },
  validators: [
    handler('market.market.spend', {
      datum: { title: 'datum', schema: ref('market/Listing') },
      redeemer: { title: 'redeemer', schema: ref('market/Action') },
    }),
    handler('market.market.mint', { redeemer: { schema: ref('Data') } }),
    handler('market.market.else'),
    handler('tokens.tokens.mint', { redeemer: { schema: ref('Int') } }),
    handler('tokens.tokens.else'),
    handler('params.params.spend', {
      hash: undefined,
      parameters: [{ title: 'owner', schema: ref('ByteArray') }],
    }),
    handler('split.split.spend'),
    handler('split.split.mint', { hash: OTHER_HASH }),
    handler('stake.stake.withdraw'),
  ],
  definitions,
};

const POOL_HASH = 'e5'.repeat(28);

const legacyDefinitions: CardanoContractDefinitions = {
  ByteArray: { dataType: 'bytes' },
  Int: { dataType: 'integer' },
  'pool/PoolDatum': {
    title: 'PoolDatum',
    anyOf: [
      {
        title: 'PoolDatum',
        dataType: 'constructor',
        index: 0,
        fields: [
          { title: 'reserve_a', ...ref('Int') },
          { title: 'reserve_b', ...ref('Int') },
        ],
      },
    ],
  },
  'pool/PoolRedeemer': {
    title: 'PoolRedeemer',
    anyOf: [
      { title: 'Swap', dataType: 'constructor', index: 0, fields: [] },
      { title: 'Withdraw', dataType: 'constructor', index: 1, fields: [] },
    ],
  },
  'lp/MintRedeemer': {
    title: 'MintRedeemer',
    anyOf: [{ title: 'MintLp', dataType: 'constructor', index: 0, fields: [] }],
  },
  String: { dataType: '#string' },
};

const legacyBlueprint = {
  preamble: { title: 'fixture/dex', version: '0.0.0', plutusVersion: 'v2' },
  validators: [
    {
      title: 'pool_validator.validate_pool',
      datum: { title: 'datum', schema: ref('pool/PoolDatum') },
      redeemer: { title: 'redeemer', schema: ref('pool/PoolRedeemer') },
      parameters: [{ title: 'authen_policy', schema: ref('ByteArray') }],
      compiledCode: '00',
    },
    {
      title: 'lp_minting_policy.validate_lp',
      redeemer: { title: 'redeemer', schema: ref('lp/MintRedeemer') },
      compiledCode: '00',
      hash: MARKET_HASH,
    },
  ],
  definitions: legacyDefinitions,
};

const listing = (
  overrides: {
    price?: Cardano.PlutusData;
    tags?: Cardano.PlutusData[];
    note?: Cardano.PlutusData;
  } = {},
): Cardano.PlutusData =>
  constr(0, [
    bytes(SELLER),
    overrides.price ?? 25_000_000n,
    list(overrides.tags ?? [bytes('01'), bytes('02')]),
    {
      data: new Map<Cardano.PlutusData, Cardano.PlutusData>([
        [bytes(SELLER), 5n],
      ]),
    },
    overrides.note ?? list([1n, bytes('ff')]),
  ]);

const decode = (schema: CardanoContractSchema, data: Cardano.PlutusData) =>
  decodeContractData(schema, definitions, data);

/** A blueprint whose one spend handler's redeemer refers to `Foo`. */
const referringTo = (blueprintDefinitions: unknown) => ({
  validators: [handler('a.a.spend', { redeemer: { schema: ref('Foo') } })],
  definitions: blueprintDefinitions,
});

const pinOrThrow = (
  blueprint: unknown,
  validator: string,
): CardanoContractPin => {
  const result = contractPinOf(blueprint, { validator, label: 'Market' });
  if (!result.ok) throw new Error(`No pin for ${validator}`);
  return result.value;
};

describe('contractPinOf', () => {
  it('pins the spend and mint handlers of the vendored account proxy', () => {
    expect(
      contractPinOf(custodyBlueprint, {
        validator: 'account.account',
        label: 'Custody account',
      }),
    ).toEqual({
      ok: true,
      value: {
        label: 'Custody account',
        scriptHash: ACCOUNT_VALIDATOR_HASH,
        spend: {
          redeemer: {
            $ref: '#/definitions/cardano_account_custody_contract~1types~1AccountRedeemer',
          },
          datum: { $ref: '#/definitions/Data' },
        },
        mint: {
          redeemer: {
            $ref: '#/definitions/cardano_account_custody_contract~1types~1MintRedeemer',
          },
        },
        definitions: {
          Data: custodyBlueprint.definitions.Data,
          'cardano_account_custody_contract/types/AccountRedeemer':
            custodyBlueprint.definitions[
              'cardano_account_custody_contract/types/AccountRedeemer'
            ],
          'cardano_account_custody_contract/types/MintRedeemer':
            custodyBlueprint.definitions[
              'cardano_account_custody_contract/types/MintRedeemer'
            ],
        },
      },
    });
  });

  it('decodes the vendored redeemers and accepts any datum through the pin', () => {
    const pin = pinOrThrow(custodyBlueprint, 'account.account');

    expect(
      decodeContractData(
        pin.mint!.redeemer,
        pin.definitions,
        encodeCustodyMintRedeemer({ kind: 'issueGrants' }),
      ),
    ).toEqual({
      ok: true,
      value: { kind: 'constructor', name: 'IssueGrants', index: 1, fields: [] },
    });
    expect(
      decodeContractData(
        pin.spend!.redeemer,
        pin.definitions,
        encodeCustodyAccountRedeemer({ kind: 'fund' }),
      ),
    ).toEqual({
      ok: true,
      value: { kind: 'constructor', name: 'Fund', index: 3, fields: [] },
    });
    const datum = constr(7, [list([1n])]);
    expect(
      decodeContractData(pin.spend!.datum!, pin.definitions, datum),
    ).toEqual({ ok: true, value: { kind: 'opaque', data: datum } });
  });

  it('pins a validator with only a mint handler', () => {
    expect(
      contractPinOf(fixtureBlueprint, {
        validator: 'tokens.tokens',
        label: 'Tokens',
      }),
    ).toEqual({
      ok: true,
      value: {
        label: 'Tokens',
        scriptHash: MARKET_HASH,
        mint: { redeemer: ref('Int') },
        definitions: { Int: definitions.Int },
      },
    });
  });

  it('pins a spend handler with its datum schema', () => {
    const pin = pinOrThrow(fixtureBlueprint, 'market.market');

    expect(pin.spend).toEqual({
      redeemer: ref('market/Action'),
      datum: ref('market/Listing'),
    });
    expect(pin.mint).toEqual({ redeemer: ref('Data') });
  });

  it.each(['nope.nope', 'market', 'market.market.spend', 'stake.stake'])(
    'refuses %s as an unknown validator',
    validator => {
      expect(
        contractPinOf(fixtureBlueprint, { validator, label: 'Market' }),
      ).toEqual({ ok: false, error: { code: 'unknown-validator', validator } });
    },
  );

  it('refuses a parameterised validator without a hash', () => {
    expect(
      contractPinOf(fixtureBlueprint, {
        validator: 'params.params',
        label: 'Params',
      }),
    ).toEqual({
      ok: false,
      error: { code: 'missing-script-hash', validator: 'params.params' },
    });
  });

  it('refuses handlers of one validator with different hashes', () => {
    expect(
      contractPinOf(fixtureBlueprint, {
        validator: 'split.split',
        label: 'Split',
      }),
    ).toEqual({
      ok: false,
      error: { code: 'mismatched-script-hash', validator: 'split.split' },
    });
  });

  it('narrows a suffixed validator to the asked purpose', () => {
    expect(
      contractPinOf(fixtureBlueprint, {
        validator: 'market.market',
        label: 'Market',
        purpose: 'mint',
      }),
    ).toEqual({
      ok: true,
      value: {
        label: 'Market',
        scriptHash: MARKET_HASH,
        mint: { redeemer: ref('Data') },
        definitions: { Data: definitions.Data },
      },
    });
    expect(
      contractPinOf(fixtureBlueprint, {
        validator: 'tokens.tokens',
        label: 'Tokens',
        purpose: 'spend',
      }),
    ).toEqual({
      ok: false,
      error: { code: 'unknown-validator', validator: 'tokens.tokens' },
    });
  });

  it('pins the deployed hash of a parameterised validator', () => {
    expect(
      contractPinOf(fixtureBlueprint, {
        validator: 'params.params',
        label: 'Params',
        scriptHash: OTHER_HASH,
      }),
    ).toEqual({
      ok: true,
      value: {
        label: 'Params',
        scriptHash: OTHER_HASH,
        spend: { redeemer: {} },
        definitions: {},
      },
    });
  });

  it('requires the deployed hash of a parameterised validator with a blueprint hash', () => {
    const blueprint = {
      validators: [
        handler('applied.applied.spend', {
          parameters: [{ title: 'owner', schema: ref('ByteArray') }],
        }),
      ],
      definitions,
    };

    expect(
      contractPinOf(blueprint, { validator: 'applied.applied', label: 'A' }),
    ).toEqual({
      ok: false,
      error: { code: 'missing-script-hash', validator: 'applied.applied' },
    });
    expect(
      contractPinOf(blueprint, {
        validator: 'applied.applied',
        label: 'A',
        scriptHash: OTHER_HASH,
      }),
    ).toMatchObject({ ok: true, value: { scriptHash: OTHER_HASH } });
  });

  it('accepts a deployed hash equal to the blueprint hash', () => {
    expect(
      contractPinOf(fixtureBlueprint, {
        validator: 'market.market',
        label: 'Market',
        scriptHash: MARKET_HASH,
      }),
    ).toMatchObject({ ok: true, value: { scriptHash: MARKET_HASH } });
  });

  it('refuses a deployed hash other than the blueprint hash', () => {
    expect(
      contractPinOf(fixtureBlueprint, {
        validator: 'market.market',
        label: 'Market',
        scriptHash: OTHER_HASH,
      }),
    ).toEqual({
      ok: false,
      error: { code: 'mismatched-script-hash', validator: 'market.market' },
    });
  });

  it.each(['AB'.repeat(28), 'ab', 'zz'.repeat(28)])(
    'refuses the deployed hash %s',
    scriptHash => {
      expect(
        contractPinOf(fixtureBlueprint, {
          validator: 'params.params',
          label: 'Params',
          scriptHash,
        }),
      ).toEqual({ ok: false, error: { code: 'invalid-script-hash' } });
    },
  );

  it('keeps only the definitions the pinned schemas reach', () => {
    const blueprint = {
      validators: [handler('a.a.mint', { redeemer: { schema: ref('Wrap') } })],
      definitions: {
        Wrap: {
          dataType: 'constructor',
          index: 0,
          fields: [{ title: 'value', ...ref('Int') }],
        },
        Int: { dataType: 'integer' },
        Text: { dataType: '#string' },
        Pair: {
          title: 'Pair',
          dataType: '#pair',
          left: ref('Int'),
          right: ref('Text'),
        },
      },
    };

    expect(contractPinOf(blueprint, { validator: 'a.a', label: 'A' })).toEqual({
      ok: true,
      value: {
        label: 'A',
        scriptHash: MARKET_HASH,
        mint: { redeemer: ref('Wrap') },
        definitions: {
          Wrap: blueprint.definitions.Wrap,
          Int: blueprint.definitions.Int,
        },
      },
    });
  });

  it('pins a parameterised spend validator of an older Aiken blueprint', () => {
    expect(
      contractPinOf(legacyBlueprint, {
        validator: 'pool_validator.validate_pool',
        label: 'Pool',
        purpose: 'spend',
        scriptHash: POOL_HASH,
      }),
    ).toEqual({
      ok: true,
      value: {
        label: 'Pool',
        scriptHash: POOL_HASH,
        spend: {
          redeemer: ref('pool/PoolRedeemer'),
          datum: ref('pool/PoolDatum'),
        },
        definitions: {
          Int: legacyDefinitions.Int,
          'pool/PoolDatum': legacyDefinitions['pool/PoolDatum'],
          'pool/PoolRedeemer': legacyDefinitions['pool/PoolRedeemer'],
        },
      },
    });
  });

  it('pins a mint policy of an older Aiken blueprint with its own hash', () => {
    expect(
      contractPinOf(legacyBlueprint, {
        validator: 'lp_minting_policy.validate_lp',
        label: 'LP',
        purpose: 'mint',
      }),
    ).toEqual({
      ok: true,
      value: {
        label: 'LP',
        scriptHash: MARKET_HASH,
        mint: { redeemer: ref('lp/MintRedeemer') },
        definitions: {
          'lp/MintRedeemer': legacyDefinitions['lp/MintRedeemer'],
        },
      },
    });
  });

  it('refuses a validator of an older Aiken blueprint without a purpose', () => {
    expect(
      contractPinOf(legacyBlueprint, {
        validator: 'pool_validator.validate_pool',
        label: 'Pool',
        scriptHash: POOL_HASH,
      }),
    ).toEqual({
      ok: false,
      error: {
        code: 'missing-purpose',
        validator: 'pool_validator.validate_pool',
      },
    });
  });

  it('refuses a spend validator of an older Aiken blueprint pinned as a mint policy', () => {
    expect(
      contractPinOf(legacyBlueprint, {
        validator: 'pool_validator.validate_pool',
        label: 'Pool',
        purpose: 'mint',
        scriptHash: POOL_HASH,
      }),
    ).toEqual({
      ok: false,
      error: {
        code: 'mismatched-purpose',
        validator: 'pool_validator.validate_pool',
      },
    });
  });

  it('refuses a mint policy of an older Aiken blueprint pinned as a spend validator', () => {
    expect(
      contractPinOf(legacyBlueprint, {
        validator: 'lp_minting_policy.validate_lp',
        label: 'LP',
        purpose: 'spend',
      }),
    ).toEqual({
      ok: false,
      error: {
        code: 'mismatched-purpose',
        validator: 'lp_minting_policy.validate_lp',
      },
    });
  });

  it('refuses a parameterised validator of an older Aiken blueprint without its deployed hash', () => {
    expect(
      contractPinOf(legacyBlueprint, {
        validator: 'pool_validator.validate_pool',
        label: 'Pool',
        purpose: 'spend',
      }),
    ).toEqual({
      ok: false,
      error: {
        code: 'missing-script-hash',
        validator: 'pool_validator.validate_pool',
      },
    });
  });

  it('decodes a datum of an older Aiken blueprint through its pin', () => {
    const result = contractPinOf(legacyBlueprint, {
      validator: 'pool_validator.validate_pool',
      label: 'Pool',
      purpose: 'spend',
      scriptHash: POOL_HASH,
    });
    if (!result.ok) throw new Error('No pin for the pool');
    const { spend, definitions: pinned } = result.value;

    expect(
      decodeContractData(spend!.datum!, pinned, constr(0, [10n, 20n])),
    ).toEqual({
      ok: true,
      value: {
        kind: 'constructor',
        name: 'PoolDatum',
        index: 0,
        fields: [
          { name: 'reserve_a', value: { kind: 'integer', value: 10n } },
          { name: 'reserve_b', value: { kind: 'integer', value: 20n } },
        ],
      },
    });
  });

  it.each(['', '   '])('refuses the empty label %j', label => {
    expect(
      contractPinOf(fixtureBlueprint, { validator: 'market.market', label }),
    ).toEqual({ ok: false, error: { code: 'empty-label' } });
  });

  it.each([
    ['not an object', 'plutus.json', undefined],
    ['without validators', { definitions }, undefined],
    ['with a validator without a title', { validators: [{}] }, 'validators[0]'],
    [
      'with an upper-case hash',
      { validators: [handler('a.a.spend', { hash: 'AB'.repeat(28) })] },
      'validators[0].hash',
    ],
    [
      'with a short hash',
      { validators: [handler('a.a.spend', { hash: 'ab' })] },
      'validators[0].hash',
    ],
    [
      'with definitions that are not an object',
      { validators: [], definitions: [] },
      'definitions',
    ],
    [
      'with a definition that is not a schema',
      referringTo({ Foo: 'integer' }),
      'definitions.Foo',
    ],
    [
      'with parameters that are not a list',
      { validators: [handler('a.a.spend', { parameters: {} })] },
      'validators[0].parameters',
    ],
    [
      'with a reference to a missing definition',
      {
        validators: [
          handler('a.a.spend', { redeemer: { schema: ref('Foo') } }),
        ],
      },
      'validators[0].redeemer.schema.$ref',
    ],
    [
      'with a reference outside the definitions',
      {
        validators: [
          handler('a.a.spend', { redeemer: { schema: { $ref: '#/Foo' } } }),
        ],
      },
      'validators[0].redeemer.schema.$ref',
    ],
    [
      'with a definition referring to a missing one',
      referringTo({ Foo: { dataType: 'list', items: ref('Bar') } }),
      'definitions.Foo.items.$ref',
    ],
    [
      'with a spend handler without a redeemer schema',
      { validators: [handler('a.a.spend', { redeemer: { title: 'r' } })] },
      'validators[0].redeemer',
    ],
    [
      'with a datum that is not an argument',
      { validators: [handler('a.a.spend', { datum: ref('Int') })] },
      'validators[0].datum',
    ],
    [
      'with an alternative that is not a schema',
      referringTo({ Foo: { anyOf: [null] } }),
      'definitions.Foo.anyOf[0]',
    ],
    [
      'with a constructor title that is not a string',
      referringTo({
        Foo: {
          anyOf: [{ title: 7, dataType: 'constructor', index: 0, fields: [] }],
        },
      }),
      'definitions.Foo.anyOf[0].title',
    ],
    [
      'with a negative constructor index',
      referringTo({
        Foo: { dataType: 'constructor', index: -1, fields: [] },
      }),
      'definitions.Foo.index',
    ],
    [
      'with list items that are null',
      referringTo({ Foo: { dataType: 'list', items: null } }),
      'definitions.Foo.items',
    ],
    [
      'with a tuple item that is not a schema',
      referringTo({ Foo: { dataType: 'list', items: [1] } }),
      'definitions.Foo.items[0]',
    ],
    [
      'with map values that are not a schema',
      referringTo({ Foo: { dataType: 'map', values: [] } }),
      'definitions.Foo.values',
    ],
    [
      'with a reference that is not a string',
      referringTo({ Foo: { $ref: 1 } }),
      'definitions.Foo.$ref',
    ],
    [
      'with a malformed schema deep inside a field',
      referringTo({
        Foo: {
          dataType: 'constructor',
          index: 0,
          fields: [{ dataType: 'list', items: { description: false } }],
        },
      }),
      'definitions.Foo.fields[0].items.description',
    ],
    [
      'with a oneOf schema',
      referringTo({ Foo: { oneOf: [ref('Int')] } }),
      'definitions.Foo',
    ],
    [
      'with a length bound beside a data type',
      referringTo({
        Foo: {
          dataType: 'constructor',
          index: 0,
          fields: [{ title: 'name', dataType: 'bytes', maxLength: 32 }],
        },
      }),
      'definitions.Foo.fields[0].maxLength',
    ],
    [
      'with a constructor schema without its data type',
      referringTo({ Foo: { title: 'X', fields: [] } }),
      'definitions.Foo',
    ],
    [
      'with a reached definition of an unsupported data type',
      referringTo({ Foo: { dataType: '#string' } }),
      'definitions.Foo',
    ],
    [
      'with a malformed redeemer schema',
      {
        validators: [
          handler('a.a.spend', {
            redeemer: { schema: { anyOf: [{ datatype: 'integer' }] } },
          }),
        ],
      },
      'validators[0].redeemer.schema.anyOf[0]',
    ],
  ])('refuses a blueprint %s', (_, blueprint, field) => {
    const result = contractPinOf(blueprint, {
      validator: 'a.a',
      label: 'A',
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe('malformed-blueprint');
    expect(
      !result.ok && result.error.code === 'malformed-blueprint'
        ? result.error.field
        : 'not malformed',
    ).toBe(field);
  });
});

describe('decodeContractData', () => {
  it('decodes a constructor with named fields of every kind', () => {
    expect(decode(ref('market/Listing'), listing())).toEqual({
      ok: true,
      value: {
        kind: 'constructor',
        name: 'Listing',
        index: 0,
        fields: [
          { name: 'seller', value: { kind: 'bytes', hex: SELLER } },
          { name: 'price', value: { kind: 'integer', value: 25_000_000n } },
          {
            name: 'tags',
            value: {
              kind: 'list',
              items: [
                { kind: 'bytes', hex: '01' },
                { kind: 'bytes', hex: '02' },
              ],
            },
          },
          {
            name: 'royalties',
            value: {
              kind: 'map',
              entries: [
                {
                  key: { kind: 'bytes', hex: SELLER },
                  value: { kind: 'integer', value: 5n },
                },
              ],
            },
          },
          {
            name: 'note',
            value: { kind: 'opaque', data: list([1n, bytes('ff')]) },
          },
        ],
      },
    });
  });

  it('decodes data read back from CBOR', () => {
    const data = listing({ note: 7n });

    expect(decode(ref('market/Listing'), fromCbor(toCbor(data)))).toEqual(
      decode(ref('market/Listing'), data),
    );
  });

  it('picks the anyOf alternative whose constructor index the data carries', () => {
    expect(decode(ref('market/Action'), constr(0, [bytes(BUYER)]))).toEqual({
      ok: true,
      value: {
        kind: 'constructor',
        name: 'Buy',
        index: 0,
        fields: [{ name: 'buyer', value: { kind: 'bytes', hex: BUYER } }],
      },
    });
    expect(decode(ref('market/Action'), constr(1))).toEqual({
      ok: true,
      value: { kind: 'constructor', name: 'Cancel', index: 1, fields: [] },
    });
  });

  it('tries alternatives that are not constructors in order', () => {
    expect(decode(ref('IntOrBytes'), 3n)).toEqual({
      ok: true,
      value: { kind: 'integer', value: 3n },
    });
    expect(decode(ref('IntOrBytes'), bytes('aa'))).toEqual({
      ok: true,
      value: { kind: 'bytes', hex: 'aa' },
    });
    expect(decode(ref('IntOrBytes'), list([]))).toEqual({
      ok: false,
      error: {
        code: 'contract-data-mismatch',
        path: '',
        expected:
          'IntOrBytes as one of #/definitions/Int, #/definitions/ByteArray',
      },
    });
  });

  it('names untitled fields by position', () => {
    expect(decode(ref('Unnamed'), constr(3, [1n, 2n]))).toEqual({
      ok: true,
      value: {
        kind: 'constructor',
        index: 3,
        fields: [
          { value: { kind: 'integer', value: 1n } },
          { value: { kind: 'integer', value: 2n } },
        ],
      },
    });
    expect(decode(ref('Unnamed'), constr(3, [1n, bytes('00')]))).toMatchObject({
      ok: false,
      error: { path: '[1]' },
    });
  });

  it('decodes a tuple by position', () => {
    expect(decode(ref('Pair'), list([1n, bytes('0a')]))).toEqual({
      ok: true,
      value: {
        kind: 'list',
        items: [
          { kind: 'integer', value: 1n },
          { kind: 'bytes', hex: '0a' },
        ],
      },
    });
    expect(decode(ref('Pair'), list([1n]))).toMatchObject({
      ok: false,
      error: { path: '', expected: 'a value as a list of 2 items' },
    });
  });

  it('accepts anything under the empty schema and the Data definition', () => {
    for (const data of [1n, bytes('00'), list([]), constr(9)]) {
      expect(decode({}, data)).toEqual({
        ok: true,
        value: { kind: 'opaque', data },
      });
      expect(decode(ref('Data'), data)).toEqual({
        ok: true,
        value: { kind: 'opaque', data },
      });
    }
  });

  it.each<{ what: string; schema: unknown; expected: string }>([
    {
      what: 'a oneOf schema',
      schema: { oneOf: [ref('Int')] },
      expected: 'a schema with a data type, anyOf or $ref',
    },
    {
      what: 'a constructor schema without its data type',
      schema: { title: 'X', fields: [ref('Int')] },
      expected: 'a schema with a data type, anyOf or $ref',
    },
    {
      what: 'a misspelt data type key',
      schema: { datatype: 'integer' },
      expected: 'a schema with a data type, anyOf or $ref',
    },
  ])(
    'refuses $what instead of treating it as opaque',
    ({ schema, expected }) => {
      expect(decode(schema as CardanoContractSchema, 1n)).toEqual({
        ok: false,
        error: { code: 'contract-data-mismatch', path: '', expected },
      });
    },
  );

  it.each<{
    what: string;
    schema: unknown;
    data: Cardano.PlutusData;
    path: string;
    expected: string;
  }>([
    {
      what: 'a schema that is not an object',
      schema: null,
      data: 1n,
      path: '',
      expected: 'a schema object',
    },
    {
      what: 'a reference that is not a string',
      schema: { $ref: 1 },
      data: 1n,
      path: '',
      expected: 'a schema whose $ref is a string',
    },
    {
      what: 'an alternative that is not a schema',
      schema: { anyOf: [null] },
      data: constr(0),
      path: '',
      expected: 'a schema whose anyOf[0] is a schema object',
    },
    {
      what: 'fields that are not a list',
      schema: { dataType: 'constructor', index: 0, fields: {} },
      data: constr(0),
      path: '',
      expected: 'a schema whose fields is a list of schemas',
    },
    {
      what: 'list items that are null',
      schema: { dataType: 'list', items: null },
      data: list([1n]),
      path: '',
      expected: 'a schema whose items is a schema or a list of schemas',
    },
    {
      what: 'map keys that are not a schema',
      schema: { dataType: 'map', keys: 'Int' },
      data: { data: new Map<Cardano.PlutusData, Cardano.PlutusData>() },
      path: '',
      expected: 'a schema whose keys is a schema',
    },
    {
      what: 'a field title that is not a string',
      schema: {
        dataType: 'constructor',
        index: 0,
        fields: [{ title: 5, dataType: 'integer' }],
      },
      data: constr(0, [1n]),
      path: '',
      expected: 'a schema whose fields[0].title is a string',
    },
    {
      what: 'a fractional constructor index',
      schema: { dataType: 'constructor', index: 0.5, fields: [] },
      data: constr(0),
      path: '',
      expected: 'a schema whose index is a non-negative integer',
    },
    {
      what: 'a constructor schema without fields',
      schema: { dataType: 'constructor', index: 0 },
      data: constr(0),
      path: '',
      expected: 'a constructor schema with index and fields',
    },
    {
      what: 'a length bound beside bytes',
      schema: { dataType: 'bytes', maxLength: 1 },
      data: bytes('0000'),
      path: '',
      expected: 'a schema whose maxLength is absent beside data type bytes',
    },
    {
      what: 'a minimum beside an integer',
      schema: { dataType: 'integer', minimum: 0 },
      data: -1n,
      path: '',
      expected: 'a schema whose minimum is absent beside data type integer',
    },
    {
      what: 'alternatives beside a reference',
      schema: { ...ref('Int'), anyOf: [ref('ByteArray')] },
      data: bytes('00'),
      path: '',
      expected: 'a schema whose anyOf is absent beside $ref',
    },
    {
      what: 'a oneOf beside an integer',
      schema: { dataType: 'integer', oneOf: [ref('ByteArray')] },
      data: 1n,
      path: '',
      expected: 'a schema whose oneOf is absent beside data type integer',
    },
    {
      what: 'a data type beside alternatives',
      schema: { anyOf: [ref('Int')], dataType: 'integer' },
      data: 1n,
      path: '',
      expected: 'a schema whose dataType is absent beside anyOf',
    },
  ])(
    'reports a hand-built schema with $what as a mismatch',
    ({ schema, data, path, expected }) => {
      expect(decode(schema as CardanoContractSchema, data)).toEqual({
        ok: false,
        error: { code: 'contract-data-mismatch', path, expected },
      });
    },
  );

  it('follows a reference whose name escapes a tilde', () => {
    expect(decode(ref('tilde~name'), 4n)).toEqual({
      ok: true,
      value: { kind: 'integer', value: 4n },
    });
  });

  it.each<{
    what: string;
    schema: CardanoContractSchema;
    data: Cardano.PlutusData;
    path: string;
    expected: string;
  }>([
    {
      what: 'an unknown constructor index',
      schema: ref('market/Action'),
      data: constr(2),
      path: '',
      expected: 'Action as one of constructor 0, constructor 1',
    },
    {
      what: 'a wrong field count',
      schema: ref('market/Action'),
      data: constr(0),
      path: '',
      expected: 'Buy as constructor 0 with 1 fields',
    },
    {
      what: 'a wrong primitive in a field',
      schema: ref('market/Listing'),
      data: listing({ price: bytes('00') }),
      path: 'price',
      expected: 'a value as an integer',
    },
    {
      what: 'a wrong list item',
      schema: ref('market/Listing'),
      data: listing({ tags: [bytes('01'), 2n] }),
      path: 'tags[1]',
      expected: 'a value as bytes',
    },
    {
      what: 'a wrong map key',
      schema: { dataType: 'map', keys: ref('Int') },
      data: {
        data: new Map<Cardano.PlutusData, Cardano.PlutusData>([
          [bytes('01'), 1n],
        ]),
      },
      path: '[0].key',
      expected: 'a value as an integer',
    },
    {
      what: 'a list where a map is due',
      schema: { dataType: 'map' },
      data: list([]),
      path: '',
      expected: 'a value as a map',
    },
    {
      what: 'an integer where a list is due',
      schema: { dataType: 'list' },
      data: 1n,
      path: '',
      expected: 'a value as a list',
    },
    {
      what: 'an unknown reference',
      schema: ref('Missing'),
      data: 1n,
      path: '',
      expected: 'a definition named Missing',
    },
    {
      what: 'a reference outside the definitions',
      schema: { $ref: '#/validators/0' },
      data: 1n,
      path: '',
      expected: 'a reference into the definitions, not #/validators/0',
    },
    {
      what: 'an unsupported data type',
      schema: { dataType: '#string' },
      data: bytes('00'),
      path: '',
      expected: 'a supported schema, not data type #string',
    },
  ])('reports $what with its path', ({ schema, data, path, expected }) => {
    expect(decode(schema, data)).toEqual({
      ok: false,
      error: { code: 'contract-data-mismatch', path, expected },
    });
  });

  it('decodes a recursive schema to any depth the data has', () => {
    const tree = constr(1, [
      list([constr(0, [1n]), constr(1, [list([constr(0, [2n])])])]),
    ]);

    expect(decode(ref('Tree'), tree)).toEqual({
      ok: true,
      value: {
        kind: 'constructor',
        name: 'Node',
        index: 1,
        fields: [
          {
            name: 'children',
            value: {
              kind: 'list',
              items: [
                {
                  kind: 'constructor',
                  name: 'Leaf',
                  index: 0,
                  fields: [
                    { name: 'value', value: { kind: 'integer', value: 1n } },
                  ],
                },
                {
                  kind: 'constructor',
                  name: 'Node',
                  index: 1,
                  fields: [
                    {
                      name: 'children',
                      value: {
                        kind: 'list',
                        items: [
                          {
                            kind: 'constructor',
                            name: 'Leaf',
                            index: 0,
                            fields: [
                              {
                                name: 'value',
                                value: { kind: 'integer', value: 2n },
                              },
                            ],
                          },
                        ],
                      },
                    },
                  ],
                },
              ],
            },
          },
        ],
      },
    });
  });

  it('reports a mismatch deep inside a recursive schema with its full path', () => {
    const tree = constr(1, [
      list([constr(0, [1n]), constr(1, [list([constr(0, [bytes('00')])])])]),
    ]);

    expect(decode(ref('Tree'), tree)).toMatchObject({
      ok: false,
      error: { path: 'children[1].children[0].value' },
    });
  });

  it('stops a reference cycle that consumes no data', () => {
    expect(decode(ref('Loop'), 1n)).toEqual({
      ok: false,
      error: {
        code: 'contract-data-mismatch',
        path: '',
        expected: 'a schema nested at most 256 steps deep',
      },
    });
  });
});
