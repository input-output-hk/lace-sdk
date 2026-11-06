import { Cardano, Serialization } from '@lace-lib/cardano-core';

import { getUnmappedBodyFields } from '../src';

import {
  rewardAccount,
  stakeKeyHash,
  txBody,
  txIn,
  pureAdaTxOut,
} from './testData';

const bodyOf = (body: Cardano.TxBody) =>
  Serialization.TransactionBody.fromCore(body).toCore();

const minimalBody: Cardano.TxBody = {
  fee: 10n,
  inputs: [txIn],
  outputs: [pureAdaTxOut],
};

describe('getUnmappedBodyFields', () => {
  it('finds none in a body the request carries', () => {
    expect(getUnmappedBodyFields(txBody)).toEqual([]);
  });

  it('finds key hash guards in credential form, which the request would write as required signers', () => {
    const body = bodyOf({
      ...minimalBody,
      guards: [{ hash: stakeKeyHash, type: Cardano.CredentialType.KeyHash }],
    });

    expect(getUnmappedBodyFields(body)).toEqual(['guards']);
  });

  it.each([
    {
      body: {
        guards: [
          { hash: stakeKeyHash, type: Cardano.CredentialType.ScriptHash },
        ],
      },
      field: 'guards',
    },
    {
      body: {
        requiredTopLevelGuards: [
          {
            credential: {
              hash: stakeKeyHash,
              type: Cardano.CredentialType.KeyHash,
            },
            datum: null,
          },
        ],
      },
      field: 'requiredTopLevelGuards',
    },
    {
      body: { directDeposits: [{ quantity: 1n, stakeAddress: rewardAccount }] },
      field: 'directDeposits',
    },
    {
      body: {
        accountBalanceIntervals: [
          { interval: { exactBalance: 1n }, rewardAccount },
        ],
      },
      field: 'accountBalanceIntervals',
    },
    {
      body: {
        subTransactions: [
          {
            body: { inputs: [], outputs: [] },
            witness: { signatures: new Map() },
          },
        ],
      },
      field: 'subTransactions',
    },
  ] as { body: Partial<Cardano.TxBody>; field: string }[])(
    'finds $field',
    ({ body, field }) => {
      expect(
        getUnmappedBodyFields(bodyOf({ ...minimalBody, ...body })),
      ).toEqual([field]);
    },
  );
});
