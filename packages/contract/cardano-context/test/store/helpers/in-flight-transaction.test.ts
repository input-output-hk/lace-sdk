import { ActivityType } from '@lace-contract/activities';
import { TokenId } from '@lace-contract/tokens';
import { AccountId } from '@lace-contract/wallet-repo';
import { Cardano, Serialization } from '@lace-lib/cardano-core';
import { BigNumber, HexBytes, Timestamp } from '@lace-lib/util';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { derivePendingActivityFromCbor } from '../../../src/store/helpers/derive-pending-activity-from-cbor';
import {
  inFlightTransactionOf,
  pendingActivityOf,
} from '../../../src/store/helpers/in-flight-transaction';
import { CardanoPaymentAddress } from '../../../src/types';

import type { CardanoCustodyActivityMetadata } from '../../../src/custody/pending-operation';

const OWN_ADDRESS = CardanoPaymentAddress(
  'addr_test1qphhr294v0w0rzgk7kz4ynsp8hwt82ha6nsp8yk6h04fhzsuryus5g7pm3lq85msee5pdtqlnv2crdc83kk2tvhsefcsu2snle',
);
const OWN_ADDRESS_2 = CardanoPaymentAddress(
  'addr_test1qpuzeec0zqcm6lrdygkkvvd8e6qactnsl5zzeujsdpkpc939l2f2vykk0ctwq4ys6w3jg8pm0kknmy8m5pml8f9cauzq2zuc95',
);
const FOREIGN_ADDRESS = CardanoPaymentAddress(
  'addr_test1qqt3r9kd56aq9ajynjkz8hdfw3kc0pcv3tpzug8azxls62tvvz7nw9gmznn65g4ksrrfvyzhz52knc3mqxdyya47gz2qmcjmcq',
);

const PREV_TX_ID = Cardano.TransactionId(
  '39a7a284c2a0948189dc45dec670211cd4d72f7b66c5726c08d9b3df11e44d58',
);
const OTHER_TX_ID = Cardano.TransactionId(
  '4c4e67bafa15e742c13c592b65c8f74c769cd7d9af04c848099672d1ba391b49',
);
const REWARD_ACCOUNT = Cardano.RewardAccount(
  'stake_test1up7pvfq8zn4quy45r2g572290p9vf99mr9tn7r9xrgy2l2qdsf58d',
);
const OTHER_REWARD_ACCOUNT = Cardano.RewardAccount(
  'stake_test1upjghly04re6yrr3nh3ntp9en3p5flnxh2yf6camc3vfhwg6dhc5w',
);

const ACCOUNT_ID = AccountId('test-account');
const chainId = Cardano.ChainIds.Preprod;

const ownUtxo: Cardano.Utxo = [
  { txId: PREV_TX_ID, index: 0, address: Cardano.PaymentAddress(OWN_ADDRESS) },
  {
    address: Cardano.PaymentAddress(OWN_ADDRESS),
    value: { coins: 10_000_000n },
  },
];

const buildTxCbor = (body: Cardano.TxBody, isValid = true): HexBytes =>
  HexBytes(
    Serialization.Transaction.fromCore({
      body,
      id: '0'.repeat(64) as Cardano.TransactionId,
      isValid,
      witness: { signatures: new Map() },
    }).toCbor(),
  );

const txIdOf = (serializedTx: HexBytes) =>
  Serialization.Transaction.fromCbor(
    Serialization.TxCBOR(serializedTx),
  ).getId();

const output = (address: CardanoPaymentAddress, coins: bigint) => ({
  address: Cardano.PaymentAddress(address),
  value: { coins },
});

/** Spends an own and a foreign input, pays a foreign address and own change. */
const spendTx = (body: Partial<Cardano.TxBody> = {}, isValid = true) =>
  buildTxCbor(
    {
      inputs: [
        { txId: PREV_TX_ID, index: 0 },
        { txId: OTHER_TX_ID, index: 1 },
      ],
      outputs: [
        output(FOREIGN_ADDRESS, 3_000_000n),
        output(OWN_ADDRESS_2, 6_800_000n),
      ],
      fee: 200_000n,
      ...body,
    },
    isValid,
  );

/** An own and a foreign collateral input. */
const collaterals = [
  { txId: PREV_TX_ID, index: 1 },
  { txId: OTHER_TX_ID, index: 2 },
];
const collateralReturn = output(OWN_ADDRESS, 4_700_000n);
const ownCollateralUtxo: Cardano.Utxo = [
  { txId: PREV_TX_ID, index: 1, address: Cardano.PaymentAddress(OWN_ADDRESS) },
  {
    address: Cardano.PaymentAddress(OWN_ADDRESS),
    value: { coins: 5_000_000n },
  },
];

describe('inFlightTransactionOf', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('records every input, own or foreign', () => {
    expect(
      inFlightTransactionOf({ serializedTx: spendTx(), chainId }).effects
        .consumedInputs,
    ).toEqual([
      { txId: PREV_TX_ID, index: 0 },
      { txId: OTHER_TX_ID, index: 1 },
    ]);
  });

  it('records every output, own or foreign, as UTxOs under the transaction id', () => {
    const serializedTx = buildTxCbor({
      inputs: [{ txId: PREV_TX_ID, index: 0 }],
      outputs: [
        output(OWN_ADDRESS, 1_000_000n),
        output(FOREIGN_ADDRESS, 2_000_000n),
        output(OWN_ADDRESS_2, 5_000_000n),
      ],
      fee: 200_000n,
    });
    const txId = txIdOf(serializedTx);

    expect(
      inFlightTransactionOf({ serializedTx, chainId }).effects.producedOutputs,
    ).toEqual([
      [{ txId, index: 0 }, output(OWN_ADDRESS, 1_000_000n)],
      [{ txId, index: 1 }, output(FOREIGN_ADDRESS, 2_000_000n)],
      [{ txId, index: 2 }, output(OWN_ADDRESS_2, 5_000_000n)],
    ]);
  });

  it("records the body's upper validity bound as invalidHereafter", () => {
    expect(
      inFlightTransactionOf({
        serializedTx: spendTx({
          validityInterval: { invalidHereafter: Cardano.Slot(118_761_883) },
        }),
        chainId,
      }).invalidHereafter,
    ).toBe(Cardano.Slot(118_761_883));
  });

  it.each([
    ['no validity interval', {}],
    [
      'only a lower validity bound',
      { validityInterval: { invalidBefore: Cardano.Slot(100) } },
    ],
  ])('records no invalidHereafter when the body sets %s', (_, body) => {
    expect(
      inFlightTransactionOf({ serializedTx: spendTx(body), chainId }),
    ).not.toHaveProperty('invalidHereafter');
  });

  it('records every body withdrawal, own or not, with exact quantities', () => {
    const withdrawals = [
      { stakeAddress: REWARD_ACCOUNT, quantity: 9_007_199_254_740_993n },
      { stakeAddress: OTHER_REWARD_ACCOUNT, quantity: 1_000_000n },
    ];
    const recorded = inFlightTransactionOf({
      serializedTx: spendTx({ withdrawals }),
      chainId,
    });

    expect(recorded.effects.withdrawals).toHaveLength(2);
    expect(recorded.effects.withdrawals).toEqual(
      expect.arrayContaining(withdrawals),
    );
  });

  it('leaves withdrawals out when the body has none', () => {
    expect(
      inFlightTransactionOf({ serializedTx: spendTx(), chainId }).effects,
    ).not.toHaveProperty('withdrawals');
  });

  it('records the inputs, outputs and withdrawals, not the collateral, of a transaction flagged isValid true', () => {
    const withdrawals = [
      { stakeAddress: REWARD_ACCOUNT, quantity: 1_000_000n },
    ];
    const serializedTx = spendTx({
      collaterals,
      collateralReturn,
      withdrawals,
    });
    const txId = txIdOf(serializedTx);

    expect(inFlightTransactionOf({ serializedTx, chainId }).effects).toEqual({
      consumedInputs: [
        { txId: PREV_TX_ID, index: 0 },
        { txId: OTHER_TX_ID, index: 1 },
      ],
      producedOutputs: [
        [{ txId, index: 0 }, output(FOREIGN_ADDRESS, 3_000_000n)],
        [{ txId, index: 1 }, output(OWN_ADDRESS_2, 6_800_000n)],
      ],
      withdrawals,
    });
  });

  describe('of a transaction flagged isValid false', () => {
    it('records only its collateral inputs and its collateral return, under the transaction id after the last output', () => {
      const serializedTx = spendTx(
        {
          collaterals,
          collateralReturn,
          withdrawals: [{ stakeAddress: REWARD_ACCOUNT, quantity: 1_000_000n }],
        },
        false,
      );

      expect(inFlightTransactionOf({ serializedTx, chainId }).effects).toEqual({
        consumedInputs: collaterals,
        producedOutputs: [
          [{ txId: txIdOf(serializedTx), index: 2 }, collateralReturn],
        ],
      });
    });

    it('records no output when it sets no collateral return', () => {
      expect(
        inFlightTransactionOf({
          serializedTx: spendTx({ collaterals }, false),
          chainId,
        }).effects,
      ).toEqual({ consumedInputs: collaterals, producedOutputs: [] });
    });
  });

  it('records a body no account can resolve, with the network and time given', () => {
    // Spends change the wallet does not hold yet and pays only a foreign
    // address: no ownership set would resolve it.
    const serializedTx = buildTxCbor({
      inputs: [{ txId: OTHER_TX_ID, index: 1 }],
      outputs: [output(FOREIGN_ADDRESS, 6_600_000n)],
      fee: 200_000n,
      validityInterval: { invalidHereafter: Cardano.Slot(90_000_000) },
    });
    const txId = txIdOf(serializedTx);

    expect(
      inFlightTransactionOf({
        serializedTx,
        chainId: Cardano.ChainIds.Preview,
        submittedAt: Timestamp(42),
      }),
    ).toEqual({
      chainId: Cardano.ChainIds.Preview,
      txId,
      effects: {
        consumedInputs: [{ txId: OTHER_TX_ID, index: 1 }],
        producedOutputs: [
          [{ txId, index: 0 }, output(FOREIGN_ADDRESS, 6_600_000n)],
        ],
      },
      invalidHereafter: Cardano.Slot(90_000_000),
      submittedAt: Timestamp(42),
    });
  });

  it('records the current time when no time is given', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-02T03:04:05Z'));

    expect(
      inFlightTransactionOf({ serializedTx: spendTx(), chainId }).submittedAt,
    ).toBe(Date.parse('2024-01-02T03:04:05Z'));
  });

  it('throws when the CBOR is not a transaction', () => {
    expect(() =>
      inFlightTransactionOf({ serializedTx: HexBytes('deadbeef'), chainId }),
    ).toThrow();
  });
});

describe('pendingActivityOf', () => {
  const rowOf = (
    serializedTx: HexBytes,
    {
      accountAddresses = [OWN_ADDRESS, OWN_ADDRESS_2],
      accountUtxos = [ownUtxo],
      custody,
    }: {
      accountAddresses?: CardanoPaymentAddress[];
      accountUtxos?: Cardano.Utxo[];
      custody?: CardanoCustodyActivityMetadata;
    } = {},
  ) =>
    pendingActivityOf({
      ...inFlightTransactionOf({ serializedTx, chainId }),
      accountId: ACCOUNT_ID,
      accountAddresses,
      accountUtxos,
      timestamp: Timestamp(42),
      ...(custody && { custody }),
    });

  it('derives the row derivePendingActivityFromCbor derives from the same body, at the time given', () => {
    const serializedTx = spendTx();

    expect(rowOf(serializedTx)).toEqual({
      ...derivePendingActivityFromCbor({
        serializedTx,
        accountId: ACCOUNT_ID,
        accountAddresses: [OWN_ADDRESS, OWN_ADDRESS_2],
        accountUtxos: [ownUtxo],
      }),
      timestamp: Timestamp(42),
    });
  });

  it('nets own outputs against the own inputs it resolves', () => {
    expect(rowOf(spendTx())).toEqual({
      accountId: ACCOUNT_ID,
      activityId: String(txIdOf(spendTx())),
      timestamp: Timestamp(42),
      tokenBalanceChanges: [
        { tokenId: TokenId('lovelace'), amount: BigNumber(-3_200_000n) },
      ],
      type: ActivityType.Pending,
    });
  });

  it('resolves inputs only against the account UTxOs given', () => {
    const sendAll = buildTxCbor({
      inputs: [{ txId: PREV_TX_ID, index: 0 }],
      outputs: [output(FOREIGN_ADDRESS, 9_800_000n)],
      fee: 200_000n,
    });

    expect(rowOf(sendAll)?.tokenBalanceChanges).toEqual([
      { tokenId: TokenId('lovelace'), amount: BigNumber(-10_000_000n) },
    ]);
    expect(rowOf(sendAll, { accountUtxos: [] })).toBeUndefined();
  });

  it('returns undefined for a transaction that neither spends from nor pays the account', () => {
    expect(
      rowOf(spendTx(), { accountAddresses: [], accountUtxos: [] }),
    ).toBeUndefined();
  });

  describe('of a transaction flagged isValid false', () => {
    const failing = spendTx({ collaterals, collateralReturn }, false);

    it('nets the own collateral return against the own collateral inputs, leaving out the inputs and outputs', () => {
      expect(
        rowOf(failing, { accountUtxos: [ownUtxo, ownCollateralUtxo] })
          ?.tokenBalanceChanges,
      ).toEqual([
        { tokenId: TokenId('lovelace'), amount: BigNumber(-300_000n) },
      ]);
    });

    it('returns undefined for an account that only its outputs pay', () => {
      expect(
        rowOf(failing, { accountAddresses: [OWN_ADDRESS_2], accountUtxos: [] }),
      ).toBeUndefined();
    });
  });

  it('carries feature metadata only, never the in-flight effects', () => {
    const custody: CardanoCustodyActivityMetadata = {
      invalidHereafter: Cardano.Slot(1234),
      operation: 'owner-spend',
      status: 'pending',
      reference: 'intent-1',
    };

    expect(rowOf(spendTx(), { custody })?.blockchainSpecific).toEqual({
      Cardano: { custody },
    });
    expect(rowOf(spendTx())).not.toHaveProperty('blockchainSpecific');
  });
});
