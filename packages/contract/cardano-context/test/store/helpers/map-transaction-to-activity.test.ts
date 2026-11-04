import {
  Cardano,
  createTxInspector,
  Serialization,
  transactionSummaryInspector,
} from '@cardano-sdk/core';
import { HexBlob } from '@cardano-sdk/util';
import { ActivityType } from '@lace-contract/activities';
import { TokenId } from '@lace-contract/tokens';
import { AccountId } from '@lace-contract/wallet-repo';
import { ACCOUNT_VALIDATOR_HASH } from '@lace-lib/cardano-custody';
import { BigNumber, Timestamp } from '@lace-lib/util';
import { firstValueFrom, of } from 'rxjs';
import { dummyLogger } from 'ts-log';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { assetProvider } from '../../../src/store/helpers/get-fallback-asset';
import { mapTransactionToActivity } from '../../../src/store/helpers/map-transaction-to-activity';
import { classifyTxAsNightDesignation } from '../../../src/store/helpers/night-designation-script-addresses';
import {
  CardanoRewardAccount,
  CardanoPaymentAddress,
} from '../../../src/types';

import type {
  ExtendedTxDetails,
  RequiredProtocolParameters,
} from '../../../src/types';
import type * as Core from '@cardano-sdk/core';

const logger = dummyLogger;

const allExtensionActivities = { nightDesignation: true, hydra: true };
const noExtensionActivities = { nightDesignation: false, hydra: false };

/**
 * A summary with every input resolved. The real `TransactionSummaryInspection`
 * always carries these fields, so a mock that omits one is not a shape the code
 * can receive.
 */
const summaryOf = (fields: Partial<Core.TransactionSummaryInspection>) =>
  ({
    assets: new Map(),
    coins: 0n,
    resolvedInputs: [],
    returnedDeposit: 0n,
    unresolved: { inputs: [], value: { coins: 0n } },
    ...fields,
  } as Core.TransactionSummaryInspection);

// Mock the Cardano SDK functions
vi.mock('@cardano-sdk/core', async importActual => {
  const module = await importActual<typeof Core>();

  return {
    Cardano: {
      ...module.Cardano,
      AssetId: {
        getPolicyId: vi.fn(),
        getAssetName: vi.fn(),
      },
      AssetFingerprint: {
        fromParts: vi.fn(),
      },
      BlockNo: vi.fn(),
      BlockId: vi.fn(),
      Slot: vi.fn(),
    },
    Serialization: module.Serialization,
    createTxInspector: vi.fn(),
    transactionSummaryInspector: vi.fn(),
  };
});

// The cNIGHT classification predicate is exhaustively tested in
// night-designation-script-addresses.test.ts; here we mock it to verify the
// mapping GLUE (classification → NightDesignation activity + metadata).
vi.mock(
  '../../../src/store/helpers/night-designation-script-addresses',
  () => ({ classifyTxAsNightDesignation: vi.fn() }),
);

describe('mapTransactionToActivity', () => {
  const mockTxId =
    '80be2d8820b8946037764fcba8177a3eb1cae94bf8993def14dda20cb89390c2';
  const mockBlockTime = 1640995200; // 2022-01-01 00:00:00 UTC
  const mockAccountAddresses = [
    'addr_test1qrr7pflnkppvp49sl2hjs9v255ydycp8zxuxzfjw03vev9ns6cdlwymh7v9kr8cd8cy5vx8l7h6v9da84ml2cjd90fusnjsh8d',
  ];
  const mockRewardAccount =
    'stake_test1uqrw9tjymlm8wrwq7jk68n6v7fs9qz8z0tkdkve26dylmfc2ux2hj';

  // Simplified mock protocol parameters
  const mockProtocolParameters = {
    coinsPerUtxoByte: 4310,
    maxValueSize: 5000,
    maxTxSize: 16384,
    maxTxExUnits: { memory: 14000000, steps: 10000000000 },
    maxBlockExUnits: { memory: 62000000, steps: 20000000000 },
    maxBlockHeaderSize: 1100,
    maxBlockBodySize: 90112,
    maxCollateralInputs: 3,
    poolDeposit: 500000000,
    desiredNumberOfPools: 500,
    collateralPercentage: 150,
    poolInfluence: '0.5',
    dRepDeposit: 500000000,
    keyDeposit: 2000000,
    minFeeCoefficient: 44,
    minFeeConstant: 155381,
    minUtxoValue: 1000000,
    minPoolCost: 340000000,
    plutusScriptVersion: 1,
    maxEpoch: 18,
    maxMajorProtocolVersion: 8,
    maxLovelaceSupply: 45000000000000000,
    stakeKeyDeposit: 2000000,
    stakePoolPledgeInfluence: 0.3,
    monetaryExpansion: '0.003',
    treasuryExpansion: 0.2,
    decentralizationParameter: 0.0,
    extraEntropy: null,
    protocolVersion: { major: 8, minor: 0 },
    costModels: new Map(),
    executionUnitPrices: { memory: 0.0577, steps: 0.0000721 },
    maxTxExecutionUnits: { memory: 14000000n, steps: 10000000000n },
    maxBlockExecutionUnits: { memory: 62000000n, steps: 20000000000n },
    prices: { memory: 0.0577, steps: 0.0000721 },
  } as RequiredProtocolParameters;

  const mockResolveInput = vi.fn();

  const mockTxDetails: ExtendedTxDetails = {
    id: Cardano.TransactionId(mockTxId),
    blockTime: mockBlockTime,
    body: {
      inputs: [],
      // The recomputed net change reads the body, so a summary reporting a
      // 1 ADA gain needs an own output that accounts for it — a gain with no
      // own output is not a transaction the inspector can report.
      outputs: [
        {
          address: Cardano.PaymentAddress(mockAccountAddresses[0]),
          value: { coins: 1_000_000n },
        },
      ] as Cardano.TxOut[],
      fee: 1000000n,
      validityInterval: {
        invalidBefore: undefined,
        invalidHereafter: undefined,
      },
      certificates: [],
      withdrawals: [],
      mint: undefined,
      collateralReturn: undefined,
      collaterals: [],
      totalCollateral: undefined,
      proposalProcedures: undefined,
      votingProcedures: undefined,
    },
    witness: {
      signatures: new Map(),
      scripts: [],
      datums: [],
      redeemers: [],
      bootstrap: [],
    },
    auxiliaryData: undefined,
    blockHeader: {
      blockNo: Cardano.BlockNo(1000),
      hash: Cardano.BlockId(
        '0000000000000000000000000000000000000000000000000000000000000001',
      ),
      slot: Cardano.Slot(1000000),
    },
    index: 0,
    inputSource: Cardano.InputSource.inputs,
    txSize: 1000,
  };

  const mockTxSummaryInspector = vi.fn();
  const mockCreateTxInspector = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(classifyTxAsNightDesignation).mockReset();

    mockCreateTxInspector.mockReturnValue(mockTxSummaryInspector);
    (
      createTxInspector as unknown as ReturnType<typeof vi.fn>
    ).mockImplementation(mockCreateTxInspector);
    (
      transactionSummaryInspector as unknown as ReturnType<typeof vi.fn>
    ).mockReturnValue({});
  });

  describe('mapTransactionToActivity', () => {
    const spentA = {
      txId: Cardano.TransactionId(
        '1111111111111111111111111111111111111111111111111111111111111111',
      ),
      index: 0,
    };
    const spentB = {
      txId: Cardano.TransactionId(
        '2222222222222222222222222222222222222222222222222222222222222222',
      ),
      index: 3,
    };
    const ownOutput = {
      address: Cardano.PaymentAddress(mockAccountAddresses[0]),
      value: { coins: 5000000n },
    };

    it('should create tx inspector with correct configuration', () => {
      const mockSummary = summaryOf({
        coins: 1000000n,
        assets: new Map([
          ['asset123', { amount: 100n }],
          ['asset456', { amount: 200n }],
        ]) as Core.TransactionSummaryInspection['assets'],
      });
      (
        transactionSummaryInspector as unknown as ReturnType<typeof vi.fn>
      ).mockReturnValue(mockSummary);
      const mockTxInspector = {
        summary: mockSummary,
      };
      mockTxSummaryInspector.mockReturnValue(of(mockTxInspector));
      mapTransactionToActivity({
        accountId: AccountId('account1'),
        txDetails: mockTxDetails,
        accountAddresses: mockAccountAddresses.map(addr =>
          CardanoPaymentAddress(addr),
        ),
        rewardAccount: CardanoRewardAccount(mockRewardAccount),
        protocolParameters: mockProtocolParameters,
        resolveInput: mockResolveInput,
        logger,
        enabledExtensionActivities: allExtensionActivities,
      });

      expect(transactionSummaryInspector).toHaveBeenCalledWith({
        addresses: mockAccountAddresses,
        rewardAccounts: [mockRewardAccount],
        inputResolver: {
          resolveInput: mockResolveInput,
        },
        protocolParameters: mockProtocolParameters,
        assetProvider: assetProvider,
        timeout: 10000,
        logger,
      });

      expect(createTxInspector).toHaveBeenCalledWith({
        summary: mockSummary,
      });
    });

    // `consumedInputs` is load-bearing rather than cosmetic: cardano-sync reads a
    // still-present outpoint as proof a provider has not applied the tx yet, and
    // withholds its UTxO cache key on that basis. Recorded straight off the tx
    // body, unresolved — ownership filtering happens where it is consumed.
    it('records every outpoint the transaction spent, whatever the net direction', async () => {
      // Net-positive, so the mapper types it `Receive` — the case a
      // type-based test would have wrongly read as "spent nothing".
      mockTxSummaryInspector.mockReturnValue(
        of({ summary: summaryOf({ coins: 1000000n }) }),
      );

      const result = await firstValueFrom(
        mapTransactionToActivity({
          accountId: AccountId('account1'),
          txDetails: {
            ...mockTxDetails,
            body: { ...mockTxDetails.body, inputs: [spentA, spentB] },
          } as ExtendedTxDetails,
          accountAddresses: mockAccountAddresses.map(addr =>
            CardanoPaymentAddress(addr),
          ),
          rewardAccount: CardanoRewardAccount(mockRewardAccount),
          protocolParameters: mockProtocolParameters,
          resolveInput: mockResolveInput,
          logger,
          enabledExtensionActivities: allExtensionActivities,
        }),
      );

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(
          (
            result.value.blockchainSpecific as {
              Cardano: { consumedInputs: unknown };
            }
          ).Cardano.consumedInputs,
        ).toEqual([spentA, spentB]);
        expect(result.value.type).toBe(ActivityType.Receive);
      }
    });

    // `producedOwnOutpoints` is the incoming mirror of `consumedInputs`:
    // cardano-sync reads an own output MISSING from a fetch as proof a trailing
    // provider has not applied the receive yet. Own addresses only — a foreign
    // output's absence proves nothing.
    it('records only the outpoints paying own addresses', async () => {
      const foreignOutput = {
        address: Cardano.PaymentAddress(
          'addr_test1qzuk9c0qaq8ustvatan8xelmp3wjn9n99c78004dsfjwvs4h5kpytryyph0d9vyzj9g9e5rwsnxc2djcandyywdvu8kq54t0f8',
        ),
        value: { coins: 1000000n },
      };
      mockTxSummaryInspector.mockReturnValue(
        of({ summary: summaryOf({ coins: 5000000n }) }),
      );

      const result = await firstValueFrom(
        mapTransactionToActivity({
          accountId: AccountId('account1'),
          txDetails: {
            ...mockTxDetails,
            body: {
              ...mockTxDetails.body,
              outputs: [foreignOutput, ownOutput],
            },
          } as ExtendedTxDetails,
          accountAddresses: mockAccountAddresses.map(addr =>
            CardanoPaymentAddress(addr),
          ),
          rewardAccount: CardanoRewardAccount(mockRewardAccount),
          protocolParameters: mockProtocolParameters,
          resolveInput: mockResolveInput,
          logger,
          enabledExtensionActivities: allExtensionActivities,
        }),
      );

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(
          (
            result.value.blockchainSpecific as {
              Cardano: { producedOwnOutpoints: unknown };
            }
          ).Cardano.producedOwnOutpoints,
        ).toEqual([{ txId: mockTxDetails.id, index: 1 }]);
      }
    });

    // A phase-2 failure created nothing but its collateral return, and
    // hydration does not preserve that output's ledger index — so even an
    // own-address collateral return records nothing. A wrong outpoint would
    // withhold the cache key until the account's next transaction; recording
    // body.outputs would wait forever on outputs the chain never produced.
    it('records no produced outpoints when the chain consumed collateral, even for an own collateral return', async () => {
      mockTxSummaryInspector.mockReturnValue(
        of({ summary: summaryOf({ coins: -1000n }) }),
      );

      const result = await firstValueFrom(
        mapTransactionToActivity({
          accountId: AccountId('account1'),
          txDetails: {
            ...mockTxDetails,
            inputSource: Cardano.InputSource.collaterals,
            body: {
              ...mockTxDetails.body,
              outputs: [ownOutput],
              collaterals: [],
              collateralReturn: {
                address: Cardano.PaymentAddress(mockAccountAddresses[0]),
                value: { coins: 3000000n },
              },
            },
          } as ExtendedTxDetails,
          accountAddresses: mockAccountAddresses.map(addr =>
            CardanoPaymentAddress(addr),
          ),
          rewardAccount: CardanoRewardAccount(mockRewardAccount),
          protocolParameters: mockProtocolParameters,
          resolveInput: mockResolveInput,
          logger,
          enabledExtensionActivities: allExtensionActivities,
        }),
      );

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(
          (
            result.value.blockchainSpecific as {
              Cardano: { producedOwnOutpoints: unknown };
            }
          ).Cardano.producedOwnOutpoints,
        ).toEqual([]);
      }
    });

    // A phase-2 failure consumes the COLLATERALS; its `body.inputs` were never
    // spent and stay in the account's UTxO set. Recording them would leave
    // cardano-sync withholding its cache key forever against a provider that is
    // reporting those inputs correctly as unspent.
    it('records the collaterals, not the inputs, when the chain consumed collateral', async () => {
      const input = {
        txId: Cardano.TransactionId(
          '3333333333333333333333333333333333333333333333333333333333333333',
        ),
        index: 1,
      };
      const collateral = {
        txId: Cardano.TransactionId(
          '4444444444444444444444444444444444444444444444444444444444444444',
        ),
        index: 2,
      };
      mockTxSummaryInspector.mockReturnValue(
        of({ summary: summaryOf({ coins: -1000n }) }),
      );

      const result = await firstValueFrom(
        mapTransactionToActivity({
          accountId: AccountId('account1'),
          txDetails: {
            ...mockTxDetails,
            inputSource: Cardano.InputSource.collaterals,
            body: {
              ...mockTxDetails.body,
              inputs: [input],
              collaterals: [collateral],
            },
          } as ExtendedTxDetails,
          accountAddresses: mockAccountAddresses.map(addr =>
            CardanoPaymentAddress(addr),
          ),
          rewardAccount: CardanoRewardAccount(mockRewardAccount),
          protocolParameters: mockProtocolParameters,
          resolveInput: mockResolveInput,
          logger,
          enabledExtensionActivities: allExtensionActivities,
        }),
      );

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(
          (
            result.value.blockchainSpecific as {
              Cardano: { consumedInputs: unknown };
            }
          ).Cardano.consumedInputs,
        ).toEqual([collateral]);
      }
    });

    it('should return Ok with correct activity for receive transaction', async () => {
      const mockSummary = summaryOf({
        coins: 1000000n,
        assets: new Map([
          ['asset123', { amount: 100n }],
          ['asset456', { amount: 200n }],
        ]) as Core.TransactionSummaryInspection['assets'],
      });

      mockTxSummaryInspector.mockReturnValue(of({ summary: mockSummary }));

      const result = await firstValueFrom(
        mapTransactionToActivity({
          accountId: AccountId('account1'),
          txDetails: mockTxDetails,
          accountAddresses: mockAccountAddresses.map(addr =>
            CardanoPaymentAddress(addr),
          ),
          rewardAccount: CardanoRewardAccount(mockRewardAccount),
          protocolParameters: mockProtocolParameters,
          resolveInput: mockResolveInput,
          logger,
          enabledExtensionActivities: allExtensionActivities,
        }),
      );

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        const activity = result.value;
        expect(activity).toEqual({
          accountId: AccountId('account1'),
          activityId: mockTxId,
          timestamp: Timestamp(mockBlockTime * 1000),
          tokenBalanceChanges: [
            { tokenId: TokenId('asset123'), amount: BigNumber(100n) },
            { tokenId: TokenId('asset456'), amount: BigNumber(200n) },
            { tokenId: TokenId('lovelace'), amount: BigNumber(1000000n) },
          ],
          type: ActivityType.Receive,
          blockchainSpecific: {
            Cardano: {
              consumedInputs: [],
              producedOutputs: [],
              producedOwnOutpoints: [{ txId: mockTxDetails.id, index: 0 }],
              slot: mockTxDetails.blockHeader.slot,
              security: {
                exploits: { deterministicNonce202606: false },
              },
            },
          },
        });
      }
    });

    // `getTopOnChainActivity` skips only Pending and Rewards, so a
    // NightDesignation CAN be the anchor cardano-sync proves a fetch against —
    // and "designate once, then leave the wallet alone" is an abandoned account.
    it.each(['designate', 'update', 'deregister'] as const)(
      'maps a classified %s tx to a NightDesignation activity carrying the action metadata and the utxo evidence',
      async action => {
        (
          classifyTxAsNightDesignation as unknown as ReturnType<typeof vi.fn>
        ).mockReturnValueOnce({ action });
        mockTxSummaryInspector.mockReturnValue(
          of({ summary: summaryOf({ coins: -2000000n }) }),
        );

        const result = await firstValueFrom(
          mapTransactionToActivity({
            accountId: AccountId('account1'),
            txDetails: {
              ...mockTxDetails,
              body: {
                ...mockTxDetails.body,
                inputs: [spentA, spentB],
                outputs: [ownOutput],
              },
            } as ExtendedTxDetails,
            accountAddresses: mockAccountAddresses.map(addr =>
              CardanoPaymentAddress(addr),
            ),
            rewardAccount: CardanoRewardAccount(mockRewardAccount),
            protocolParameters: mockProtocolParameters,
            resolveInput: mockResolveInput,
            logger,
            enabledExtensionActivities: allExtensionActivities,
          }),
        );

        expect(result.isOk()).toBe(true);
        if (result.isOk()) {
          expect(result.value).toMatchObject({
            accountId: AccountId('account1'),
            activityId: mockTxId,
            type: ActivityType.NightDesignation,
            blockchainSpecific: {
              Cardano: {
                consumedInputs: [spentA, spentB],
                producedOwnOutpoints: [{ txId: mockTxDetails.id, index: 0 }],
                slot: mockTxDetails.blockHeader.slot,
                nightDesignation: { action },
                // Compromise detection runs for designation txs too — a
                // NightDesignation activity still carries security.exploits.
                security: { exploits: { deterministicNonce202606: false } },
              },
            },
          });
        }
      },
    );

    it('classifies a designation tx as Send/Receive when the cNIGHT designation flag is off', async () => {
      (
        classifyTxAsNightDesignation as unknown as ReturnType<typeof vi.fn>
      ).mockReturnValueOnce({ action: 'designate' });
      mockTxSummaryInspector.mockReturnValue(
        of({ summary: summaryOf({ coins: -2000000n }) }),
      );

      const result = await firstValueFrom(
        mapTransactionToActivity({
          accountId: AccountId('account1'),
          txDetails: mockTxDetails,
          accountAddresses: mockAccountAddresses.map(addr =>
            CardanoPaymentAddress(addr),
          ),
          rewardAccount: CardanoRewardAccount(mockRewardAccount),
          protocolParameters: mockProtocolParameters,
          resolveInput: mockResolveInput,
          logger,
          enabledExtensionActivities: noExtensionActivities,
        }),
      );

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value).toEqual({
          accountId: AccountId('account1'),
          activityId: mockTxId,
          timestamp: Timestamp(mockBlockTime * 1000),
          tokenBalanceChanges: [
            { tokenId: TokenId('lovelace'), amount: BigNumber(-2000000n) },
          ],
          type: ActivityType.Send,
          blockchainSpecific: {
            Cardano: {
              consumedInputs: [],
              producedOutputs: [],
              producedOwnOutpoints: [{ txId: mockTxDetails.id, index: 0 }],
              slot: mockTxDetails.blockHeader.slot,
              security: {
                exploits: { deterministicNonce202606: false },
              },
            },
          },
        });
        expect(result.value.type).not.toBe(ActivityType.NightDesignation);
      }
    });

    it('should return Ok with correct activity for send transaction', async () => {
      const mockSummary = summaryOf({
        coins: -500000n,
        assets: new Map([
          ['asset123', { amount: -50n }],
        ]) as Core.TransactionSummaryInspection['assets'],
      });

      mockTxSummaryInspector.mockReturnValue(of({ summary: mockSummary }));

      const result = await firstValueFrom(
        mapTransactionToActivity({
          accountId: AccountId('account1'),
          txDetails: mockTxDetails,
          accountAddresses: mockAccountAddresses.map(addr =>
            CardanoPaymentAddress(addr),
          ),
          rewardAccount: CardanoRewardAccount(mockRewardAccount),
          protocolParameters: mockProtocolParameters,
          resolveInput: mockResolveInput,
          logger,
          enabledExtensionActivities: allExtensionActivities,
        }),
      );

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        const activity = result.value;
        expect(activity).toEqual({
          accountId: AccountId('account1'),
          activityId: mockTxId,
          timestamp: Timestamp(mockBlockTime * 1000),
          tokenBalanceChanges: [
            { tokenId: TokenId('asset123'), amount: BigNumber(-50n) },
            { tokenId: TokenId('lovelace'), amount: BigNumber(-500000n) },
          ],
          type: ActivityType.Send,
          blockchainSpecific: {
            Cardano: {
              consumedInputs: [],
              producedOutputs: [],
              producedOwnOutpoints: [{ txId: mockTxDetails.id, index: 0 }],
              slot: mockTxDetails.blockHeader.slot,
              security: {
                exploits: { deterministicNonce202606: false },
              },
            },
          },
        });
      }
    });
    // ─── Send/Receive classification and amount ─────────────────────────
    //
    // Net-change semantics are covered against the real inspector in
    // compute-own-net-coins.test.ts; these cover the wiring only — that the
    // mapper feeds it the body and the whole summary, never `summary.coins`.

    const ownInput = {
      txId: Cardano.TransactionId(
        '4444444444444444444444444444444444444444444444444444444444444444',
      ),
      index: 0,
      address: Cardano.PaymentAddress(mockAccountAddresses[0]),
    };
    const ownOutputOf = (coins: bigint) =>
      ({
        address: Cardano.PaymentAddress(mockAccountAddresses[0]),
        value: { coins },
      } as Cardano.TxOut);
    const foreignOutputOf = (coins: bigint) =>
      ({
        address: Cardano.PaymentAddress(
          'addr_test1wpnlxv2xv9a9ucvnvzqakwepzl9ltx7jzgm53av2e9ncv4sysemm8',
        ),
        value: { coins },
      } as Cardano.TxOut);

    const activityFor = async (
      txDetails: ExtendedTxDetails,
      summary: Core.TransactionSummaryInspection,
    ) => {
      mockTxSummaryInspector.mockReturnValue(of({ summary }));
      return firstValueFrom(
        mapTransactionToActivity({
          accountId: AccountId('account1'),
          txDetails,
          accountAddresses: mockAccountAddresses.map(addr =>
            CardanoPaymentAddress(addr),
          ),
          rewardAccount: CardanoRewardAccount(mockRewardAccount),
          protocolParameters: mockProtocolParameters,
          resolveInput: mockResolveInput,
          logger,
          enabledExtensionActivities: allExtensionActivities,
        }),
      );
    };

    const spendingOwnInput = (
      outputs: Cardano.TxOut[] = [],
    ): ExtendedTxDetails =>
      ({
        ...mockTxDetails,
        body: { ...mockTxDetails.body, inputs: [ownInput], outputs },
      } as ExtendedTxDetails);

    const lovelaceChange = (activity: { tokenBalanceChanges: unknown[] }) =>
      (
        activity.tokenBalanceChanges as {
          tokenId: string;
          amount: BigNumber;
        }[]
      ).find(({ tokenId }) => tokenId === 'lovelace')?.amount;

    it('types a transaction whose net change is a loss as Send', async () => {
      const result = await activityFor(
        spendingOwnInput([ownOutputOf(1_000_000n)]),
        summaryOf({
          coins: -500_000n,
          resolvedInputs: [
            { ...ownInput, value: { coins: 1_500_000n } },
          ] as Core.TransactionSummaryInspection['resolvedInputs'],
        }),
      );

      expect(result.isOk()).toBe(true);
      if (result.isOk()) expect(result.value.type).toBe(ActivityType.Send);
    });

    it('types a transaction whose net change is a gain as Receive', async () => {
      const result = await activityFor(
        spendingOwnInput([ownOutputOf(101_000_000n)]),
        summaryOf({
          coins: 1_000_000n,
          resolvedInputs: [
            { ...ownInput, value: { coins: 100_000_000n } },
          ] as Core.TransactionSummaryInspection['resolvedInputs'],
        }),
      );

      expect(result.isOk()).toBe(true);
      if (result.isOk()) expect(result.value.type).toBe(ActivityType.Receive);
    });

    it('reports the recomputed loss, not the reported gain, when an own input never resolved', async () => {
      const result = await activityFor(
        spendingOwnInput([
          foreignOutputOf(100_000_000n),
          ownOutputOf(399_000_000n),
        ]),
        summaryOf({
          coins: 399_000_000n,
          unresolved: {
            inputs: [{ txId: ownInput.txId, index: ownInput.index }],
            value: { coins: 500_000_000n } as Cardano.Value,
          },
        }),
      );

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.type).toBe(ActivityType.Send);
        expect(lovelaceChange(result.value)).toEqual(BigNumber(-101_000_000n));
      }
    });

    it('still produces an activity when an input could not be resolved at all', async () => {
      // A real 404 and a pruned or Byron-era outpoint both surface as an
      // unresolved input. Dropping the activity would make those transactions
      // vanish from Activities and be re-requested every sync round.
      const result = await activityFor(
        spendingOwnInput([ownOutputOf(1_000_000n)]),
        summaryOf({
          coins: 1_000_000n,
          unresolved: {
            inputs: [{ txId: ownInput.txId, index: ownInput.index }],
            value: { coins: 2_000_000n } as Cardano.Value,
          },
        }),
      );

      expect(result.isOk()).toBe(true);
      if (result.isOk()) expect(result.value.activityId).toBe(mockTxId);
    });

    describe('Hydra Head transactions', () => {
      /** Head of a Hydra 2.3.0 deposit recorded on Preprod. */
      const headId = '324c8b8198c4c9db7526d6dccb79e992c4863b24b56453bb16995bdc';
      const depositAddress = Cardano.PaymentAddress(
        'addr_test1wrrcaryjq4epavl0gsg08kuuv95l5md5jlpyvswjnss998qyu7lhm',
      );
      const headAddress = Cardano.PaymentAddress(
        'addr_test1wq4erflxvet45fr9hrrldflevr2cwr83x622vlejzhspf3gn6jry8',
      );
      const depositDatum =
        'd8799f581c324c8b8198c4c9db7526d6dccb79e992c4863b24b56453bb16995bdc1b000001a05d17b3df9fd8799fd8799f5820e2f094efbbf8e363b9d02c7b5c61f89abdd6b839161d3a01638a882356ef96b101ff5f5840d8799fd8799fd8799f581cba1e067abfb07ecd833cec7005a8aa89cbdf09e10d6c87bb73da9e35ffd8799fd8799fd8799f581cac246d63642cf5fba32b6b605158236b8abf4d4e926fa42750db18341406ffffffffa140a1401a004699f3d87980d87a80ffffffffff';
      const headStateTokenId =
        `${headId}4879647261486561645632` as Cardano.AssetId;
      const depositOutput = {
        address: depositAddress,
        value: { coins: 4_626_931n },
        datum: Serialization.PlutusData.fromCbor(
          HexBlob(depositDatum),
        ).toCore(),
      } as Cardano.TxOut;
      const depositInput = {
        txId: Cardano.TransactionId(
          'c1a8300f3d89c7feca5a91561329d205574170d5886e7bfb384558b5b89759a7',
        ),
        index: 0,
        address: depositAddress,
      };
      const headInput = {
        txId: Cardano.TransactionId(
          'd2b9a1c3e4f5061728394a5b6c7d8e9f00112233445566778899aabbccddeeff',
        ),
        index: 0,
        address: headAddress,
      };
      const headOutput = {
        address: headAddress,
        value: {
          coins: 10_000_000n,
          assets: new Map([[headStateTokenId, 1n]]),
        },
      } as Cardano.TxOut;
      const hydraTag = (value: string): Cardano.AuxiliaryData => ({
        blob: new Map([[55_555n, value]]),
      });

      const hydraTx = ({
        tag,
        inputs = [ownInput],
        outputs,
        mint,
        inputSource = Cardano.InputSource.inputs,
      }: {
        tag?: string;
        inputs?: Cardano.HydratedTxIn[];
        outputs: Cardano.TxOut[];
        mint?: Cardano.TokenMap;
        inputSource?: Cardano.InputSource;
      }): ExtendedTxDetails =>
        ({
          ...mockTxDetails,
          auxiliaryData: tag === undefined ? undefined : hydraTag(tag),
          inputSource,
          body: { ...mockTxDetails.body, inputs, outputs, mint },
        } as ExtendedTxDetails);

      const depositTx = (tag?: string) =>
        hydraTx({
          tag,
          outputs: [depositOutput, ownOutputOf(5_000_000n)],
        });

      const depositSummary = summaryOf({
        coins: -4_800_000n,
        resolvedInputs: [
          { ...ownInput, value: { coins: 9_800_000n } },
        ] as Core.TransactionSummaryInspection['resolvedInputs'],
      });

      const mapWith = async (
        txDetails: ExtendedTxDetails,
        enabledExtensionActivities: typeof allExtensionActivities,
        summary = depositSummary,
      ) => {
        mockTxSummaryInspector.mockReturnValue(of({ summary }));
        const result = await firstValueFrom(
          mapTransactionToActivity({
            accountId: AccountId('account1'),
            txDetails,
            accountAddresses: mockAccountAddresses.map(addr =>
              CardanoPaymentAddress(addr),
            ),
            rewardAccount: CardanoRewardAccount(mockRewardAccount),
            protocolParameters: mockProtocolParameters,
            resolveInput: mockResolveInput,
            logger,
            enabledExtensionActivities,
          }),
        );
        if (result.isErr()) throw result.error;
        return result.value;
      };

      const hydraOnly = { nightDesignation: false, hydra: true };

      beforeEach(async () => {
        const { Cardano: actual } = await vi.importActual<typeof Core>(
          '@cardano-sdk/core',
        );
        vi.mocked(Cardano.AssetId.getPolicyId).mockImplementation(
          actual.AssetId.getPolicyId,
        );
        vi.mocked(Cardano.AssetId.getAssetName).mockImplementation(
          actual.AssetId.getAssetName,
        );
      });

      afterEach(() => {
        vi.mocked(Cardano.AssetId.getPolicyId).mockReset();
        vi.mocked(Cardano.AssetId.getAssetName).mockReset();
      });

      const cardanoOf = (activity: { blockchainSpecific?: unknown }) =>
        (activity.blockchainSpecific as { Cardano: Record<string, unknown> })
          .Cardano;

      it('adds the head id and deadline of a tagged deposit and keeps its Send type and amounts', async () => {
        const off = await mapWith(
          depositTx('HydraV2/DepositTx'),
          noExtensionActivities,
        );
        const on = await mapWith(depositTx('HydraV2/DepositTx'), hydraOnly);

        expect(on.type).toBe(ActivityType.Send);
        expect(on).toEqual({
          ...off,
          blockchainSpecific: {
            Cardano: {
              ...cardanoOf(off),
              hydra: {
                protocol: 'HydraV2',
                txName: 'DepositTx',
                headId,
                depositDeadline: '2026-09-01T13:10:29.599Z',
              },
            },
          },
        });
      });

      it('labels a tagged recover as Receive without a head id', async () => {
        const activity = await mapWith(
          hydraTx({
            tag: 'HydraV2/RecoverTx',
            inputs: [depositInput],
            outputs: [ownOutputOf(4_400_000n)],
          }),
          hydraOnly,
          summaryOf({ coins: 4_400_000n }),
        );

        expect(activity.type).toBe(ActivityType.Receive);
        expect(cardanoOf(activity).hydra).toEqual({
          protocol: 'HydraV2',
          txName: 'RecoverTx',
        });
      });

      it('reads the head id of a tagged fanout from the head state token it burns', async () => {
        const activity = await mapWith(
          hydraTx({
            tag: 'HydraV2/FanoutTx',
            inputs: [headInput],
            outputs: [ownOutputOf(4_626_931n)],
            mint: new Map([[headStateTokenId, -1n]]),
          }),
          hydraOnly,
          summaryOf({ coins: 4_626_931n }),
        );

        expect(activity.type).toBe(ActivityType.Receive);
        expect(cardanoOf(activity).hydra).toEqual({
          protocol: 'HydraV2',
          txName: 'FanoutTx',
          headId,
        });
      });

      it('reads the head id of a tagged head step from the head output', async () => {
        const activity = await mapWith(
          hydraTx({
            tag: 'HydraV2/CloseTx',
            inputs: [headInput],
            outputs: [headOutput, ownOutputOf(5_000_000n)],
          }),
          hydraOnly,
        );

        expect(cardanoOf(activity).hydra).toEqual({
          protocol: 'HydraV2',
          txName: 'CloseTx',
          headId,
        });
      });

      it('reads the head id of a tagged increment from the head output', async () => {
        const activity = await mapWith(
          hydraTx({
            tag: 'HydraV2/IncrementTx',
            inputs: [headInput, depositInput],
            outputs: [headOutput],
          }),
          hydraOnly,
        );

        expect(cardanoOf(activity).hydra).toEqual({
          protocol: 'HydraV2',
          txName: 'IncrementTx',
          headId,
        });
      });

      it('ignores a tagged transaction that touches no Hydra address, whatever it mints', async () => {
        const activity = await mapWith(
          hydraTx({
            tag: 'HydraV2/FanoutTx',
            outputs: [ownOutputOf(5_000_000n)],
            mint: new Map([[headStateTokenId, 1n]]),
          }),
          hydraOnly,
        );

        expect(cardanoOf(activity)).not.toHaveProperty('hydra');
      });

      it.each([
        ['CollectComTx', true],
        ['CloseTx', true],
        ['ContestTx', true],
        ['DecrementTx', true],
        ['PartialFanoutTx', true],
        ['AbortTx', false],
        ['FanoutTx', false],
        ['FinalPartialFanoutTx', false],
      ] as const)(
        'names a head step %s from the marker when it fits whether a head UTxO is left (%s)',
        async (step, leavesHead) => {
          const activity = await mapWith(
            hydraTx({
              tag: `HydraV2/${step}`,
              inputs: [headInput],
              outputs: leavesHead ? [headOutput] : [ownOutputOf(5_000_000n)],
            }),
            hydraOnly,
          );

          expect(cardanoOf(activity).hydra).toMatchObject({
            protocol: 'HydraV2',
            txName: step,
          });
        },
      );

      it.each([
        {
          case: 'a step that leaves a head UTxO as one that does not',
          tag: 'HydraV2/FanoutTx',
          outputs: [headOutput],
        },
        {
          case: 'a step that leaves no head UTxO as one that does',
          tag: 'HydraV2/CloseTx',
          outputs: [ownOutputOf(5_000_000n)],
        },
        {
          case: 'a head step by a name it does not know',
          tag: 'HydraV2/Claim refund at evil.example',
          outputs: [headOutput],
        },
      ])(
        'keeps a head step as HeadTx when the marker names $case',
        async ({ tag, outputs }) => {
          const activity = await mapWith(
            hydraTx({ tag, inputs: [headInput], outputs }),
            hydraOnly,
          );

          expect(cardanoOf(activity).hydra).toMatchObject({
            protocol: 'HydraV2',
            txName: 'HeadTx',
          });
        },
      );

      it.each([
        {
          case: 'an increment',
          tag: 'HydraV2/FanoutTx',
          inputs: [headInput, depositInput],
          outputs: [headOutput],
          txName: 'IncrementTx',
        },
        {
          case: 'an init',
          tag: 'HydraV2/CloseTx',
          inputs: [ownInput],
          outputs: [headOutput, ownOutputOf(5_000_000n)],
          txName: 'InitTx',
        },
        {
          case: 'a deposit',
          tag: 'HydraV2/CloseTx',
          inputs: [ownInput],
          outputs: [depositOutput, ownOutputOf(5_000_000n)],
          txName: 'DepositTx',
        },
      ])(
        'names $case from its addresses whatever the marker says',
        async ({ tag, inputs, outputs, txName }) => {
          const activity = await mapWith(
            hydraTx({ tag, inputs, outputs }),
            hydraOnly,
          );

          expect(cardanoOf(activity).hydra).toMatchObject({ txName });
        },
      );

      it.each([
        {
          case: 'a datum of another shape',
          datum: Serialization.PlutusData.fromCbor(HexBlob('d87980')).toCore(),
        },
        { case: 'no datum', datum: undefined },
      ])(
        'labels a tagged deposit whose deposit output has $case without a head id or deadline',
        async ({ datum }) => {
          const activity = await mapWith(
            hydraTx({
              tag: 'HydraV2/DepositTx',
              outputs: [{ ...depositOutput, datum }, ownOutputOf(5_000_000n)],
            }),
            hydraOnly,
          );

          expect(cardanoOf(activity).hydra).toEqual({
            protocol: 'HydraV2',
            txName: 'DepositTx',
          });
        },
      );

      it('labels a tagged deposit whose deadline is beyond the date range without a head id or deadline', async () => {
        const datum = Serialization.PlutusData.fromCbor(
          HexBlob(
            depositDatum.replace('1b000001a05d17b3df', '1b001eb208c2dc0001'),
          ),
        ).toCore();
        const activity = await mapWith(
          hydraTx({
            tag: 'HydraV2/DepositTx',
            outputs: [{ ...depositOutput, datum }, ownOutputOf(5_000_000n)],
          }),
          hydraOnly,
        );

        expect(activity.type).toBe(ActivityType.Send);
        expect(cardanoOf(activity).hydra).toEqual({
          protocol: 'HydraV2',
          txName: 'DepositTx',
        });
      });

      it('recognises an untagged transaction paying the head state token to a head address as an init', async () => {
        const activity = await mapWith(
          hydraTx({ outputs: [headOutput, ownOutputOf(5_000_000n)] }),
          hydraOnly,
        );

        expect(cardanoOf(activity).hydra).toEqual({
          txName: 'InitTx',
          headId,
        });
      });

      it('recognises an untagged transaction paying a deposit address as a deposit', async () => {
        const activity = await mapWith(depositTx(), hydraOnly);

        expect(activity.type).toBe(ActivityType.Send);
        expect(cardanoOf(activity).hydra).toEqual({
          txName: 'DepositTx',
          headId,
          depositDeadline: '2026-09-01T13:10:29.599Z',
        });
      });

      it('recognises an untagged transaction spending a deposit as a recover', async () => {
        const activity = await mapWith(
          hydraTx({
            inputs: [depositInput],
            outputs: [ownOutputOf(4_400_000n)],
          }),
          hydraOnly,
          summaryOf({ coins: 4_400_000n }),
        );

        expect(activity.type).toBe(ActivityType.Receive);
        expect(cardanoOf(activity).hydra).toEqual({ txName: 'RecoverTx' });
      });

      it('ignores an untagged transaction that touches no Hydra address', async () => {
        const activity = await mapWith(
          hydraTx({ outputs: [ownOutputOf(4_400_000n)] }),
          hydraOnly,
          summaryOf({ coins: 4_400_000n }),
        );

        expect(cardanoOf(activity)).not.toHaveProperty('hydra');
      });

      it.each(['HydraV3/DepositTx', 'HydraV2/', 'DepositTx'])(
        'falls back to the script addresses when the tag is malformed: %s',
        async tag => {
          const tagged = await mapWith(
            hydraTx({ tag, outputs: [ownOutputOf(5_000_000n)] }),
            hydraOnly,
          );
          const deposit = await mapWith(depositTx(tag), hydraOnly);

          expect(cardanoOf(tagged)).not.toHaveProperty('hydra');
          expect(cardanoOf(deposit).hydra).toEqual({
            txName: 'DepositTx',
            headId,
            depositDeadline: '2026-09-01T13:10:29.599Z',
          });
        },
      );

      it('ignores a transaction that failed phase-2 validation', async () => {
        const activity = await mapWith(
          hydraTx({
            tag: 'HydraV2/DepositTx',
            outputs: [depositOutput],
            inputSource: Cardano.InputSource.collaterals,
          }),
          hydraOnly,
        );

        expect(cardanoOf(activity)).not.toHaveProperty('hydra');
      });

      it('maps a Hydra transaction exactly as without the feature when the flag is off', async () => {
        const activity = await mapWith(
          depositTx('HydraV2/DepositTx'),
          noExtensionActivities,
        );

        expect(activity).toEqual({
          accountId: AccountId('account1'),
          activityId: mockTxId,
          timestamp: Timestamp(mockBlockTime * 1000),
          tokenBalanceChanges: [
            { tokenId: TokenId('lovelace'), amount: BigNumber(-4_800_000n) },
          ],
          type: ActivityType.Send,
          blockchainSpecific: {
            Cardano: {
              consumedInputs: [{ txId: ownInput.txId, index: ownInput.index }],
              producedOutputs: [],
              producedOwnOutpoints: [{ txId: mockTxDetails.id, index: 1 }],
              slot: mockTxDetails.blockHeader.slot,
              security: { exploits: { deterministicNonce202606: false } },
            },
          },
        });
      });

      it.each([
        { nightDesignation: false, hydra: false },
        { nightDesignation: true, hydra: false },
        { nightDesignation: false, hydra: true },
        { nightDesignation: true, hydra: true },
      ])(
        'gates cNIGHT and Hydra classification independently: %o',
        async enabled => {
          vi.mocked(classifyTxAsNightDesignation).mockReturnValue({
            action: 'designate',
          });

          const activity = await mapWith(
            depositTx('HydraV2/DepositTx'),
            enabled,
          );
          const cardano = cardanoOf(activity);

          expect(activity.type).toBe(
            enabled.nightDesignation
              ? ActivityType.NightDesignation
              : ActivityType.Send,
          );
          expect(cardano.nightDesignation).toEqual(
            enabled.nightDesignation ? { action: 'designate' } : undefined,
          );
          expect('hydra' in cardano).toBe(enabled.hydra);
          expect(
            vi.mocked(classifyTxAsNightDesignation).mock.calls,
          ).toHaveLength(enabled.nightDesignation ? 1 : 0);
        },
      );
    });

    describe('custody accounts', () => {
      // Lace's Preprod custody account; literal here because this file mocks
      // `Cardano.AssetId`.
      const stakeScriptHash =
        'f176158fcbbdfc44c1e3b3f0863032dc048c091738b0fa4107975157';
      const custodyAddress = CardanoPaymentAddress(
        'addr_test1xrkkr936e9x39s9nyzl95vmvx6hkd0qzcwqwp23sqxyey5l3wc2cljaal3zvrcan7zrrqvkuqjxqj9eckrayzpuh29tsszhnvv',
      );
      const custodyRewardAccount = CardanoRewardAccount(
        'stake_test17rchv9v0ew7lc3xpuwelpp3sxtwqfrqfzuutp7jpq7t4z4cnrk4ek',
      );
      const stateNftId = `${ACCOUNT_VALIDATOR_HASH}${stakeScriptHash}`;
      const grantTokenId = `${ACCOUNT_VALIDATOR_HASH}${stakeScriptHash}00000007`;
      const tokenId = `${'99'.repeat(28)}746f6b656e`;

      beforeEach(async () => {
        const { Cardano: actual } = await vi.importActual<typeof Core>(
          '@cardano-sdk/core',
        );
        vi.mocked(Cardano.AssetId.getPolicyId).mockImplementation(
          actual.AssetId.getPolicyId,
        );
        vi.mocked(Cardano.AssetId.getAssetName).mockImplementation(
          actual.AssetId.getAssetName,
        );
      });

      afterEach(() => {
        vi.mocked(Cardano.AssetId.getPolicyId).mockReset();
        vi.mocked(Cardano.AssetId.getAssetName).mockReset();
      });

      it('omits the state NFT and grant tokens from the balance changes, so no metadata is fetched for them', async () => {
        mockTxSummaryInspector.mockReturnValue(
          of({
            summary: summaryOf({
              assets: new Map([
                [stateNftId, { amount: 1n }],
                [grantTokenId, { amount: 1n }],
                [tokenId, { amount: 5n }],
              ]) as Core.TransactionSummaryInspection['assets'],
            }),
          }),
        );

        const result = await firstValueFrom(
          mapTransactionToActivity({
            accountId: AccountId('custody'),
            txDetails: mockTxDetails,
            accountAddresses: [custodyAddress],
            rewardAccount: custodyRewardAccount,
            protocolParameters: mockProtocolParameters,
            resolveInput: mockResolveInput,
            logger,
            enabledExtensionActivities: allExtensionActivities,
          }),
        );

        expect(result.isOk()).toBe(true);
        if (result.isOk()) {
          expect(
            result.value.tokenBalanceChanges.map(change => change.tokenId),
          ).toEqual([TokenId(tokenId), TokenId('lovelace')]);
        }
      });
    });
  });
});
