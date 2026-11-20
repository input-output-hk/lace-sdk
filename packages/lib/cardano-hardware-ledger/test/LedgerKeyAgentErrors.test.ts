import {
  Ada,
  DeviceStatusError,
} from '@cardano-foundation/ledgerjs-hw-app-cardano';
import { Cardano, Serialization } from '@lace-lib/cardano-core';
import * as Crypto from '@lace-lib/cardano-crypto';
import {
  CommunicationType,
  KeyPurpose,
  errors,
  util,
} from '@lace-lib/cardano-key-management';
import { HexBlob } from '@lace-lib/cardano-util';
import {
  DisconnectedDeviceDuringOperation,
  TransportExchangeTimeoutError,
} from '@ledgerhq/errors/lib/index';
import Transport from '@ledgerhq/hw-transport';
import { dummyLogger } from 'ts-log';

import { LedgerKeyAgent } from '../src';

import {
  CONTEXT_WITH_KNOWN_ADDRESSES,
  pureAdaTxOut,
  rewardAccount,
  txIn,
} from './testData';

describe('LedgerKeyAgent device errors (LW-15427)', () => {
  let keyAgent: LedgerKeyAgent;
  let deviceConnection: Ada;

  beforeEach(async () => {
    const bip32Ed25519 = await Crypto.SodiumBip32Ed25519.create();
    // Zero entropy is the public eleven-abandon-and-about mnemonic fixture.
    const rootKey = bip32Ed25519.fromBip39Entropy(Buffer.alloc(16), '');
    const accountKey = bip32Ed25519.derivePrivateKey(rootKey, [
      util.harden(KeyPurpose.STANDARD),
      util.harden(1815),
      util.harden(0),
    ]);
    deviceConnection = new Ada(new Transport());
    vi.spyOn(LedgerKeyAgent, 'checkDeviceConnection').mockResolvedValue(
      deviceConnection,
    );
    keyAgent = new LedgerKeyAgent(
      {
        accountIndex: 0,
        chainId: Cardano.ChainIds.Preview,
        communicationType: CommunicationType.Node,
        deviceConnection,
        extendedAccountPublicKey: bip32Ed25519.getBip32PublicKey(accountKey),
        purpose: KeyPurpose.STANDARD,
      },
      { bip32Ed25519, logger: dummyLogger },
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([0x69_85, 0x6e_09])(
    'uses the installed vendor rejection message for status %i',
    code => {
      const error = new DeviceStatusError(code);

      expect(error.code).toBe(code);
      expect(error.message).toBe('Action rejected by user on device.');
    },
  );

  describe.each([
    {
      authenticationMessage: 'Failed to export extended account public key',
      deviceMethod: 'getExtendedPublicKey',
      invoke: () =>
        LedgerKeyAgent.getXpub({
          accountIndex: 0,
          communicationType: CommunicationType.Node,
          deviceConnection,
          purpose: KeyPurpose.STANDARD,
        }),
      method: 'getXpub',
    },
    {
      authenticationMessage: 'Transaction signing aborted',
      deviceMethod: 'signTransaction',
      invoke: () =>
        keyAgent.signTransaction(
          Serialization.TransactionBody.fromCore({
            fee: 10n,
            inputs: [txIn],
            outputs: [pureAdaTxOut],
          }),
          { knownAddresses: [], txInKeyPathMap: {} },
        ),
      method: 'signTransaction',
    },
    {
      authenticationMessage: 'Transaction signing aborted',
      deviceMethod: 'signMessage',
      invoke: () =>
        keyAgent.signCip8Data({
          knownAddresses: CONTEXT_WITH_KNOWN_ADDRESSES.knownAddresses,
          payload: HexBlob('68656c6c6f'),
          signWith: rewardAccount,
        }),
      method: 'signCip8Data',
    },
  ] as const)('$method', ({ authenticationMessage, deviceMethod, invoke }) => {
    it.each([0x69_85, 0x6e_09])(
      'wraps vendor rejection status %i as AuthenticationError with its original cause and message',
      async code => {
        const original = new DeviceStatusError(code);
        const deviceCall = vi
          .spyOn(deviceConnection, deviceMethod)
          .mockRejectedValueOnce(original);

        const error = await invoke().catch((cause: unknown) => cause);

        expect(deviceCall).toHaveBeenCalledTimes(1);
        expect((error as errors.AuthenticationError).innerError).toBe(original);
        expect(error).toBeInstanceOf(errors.AuthenticationError);
        expect(error).not.toBeInstanceOf(errors.TransportError);
        expect((error as Error).message).toBe(
          new errors.AuthenticationError(authenticationMessage, original)
            .message,
        );
      },
    );

    it.each([
      {
        createError: () =>
          new DisconnectedDeviceDuringOperation('Device disconnected'),
        reason: 'device disconnection',
      },
      {
        createError: () =>
          new TransportExchangeTimeoutError('Exchange timed out'),
        reason: 'transport exchange timeout',
      },
      {
        createError: () => new DeviceStatusError(0x69_82),
        reason: 'v8 security policy denial (0x6982)',
      },
    ])(
      'keeps $reason as TransportError with its original cause and message',
      async ({ createError }) => {
        const original = createError();
        const deviceCall = vi
          .spyOn(deviceConnection, deviceMethod)
          .mockRejectedValueOnce(original);

        const error = await invoke().catch((cause: unknown) => cause);

        expect(deviceCall).toHaveBeenCalledTimes(1);
        expect(error).toBeInstanceOf(errors.TransportError);
        expect(error).not.toBeInstanceOf(errors.AuthenticationError);
        expect((error as errors.TransportError).innerError).toBe(original);
        expect((error as Error).message).toBe(
          new errors.TransportError('Ledger transport failed', original)
            .message,
        );
      },
    );
  });
});
