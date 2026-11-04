import * as fixture from '@lace-contract/midnight-context/src/stub-data';
import { MidnightWorkerError } from '@lace-module/midnight-sync/sdk';
import { firstValueFrom, take, toArray } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createMidnightModule,
  MidnightAttestedProverUnsupportedError,
  MidnightWorkerSettingsConflictError,
  MidnightWorkerUnsupportedError,
  observeMidnightBalances,
  signMidnightData,
} from '../src/midnight';

import {
  addMidnightAccount,
  createFakeEngineHost,
  createMidnightWallet,
  installFakeBrowser,
  PASSWORD,
} from './midnight-worker-fakes';

import type * as MidnightSyncSdk from '@lace-module/midnight-sync/sdk';

const { syncModuleOptions } = vi.hoisted(() => ({
  syncModuleOptions: [] as unknown[],
}));
vi.mock('@lace-module/midnight-sync/sdk', async importActual => {
  const actual = await importActual<typeof MidnightSyncSdk>();
  return {
    ...actual,
    createMidnightSyncModule: (
      options: Parameters<typeof actual.createMidnightSyncModule>[0],
    ) => {
      syncModuleOptions.push(options);
      return actual.createMidnightSyncModule(options);
    },
  };
});

vi.setConfig({ testTimeout: 30_000 });
const { accountId } = fixture;
const signData = async (
  wallet: Awaited<ReturnType<typeof createMidnightWallet>>,
) =>
  signMidnightData(wallet, {
    accountId,
    data: '00ff80',
    options: { encoding: 'hex', keyType: 'unshielded' },
    startTimeout: 10_000,
  });
// `crypto.randomUUID` exists only in a secure context; a page served over plain HTTP has the rest of `crypto`.
const cryptoWithoutRandomUUID = {
  getRandomValues: crypto.getRandomValues.bind(crypto),
  subtle: crypto.subtle,
};
const attestedProver = (() => {
  throw new Error('not called');
}) as unknown as NonNullable<
  Parameters<typeof createMidnightModule>[0]['createAttestedProver']
>;

afterEach(() => {
  syncModuleOptions.length = 0;
  vi.unstubAllGlobals();
});

describe('test:midnight-worker-module-options', () => {
  it('starts the engine in the SDK SharedWorker: the worker entry beside the Midnight entry, a module worker shared by name, whose engine serves the helpers with the storage kind and adopt choice the page set', async () => {
    const { host, asHost } = createFakeEngineHost();
    const browser = installFakeBrowser(asHost());
    const wallet = await createMidnightWallet({
      worker: { storage: 'indexeddb', adopt: true },
    });
    await addMidnightAccount(wallet);

    const signed = await signData(wallet);

    expect(signed.unwrap()).toEqual({
      data: '00ff80',
      signature: 'worker-signature',
      verifyingKey: 'worker-key',
    });
    expect(browser.started).toEqual([
      {
        url: expect.stringMatching(/\/midnight-worker\.js$/) as unknown,
        options: { type: 'module', name: 'lace-midnight-engine' },
      },
    ]);
    expect(host.attach).toHaveBeenCalled();
    expect(host.attach.mock.calls[0][0]).toMatchObject({
      account: { accountId },
      adopt: true,
      settings: { storage: 'indexeddb', attestedProver: false },
    });
    expect(browser.workers[0].scope.Buffer).toBe(Buffer);
  });

  it('keeps the engines state in memory and adopts no running settings with `worker: true`', async () => {
    const { host, asHost } = createFakeEngineHost();
    installFakeBrowser(asHost());
    const wallet = await createMidnightWallet({ worker: true });
    await addMidnightAccount(wallet);

    expect((await signData(wallet)).isOk()).toBe(true);
    expect(host.attach.mock.calls[0][0]).toMatchObject({
      adopt: false,
      settings: { storage: 'memory' },
    });
  });

  it('serves two pages from one worker, each on a channel of its own, and detaches a page that closes', async () => {
    const { host, asHost } = createFakeEngineHost();
    const browser = installFakeBrowser(asHost());
    const first = await createMidnightWallet({ worker: true });
    const second = await createMidnightWallet({ worker: true });
    await addMidnightAccount(first);
    await addMidnightAccount(second);

    const [fromFirst, fromSecond] = await Promise.all([
      signData(first),
      signData(second),
    ]);
    const clientIds = [
      ...new Set(host.attach.mock.calls.map(([request]) => request.clientId)),
    ];
    browser.kill('page');

    expect(fromFirst.isOk() && fromSecond.isOk()).toBe(true);
    expect(browser.workers).toHaveLength(1);
    expect(clientIds).toHaveLength(2);
    expect(
      host.signData.mock.calls.map(([request]) => request.clientId),
    ).toEqual(expect.arrayContaining(clientIds));
    await vi.waitFor(() => {
      expect(
        host.detachClient.mock.calls.map(([clientId]) => clientId).sort(),
      ).toEqual([...clientIds].sort());
    });
  });

  it('passes the worker option to the engine module: none without it or with `false`, memory and no adoption by default', () => {
    createMidnightModule({ password: PASSWORD });
    createMidnightModule({ password: PASSWORD, worker: false });
    createMidnightModule({ password: PASSWORD, worker: true });
    createMidnightModule({
      password: PASSWORD,
      worker: { storage: 'indexeddb', adopt: true },
    });
    createMidnightModule({ password: PASSWORD, worker: { adopt: true } });

    expect(
      syncModuleOptions.map(
        options => (options as { worker?: unknown }).worker,
      ),
    ).toEqual([
      undefined,
      undefined,
      {
        connect: expect.any(Function) as unknown,
        storage: 'memory',
        adopt: false,
      },
      {
        connect: expect.any(Function) as unknown,
        storage: 'indexeddb',
        adopt: true,
      },
      {
        connect: expect.any(Function) as unknown,
        storage: 'memory',
        adopt: true,
      },
    ]);
  });

  it.each([
    ['no SharedWorker', { hasSharedWorker: false, hasLocks: true }],
    [
      'a SharedWorker that runs classic scripts only',
      { isClassicOnly: true, hasLocks: true },
    ],
    ['no Web Locks', { hasLocks: false }],
    ['no crypto', { hasLocks: true, crypto: undefined }],
    [
      'no crypto.randomUUID, as on a page outside a secure context',
      { hasLocks: true, crypto: cryptoWithoutRandomUUID },
    ],
  ] as const)(
    'returns MidnightWorkerUnsupportedError from every call that needs the engine where there is %s, and starts no worker',
    async (_case, environment) => {
      const { host, asHost } = createFakeEngineHost();
      const browser = installFakeBrowser(asHost(), {
        isClassicOnly: 'isClassicOnly' in environment,
      });
      if ('hasSharedWorker' in environment)
        vi.stubGlobal('SharedWorker', undefined);
      if (!environment.hasLocks) vi.stubGlobal('navigator', {});
      if ('crypto' in environment) vi.stubGlobal('crypto', environment.crypto);
      const wallet = await createMidnightWallet({ worker: true });
      await addMidnightAccount(wallet);

      const signed = await signData(wallet);
      const balances = await firstValueFrom(
        observeMidnightBalances(wallet, {
          accountId,
          startTimeout: 10_000,
        }).pipe(take(1), toArray()),
      ).catch((error: unknown) => error);

      expect(signed.isErr() && signed.error).toBeInstanceOf(
        MidnightWorkerUnsupportedError,
      );
      expect(signed.isErr() && signed.error).toMatchObject({
        code: 'midnight-worker-unsupported',
      });
      expect(balances).toBeInstanceOf(MidnightWorkerUnsupportedError);
      expect(browser.started).toEqual([]);
      expect(host.attach).not.toHaveBeenCalled();
    },
  );

  it('refuses createAttestedProver in Worker mode with MidnightAttestedProverUnsupportedError, and accepts it on the page', () => {
    for (const worker of [true, { storage: 'indexeddb' as const }]) {
      expect(() =>
        createMidnightModule({
          password: PASSWORD,
          worker,
          createAttestedProver: attestedProver,
        }),
      ).toThrow(MidnightAttestedProverUnsupportedError);
    }
    expect(() =>
      createMidnightModule({
        password: PASSWORD,
        worker: false,
        createAttestedProver: attestedProver,
      }),
    ).not.toThrow();
  });

  it.each(['yes', null, { storage: 'disk' }, { adopt: 'yes' }])(
    'refuses the worker value %j with a TypeError',
    worker => {
      expect(() =>
        createMidnightModule({
          password: PASSWORD,
          worker: worker as unknown as boolean,
        }),
      ).toThrow(TypeError);
    },
  );

  it('returns MidnightWorkerSettingsConflictError when another page runs the account engine with other settings and this page does not adopt them', async () => {
    const { host, asHost } = createFakeEngineHost();
    host.attach.mockImplementation(async request => {
      throw new MidnightWorkerError(
        'settings-conflict',
        `The Midnight engine of account "${request.account.accountId}" runs with other settings`,
      );
    });
    installFakeBrowser(asHost());
    const wallet = await createMidnightWallet({ worker: true });
    await addMidnightAccount(wallet);

    const signed = await signData(wallet);

    expect(signed.isErr() && signed.error).toBeInstanceOf(
      MidnightWorkerSettingsConflictError,
    );
    expect(signed.isErr() && signed.error).toMatchObject({
      code: 'midnight-settings-conflict',
    });
  });
});
