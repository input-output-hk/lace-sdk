import { outpointKey } from '@lace-contract/cardano-context';
import { Cardano } from '@lace-lib/cardano-core';
import { Hash28ByteBase16 } from '@lace-lib/cardano-crypto';
import { describe, expect, it, vi } from 'vitest';

import { CustodyBuildFailure } from '../../../src/store/custody/build-failure';
import {
  checkContractCall,
  outflowOf,
  owedOf,
} from '../../../src/store/custody/custody-contract-call';

import {
  chainId,
  controlUtxo,
  CONTRACT_ADDRESS,
  fundUtxo,
  identity,
  utxo,
} from './fixtures';

import type { CustodyAccountContext } from '../../../src/store/custody/custody-account';
import type { CardanoCustodyContractCall } from '@lace-contract/cardano-context';

const older = vi.hoisted(() => ({ accountValidatorHash: '99'.repeat(28) }));

vi.mock('@lace-lib/cardano-custody', async importOriginal => {
  const actual = await importOriginal<
    // eslint-disable-next-line @typescript-eslint/consistent-type-imports
    typeof import('@lace-lib/cardano-custody')
  >();
  return {
    ...actual,
    SUPPORTED_CUSTODY_CONTRACT_VERSIONS: [
      {
        ...actual.CURRENT_CUSTODY_CONTRACT_VERSION,
        accountValidatorHash: older.accountValidatorHash,
      },
      ...actual.SUPPORTED_CUSTODY_CONTRACT_VERSIONS,
    ],
  };
});

/** A reserve of the account: a UTxO at its address that only an owner spends. */
const reserve = fundUtxo(810, 3_000_000n);

/** An account of the current contract version with one reserve, no funds and no grants. */
const context = {
  identity,
  control: controlUtxo(),
  funds: [],
  reserves: [reserve],
  grants: [],
} as unknown as CustodyAccountContext;

/** A script address locked by the account validator of an older supported version. */
const olderAccountAddress = Cardano.EnterpriseAddress.fromCredentials(
  Cardano.NetworkId.Testnet,
  {
    type: Cardano.CredentialType.ScriptHash,
    hash: Hash28ByteBase16(older.accountValidatorHash),
  },
)
  .toAddress()
  .toBech32() as Cardano.PaymentAddress;

const callSpending = (address: Cardano.PaymentAddress) =>
  ({
    inputs: [
      {
        utxo: utxo(800, { address, value: { coins: 5_000_000n }, datum: 1n }),
        redeemer: 1n,
      },
    ],
  } satisfies CardanoCustodyContractCall);

/** The reason the check refuses the call with, or undefined when it passes. */
const refusalOf = (
  call: CardanoCustodyContractCall,
  options?: { isControlSpent?: boolean },
) => {
  try {
    checkContractCall(call, context, { chainId, ...options });
    return undefined;
  } catch (error) {
    if (error instanceof CustodyBuildFailure) return error.reason;
    throw error;
  }
};

describe('checkContractCall', () => {
  it('refuses an input locked by the account validator of any supported version', () => {
    expect(refusalOf(callSpending(olderAccountAddress))).toEqual({
      code: 'invalid-operation',
      reason: 'invalid-contract-call',
      message: 'Input 0 belongs to a custody account',
    });
  });

  it('lets an input of another contract through', () => {
    expect(refusalOf(callSpending(CONTRACT_ADDRESS))).toBeUndefined();
  });

  it("refuses a reference input of a reserve as the account's own", () => {
    expect(
      refusalOf({
        ...callSpending(CONTRACT_ADDRESS),
        referenceInputs: [reserve],
      }),
    ).toEqual({
      code: 'invalid-operation',
      reason: 'invalid-contract-call',
      message: `UTxO ${outpointKey(reserve[0])} is the account's own`,
    });
  });

  it('reads the control UTxO unless the spend also spends it', () => {
    const call = {
      ...callSpending(CONTRACT_ADDRESS),
      referenceInputs: [context.control],
    };
    expect(refusalOf(call)).toBeUndefined();
    expect(refusalOf(call, { isControlSpent: true })).toEqual({
      code: 'invalid-operation',
      reason: 'invalid-contract-call',
      message: `UTxO ${outpointKey(context.control[0])} is the account's own`,
    });
  });
});

describe('owedOf', () => {
  it('owes the lovelace, even below zero, and only the assets the outflow takes', () => {
    const taken = Cardano.AssetId(`${'77'.repeat(28)}01`);
    const left = Cardano.AssetId(`${'77'.repeat(28)}02`);
    expect(
      owedOf(
        outflowOf(
          { coins: 2_000_000n, assets: new Map([[taken, 5n]]) },
          {
            lovelace: 7_000_000n,
            assets: new Map([
              [taken, 2n],
              [left, 3n],
            ]),
          },
        ),
      ),
    ).toEqual({ coins: -5_000_000n, assets: new Map([[taken, 3n]]) });
  });
});
