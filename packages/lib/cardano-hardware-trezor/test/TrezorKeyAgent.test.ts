import { Cardano, Serialization } from '@lace-lib/cardano-core';
import * as Crypto from '@lace-lib/cardano-crypto';
import {
  CardanoKeyConst,
  CommunicationType,
  KeyPurpose,
  KeyRole,
  TxInId,
  errors,
  util,
} from '@lace-lib/cardano-key-management';
import * as Trezor from '@trezor/connect';
import { dummyLogger } from 'ts-log';

import { TrezorKeyAgent } from '../src';

import {
  knownAddress,
  knownAddressKeyPath,
  knownAddressStakeKeyPath,
  minValidTxBody,
  rewardAccount,
  stakeKeyHash,
  txIn as coreTxIn,
} from './testData';

import type { Bip32Ed25519 } from '@lace-lib/cardano-crypto';
import type { Logger } from 'ts-log';
import type { Mock } from 'vitest';

describe('TrezorKeyAgent', () => {
  // Transformed / mapped data
  const txIn = {
    prev_hash:
      '0f3abbc8fc19c2e61bab6059bf8a466e6e754833a08a62a6c56fe0e78f190000',
    prev_index: 0,
  };

  const txInWithPath = {
    path: [
      util.harden(CardanoKeyConst.PURPOSE),
      util.harden(CardanoKeyConst.COIN_TYPE),
      util.harden(0),
      1,
      0,
    ],
    prev_hash:
      '0f3abbc8fc19c2e61bab6059bf8a466e6e754833a08a62a6c56fe0e78f190000',
    prev_index: 0,
  };

  const txOut = {
    address:
      'addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3jcu5d8ps7zex2k2xt3uqxgjqnnj83ws8lhrn648jjxtwq2ytjqp',
    amount: '10',
    format: Trezor.PROTO.CardanoTxOutputSerializationFormat.ARRAY_LEGACY,
  };

  const txOutToOwnedAddress = {
    addressParameters: {
      addressType: Trezor.PROTO.CardanoAddressType.BASE,
      path: knownAddressKeyPath,
      stakingPath: knownAddressStakeKeyPath,
    },
    amount: '10',
    format: Trezor.PROTO.CardanoTxOutputSerializationFormat.ARRAY_LEGACY,
  };

  const stakeRegistrationCertificate = {
    scriptHash: 'cb0ec2692497b458e46812c8a5bfa2931d1a2d965a99893828ec810f',
    type: Trezor.PROTO.CardanoCertificateType.STAKE_REGISTRATION,
  };

  const simpleTx: Omit<Trezor.CardanoSignTransaction, 'signingMode'> = {
    fee: '10',
    inputs: [txInWithPath],
    networkId: 0,
    outputs: [txOutToOwnedAddress],
    protocolMagic: 999,
    ttl: 999,
  };

  const validMultisigTx: Omit<Trezor.CardanoSignTransaction, 'signingMode'> = {
    // Contains ONLY script hash credentials
    certificates: [stakeRegistrationCertificate],

    fee: '10',

    // All third party inputs
    inputs: [txIn],

    networkId: 0,
    // All third party outputs
    outputs: [txOut],
    protocolMagic: 999,
    ttl: 999,
  };

  const poolRegistrationCertificate = {
    poolParameters: {
      cost: '1000',
      margin: {
        denominator: '5',
        numerator: '1',
      },
      metadata: {
        hash: '0f3abbc8fc19c2e61bab6059bf8a466e6e754833a08a62a6c56fe0e78f19d9d5',
        url: 'https://example.com',
      },
      owners: [
        {
          stakingKeyPath: [
            util.harden(CardanoKeyConst.PURPOSE),
            util.harden(CardanoKeyConst.COIN_TYPE),
            util.harden(0),
            2,
            0,
          ],
        },
      ],
      pledge: '10000',
      poolId: 'cb0ec2692497b458e46812c8a5bfa2931d1a2d965a99893828ec810f',
      relays: [
        {
          ipv4Address: '127.0.0.1',
          port: 6000,
          type: 0,
        },
        {
          hostName: 'example.com',
          port: 5000,
          type: 1,
        },
        {
          hostName: 'example.com',
          type: 2,
        },
      ],
      rewardAccount:
        'stake1u89sasnfyjtmgk8ydqfv3fdl52f36x3djedfnzfc9rkgzrcss5vgr',
      vrfKeyHash:
        '8dd154228946bd12967c12bedb1cb6038b78f8b84a1760b1a788fa72a4af3db0',
    },
    type: Trezor.PROTO.CardanoCertificateType.STAKE_POOL_REGISTRATION,
  };

  const validPlutusTx = {
    ...simpleTx,
    collateralInputs: [txInWithPath],
  };
  // END of Transformed / mapped data

  describe('matchSigningMode', () => {
    it('can detect ordinary transaction signing mode', async () => {
      const signingMode = TrezorKeyAgent.matchSigningMode(simpleTx);
      expect(signingMode).toEqual(
        Trezor.PROTO.CardanoTxSigningMode.ORDINARY_TRANSACTION,
      );
    });

    it('can detect ordinary transaction signing mode when we own a required signer', async () => {
      const signingMode = TrezorKeyAgent.matchSigningMode({
        ...validMultisigTx,
        requiredSigners: [{ keyPath: knownAddressKeyPath }],
      });
      expect(signingMode).toEqual(
        Trezor.PROTO.CardanoTxSigningMode.ORDINARY_TRANSACTION,
      );
    });

    it('can detect pool registrations signing mode', async () => {
      const signingMode = TrezorKeyAgent.matchSigningMode({
        ...simpleTx,
        certificates: [poolRegistrationCertificate],
      });
      expect(signingMode).toEqual(
        Trezor.PROTO.CardanoTxSigningMode.POOL_REGISTRATION_AS_OWNER,
      );
    });

    it('can detect plutus transaction signing mode', async () => {
      const signingMode = TrezorKeyAgent.matchSigningMode(validPlutusTx);
      expect(signingMode).toEqual(
        Trezor.PROTO.CardanoTxSigningMode.PLUTUS_TRANSACTION,
      );
    });

    it('can detect multisig transaction signing mode', async () => {
      const signingMode = TrezorKeyAgent.matchSigningMode(validMultisigTx);
      expect(signingMode).toEqual(
        Trezor.PROTO.CardanoTxSigningMode.MULTISIG_TRANSACTION,
      );
    });

    describe('broader plutus signing mode usage', () => {
      it('matches plutus signing mode if multisig tx body contains collateral inputs', async () => {
        const signingMode = TrezorKeyAgent.matchSigningMode({
          ...validMultisigTx,
          collateralInputs: [txIn],
        });
        expect(signingMode).toEqual(
          Trezor.PROTO.CardanoTxSigningMode.PLUTUS_TRANSACTION,
        );
      });

      it('matches plutus signing mode if multisig tx body contains collateral outputs', async () => {
        const signingMode = TrezorKeyAgent.matchSigningMode({
          ...validMultisigTx,
          collateralReturn: txOut,
        });
        expect(signingMode).toEqual(
          Trezor.PROTO.CardanoTxSigningMode.PLUTUS_TRANSACTION,
        );
      });

      it('matches plutus signing mode if multisig tx body contains total collateral', async () => {
        const signingMode = TrezorKeyAgent.matchSigningMode({
          ...validMultisigTx,
          totalCollateral: '10',
        });
        expect(signingMode).toEqual(
          Trezor.PROTO.CardanoTxSigningMode.PLUTUS_TRANSACTION,
        );
      });

      it('matches plutus signing mode if multisig tx body contains reference input', async () => {
        const signingMode = TrezorKeyAgent.matchSigningMode({
          ...validMultisigTx,
          referenceInputs: [txIn],
        });
        expect(signingMode).toEqual(
          Trezor.PROTO.CardanoTxSigningMode.PLUTUS_TRANSACTION,
        );
      });
    });
  });

  describe('signTransaction', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('asks the device for the stake witness a native script in the context requires', async () => {
      const cardanoSignTransaction = vi
        .spyOn(Trezor.default, 'cardanoSignTransaction')
        .mockResolvedValue({ payload: { error: 'rejected' }, success: false });
      const keyAgent = new TrezorKeyAgent(
        {
          accountIndex: 0,
          chainId: Cardano.ChainIds.Preview,
          extendedAccountPublicKey: Crypto.Bip32PublicKeyHex(
            'fc5ab25e830b67c47d0a17411bf7fdabf711a597fb6cf04102734b0a2934ceaaa65ff5e7c52498d52c07b8ddfcd436fc2b4d2775e2984a49d0c79f65ceee4779',
          ),
          isTrezorInitialized: true,
          purpose: KeyPurpose.STANDARD,
          trezorConfig: {
            communicationType: CommunicationType.Node,
            manifest: { appUrl: 'https://test.com', email: 'test@test.com' },
          },
        },
        {
          bip32Ed25519: await Crypto.SodiumBip32Ed25519.create(),
          logger: dummyLogger,
        },
      );

      const script: Cardano.Script = {
        __type: Cardano.ScriptType.Native,
        keyHash: Crypto.Ed25519KeyHashHex(stakeKeyHash),
        kind: Cardano.NativeScriptKind.RequireSignature,
      };
      const policyId = Cardano.PolicyId(
        Serialization.Script.fromCore(script).hash(),
      );

      await expect(
        keyAgent.signTransaction(
          Serialization.TransactionBody.fromCore({
            ...minValidTxBody,
            mint: new Map([
              [Cardano.AssetId.fromParts(policyId, Cardano.AssetName('')), 1n],
            ]),
          }),
          {
            knownAddresses: [knownAddress],
            scripts: [script],
            txInKeyPathMap: {
              [TxInId(coreTxIn)]: { index: 0, role: KeyRole.Internal },
            },
          },
        ),
      ).rejects.toThrow();
      expect(cardanoSignTransaction).toHaveBeenCalledWith(
        expect.objectContaining({
          additionalWitnessRequests: [
            knownAddressKeyPath,
            knownAddressStakeKeyPath,
          ],
        }),
      );
    });

    it.each([
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
          requiredTopLevelGuards: [
            {
              credential: {
                hash: stakeKeyHash,
                type: Cardano.CredentialType.ScriptHash,
              },
              datum: null,
            },
          ],
        },
        field: 'requiredTopLevelGuards',
      },
    ] as { body: Partial<Cardano.TxBody>; field: string }[])(
      'refuses a body with $field before reaching the device',
      async ({ body, field }) => {
        const cardanoSignTransaction = vi.spyOn(
          Trezor.default,
          'cardanoSignTransaction',
        );
        const keyAgent = new TrezorKeyAgent(
          {
            accountIndex: 0,
            chainId: Cardano.ChainIds.Preview,
            extendedAccountPublicKey: Crypto.Bip32PublicKeyHex(
              'fc5ab25e830b67c47d0a17411bf7fdabf711a597fb6cf04102734b0a2934ceaaa65ff5e7c52498d52c07b8ddfcd436fc2b4d2775e2984a49d0c79f65ceee4779',
            ),
            isTrezorInitialized: true,
            purpose: KeyPurpose.STANDARD,
            trezorConfig: {
              communicationType: CommunicationType.Node,
              manifest: { appUrl: 'https://test.com', email: 'test@test.com' },
            },
          },
          {
            bip32Ed25519: await Crypto.SodiumBip32Ed25519.create(),
            logger: dummyLogger,
          },
        );

        const signing = keyAgent.signTransaction(
          Serialization.TransactionBody.fromCore({
            ...minValidTxBody,
            ...body,
          }),
          { knownAddresses: [knownAddress], txInKeyPathMap: {} },
        );

        await expect(signing).rejects.toThrow(errors.HwMappingError);
        await expect(signing).rejects.toThrow(field);
        expect(cardanoSignTransaction).not.toHaveBeenCalled();
      },
    );
  });

  describe('signSubTransaction', () => {
    it('refuses to sign a sub transaction, which the Trezor Cardano app cannot sign', async () => {
      const cardanoSignTransaction = vi.spyOn(
        Trezor.default,
        'cardanoSignTransaction',
      );
      const keyAgent = new TrezorKeyAgent(
        {
          accountIndex: 0,
          chainId: Cardano.ChainIds.Preview,
          extendedAccountPublicKey: Crypto.Bip32PublicKeyHex(
            'fc5ab25e830b67c47d0a17411bf7fdabf711a597fb6cf04102734b0a2934ceaaa65ff5e7c52498d52c07b8ddfcd436fc2b4d2775e2984a49d0c79f65ceee4779',
          ),
          isTrezorInitialized: true,
          purpose: KeyPurpose.STANDARD,
          trezorConfig: {
            communicationType: CommunicationType.Node,
            manifest: { appUrl: 'https://test.com', email: 'test@test.com' },
          },
        },
        {
          bip32Ed25519: await Crypto.SodiumBip32Ed25519.create(),
          logger: dummyLogger,
        },
      );

      await expect(keyAgent.signSubTransaction()).rejects.toThrow(
        'Sub transaction signing is not supported by Trezor devices',
      );
      expect(cardanoSignTransaction).not.toHaveBeenCalled();
      cardanoSignTransaction.mockRestore();
    });
  });

  describe('getXpub', () => {
    const mockCardanoGetPublicKey = vi.fn();

    beforeEach(() => {
      vi.clearAllMocks();
      // Mock the Trezor module methods
      vi.spyOn(TrezorKeyAgent, 'checkDeviceConnection').mockResolvedValue(
        {} as Trezor.Features,
      );
      vi.spyOn(Trezor.default, 'cardanoGetPublicKey').mockImplementation(
        mockCardanoGetPublicKey,
      );
      vi.spyOn(Trezor.default, 'getFeatures').mockResolvedValue({
        payload: {} as Trezor.Features,
        success: true,
      });
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    describe('derivationType parameter', () => {
      const baseProps = {
        accountIndex: 0,
        communicationType: CommunicationType.Node,
        purpose: KeyPurpose.STANDARD,
      };

      it('should call cardanoGetPublicKey without derivationType when not provided', async () => {
        mockCardanoGetPublicKey.mockResolvedValue({
          payload: { publicKey: 'a'.repeat(128) },
          success: true,
        });

        await TrezorKeyAgent.getXpub(baseProps);

        expect(mockCardanoGetPublicKey).toHaveBeenCalledWith({
          path: `m/${KeyPurpose.STANDARD}'/${CardanoKeyConst.COIN_TYPE}'/0'`,
          showOnTrezor: true,
        });
      });

      it('should call cardanoGetPublicKey with ICARUS derivationType when provided', async () => {
        mockCardanoGetPublicKey.mockResolvedValue({
          payload: { publicKey: 'a'.repeat(128) },
          success: true,
        });

        await TrezorKeyAgent.getXpub({
          ...baseProps,
          derivationType: 'ICARUS',
        });

        expect(mockCardanoGetPublicKey).toHaveBeenCalledWith({
          derivationType: 1, // Trezor.PROTO.CardanoDerivationType.ICARUS
          path: `m/${KeyPurpose.STANDARD}'/${CardanoKeyConst.COIN_TYPE}'/0'`,
          showOnTrezor: true,
        });
      });

      it('should call cardanoGetPublicKey with ICARUS_TREZOR derivationType when provided', async () => {
        mockCardanoGetPublicKey.mockResolvedValue({
          payload: { publicKey: 'a'.repeat(128) },
          success: true,
        });

        await TrezorKeyAgent.getXpub({
          ...baseProps,
          derivationType: 'ICARUS_TREZOR',
        });

        expect(mockCardanoGetPublicKey).toHaveBeenCalledWith({
          derivationType: 2, // Trezor.PROTO.CardanoDerivationType.ICARUS_TREZOR
          path: `m/${KeyPurpose.STANDARD}'/${CardanoKeyConst.COIN_TYPE}'/0'`,
          showOnTrezor: true,
        });
      });

      it('should call cardanoGetPublicKey with LEDGER derivationType when provided', async () => {
        mockCardanoGetPublicKey.mockResolvedValue({
          payload: { publicKey: 'a'.repeat(128) },
          success: true,
        });

        await TrezorKeyAgent.getXpub({
          ...baseProps,
          derivationType: 'LEDGER',
        });

        expect(mockCardanoGetPublicKey).toHaveBeenCalledWith({
          derivationType: 0, // Trezor.PROTO.CardanoDerivationType.LEDGER
          path: `m/${KeyPurpose.STANDARD}'/${CardanoKeyConst.COIN_TYPE}'/0'`,
          showOnTrezor: true,
        });
      });

      it('should handle different account indices with derivationType', async () => {
        mockCardanoGetPublicKey.mockResolvedValue({
          payload: { publicKey: 'a'.repeat(128) },
          success: true,
        });

        await TrezorKeyAgent.getXpub({
          ...baseProps,
          accountIndex: 5,
          derivationType: 'ICARUS',
        });

        expect(mockCardanoGetPublicKey).toHaveBeenCalledWith({
          derivationType: 1, // Trezor.PROTO.CardanoDerivationType.ICARUS
          path: `m/${KeyPurpose.STANDARD}'/${CardanoKeyConst.COIN_TYPE}'/5'`,
          showOnTrezor: true,
        });
      });

      it('should handle different purposes with derivationType', async () => {
        mockCardanoGetPublicKey.mockResolvedValue({
          payload: { publicKey: 'a'.repeat(128) },
          success: true,
        });

        await TrezorKeyAgent.getXpub({
          ...baseProps,
          derivationType: 'LEDGER',
          purpose: KeyPurpose.MULTI_SIG,
        });

        expect(mockCardanoGetPublicKey).toHaveBeenCalledWith({
          derivationType: 0, // Trezor.PROTO.CardanoDerivationType.LEDGER
          path: `m/${KeyPurpose.MULTI_SIG}'/${CardanoKeyConst.COIN_TYPE}'/0'`,
          showOnTrezor: true,
        });
      });

      it('should return the public key from successful response', async () => {
        const expectedPublicKey = 'a'.repeat(128);
        mockCardanoGetPublicKey.mockResolvedValue({
          payload: { publicKey: expectedPublicKey },
          success: true,
        });

        const result = await TrezorKeyAgent.getXpub({
          ...baseProps,
          derivationType: 'ICARUS',
        });

        expect(result).toBe(expectedPublicKey);
      });

      it('should throw TransportError when cardanoGetPublicKey fails', async () => {
        const errorPayload = { error: 'Device not connected' };
        mockCardanoGetPublicKey.mockResolvedValue({
          payload: errorPayload,
          success: false,
        });

        await expect(
          TrezorKeyAgent.getXpub({
            ...baseProps,
            derivationType: 'ICARUS',
          }),
        ).rejects.toThrow('Failed to export extended account public key');
      });

      it('should throw AuthenticationError when cardanoGetPublicKey throws', async () => {
        const error = new Error('Connection failed');
        mockCardanoGetPublicKey.mockRejectedValue(error);

        await expect(
          TrezorKeyAgent.getXpub({
            ...baseProps,
            derivationType: 'ICARUS',
          }),
        ).rejects.toThrow('Trezor transport failed');
      });

      it('should map master key generation schemes correctly to Trezor enum values', async () => {
        // Test ICARUS mapping
        mockCardanoGetPublicKey.mockResolvedValue({
          payload: { publicKey: 'a'.repeat(128) },
          success: true,
        });

        await TrezorKeyAgent.getXpub({
          ...baseProps,
          derivationType: 'ICARUS',
        });

        expect(mockCardanoGetPublicKey).toHaveBeenCalledWith(
          expect.objectContaining({
            derivationType: 1, // Trezor.PROTO.CardanoDerivationType.ICARUS
          }),
        );

        // Test ICARUS_TREZOR mapping
        await TrezorKeyAgent.getXpub({
          ...baseProps,
          derivationType: 'ICARUS_TREZOR',
        });

        expect(mockCardanoGetPublicKey).toHaveBeenCalledWith(
          expect.objectContaining({
            derivationType: 2, // Trezor.PROTO.CardanoDerivationType.ICARUS_TREZOR
          }),
        );

        // Test LEDGER mapping
        await TrezorKeyAgent.getXpub({
          ...baseProps,
          derivationType: 'LEDGER',
        });

        expect(mockCardanoGetPublicKey).toHaveBeenCalledWith(
          expect.objectContaining({
            derivationType: 0, // Trezor.PROTO.CardanoDerivationType.LEDGER
          }),
        );
      });
    });

    describe('integration with createWithDevice', () => {
      it('should pass derivationType from trezorConfig to getXpub', async () => {
        const mockPublicKey = 'mock-public-key' as Crypto.Bip32PublicKeyHex;
        const mockGetXpub = vi
          .spyOn(TrezorKeyAgent, 'getXpub')
          .mockResolvedValue(mockPublicKey);
        const mockInitializeTrezorTransport = vi
          .spyOn(
            TrezorKeyAgent as unknown as { initializeTrezorTransport: Mock },
            'initializeTrezorTransport',
          )
          .mockResolvedValue(true);

        const trezorConfig = {
          communicationType: CommunicationType.Node,
          derivationType: 'ICARUS' as const,
          manifest: {
            appUrl: 'https://test.com',
            email: 'test@test.com',
          },
        };

        await TrezorKeyAgent.createWithDevice(
          {
            chainId: {
              networkId: 0,
              networkMagic: 999,
            } as unknown as Cardano.ChainId,
            trezorConfig,
          },
          {
            bip32Ed25519: {} as unknown as Bip32Ed25519,
            logger: {} as unknown as Logger,
          },
        );

        expect(mockGetXpub).toHaveBeenCalledWith({
          accountIndex: 0,
          communicationType: CommunicationType.Node,
          derivationType: 'ICARUS',
          purpose: KeyPurpose.STANDARD,
        });

        mockGetXpub.mockRestore();
        mockInitializeTrezorTransport.mockRestore();
      });

      it('should not pass derivationType when not specified in trezorConfig', async () => {
        const mockPublicKey = 'mock-public-key' as Crypto.Bip32PublicKeyHex;
        const mockGetXpub = vi
          .spyOn(TrezorKeyAgent, 'getXpub')
          .mockResolvedValue(mockPublicKey);
        const mockInitializeTrezorTransport = vi
          .spyOn(
            TrezorKeyAgent as unknown as { initializeTrezorTransport: Mock },
            'initializeTrezorTransport',
          )
          .mockResolvedValue(true);

        const trezorConfig = {
          communicationType: CommunicationType.Node,
          manifest: {
            appUrl: 'https://test.com',
            email: 'test@test.com',
          },
        };

        await TrezorKeyAgent.createWithDevice(
          {
            chainId: {
              networkId: 0,
              networkMagic: 999,
            } as unknown as Cardano.ChainId,
            trezorConfig,
          },
          {
            bip32Ed25519: {} as unknown as Bip32Ed25519,
            logger: {} as unknown as Logger,
          },
        );

        expect(mockGetXpub).toHaveBeenCalledWith({
          accountIndex: 0,
          communicationType: CommunicationType.Node,
          purpose: KeyPurpose.STANDARD,
        });

        mockGetXpub.mockRestore();
        mockInitializeTrezorTransport.mockRestore();
      });
    });
  });
});
