import { util } from '../../src';
import { testKeyAgent } from '../mocks';

import type { KeyAgent } from '../../src';
import type { Cardano, Serialization } from '@lace-lib/cardano-core';

describe('createAsyncKeyAgent', () => {
  let keyAgent: KeyAgent;

  beforeAll(async () => {
    keyAgent = await testKeyAgent();
  });

  it('exposes the key agent properties as promises', async () => {
    const asyncKeyAgent = util.createAsyncKeyAgent(keyAgent);
    await expect(asyncKeyAgent.getAccountIndex()).resolves.toBe(
      keyAgent.accountIndex,
    );
    await expect(asyncKeyAgent.getChainId()).resolves.toEqual(keyAgent.chainId);
    await expect(asyncKeyAgent.getBip32Ed25519()).resolves.toBe(
      keyAgent.bip32Ed25519,
    );
    await expect(asyncKeyAgent.getExtendedAccountPublicKey()).resolves.toBe(
      keyAgent.extendedAccountPublicKey,
    );
  });

  it('delegates sub transaction signing to the key agent', async () => {
    const signatures = new Map() as Cardano.Signatures;
    const signSubTransaction = vi
      .spyOn(keyAgent, 'signSubTransaction')
      .mockResolvedValueOnce(signatures);
    const subTransaction = {} as Serialization.SubTransaction;
    const context = { knownAddresses: [], txInKeyPathMap: {} };

    await expect(
      util
        .createAsyncKeyAgent(keyAgent)
        .signSubTransaction(subTransaction, context),
    ).resolves.toBe(signatures);
    expect(signSubTransaction).toBeCalledWith(subTransaction, context);
  });

  it('shutdown calls the callback once, and is safe without one', () => {
    const onShutdown = vi.fn();
    util.createAsyncKeyAgent(keyAgent, onShutdown).shutdown();
    expect(onShutdown).toHaveBeenCalledTimes(1);
    expect(() => util.createAsyncKeyAgent(keyAgent).shutdown()).not.toThrow();
  });
});
