import { Cardano } from '@lace-lib/cardano-core';
import { describe, expect, it } from 'vitest';

import { decodeHydraCommitDatum } from '../src/commit-datum';

import { preprodHeadHistories } from './fixtures/head-histories';
import {
  bytes,
  constr,
  integer,
  list,
  nestedListCbor,
} from './fixtures/plutus';
import { preprodUtxos } from './fixtures/preprod';

import type { RecordedHeadHistory } from './fixtures/head-histories';

const testnet = Cardano.NetworkId.Testnet;

/** Inline datums of the commit UTxOs a collect transaction spends. */
const commitDatumsOf = ({ headId, transactions }: RecordedHeadHistory) =>
  transactions.flatMap(({ inputs }) =>
    inputs.flatMap(({ amount, inline_datum }) =>
      inline_datum &&
      amount.some(
        ({ unit }) =>
          unit.startsWith(headId) && !unit.endsWith('4879647261486561645631'),
      )
        ? [inline_datum]
        : [],
    ),
  );

describe('decodeHydraCommitDatum', () => {
  it('decodes the commit of a Hydra 1.3.0 participant', () => {
    const [datum] = commitDatumsOf(preprodHeadHistories.incrementsV1);

    expect(decodeHydraCommitDatum(datum, testnet)).toEqual({
      headId: 'e4a912c2d066420b341112415cc2c3bce75a6976f5b91fe6f26651f4',
      committed: [
        {
          input: {
            txId: 'c12725bb1a8277b983d18431356341192341a2cccfe75eb4168baf4eb5b38e0e',
            index: 0,
          },
          address: expect.stringMatching(/^addr_test1q/) as string,
          paymentKeyHash:
            'a0abf91dee3e17b3b3091bbc4acdd395209b7925fd62f147aae85416',
          value: { coins: 5_000_000n, assets: new Map() },
        },
      ],
    });
  });

  it('decodes a commit of nothing', () => {
    const [, datum] = commitDatumsOf(preprodHeadHistories.incrementsV1);

    expect(decodeHydraCommitDatum(datum, testnet)?.committed).toEqual([]);
  });

  it('reads the Plutus V2 output references of Hydra 0.18.0 commits', () => {
    const [first] = commitDatumsOf(preprodHeadHistories.collectV1Plutus2);

    expect(
      decodeHydraCommitDatum(first, testnet)?.committed.map(
        ({ input }) => input,
      ),
    ).toEqual(
      [0, 1, 3].map(index => ({
        txId: 'f9e38c6f60d2771c9146cace6354f69691066d97a248ea9026d21582706144a1',
        index,
      })),
    );
  });

  it('rejects a deposit datum', () => {
    expect(
      decodeHydraCommitDatum(preprodUtxos.depositV2.inline_datum, testnet),
    ).toBeUndefined();
  });

  it('rejects a commit whose head id is not a policy id', () => {
    const datum = constr(0n, bytes('ab'.repeat(32)), list(), bytes('cd'));

    expect(decodeHydraCommitDatum(datum.toCbor(), testnet)).toBeUndefined();
  });

  it('rejects a commit whose output does not decode', () => {
    const datum = constr(
      0n,
      bytes('ab'.repeat(32)),
      list(
        constr(
          0n,
          constr(0n, bytes('ef'.repeat(32)), integer(0n)),
          bytes('00'),
        ),
      ),
      bytes('cd'.repeat(28)),
    );

    expect(decodeHydraCommitDatum(datum.toCbor(), testnet)).toBeUndefined();
  });

  it('returns undefined for malformed CBOR', () => {
    expect(decodeHydraCommitDatum('ff', testnet)).toBeUndefined();
  });

  it('rejects a commit whose output is nested too deep to decode', () => {
    const datum = constr(
      0n,
      bytes('ab'.repeat(32)),
      list(
        constr(
          0n,
          constr(0n, bytes('ef'.repeat(32)), integer(0n)),
          bytes(nestedListCbor(2000)),
        ),
      ),
      bytes('cd'.repeat(28)),
    );

    const start = performance.now();
    expect(decodeHydraCommitDatum(datum.toCbor(), testnet)).toBeUndefined();
    expect(performance.now() - start).toBeLessThan(1000);
  });
});
