import { Cardano, Serialization } from '@lace-lib/cardano-core';
import { describe, expect, it } from 'vitest';

import {
  subTransactionImbalance,
  subTransactionsImbalance,
} from '../src/sub-transactions';

import type * as Crypto from '@lace-lib/cardano-crypto';

const protocolParameters = {
  stakeKeyDeposit: 2_000_000,
  poolDeposit: 500_000_000,
};

const address = Cardano.PaymentAddress(
  'addr_test1qpfhhfy2qgls50r9u4yh0l7z67xpg0a5rrhkmvzcuqrd0znuzcjqw982pcftgx53fu5527z2cj2tkx2h8ux2vxsg475q9gw0lz',
);
const rewardAccount = Cardano.RewardAccount(
  'stake_test1uqfu74w3wh4gfzu8m6e7j987h4lq9r3t7ef5gaw497uu85qsqfy27',
);
const stakeCredential: Cardano.Credential = {
  type: Cardano.CredentialType.KeyHash,
  hash: Cardano.RewardAccount.toHash(
    rewardAccount,
  ) as unknown as Crypto.Hash28ByteBase16,
};
const token = Cardano.AssetId(`${'ab'.repeat(28)}544f4b454e`);

const utxoOf = (byte: string, value: Cardano.Value): Cardano.Utxo => [
  { txId: Cardano.TransactionId(byte.repeat(32)), index: 0, address },
  { address, value },
];

const poolId = Cardano.PoolId(
  'pool1ev8vy6fyj7693ergzty2t0azjvw35tvkt2vcjwpgajqs7z6u2vn',
);
const otherPoolId = Cardano.PoolId(
  'pool1mpgg03jxj52qwxvvy7cmj58a96vl9pvxcqqvuw0kumheygxmn34',
);
const poolDeposit = BigInt(protocolParameters.poolDeposit);

const poolRegistrationOf = (
  id: Cardano.PoolId,
): Cardano.PoolRegistrationCertificate => ({
  __typename: Cardano.CertificateType.PoolRegistration,
  poolParameters: {
    id,
    rewardAccount,
    pledge: 10_000n,
    cost: 340_000_000n,
    margin: { numerator: 1, denominator: 50 },
    owners: [rewardAccount],
    relays: [],
    vrf: Cardano.VrfVkHex('8d'.repeat(32)),
  },
});

const subTransactionOf = (body: Partial<Cardano.SubTransactionBody>) =>
  Serialization.SubTransaction.fromCore({
    body: { inputs: [], outputs: [], ...body },
    witness: { signatures: new Map() },
  });

describe('subTransactionImbalance', () => {
  const spent = utxoOf('a1', {
    coins: 100_000_000n,
    assets: new Map([[token, 10n]]),
  });

  it('is the spent value minus the outputs', () => {
    const subTransaction = subTransactionOf({
      inputs: [spent[0]],
      outputs: [
        {
          address,
          value: { coins: 60_000_000n, assets: new Map([[token, 15n]]) },
        },
      ],
    });

    expect(
      subTransactionImbalance(subTransaction, [spent], protocolParameters),
    ).toEqual({
      coins: 40_000_000n,
      assets: new Map([[token, -5n]]),
    });
  });

  it('counts withdrawals, reclaimed deposits and mint as consumed, and deposits, donation and direct deposits as produced', () => {
    const subTransaction = subTransactionOf({
      inputs: [spent[0]],
      outputs: [
        {
          address,
          value: { coins: 90_000_000n, assets: new Map([[token, 10n]]) },
        },
      ],
      withdrawals: [{ stakeAddress: rewardAccount, quantity: 1_200_000n }],
      certificates: [
        {
          __typename: Cardano.CertificateType.Registration,
          stakeCredential,
          deposit: 2_000_000n,
        },
      ],
      mint: new Map([[token, 7n]]),
      donation: 300_000n,
      directDeposits: [{ stakeAddress: rewardAccount, quantity: 3_000_000n }],
    });

    expect(
      subTransactionImbalance(subTransaction, [spent], protocolParameters),
    ).toEqual({
      coins:
        100_000_000n +
        1_200_000n -
        90_000_000n -
        2_000_000n -
        300_000n -
        3_000_000n,
      assets: new Map([[token, 7n]]),
    });
  });

  it('refunds no pool deposit for a pool retirement, which the ledger refunds at the epoch boundary', () => {
    const subTransaction = subTransactionOf({
      inputs: [spent[0]],
      outputs: [
        {
          address,
          value: { coins: 100_000_000n, assets: new Map([[token, 10n]]) },
        },
      ],
      certificates: [
        {
          __typename: Cardano.CertificateType.PoolRetirement,
          poolId,
          epoch: Cardano.EpochNo(300),
        },
      ],
    });

    expect(
      subTransactionImbalance(subTransaction, [spent], protocolParameters),
    ).toEqual({ coins: 0n, assets: new Map() });
  });

  it('charges the pool deposit once per pool, however many times the sub transaction registers it', () => {
    const subTransaction = subTransactionOf({
      inputs: [spent[0]],
      certificates: [
        poolRegistrationOf(poolId),
        poolRegistrationOf(otherPoolId),
        poolRegistrationOf(poolId),
      ],
    });

    expect(
      subTransactionImbalance(subTransaction, [spent], protocolParameters),
    ).toEqual({
      coins: 100_000_000n - 2n * poolDeposit,
      assets: new Map([[token, 10n]]),
    });
  });

  it('refuses a sub transaction whose spent input is not resolved', () => {
    const subTransaction = subTransactionOf({ inputs: [spent[0]] });

    expect(() =>
      subTransactionImbalance(subTransaction, [], protocolParameters),
    ).toThrow(`spends an input that is not resolved: ${spent[0].txId}#0`);
  });
});

describe('subTransactionsImbalance', () => {
  it('adds up the imbalances, so opposite intents cancel out', () => {
    const buyerUtxo = utxoOf('b1', { coins: 100_000_000n });
    const sellerUtxo = utxoOf('b2', {
      coins: 10_000_000n,
      assets: new Map([[token, 5000n]]),
    });
    const buyer = subTransactionOf({
      inputs: [buyerUtxo[0]],
      outputs: [
        {
          address,
          value: { coins: 50_000_000n, assets: new Map([[token, 1000n]]) },
        },
      ],
    });
    const seller = subTransactionOf({
      inputs: [sellerUtxo[0]],
      outputs: [
        {
          address,
          value: { coins: 60_000_000n, assets: new Map([[token, 4000n]]) },
        },
      ],
    });

    const imbalance = subTransactionsImbalance(
      [buyer, seller],
      [buyerUtxo, sellerUtxo],
      protocolParameters,
    );

    expect(imbalance.coins).toBe(0n);
    expect(imbalance.assets?.get(token) ?? 0n).toBe(0n);
  });

  it('charges the pool deposit once for a pool several sub transactions register', () => {
    const first = utxoOf('c1', { coins: 600_000_000n });
    const second = utxoOf('c2', { coins: 600_000_000n });

    const imbalance = subTransactionsImbalance(
      [
        subTransactionOf({
          inputs: [first[0]],
          certificates: [poolRegistrationOf(poolId)],
        }),
        subTransactionOf({
          inputs: [second[0]],
          certificates: [
            poolRegistrationOf(poolId),
            poolRegistrationOf(otherPoolId),
          ],
        }),
      ],
      [first, second],
      protocolParameters,
    );

    expect(imbalance.coins).toBe(1_200_000_000n - 2n * poolDeposit);
  });

  it('charges no pool deposit for a pool already registered on chain, and a new pool once', () => {
    const first = utxoOf('c1', { coins: 600_000_000n });
    const second = utxoOf('c2', { coins: 600_000_000n });
    const subTransactions = [
      subTransactionOf({
        inputs: [first[0]],
        certificates: [poolRegistrationOf(poolId)],
      }),
      subTransactionOf({
        inputs: [second[0]],
        certificates: [
          poolRegistrationOf(poolId),
          poolRegistrationOf(otherPoolId),
        ],
      }),
    ];

    expect(
      subTransactionsImbalance(subTransactions, [first, second], {
        ...protocolParameters,
        registeredPools: new Set([poolId]),
      }).coins,
    ).toBe(1_200_000_000n - poolDeposit);
    expect(
      subTransactionImbalance(subTransactions[0], [first], {
        ...protocolParameters,
        registeredPools: new Set([poolId]),
      }).coins,
    ).toBe(600_000_000n);
  });

  it('is zero without sub transactions', () => {
    expect(subTransactionsImbalance([], [], protocolParameters).coins).toBe(0n);
  });
});
