import { Cardano } from '@lace-lib/cardano-core';
import * as Crypto from '@lace-lib/cardano-crypto';
import { KeyRole, TxInId } from '@lace-lib/cardano-key-management';

import { mapAdditionalWitnessRequests } from '../../src/transformers/additionalWitnessRequests';
import {
  contextWithKnownAddresses,
  knownAddress,
  knownAddressStakeKeyPath,
  minValidTxBody,
  rewardAccount,
  stakeKeyHash,
  txIn,
} from '../testData';

import type { GroupedAddress } from '@lace-lib/cardano-key-management';

const paymentKeyPath = { index: 0, role: 1 };
const paymentBip32Path = [
  2_147_485_500,
  2_147_485_463,
  2_147_483_648,
  paymentKeyPath.role,
  paymentKeyPath.index,
];
const context = {
  ...contextWithKnownAddresses,
  txInKeyPathMap: { [TxInId(txIn)]: paymentKeyPath },
};

const stakeKeyHash3 = Crypto.Hash28ByteBase16('cd'.repeat(28));
const knownAddressAtStake3: GroupedAddress = {
  ...knownAddress,
  rewardAccount: Cardano.RewardAccount.fromCredential(
    { hash: stakeKeyHash3, type: Cardano.CredentialType.KeyHash },
    Cardano.NetworkId.Mainnet,
  ),
  stakeKeyDerivationPath: { index: 3, role: KeyRole.Stake },
};

describe('additionalWitnessRequests', () => {
  it('requests only the input payment key paths when no stake witness is needed', () => {
    expect(mapAdditionalWitnessRequests(minValidTxBody, context)).toEqual([
      paymentBip32Path,
    ]);
  });

  it('requests the stake key of a withdrawal from an own reward account', () => {
    expect(
      mapAdditionalWitnessRequests(
        {
          ...minValidTxBody,
          withdrawals: [{ quantity: 1n, stakeAddress: rewardAccount }],
        },
        context,
      ),
    ).toEqual([paymentBip32Path, knownAddressStakeKeyPath]);
  });

  it('requests the stake key a native script in the context requires', () => {
    expect(
      mapAdditionalWitnessRequests(minValidTxBody, {
        ...context,
        scripts: [
          {
            __type: Cardano.ScriptType.Native,
            keyHash: Crypto.Ed25519KeyHashHex(stakeKeyHash),
            kind: Cardano.NativeScriptKind.RequireSignature,
          },
        ],
      }),
    ).toEqual([paymentBip32Path, knownAddressStakeKeyPath]);
  });

  it('requests the stake key a certificate needs, not the first known address one', () => {
    expect(
      mapAdditionalWitnessRequests(
        {
          ...minValidTxBody,
          certificates: [
            {
              __typename: Cardano.CertificateType.StakeDeregistration,
              stakeCredential: {
                hash: stakeKeyHash3,
                type: Cardano.CredentialType.KeyHash,
              },
            },
          ],
        },
        {
          ...context,
          knownAddresses: [knownAddress, knownAddressAtStake3],
        },
      ),
    ).toEqual([
      paymentBip32Path,
      [2_147_485_500, 2_147_485_463, 2_147_483_648, 2, 3],
    ]);
  });
});
