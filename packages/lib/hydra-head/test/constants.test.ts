import { describe, expect, it } from 'vitest';

import {
  HYDRA_HEAD_HISTORY_LIMITS,
  HYDRA_HEAD_STATE_TOKEN_NAMES,
  HYDRA_METADATA_LABEL,
} from '../src';

import { preprodHeadHistories } from './fixtures/head-histories';

const hexToText = (hex: string) => Buffer.from(hex, 'hex').toString('utf8');

describe('Hydra constants', () => {
  it('decodes the state token names', () => {
    expect(hexToText(HYDRA_HEAD_STATE_TOKEN_NAMES.v1)).toBe('HydraHeadV1');
    expect(hexToText(HYDRA_HEAD_STATE_TOKEN_NAMES.v2)).toBe('HydraHeadV2');
  });

  it('uses label 55555', () => {
    expect(HYDRA_METADATA_LABEL).toBe(55_555n);
  });

  it('reads every recorded head in full', () => {
    for (const { transactions } of Object.values(preprodHeadHistories)) {
      expect(transactions.length).toBeLessThan(
        HYDRA_HEAD_HISTORY_LIMITS.maxTransactionsPerHead,
      );
      const produced = new Set<string>();
      let countOutsideInputs = 0;
      for (const { hash, inputs, outputs } of transactions) {
        countOutsideInputs += inputs.filter(
          ({ collateral, reference, tx_hash, output_index }) =>
            !collateral &&
            !reference &&
            !produced.has(`${tx_hash}#${output_index}`),
        ).length;
        for (const { output_index } of outputs) {
          produced.add(`${hash}#${output_index}`);
        }
      }
      expect(countOutsideInputs).toBeLessThanOrEqual(
        HYDRA_HEAD_HISTORY_LIMITS.maxResolvedInputsPerHead,
      );
    }
  });
});
