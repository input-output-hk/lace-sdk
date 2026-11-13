import { pendingRewardWithdrawalKey } from '@lace-contract/cardano-context';
import { AccountId } from '@lace-contract/wallet-repo';
import { Cardano, Serialization } from '@lace-lib/cardano-core';
import { Hash28ByteBase16 } from '@lace-lib/cardano-crypto';
import { BigNumber } from '@lace-lib/util';
import { firstValueFrom, of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';

import { CardanoCustodyAccountRefusedError } from '../../src/store/custody/custody-account-guard';
import { makeBuildDeregistrationTx } from '../../src/tx-executor-implementation';
import { custodyAddressEntry } from '../store/custody/custody-address-entry';

import type { Address, AnyAddress } from '@lace-contract/addresses';
import type {
  AccountRewardAccountDetailsMap,
  PendingRewardWithdrawals,
} from '@lace-contract/cardano-context';
import type { SideEffectDependencies } from '@lace-contract/module';

const testAccountId = AccountId('test-account');

const testAddress =
  'addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3jcu5d8ps7zex2k2xt3uqxgjqnnj83ws8lhrn648jjxtwq2ytjqp';

const mockUtxo: Cardano.Utxo = [
  {
    address: Cardano.PaymentAddress(testAddress),
    txId: Cardano.TransactionId(
      '0000000000000000000000000000000000000000000000000000000000000001',
    ),
    index: 0,
  },
  {
    address: Cardano.PaymentAddress(testAddress),
    value: { coins: 10_000_000n },
  },
];

const mockProtocolParameters: Cardano.ProtocolParameters = {
  coinsPerUtxoByte: 4310,
  maxCollateralInputs: 3,
  maxTxSize: 16384,
  maxValueSize: 5000,
  minFeeCoefficient: 44,
  minFeeConstant: 155381,
  minPoolCost: 170_000_000,
  poolDeposit: 500_000_000,
  stakeKeyDeposit: 2_000_000,
  prices: {
    memory: 0.0577,
    steps: 0.0000721,
  },
} as Cardano.ProtocolParameters;

const mockAddress: AnyAddress = {
  accountId: testAccountId,
  address: testAddress as Address,
  blockchainName: 'Cardano',
};

// For deregistration, the stake key must be registered (isActive: true)
const activeRewardAccountDetails = {
  [testAccountId]: {
    rewardAccountInfo: { isActive: true, isRegistered: true },
  },
} as AccountRewardAccountDetailsMap;

const inactiveRewardAccountDetails = {
  [testAccountId]: {
    rewardAccountInfo: { isActive: false, isRegistered: false },
  },
} as AccountRewardAccountDetailsMap;

const activeRewardAccountDetailsWithRewards = {
  [testAccountId]: {
    rewardAccountInfo: {
      isActive: true,
      isRegistered: true,
      withdrawableAmount: BigNumber(5000000n), // 5 ADA
    },
  },
} as AccountRewardAccountDetailsMap;

// The reward account the builder withdraws from: the address's stake
// credential on the network the fixtures build for (Mainnet).
const testRewardAccount = Cardano.RewardAccount.fromCredential(
  Cardano.Address.fromBech32(testAddress).asBase()!.getStakeCredential(),
  Cardano.NetworkId.Mainnet,
);

// Another key-hash stake credential: a second reward account.
const otherRewardAccount = Cardano.RewardAccount.fromCredential(
  {
    type: Cardano.CredentialType.KeyHash,
    hash: Hash28ByteBase16('2'.repeat(56)),
  },
  Cardano.NetworkId.Mainnet,
);

// Pending withdrawals as the builder receives them.
const pendingOn = (
  rewardAccount: Cardano.RewardAccount,
  quantity: bigint,
  networkMagic: Cardano.NetworkMagic = Cardano.NetworkMagics.Mainnet,
): PendingRewardWithdrawals =>
  new Map([
    [pendingRewardWithdrawalKey(networkMagic, rewardAccount), quantity],
  ]);

const withRewardsDependencies = (
  pendingRewardWithdrawals: PendingRewardWithdrawals,
) =>
  ({
    txExecutorCardano: {
      cardanoNetworkMagic$: of(764824073),
      cardanoProtocolParameters$: of(mockProtocolParameters),
      cardanoSettledAvailableAccountUtxos$: of({ [testAccountId]: [mockUtxo] }),
      cardanoAddresses$: of([mockAddress]),
      cardanoRewardAccountDetails$: of(activeRewardAccountDetailsWithRewards),
      cardanoPendingRewardWithdrawals$: of(pendingRewardWithdrawals),
    },
  } as unknown as SideEffectDependencies);

describe('makeBuildDeregistrationTx', () => {
  it('returns error when network magic is not available', async () => {
    const dependencies = {
      txExecutorCardano: {
        cardanoNetworkMagic$: of(null),
        cardanoProtocolParameters$: of(mockProtocolParameters),
        cardanoSettledAvailableAccountUtxos$: of({
          [testAccountId]: [mockUtxo],
        }),
        cardanoAddresses$: of([mockAddress]),
        cardanoRewardAccountDetails$: of(activeRewardAccountDetails),
        cardanoPendingRewardWithdrawals$: of(new Map()),
      },
    } as unknown as SideEffectDependencies;

    const buildDeregistrationTx = makeBuildDeregistrationTx(dependencies);

    const result = await firstValueFrom(
      buildDeregistrationTx({ accountId: testAccountId }),
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toBe('Network magic not available');
    }
  });

  it('returns error when protocol parameters are not available', async () => {
    const dependencies = {
      txExecutorCardano: {
        cardanoNetworkMagic$: of(764824073),
        cardanoProtocolParameters$: of(null),
        cardanoSettledAvailableAccountUtxos$: of({
          [testAccountId]: [mockUtxo],
        }),
        cardanoAddresses$: of([mockAddress]),
        cardanoRewardAccountDetails$: of(activeRewardAccountDetails),
        cardanoPendingRewardWithdrawals$: of(new Map()),
      },
    } as unknown as SideEffectDependencies;

    const buildDeregistrationTx = makeBuildDeregistrationTx(dependencies);

    const result = await firstValueFrom(
      buildDeregistrationTx({ accountId: testAccountId }),
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toBe('Protocol parameters not available');
    }
  });

  it('returns error when no addresses found for account', async () => {
    const dependencies = {
      txExecutorCardano: {
        cardanoNetworkMagic$: of(764824073),
        cardanoProtocolParameters$: of(mockProtocolParameters),
        cardanoSettledAvailableAccountUtxos$: of({
          [testAccountId]: [mockUtxo],
        }),
        cardanoAddresses$: of([]),
        cardanoRewardAccountDetails$: of(activeRewardAccountDetails),
        cardanoPendingRewardWithdrawals$: of(new Map()),
      },
    } as unknown as SideEffectDependencies;

    const buildDeregistrationTx = makeBuildDeregistrationTx(dependencies);

    const result = await firstValueFrom(
      buildDeregistrationTx({ accountId: testAccountId }),
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toBe(
        'No Cardano addresses found for account',
      );
    }
  });

  it('returns error when reward account details not available', async () => {
    const dependencies = {
      txExecutorCardano: {
        cardanoNetworkMagic$: of(764824073),
        cardanoProtocolParameters$: of(mockProtocolParameters),
        cardanoSettledAvailableAccountUtxos$: of({
          [testAccountId]: [mockUtxo],
        }),
        cardanoAddresses$: of([mockAddress]),
        cardanoRewardAccountDetails$: of({}),
        cardanoPendingRewardWithdrawals$: of(new Map()),
      },
    } as unknown as SideEffectDependencies;

    const buildDeregistrationTx = makeBuildDeregistrationTx(dependencies);

    const result = await firstValueFrom(
      buildDeregistrationTx({ accountId: testAccountId }),
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toBe(
        'Stake key is not registered or reward account details not available',
      );
    }
  });

  it('returns error when stake key is not registered', async () => {
    const dependencies = {
      txExecutorCardano: {
        cardanoNetworkMagic$: of(764824073),
        cardanoProtocolParameters$: of(mockProtocolParameters),
        cardanoSettledAvailableAccountUtxos$: of({
          [testAccountId]: [mockUtxo],
        }),
        cardanoAddresses$: of([mockAddress]),
        cardanoRewardAccountDetails$: of(inactiveRewardAccountDetails),
        cardanoPendingRewardWithdrawals$: of(new Map()),
      },
    } as unknown as SideEffectDependencies;

    const buildDeregistrationTx = makeBuildDeregistrationTx(dependencies);

    const result = await firstValueFrom(
      buildDeregistrationTx({ accountId: testAccountId }),
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toBe(
        'Stake key is not registered or reward account details not available',
      );
    }
  });

  it('builds transaction with deposit return for registered stake key', async () => {
    const dependencies = {
      txExecutorCardano: {
        cardanoNetworkMagic$: of(764824073),
        cardanoProtocolParameters$: of(mockProtocolParameters),
        cardanoSettledAvailableAccountUtxos$: of({
          [testAccountId]: [mockUtxo],
        }),
        cardanoAddresses$: of([mockAddress]),
        cardanoRewardAccountDetails$: of(activeRewardAccountDetails),
        cardanoPendingRewardWithdrawals$: of(new Map()),
      },
    } as unknown as SideEffectDependencies;

    const buildDeregistrationTx = makeBuildDeregistrationTx(dependencies);

    const result = await firstValueFrom(
      buildDeregistrationTx({ accountId: testAccountId }),
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.serializedTx).toBeTruthy();
      expect(result.fees.length).toBeGreaterThan(0);
      // depositReturn should be the stake key deposit (positive value - user gets this back)
      expect(result.depositReturn).toBe('2000000');
    }
  });

  it('catches and returns errors from transaction building', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const dependencies = {
      txExecutorCardano: {
        cardanoNetworkMagic$: of(764824073),
        cardanoProtocolParameters$: of(mockProtocolParameters),
        cardanoSettledAvailableAccountUtxos$: of({ [testAccountId]: [] }),
        cardanoAddresses$: of([mockAddress]),
        cardanoRewardAccountDetails$: of(activeRewardAccountDetails),
        cardanoPendingRewardWithdrawals$: of(new Map()),
      },
    } as unknown as SideEffectDependencies;

    const buildDeregistrationTx = makeBuildDeregistrationTx(dependencies);

    const result = await firstValueFrom(
      buildDeregistrationTx({ accountId: testAccountId }),
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeInstanceOf(Error);
    }

    vi.restoreAllMocks();
  });

  it('builds transaction with withdrawal when rewards exist', async () => {
    const dependencies = {
      txExecutorCardano: {
        cardanoNetworkMagic$: of(764824073),
        cardanoProtocolParameters$: of(mockProtocolParameters),
        cardanoSettledAvailableAccountUtxos$: of({
          [testAccountId]: [mockUtxo],
        }),
        cardanoAddresses$: of([mockAddress]),
        cardanoRewardAccountDetails$: of(activeRewardAccountDetailsWithRewards),
        cardanoPendingRewardWithdrawals$: of(new Map()),
      },
    } as unknown as SideEffectDependencies;

    const buildDeregistrationTx = makeBuildDeregistrationTx(dependencies);
    const result = await firstValueFrom(
      buildDeregistrationTx({ accountId: testAccountId }),
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.depositReturn).toBe('2000000');
      expect(result.withdrawalAmount).toBe('5000000');
      const tx = Serialization.Transaction.fromCbor(
        Serialization.TxCBOR(result.serializedTx),
      );
      expect(tx.toCore().body.withdrawals).toEqual([
        { stakeAddress: testRewardAccount, quantity: 5_000_000n },
      ]);
    }
  });

  // An in-flight transaction that withdraws the rewards leaves a balance of
  // zero, and the ledger refuses a withdrawal of anything but the whole
  // balance: the deregistration withdraws nothing and chains on it.
  it('skips the withdrawal while an in-flight transaction withdraws the rewards', async () => {
    const result = await firstValueFrom(
      makeBuildDeregistrationTx(
        withRewardsDependencies(pendingOn(testRewardAccount, 5_000_000n)),
      )({ accountId: testAccountId }),
    );

    if (!result.success)
      throw new Error('expected the deregistration to build');
    expect(result.withdrawalAmount).toBe('0');
    expect(result.depositReturn).toBe('2000000');
    const body = Serialization.Transaction.fromCbor(
      Serialization.TxCBOR(result.serializedTx),
    ).toCore().body;
    expect(body.withdrawals).toBeUndefined();
    expect(body.certificates).toEqual([
      expect.objectContaining({
        __typename: Cardano.CertificateType.Unregistration,
      }),
    ]);
  });

  // The pending key names the network: Preview and Preprod share reward
  // addresses, so a withdrawal pending on one network must not skip another's.
  it.each([
    ['the pending amount is zero', pendingOn(testRewardAccount, 0n)],
    [
      'the same reward account has a withdrawal pending on another network',
      pendingOn(testRewardAccount, 5_000_000n, Cardano.NetworkMagics.Preprod),
    ],
    [
      'the pending withdrawal is from another reward account',
      pendingOn(otherRewardAccount, 5_000_000n),
    ],
  ])('still withdraws when %s', async (_, pendingRewardWithdrawals) => {
    const result = await firstValueFrom(
      makeBuildDeregistrationTx(
        withRewardsDependencies(pendingRewardWithdrawals),
      )({ accountId: testAccountId }),
    );

    if (!result.success)
      throw new Error('expected the deregistration to build');
    expect(result.withdrawalAmount).toBe('5000000');
    const body = Serialization.Transaction.fromCbor(
      Serialization.TxCBOR(result.serializedTx),
    ).toCore().body;
    expect(body.withdrawals).toEqual([
      { stakeAddress: testRewardAccount, quantity: 5_000_000n },
    ]);
  });

  it('builds transaction without withdrawal when no rewards exist', async () => {
    const dependencies = {
      txExecutorCardano: {
        cardanoNetworkMagic$: of(764824073),
        cardanoProtocolParameters$: of(mockProtocolParameters),
        cardanoSettledAvailableAccountUtxos$: of({
          [testAccountId]: [mockUtxo],
        }),
        cardanoAddresses$: of([mockAddress]),
        cardanoRewardAccountDetails$: of(activeRewardAccountDetails),
        cardanoPendingRewardWithdrawals$: of(new Map()),
      },
    } as unknown as SideEffectDependencies;

    const buildDeregistrationTx = makeBuildDeregistrationTx(dependencies);
    const result = await firstValueFrom(
      buildDeregistrationTx({ accountId: testAccountId }),
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.withdrawalAmount).toBe('0');
      const tx = Serialization.Transaction.fromCbor(
        Serialization.TxCBOR(result.serializedTx),
      );
      expect(tx.toCore().body.withdrawals).toBeUndefined();
    }
  });

  it('refuses a Cardano custody account before building', async () => {
    const dependencies = {
      txExecutorCardano: {
        cardanoNetworkMagic$: of(764824073),
        cardanoProtocolParameters$: of(mockProtocolParameters),
        cardanoSettledAvailableAccountUtxos$: of({
          [testAccountId]: [mockUtxo],
        }),
        cardanoAddresses$: of([custodyAddressEntry(testAccountId)]),
        cardanoRewardAccountDetails$: of(activeRewardAccountDetails),
        cardanoPendingRewardWithdrawals$: of(new Map()),
      },
    } as unknown as SideEffectDependencies;

    const result = await firstValueFrom(
      makeBuildDeregistrationTx(dependencies)({ accountId: testAccountId }),
    );

    expect(result).toEqual({
      success: false,
      error: expect.any(CardanoCustodyAccountRefusedError) as unknown,
    });
  });
});
