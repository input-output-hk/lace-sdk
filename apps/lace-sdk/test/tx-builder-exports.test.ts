import * as tx from '@lace-lib/cardano-tx-builder';
import { describe, expect, it } from 'vitest';

import * as sdk from '../src';

const BUILD_ERRORS = [
  'EvaluatedFeeShortfallError',
  'ExtraneousRedeemerError',
  'InputSelectionError',
  'InsufficientCollateralError',
  'MalformedGuardDatumError',
  'MissingCollateralError',
  'MissingDatumError',
  'MissingRedeemerError',
  'MissingTopLevelGuardError',
  'NotAllowedSupplementalDatumError',
  'UnbalancedSubTransactionsError',
] as const;

describe('transaction builder exports', () => {
  it.each(BUILD_ERRORS)("exports %s as the builder's own class", name => {
    expect(sdk[name]).toBeTypeOf('function');
    expect(sdk[name]).toBe(tx[name]);
    expect(Object.getPrototypeOf(sdk[name])).toBe(Error);
  });

  it('exports the builder the errors are thrown by', () => {
    expect(sdk.TransactionBuilder).toBe(tx.TransactionBuilder);
  });
});
