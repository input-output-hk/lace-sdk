import { describe, expect, it } from 'vitest';

import { HYDRA_METADATA_LABEL, parseHydraTxTag } from '../src';

import type { Cardano } from '@lace-lib/cardano-core';

const withTag = (value: Cardano.Metadatum) =>
  new Map<bigint, Cardano.Metadatum>([[HYDRA_METADATA_LABEL, value]]);

describe('parseHydraTxTag', () => {
  it('parses a HydraV2 tag', () => {
    expect(parseHydraTxTag(withTag('HydraV2/DepositTx'))).toEqual({
      protocol: 'HydraV2',
      txName: 'DepositTx',
    });
  });

  it('parses a HydraV1 tag', () => {
    expect(parseHydraTxTag(withTag('HydraV1/CommitTx'))).toEqual({
      protocol: 'HydraV1',
      txName: 'CommitTx',
    });
  });

  it('parses the tag of the last partial fanout', () => {
    expect(parseHydraTxTag(withTag('HydraV2/FinalPartialFanoutTx'))).toEqual({
      protocol: 'HydraV2',
      txName: 'FinalPartialFanoutTx',
    });
  });

  it('keeps unknown transaction names', () => {
    expect(parseHydraTxTag(withTag('HydraV2/FutureTx'))).toEqual({
      protocol: 'HydraV2',
      txName: 'FutureTx',
    });
  });

  it('ignores other labels', () => {
    const metadata = new Map<bigint, Cardano.Metadatum>([
      [674n, 'HydraV2/DepositTx'],
    ]);
    expect(parseHydraTxTag(metadata)).toBeUndefined();
  });

  it('returns undefined without metadata', () => {
    expect(parseHydraTxTag(undefined)).toBeUndefined();
    expect(parseHydraTxTag(new Map())).toBeUndefined();
  });

  it.each([
    ['a number', 55n],
    ['bytes', new Uint8Array([72, 121])],
    ['a list', ['HydraV2/DepositTx']],
    ['a map', new Map<Cardano.Metadatum, Cardano.Metadatum>()],
  ])('returns undefined when the value is %s', (_, value) => {
    expect(parseHydraTxTag(withTag(value))).toBeUndefined();
  });

  it.each([
    'DepositTx',
    'HydraV3/DepositTx',
    'hydrav2/DepositTx',
    'HydraV2',
    'HydraV2/',
    '/DepositTx',
    'NotHydra/DepositTx',
    '',
  ])('returns undefined for text %j', text => {
    expect(parseHydraTxTag(withTag(text))).toBeUndefined();
  });
});
