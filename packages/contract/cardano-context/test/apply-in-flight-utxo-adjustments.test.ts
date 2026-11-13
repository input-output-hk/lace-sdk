import { Cardano, Serialization } from '@lace-lib/cardano-core';
import { HexBytes } from '@lace-lib/util';
import { describe, expect, it } from 'vitest';

import {
  applyInFlightUtxoAdjustments,
  ownPendingOutputs,
} from '../src/apply-in-flight-utxo-adjustments';
import { inFlightTransactionOf } from '../src/store/helpers/in-flight-transaction';
import { CardanoPaymentAddress } from '../src/types';

import type { CardanoInFlightEffects } from '../src/types';

const OWN_ADDRESS = CardanoPaymentAddress(
  'addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3jcu5d8ps7zex2k2xt3uqxgjqnnj83ws8lhrn648jjxtwq2ytjqp',
);
const OWN_ADDRESS_2 = CardanoPaymentAddress(
  'addr_test1qpuzeec0zqcm6lrdygkkvvd8e6qactnsl5zzeujsdpkpc939l2f2vykk0ctwq4ys6w3jg8pm0kknmy8m5pml8f9cauzq2zuc95',
);
const FOREIGN_ADDRESS = CardanoPaymentAddress(
  'addr_test1qqt3r9kd56aq9ajynjkz8hdfw3kc0pcv3tpzug8azxls62tvvz7nw9gmznn65g4ksrrfvyzhz52knc3mqxdyya47gz2qmcjmcq',
);

const previousTxId = Cardano.TransactionId(
  '39a7a284c2a0948189dc45dec670211cd4d72f7b66c5726c08d9b3df11e44d58',
);
const pendingTxId = Cardano.TransactionId(
  '4c4e67bafa15e742c13c592b65c8f74c769cd7d9af04c848099672d1ba391b49',
);
const otherPendingTxId = Cardano.TransactionId(
  'a8c5b55caa9d716c3d98df7df19b33b66b1d5d5b4a894aa8f53adcdfb9e66ae9',
);

/* eslint-disable max-params */
const makeUtxo = (
  txId: Cardano.TransactionId,
  index: number,
  coins: bigint,
  address: CardanoPaymentAddress = OWN_ADDRESS,
): Cardano.Utxo => [
  { txId, index, address: Cardano.PaymentAddress(address) },
  { address: Cardano.PaymentAddress(address), value: { coins } },
];
/* eslint-enable max-params */

const inFlight = ({
  consumedInputs = [],
  producedOutputs = [],
}: Partial<CardanoInFlightEffects>): CardanoInFlightEffects => ({
  consumedInputs,
  producedOutputs,
});

describe('applyInFlightUtxoAdjustments', () => {
  it('returns the original list when nothing is in flight', () => {
    const utxos = [makeUtxo(previousTxId, 0, 10_000_000n)];
    expect(applyInFlightUtxoAdjustments(utxos, [OWN_ADDRESS], [])).toBe(utxos);
  });

  it('returns the original list when no in-flight transaction has an effect', () => {
    const utxos = [makeUtxo(previousTxId, 0, 10_000_000n)];
    expect(
      applyInFlightUtxoAdjustments(utxos, [OWN_ADDRESS], [inFlight({})]),
    ).toBe(utxos);
  });

  it('returns the original list when the in-flight transactions touch none of its UTxOs or addresses', () => {
    const utxos = [makeUtxo(previousTxId, 0, 10_000_000n)];
    expect(
      applyInFlightUtxoAdjustments(
        utxos,
        [OWN_ADDRESS],
        [
          inFlight({
            consumedInputs: [{ txId: otherPendingTxId, index: 0 }],
            producedOutputs: [
              makeUtxo(pendingTxId, 0, 3_000_000n, FOREIGN_ADDRESS),
            ],
          }),
        ],
      ),
    ).toBe(utxos);
  });

  it('drops a UTxO an in-flight transaction consumes', () => {
    const utxoA = makeUtxo(previousTxId, 0, 10_000_000n);
    const utxoB = makeUtxo(previousTxId, 1, 5_000_000n);

    const result = applyInFlightUtxoAdjustments(
      [utxoA, utxoB],
      [OWN_ADDRESS],
      [inFlight({ consumedInputs: [{ txId: previousTxId, index: 0 }] })],
    );

    expect(result).toEqual([utxoB]);
  });

  it('ignores a consumed input the set does not hold (a foreign input)', () => {
    const utxoA = makeUtxo(previousTxId, 0, 10_000_000n);

    const result = applyInFlightUtxoAdjustments(
      [utxoA],
      [OWN_ADDRESS],
      [
        inFlight({
          consumedInputs: [
            { txId: previousTxId, index: 7 },
            { txId: previousTxId, index: 0 },
          ],
        }),
      ],
    );

    expect(result).toEqual([]);
  });

  it('appends outputs whose address matches accountAddresses and ignores foreign outputs', () => {
    const utxoA = makeUtxo(previousTxId, 0, 10_000_000n);
    const ownChange = makeUtxo(pendingTxId, 1, 6_000_000n, OWN_ADDRESS_2);
    const foreignOutput = makeUtxo(pendingTxId, 0, 3_000_000n, FOREIGN_ADDRESS);

    const result = applyInFlightUtxoAdjustments(
      [utxoA],
      [OWN_ADDRESS, OWN_ADDRESS_2],
      [inFlight({ producedOutputs: [foreignOutput, ownChange] })],
    );

    expect(result).toEqual([utxoA, ownChange]);
  });

  it('does not duplicate produced outputs when the settled set already includes them', () => {
    // The chain refresh can add the outputs before the entry is removed: the
    // produced outpoint is already in the set, so it is not appended again.
    const ownChange = makeUtxo(pendingTxId, 0, 6_000_000n);

    const result = applyInFlightUtxoAdjustments(
      [ownChange],
      [OWN_ADDRESS],
      [inFlight({ producedOutputs: [ownChange] })],
    );

    expect(result).toEqual([ownChange]);
  });

  it('appends every own output of a dApp-style transaction with several', () => {
    const utxoA = makeUtxo(previousTxId, 0, 10_000_000n);
    const ownOutput1 = makeUtxo(pendingTxId, 0, 2_000_000n);
    const ownOutput2 = makeUtxo(pendingTxId, 1, 4_000_000n, OWN_ADDRESS_2);
    const ownOutput3 = makeUtxo(pendingTxId, 2, 1_500_000n);

    const result = applyInFlightUtxoAdjustments(
      [utxoA],
      [OWN_ADDRESS, OWN_ADDRESS_2],
      [inFlight({ producedOutputs: [ownOutput1, ownOutput2, ownOutput3] })],
    );

    expect(result).toEqual([utxoA, ownOutput1, ownOutput2, ownOutput3]);
  });

  it('credits an output once its address joins the account addresses', () => {
    const laterDiscoveredOutput = makeUtxo(
      pendingTxId,
      0,
      7_500_000n,
      OWN_ADDRESS_2,
    );
    const entries = [inFlight({ producedOutputs: [laterDiscoveredOutput] })];

    expect(applyInFlightUtxoAdjustments([], [OWN_ADDRESS], entries)).toEqual(
      [],
    );
    expect(
      applyInFlightUtxoAdjustments([], [OWN_ADDRESS, OWN_ADDRESS_2], entries),
    ).toEqual([laterDiscoveredOutput]);
  });

  it('replaces a spent UTxO with the change of the transaction that spends it', () => {
    const utxoA = makeUtxo(previousTxId, 0, 10_000_000n);
    const changeUtxo = makeUtxo(pendingTxId, 0, 6_000_000n);

    const result = applyInFlightUtxoAdjustments(
      [utxoA],
      [OWN_ADDRESS],
      [
        inFlight({
          consumedInputs: [{ txId: previousTxId, index: 0 }],
          producedOutputs: [changeUtxo],
        }),
      ],
    );

    expect(result).toEqual([changeUtxo]);
  });

  it('drops an own output one in-flight transaction produces and another consumes', () => {
    const tx1Out0 = makeUtxo(pendingTxId, 0, 2_000_000n);
    const tx1Out1 = makeUtxo(pendingTxId, 1, 4_000_000n);
    const tx2Out0 = makeUtxo(otherPendingTxId, 0, 1_500_000n);

    const result = applyInFlightUtxoAdjustments(
      [],
      [OWN_ADDRESS],
      [
        inFlight({ producedOutputs: [tx1Out0, tx1Out1] }),
        inFlight({
          consumedInputs: [{ txId: pendingTxId, index: 0 }],
          producedOutputs: [tx2Out0],
        }),
      ],
    );

    expect(result).toEqual([tx1Out1, tx2Out0]);
  });

  it.each(['parent first', 'child first'])(
    'keeps the change a child spends out whichever entry comes first (%s)',
    order => {
      const parentChange = makeUtxo(pendingTxId, 0, 3_000_000n);
      const childChange = makeUtxo(otherPendingTxId, 0, 1_000_000n);
      const parent = inFlight({
        consumedInputs: [{ txId: previousTxId, index: 0 }],
        producedOutputs: [parentChange],
      });
      const child = inFlight({
        consumedInputs: [{ txId: pendingTxId, index: 0 }],
        producedOutputs: [childChange],
      });

      const result = applyInFlightUtxoAdjustments(
        [makeUtxo(previousTxId, 0, 10_000_000n)],
        [OWN_ADDRESS],
        order === 'parent first' ? [parent, child] : [child, parent],
      );

      expect(result).toEqual([childChange]);
    },
  );

  it('merges the adjustments of several in-flight transactions', () => {
    const utxoA = makeUtxo(previousTxId, 0, 10_000_000n);
    const utxoB = makeUtxo(previousTxId, 1, 5_000_000n);
    const changeFromTx1 = makeUtxo(pendingTxId, 0, 4_000_000n);
    const changeFromTx2 = makeUtxo(otherPendingTxId, 0, 2_000_000n);

    const result = applyInFlightUtxoAdjustments(
      [utxoA, utxoB],
      [OWN_ADDRESS],
      [
        inFlight({
          consumedInputs: [{ txId: previousTxId, index: 0 }],
          producedOutputs: [changeFromTx1],
        }),
        inFlight({
          consumedInputs: [{ txId: previousTxId, index: 1 }],
          producedOutputs: [changeFromTx2],
        }),
      ],
    );

    expect(result).toEqual([changeFromTx1, changeFromTx2]);
  });

  it('keeps the inputs of a transaction flagged isValid false, drops its collateral and adds its collateral return', () => {
    const bodyInput = makeUtxo(previousTxId, 0, 10_000_000n);
    const collateral = makeUtxo(previousTxId, 1, 5_000_000n);
    const collateralReturn = {
      address: Cardano.PaymentAddress(OWN_ADDRESS),
      value: { coins: 4_700_000n },
    };
    const { txId, effects } = inFlightTransactionOf({
      serializedTx: HexBytes(
        Serialization.Transaction.fromCore({
          body: {
            inputs: [{ txId: previousTxId, index: 0 }],
            outputs: [
              {
                address: Cardano.PaymentAddress(OWN_ADDRESS_2),
                value: { coins: 9_800_000n },
              },
            ],
            fee: 200_000n,
            collaterals: [{ txId: previousTxId, index: 1 }],
            collateralReturn,
          },
          id: Cardano.TransactionId('0'.repeat(64)),
          isValid: false,
          witness: { signatures: new Map() },
        }).toCbor(),
      ),
      chainId: Cardano.ChainIds.Preprod,
    });

    const result = applyInFlightUtxoAdjustments(
      [bodyInput, collateral],
      [OWN_ADDRESS, OWN_ADDRESS_2],
      [effects],
    );

    expect(result).toEqual([bodyInput, [{ txId, index: 1 }, collateralReturn]]);
  });
});

describe('ownPendingOutputs', () => {
  it('keeps every own output, also one another in-flight transaction consumes', () => {
    const tx1Out0 = makeUtxo(pendingTxId, 0, 2_000_000n);
    const tx2Out0 = makeUtxo(otherPendingTxId, 0, 1_500_000n, OWN_ADDRESS_2);

    expect(
      ownPendingOutputs(
        [
          inFlight({ producedOutputs: [tx1Out0] }),
          inFlight({
            consumedInputs: [{ txId: pendingTxId, index: 0 }],
            producedOutputs: [
              tx2Out0,
              makeUtxo(otherPendingTxId, 1, 3_000_000n, FOREIGN_ADDRESS),
            ],
          }),
        ],
        [OWN_ADDRESS, OWN_ADDRESS_2],
      ),
    ).toEqual([tx1Out0, tx2Out0]);
  });

  it('lists an outpoint once', () => {
    const output = makeUtxo(pendingTxId, 0, 2_000_000n);

    expect(
      ownPendingOutputs(
        [
          inFlight({ producedOutputs: [output] }),
          inFlight({ producedOutputs: [output] }),
        ],
        [OWN_ADDRESS],
      ),
    ).toEqual([output]);
  });
});
