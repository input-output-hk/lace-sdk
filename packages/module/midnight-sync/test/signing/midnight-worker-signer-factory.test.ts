import * as stubData from '@lace-contract/midnight-context/src/stub-data';
import { AuthenticationCancelledError } from '@lace-contract/signer';
import { HexBytes } from '@lace-lib/util';
import { BehaviorSubject, firstValueFrom, of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';

import { MidnightWorkerSignerFactory } from '../../src/signing/midnight-worker-signer-factory';

import type {
  MidnightEnginesByAccountId,
  MidnightRemoteEngine,
  MidnightSignRequest,
  MidnightSignerContext,
  MidnightWallet,
} from '@lace-contract/midnight-context';
import type { SignerAuth } from '@lace-contract/signer';

const { accountId, midnightAccount, midnightWallet } = stubData;
const request = {
  serializedTx: HexBytes('00'),
  flowType: 'send',
} as unknown as MidnightSignRequest;
const signed = { serializedTx: HexBytes('ff') };

const remoteEngine = () =>
  ({
    accountId,
    remote: true,
    signTransaction: vi.fn(() => of(signed)),
    signData: vi.fn(() =>
      of({ signature: '11'.repeat(4), verifyingKey: '22'.repeat(4) }),
    ),
  } as unknown as MidnightRemoteEngine & {
    signTransaction: ReturnType<typeof vi.fn>;
    signData: ReturnType<typeof vi.fn>;
  });

const auth = (confirmed = true): SignerAuth => ({
  authenticate: () => of(confirmed),
  accessAuthSecret: vi.fn(),
});

const context = (signerAuth = auth()): MidnightSignerContext => ({
  wallet: midnightWallet,
  accountId,
  auth: signerAuth,
});

describe('MidnightWorkerSignerFactory', () => {
  it('signs the accounts the in-memory factory signs, and no other', () => {
    const factory = new MidnightWorkerSignerFactory(of({}));

    expect(factory.canSign(midnightAccount)).toBe(true);
    expect(
      factory.canSign({ ...midnightAccount, blockchainName: 'Cardano' }),
    ).toBe(false);
    expect(() =>
      factory.createTransactionSigner({
        ...context(),
        accountId: 'elsewhere' as typeof accountId,
      }),
    ).toThrow('does not support account type');
  });

  it("signs a transaction through the account's engine in the worker once the user confirmed, and reports a failed phase otherwise", async () => {
    const engine = remoteEngine();
    const engines$ = new BehaviorSubject<MidnightEnginesByAccountId>({
      [accountId]: engine,
    });
    const factory = new MidnightWorkerSignerFactory(engines$);

    const result = await firstValueFrom(
      factory.createTransactionSigner(context()).sign(request),
    );

    expect(result).toEqual(signed);
    expect(engine.signTransaction).toHaveBeenCalledWith(
      request,
      expect.any(Function),
    );
    await expect(
      firstValueFrom(
        factory.createTransactionSigner(context(auth(false))).sign(request),
      ),
    ).rejects.toBeInstanceOf(AuthenticationCancelledError);
    expect(engine.signTransaction).toHaveBeenCalledTimes(1);
  });

  it('refuses an engine that runs on this page, which Worker mode never starts', async () => {
    const engines$ = of({
      [accountId]: { accountId } as unknown as MidnightWallet,
    } as MidnightEnginesByAccountId);
    const factory = new MidnightWorkerSignerFactory(engines$);

    await expect(
      firstValueFrom(factory.createTransactionSigner(context()).sign(request)),
    ).rejects.toThrow('runs on this page');
  });

  it("signs data through the account's engine", async () => {
    const engine = remoteEngine();
    const factory = new MidnightWorkerSignerFactory(
      of({ [accountId]: engine } as MidnightEnginesByAccountId),
    );

    const result = await firstValueFrom(
      factory
        .createDataSigner(context())
        .signData({ data: new Uint8Array([1, 2]) }),
    );

    expect(engine.signData).toHaveBeenCalledWith(new Uint8Array([1, 2]));
    expect(result).toEqual({
      signature: HexBytes('11'.repeat(4)),
      verifyingKey: HexBytes('22'.repeat(4)),
    });
  });
});
