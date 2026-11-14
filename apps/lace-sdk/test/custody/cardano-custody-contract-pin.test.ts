import { describe, expect, it } from 'vitest';

import { cardanoCustodyContractPinOf } from '../../src/custody/cardano-custody-contract-pin';
import { CardanoCustodyContractPinInvalidError } from '../../src/custody/cardano-custody-errors';

import type { CardanoCustodyContractPinRequest } from '../../src/custody/cardano-custody-contract-pin';
import type { CardanoCustodyContractPinInvalidReason } from '../../src/custody/cardano-custody-errors';

const MARKET_HASH = 'a1'.repeat(28);
const OTHER_HASH = 'b2'.repeat(28);

const INT = { $ref: '#/definitions/Int' };

const handler = (
  title: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  title,
  hash: MARKET_HASH,
  redeemer: { title: 'redeemer', schema: INT },
  compiledCode: '00',
  ...extra,
});

const blueprint = {
  preamble: { title: 'fixture/market', version: '0.0.0', plutusVersion: 'v3' },
  validators: [
    handler('market.market.spend', { datum: { title: 'datum', schema: INT } }),
    handler('market.market.mint'),
    handler('tokens.tokens.mint'),
    handler('params.params.spend', {
      hash: undefined,
      parameters: [{ title: 'owner', schema: INT }],
    }),
    handler('split.split.spend'),
    handler('split.split.mint', { hash: OTHER_HASH }),
    handler('legacy.legacy', { datum: { title: 'datum', schema: INT } }),
  ],
  definitions: { Int: { dataType: 'integer' } },
};

const malformedBlueprint = {
  validators: [
    handler('market.market.spend', {
      redeemer: { schema: { anyOf: [{ datatype: 'integer' }] } },
    }),
  ],
};

const refusalOf = (
  source: unknown,
  request: CardanoCustodyContractPinRequest,
): unknown => {
  try {
    cardanoCustodyContractPinOf(source, request);
  } catch (error) {
    return error;
  }
  throw new Error('expected a refusal');
};

describe('cardanoCustodyContractPinOf', () => {
  it('pins the spend and mint handlers of a validator', () => {
    expect(
      cardanoCustodyContractPinOf(blueprint, {
        validator: 'market.market',
        label: 'Market',
      }),
    ).toEqual({
      label: 'Market',
      scriptHash: MARKET_HASH,
      spend: { redeemer: INT, datum: INT },
      mint: { redeemer: INT },
      definitions: { Int: { dataType: 'integer' } },
    });
  });

  it('pins the deployed hash of a validator with parameters', () => {
    expect(
      cardanoCustodyContractPinOf(blueprint, {
        validator: 'params.params',
        label: 'Params',
        scriptHash: OTHER_HASH,
      }),
    ).toMatchObject({ label: 'Params', scriptHash: OTHER_HASH });
  });

  it.each<{
    reason: CardanoCustodyContractPinInvalidReason;
    source: unknown;
    request: CardanoCustodyContractPinRequest;
    expected: { validator?: string; field?: string };
  }>([
    {
      reason: 'malformed-blueprint',
      source: malformedBlueprint,
      request: { validator: 'market.market', label: 'Market' },
      expected: { field: 'validators[0].redeemer.schema.anyOf[0]' },
    },
    {
      reason: 'unknown-validator',
      source: blueprint,
      request: { validator: 'missing.missing', label: 'Missing' },
      expected: { validator: 'missing.missing' },
    },
    {
      reason: 'unknown-validator',
      source: blueprint,
      request: {
        validator: 'tokens.tokens',
        label: 'Tokens',
        purpose: 'spend',
      },
      expected: { validator: 'tokens.tokens' },
    },
    {
      reason: 'missing-purpose',
      source: blueprint,
      request: { validator: 'legacy.legacy', label: 'Legacy' },
      expected: { validator: 'legacy.legacy' },
    },
    {
      reason: 'mismatched-purpose',
      source: blueprint,
      request: { validator: 'legacy.legacy', label: 'Legacy', purpose: 'mint' },
      expected: { validator: 'legacy.legacy' },
    },
    {
      reason: 'missing-script-hash',
      source: blueprint,
      request: { validator: 'params.params', label: 'Params' },
      expected: { validator: 'params.params' },
    },
    {
      reason: 'mismatched-script-hash',
      source: blueprint,
      request: { validator: 'split.split', label: 'Split' },
      expected: { validator: 'split.split' },
    },
    {
      reason: 'mismatched-script-hash',
      source: blueprint,
      request: {
        validator: 'market.market',
        label: 'Market',
        scriptHash: OTHER_HASH,
      },
      expected: { validator: 'market.market' },
    },
    {
      reason: 'invalid-script-hash',
      source: blueprint,
      request: {
        validator: 'params.params',
        label: 'Params',
        scriptHash: 'AB',
      },
      expected: {},
    },
    {
      reason: 'empty-label',
      source: blueprint,
      request: { validator: 'market.market', label: ' ' },
      expected: {},
    },
  ])(
    'refuses $reason with CardanoCustodyContractPinInvalidError',
    ({ reason, source, request, expected: { validator, field } }) => {
      const error = refusalOf(source, request);

      expect(error).toBeInstanceOf(CardanoCustodyContractPinInvalidError);
      expect(error).toMatchObject({
        code: 'custody-contract-pin-invalid',
        reason,
        validator,
        field,
      });
    },
  );
});
