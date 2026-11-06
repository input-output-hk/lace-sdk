import { Hash28ByteBase16 } from '@lace-lib/cardano-crypto';

import { dijkstraReviewFields, unrenderedDijkstraFields } from '../../src';
import * as Cardano from '../../src/Cardano';

const address = Cardano.PaymentAddress(
  'addr_test1qq585l3hyxgj3nas2v3xymd23vvartfhceme6gv98aaeg9muzcjqw982pcftgx53fu5527z2cj2tkx2h8ux2vxsg475q2g7k3g',
);
const rewardAccount = Cardano.RewardAccount(
  'stake_test1uqfu74w3wh4gfzu8m6e7j987h4lq9r3t7ef5gaw497uu85qsqfy27',
);
const keyHashGuard: Cardano.Credential = {
  hash: Hash28ByteBase16('11'.repeat(28)),
  type: Cardano.CredentialType.KeyHash,
};
const scriptHashGuard: Cardano.Credential = {
  hash: Hash28ByteBase16('22'.repeat(28)),
  type: Cardano.CredentialType.ScriptHash,
};

const body = (fields: Partial<Cardano.TxBody> = {}): Cardano.TxBody => ({
  fee: 200_000n,
  inputs: [{ index: 0, txId: Cardano.TransactionId('a'.repeat(64)) }],
  outputs: [{ address, value: { coins: 2_000_000n } }],
  ...fields,
});

const subTransaction = (
  fields: Partial<Cardano.SubTransactionBody> = {},
): Cardano.SubTransaction => ({
  body: {
    inputs: [{ index: 0, txId: Cardano.TransactionId('b'.repeat(64)) }],
    outputs: [],
    ...fields,
  },
  witness: { signatures: new Map() },
});

describe('dijkstraReviewFields', () => {
  it('lists nothing for a transaction without Dijkstra-era parts', () => {
    expect(dijkstraReviewFields(body())).toEqual([]);
  });

  it('does not list a key-hash guard, which is a required signer', () => {
    expect(dijkstraReviewFields(body({ guards: [keyHashGuard] }))).toEqual([]);
  });

  it('lists each part of the top level body', () => {
    expect(
      dijkstraReviewFields(
        body({
          directDeposits: [{ quantity: 1n, stakeAddress: rewardAccount }],
          guards: [keyHashGuard, scriptHashGuard],
          requiredTopLevelGuards: [{ credential: scriptHashGuard, datum: 1n }],
          startingAccountBalanceIntervals: [
            { interval: { exactBalance: 0n }, rewardAccount },
          ],
        }),
      ).sort(),
    ).toEqual([
      'accountBalanceIntervals',
      'directDeposits',
      'requiredTopLevelGuards',
      'scriptGuards',
    ]);
  });

  it('lists the parts of every sub transaction, once each', () => {
    expect(
      dijkstraReviewFields(
        body({
          accountBalanceIntervals: [
            { interval: { exactBalance: 0n }, rewardAccount },
          ],
          subTransactions: [
            subTransaction({
              accountBalanceIntervals: [
                { interval: { inclusiveLowerBound: 1n }, rewardAccount },
              ],
            }),
            subTransaction({ guards: [scriptHashGuard] }),
          ],
        }),
      ).sort(),
    ).toEqual(['accountBalanceIntervals', 'scriptGuards', 'subTransactions']);
  });
});

describe('unrenderedDijkstraFields', () => {
  const batch = body({
    subTransactions: [
      subTransaction({
        directDeposits: [{ quantity: 1n, stakeAddress: rewardAccount }],
      }),
    ],
  });

  it('lists every part a surface rendering none of them cannot show', () => {
    expect(unrenderedDijkstraFields(batch).sort()).toEqual([
      'directDeposits',
      'subTransactions',
    ]);
  });

  it('leaves out the parts the surface renders', () => {
    expect(unrenderedDijkstraFields(batch, ['subTransactions'])).toEqual([
      'directDeposits',
    ]);
    expect(
      unrenderedDijkstraFields(batch, ['directDeposits', 'subTransactions']),
    ).toEqual([]);
  });
});
