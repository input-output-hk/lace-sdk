import { ByteArray } from '@lace-lib/util';
import { firstValueFrom, Subject } from 'rxjs';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from 'vitest';

import {
  encodeMidnightFinalizedTx,
  midnightEngineGeneration,
} from '../../src/worker/codec';

import {
  assertPlainData,
  facadeState,
  fakeEngines,
  finalized,
  nightCoin,
  PASSWORD,
  sealedAccount,
  settings,
  useFastKeyDerivation,
  verifyingKey,
  WRONG_PASSWORD,
} from './engine-host-fakes';
import { createHost } from './engine-host-setup';

import type { createAccountKeyManager } from '../../src/store/side-effects/account-key-manager';
import type {
  MidnightEngineHost,
  MidnightEngineSettings,
  MidnightEngineValue,
  MidnightSessionStatus,
} from '../../src/worker/protocol';
import type { MidnightStateView } from '../../src/worker/state-view';
import type {
  AccountKeyManager,
  MidnightWallet,
} from '@lace-contract/midnight-context';
import type { AccountId } from '@lace-contract/wallet-repo';
import type { FacadeState } from '@midnightntwrk/wallet-sdk/facade';
import type { Subscription } from 'rxjs';

vi.mock('../../src/store/dependencies', async importOriginal => {
  const fakes = await import('./engine-host-fakes');
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    createStartMidnightAccountWallet: fakes.fakeEngines.createStart,
  };
});

// Every key manager the host creates, so that a test can see it destroyed even when no engine started.
const keyManagers = vi.hoisted(() => [] as AccountKeyManager[]);
vi.mock(
  '../../src/store/side-effects/account-key-manager',
  async importOriginal => {
    const actual = await importOriginal<{
      createAccountKeyManager: typeof createAccountKeyManager;
    }>();
    return {
      ...actual,
      createAccountKeyManager: (
        ...args: Parameters<typeof createAccountKeyManager>
      ) => {
        const keyManager = actual.createAccountKeyManager(...args);
        vi.spyOn(keyManager, 'destroy');
        keyManagers.push(keyManager);
        return keyManager;
      },
    };
  },
);

const reasonOf = async (call: Promise<unknown>) =>
  call.then(
    () => 'resolved',
    (error: unknown) => (error as { reason?: string }).reason ?? error,
  );

const proved = (engine: MidnightWallet) =>
  encodeMidnightFinalizedTx(finalized(), {
    accountId: engine.accountId,
    engineGeneration: midnightEngineGeneration(engine),
  });

const isZeroed = (bytes: Uint8Array) => bytes.every(byte => byte === 0);

const flush = async () =>
  new Promise<void>(resolve => {
    setImmediate(resolve);
  });

// The host keeps these collections to itself, so the test finds them by what goes into them: the account channels by
// their values, the attaches by their sets of promises, and the closed clients by what `detachClient` adds as it is
// called. The prototypes are patched by hand, as a spy would record its own calls in a map.
const trackHostCollections = (host: MidnightEngineHost) => {
  const { add: addItem } = Set.prototype;
  const { set: setEntry } = Map.prototype;
  const channels = new Set<Map<unknown, unknown>>();
  const attaches = new Set<Map<unknown, unknown>>();
  const closedClients = new Set<Set<unknown>>();
  let isClosing = false;
  Map.prototype.set = function (
    this: Map<unknown, unknown>,
    key: unknown,
    value: unknown,
  ) {
    if (typeof value === 'object' && value !== null && 'status$' in value)
      addItem.call(channels, this);
    if (
      value instanceof Set &&
      value.size > 0 &&
      [...(value as Set<unknown>)].every(item => item instanceof Promise)
    )
      addItem.call(attaches, this);
    return setEntry.call(this, key, value);
  };
  Set.prototype.add = function (this: Set<unknown>, value: unknown) {
    if (isClosing) addItem.call(closedClients, this);
    return addItem.call(this, value);
  };
  onTestFinished(() => {
    Map.prototype.set = setEntry;
    Set.prototype.add = addItem;
  });
  const { detachClient } = host;
  host.detachClient = async clientId => {
    isClosing = true;
    try {
      return detachClient(clientId);
    } finally {
      isClosing = false;
    }
  };
  const sizeOf = (collections: Set<{ size: number }>) =>
    [...collections].reduce((total, { size }) => total + size, 0);
  return () => ({
    channels: sizeOf(channels),
    attaches: sizeOf(attaches),
    closedClients: sizeOf(closedClients),
  });
};

describe('engine-host-sessions', () => {
  beforeAll(useFastKeyDerivation);
  beforeEach(() => {
    fakeEngines.reset();
    keyManagers.length = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('starts the account engine on the first attach, with the store of its storage kind and the batch updates', async () => {
    const { host, stores } = createHost();
    const account = await sealedAccount();

    const result = await host.attach({
      clientId: 'tab-1',
      account,
      password: PASSWORD.slice(),
      settings: settings(),
      batchUpdates: { size: 3, spacing: 1 },
    });

    expect(fakeEngines.started).toHaveLength(1);
    const [{ engine, params, options }] = fakeEngines.started;
    expect(params.account).toBe(account);
    expect(params.config).toEqual(settings().config);
    expect(params.store).toBe(stores.get('memory')?.store);
    expect(options).toEqual({ batchUpdates: { size: 3, spacing: 1 } });
    expect(result).toEqual({
      accountId: account.accountId,
      walletId: account.walletId,
      networkId: account.blockchainSpecific.networkId,
      nightVerifyingKey: verifyingKey,
      engineGeneration: midnightEngineGeneration(engine),
      resets: 0,
      settings: settings(),
    });
    expect(() => {
      assertPlainData(result);
    }).not.toThrow();
  });

  it('attaches a second client to the running engine without starting another', async () => {
    const { host } = createHost();
    const account = await sealedAccount();
    const request = () => ({
      account,
      password: PASSWORD.slice(),
      settings: settings(),
    });

    const first = await host.attach({ clientId: 'tab-1', ...request() });
    const second = await host.attach({ clientId: 'tab-2', ...request() });

    expect(fakeEngines.started).toHaveLength(1);
    expect(second.engineGeneration).toBe(first.engineGeneration);
    await expect(
      host.signData({
        clientId: 'tab-2',
        accountId: account.accountId,
        data: new Uint8Array([1]),
      }),
    ).resolves.toEqual({ signature: 'signature', verifyingKey });
  });

  it('starts one engine for concurrent attaches of one account', async () => {
    const { host } = createHost();
    const account = await sealedAccount();
    const request = () => ({
      account,
      password: PASSWORD.slice(),
      settings: settings(),
    });

    const [first, second] = await Promise.all([
      host.attach({ clientId: 'tab-1', ...request() }),
      host.attach({ clientId: 'tab-2', ...request() }),
    ]);

    expect(fakeEngines.started).toHaveLength(1);
    expect(second.engineGeneration).toBe(first.engineGeneration);
  });

  it('runs a second account alongside the first, each call scoped to its account', async () => {
    const { host } = createHost();
    const a = await sealedAccount({ walletId: 'wallet-a' });
    const b = await sealedAccount({ walletId: 'wallet-b', accountIndex: 3 });

    await host.attach({
      clientId: 'tab-1',
      account: a,
      password: PASSWORD.slice(),
      settings: settings(),
    });
    await host.attach({
      clientId: 'tab-1',
      account: b,
      password: PASSWORD.slice(),
      settings: settings(),
    });
    await host.signData({
      clientId: 'tab-1',
      accountId: b.accountId,
      data: new Uint8Array([2]),
    });

    expect(fakeEngines.started.map(({ engine }) => engine.accountId)).toEqual([
      a.accountId,
      b.accountId,
    ]);
    expect(fakeEngines.current(a.accountId).engine.signData).not.toBeCalled();
    expect(fakeEngines.current(b.accountId).engine.signData).toBeCalledWith(
      new Uint8Array([2]),
    );
  });

  it('derives the engine keys in the worker from the account data and its own copy of the password', async () => {
    const { host } = createHost();
    const account = await sealedAccount();
    const password = new Uint8Array(PASSWORD);

    await host.attach({
      clientId: 'tab-1',
      account,
      password,
      settings: settings(),
    });
    password.fill(0);
    const keys = await firstValueFrom(
      fakeEngines.started[0].params.keyManager.keys$,
    );

    expect(keys.walletKeys.dustKeyBuffer).toHaveLength(32);
    expect(keys.walletKeys.zswapKeyBuffer).toHaveLength(32);
    expect(typeof keys.unshieldedKeystore.getPublicKey()).toBe('string');
  });

  it('zeroes the password of the request once the attach settles, refused or not', async () => {
    const { host } = createHost();
    const account = await sealedAccount();
    const other = await sealedAccount({ walletId: 'wallet-b' });
    const passwords = [
      PASSWORD.slice(),
      WRONG_PASSWORD.slice(),
      PASSWORD.slice(),
      WRONG_PASSWORD.slice(),
    ];

    await host.attach({
      clientId: 'tab-1',
      account,
      password: passwords[0],
      settings: settings(),
    });
    const reasons = [
      await reasonOf(
        host.attach({
          clientId: 'tab-2',
          account,
          password: passwords[1],
          settings: settings(),
        }),
      ),
      await reasonOf(
        host.attach({
          clientId: 'tab-2',
          account,
          password: passwords[2],
          settings: settings({ storage: 'indexeddb' }),
        }),
      ),
      await reasonOf(
        host.attach({
          clientId: 'tab-1',
          account: other,
          password: passwords[3],
          settings: settings(),
        }),
      ),
    ];

    expect(reasons).toEqual([
      'wrong-password',
      'settings-conflict',
      'wrong-password',
    ]);
    expect(passwords.map(isZeroed)).toEqual([true, true, true, true]);
  });

  it('zeroes its password copy and destroys the key manager when the session ends with its last client', async () => {
    const { host } = createHost();
    const account = await sealedAccount();
    const clone = vi.spyOn(ByteArray, 'clone');
    await host.attach({
      clientId: 'tab-1',
      account,
      password: PASSWORD.slice(),
      settings: settings(),
    });
    const copies = clone.mock.results.map(({ value }) => value as Uint8Array);
    const isCopyLiveWhileAttached = copies.some(copy => !isZeroed(copy));
    const [keyManager] = keyManagers;
    const destroysWhileAttached = vi.mocked(keyManager.destroy).mock.calls
      .length;

    await host.detach({ clientId: 'tab-1', accountId: account.accountId });

    expect(isCopyLiveWhileAttached).toBe(true);
    expect(destroysWhileAttached).toBe(0);
    expect(copies.every(isZeroed)).toBe(true);
    expect(keyManagers).toHaveLength(1);
    expect(keyManager.destroy).toHaveBeenCalledOnce();
  });

  it('zeroes its password copy and destroys the key manager when the first engine start fails', async () => {
    const { host } = createHost();
    const account = await sealedAccount();
    const clone = vi.spyOn(ByteArray, 'clone');
    fakeEngines.failNextStart = new Error('indexer unreachable');

    await expect(
      host.attach({
        clientId: 'tab-1',
        account,
        password: PASSWORD.slice(),
        settings: settings(),
      }),
    ).rejects.toThrow('indexer unreachable');

    const copies = clone.mock.results.map(({ value }) => value as Uint8Array);
    expect(copies.length).toBeGreaterThan(0);
    expect(copies.every(isZeroed)).toBe(true);
    expect(keyManagers).toHaveLength(1);
    expect(keyManagers[0].destroy).toHaveBeenCalledOnce();
  });

  it('refuses a wrong password at start without starting an engine', async () => {
    const { host } = createHost();
    const account = await sealedAccount();

    await expect(
      reasonOf(
        host.attach({
          clientId: 'tab-1',
          account,
          password: WRONG_PASSWORD.slice(),
          settings: settings(),
        }),
      ),
    ).resolves.toBe('wrong-password');
    expect(fakeEngines.started).toHaveLength(0);
  });

  it('refuses a wrong password at attach and gives that client no access', async () => {
    const { host } = createHost();
    const account = await sealedAccount();
    const { accountId } = account;
    await host.attach({
      clientId: 'tab-1',
      account,
      password: PASSWORD.slice(),
      settings: settings(),
    });

    await expect(
      reasonOf(
        host.attach({
          clientId: 'tab-2',
          account,
          password: WRONG_PASSWORD.slice(),
          settings: settings(),
        }),
      ),
    ).resolves.toBe('wrong-password');
    const emitted = vi.fn();
    host
      .streams({ clientId: 'tab-2', accountId })
      .stateView$.subscribe(emitted);

    await expect(
      reasonOf(
        host.signData({
          clientId: 'tab-2',
          accountId,
          data: new Uint8Array([1]),
        }),
      ),
    ).resolves.toBe('not-attached');
    expect(emitted).not.toBeCalled();
    expect(fakeEngines.started).toHaveLength(1);
  });

  it('checks the password against the running account, not against the account data a client presents', async () => {
    const { host } = createHost();
    const account = await sealedAccount();
    await host.attach({
      clientId: 'tab-1',
      account,
      password: PASSWORD.slice(),
      settings: settings(),
    });
    const forged = {
      ...(await sealedAccount({ password: WRONG_PASSWORD })),
      accountId: account.accountId,
    };

    await expect(
      reasonOf(
        host.attach({
          clientId: 'tab-2',
          account: forged,
          password: WRONG_PASSWORD.slice(),
          settings: settings(),
        }),
      ),
    ).resolves.toBe('wrong-password');
  });

  const differing: [string, MidnightEngineSettings][] = [
    [
      'indexer',
      settings({
        config: {
          ...settings().config,
          indexerAddress: 'https://other-indexer.example',
        },
      }),
    ],
    [
      'node',
      settings({
        config: { ...settings().config, nodeAddress: 'https://other.example' },
      }),
    ],
    [
      'proof-server kind',
      settings({
        config: {
          ...settings().config,
          proofServer: {
            kind: 'delegated',
            url: 'http://127.0.0.1:6300',
            label: 'local',
          },
        },
      }),
    ],
    [
      'proof-server URL',
      settings({
        config: {
          ...settings().config,
          proofServer: { kind: 'local-host', url: 'http://127.0.0.1:6301' },
        },
      }),
    ],
    ['storage kind', settings({ storage: 'indexeddb' })],
  ];

  it.each(differing)(
    'refuses a different %s unless the client adopts the running settings',
    async (_, requested) => {
      const { host } = createHost();
      const account = await sealedAccount();
      await host.attach({
        clientId: 'tab-1',
        account,
        password: PASSWORD.slice(),
        settings: settings(),
      });

      await expect(
        reasonOf(
          host.attach({
            clientId: 'tab-2',
            account,
            password: PASSWORD.slice(),
            settings: requested,
          }),
        ),
      ).resolves.toBe('settings-conflict');
      const adopted = await host.attach({
        clientId: 'tab-2',
        account,
        password: PASSWORD.slice(),
        settings: requested,
        adopt: true,
      });

      expect(adopted.settings).toEqual(settings());
      expect(fakeEngines.started).toHaveLength(1);
    },
  );

  it('refuses an attested prover even with adopt, and a tee-delegated proof server, before starting anything', async () => {
    const { host } = createHost();
    const account = await sealedAccount();
    await host.attach({
      clientId: 'tab-1',
      account,
      password: PASSWORD.slice(),
      settings: settings(),
    });
    const other = await sealedAccount({ walletId: 'wallet-b' });

    const refusals = await Promise.all([
      reasonOf(
        host.attach({
          clientId: 'tab-2',
          account,
          password: PASSWORD.slice(),
          settings: settings({ attestedProver: true }),
          adopt: true,
        }),
      ),
      reasonOf(
        host.attach({
          clientId: 'tab-2',
          account: other,
          password: PASSWORD.slice(),
          settings: settings({
            config: {
              ...settings().config,
              proofServer: {
                kind: 'tee-delegated',
                url: 'https://api.proofserver.wastedp.io',
                label: 'Temenos',
              },
            },
          }),
        }),
      ),
    ]);

    expect(refusals).toEqual(['attested-prover', 'attested-prover']);
    expect(fakeEngines.started).toHaveLength(1);
  });

  it('ends the engine with its last client and keeps it while another client remains', async () => {
    const { host } = createHost();
    const account = await sealedAccount();
    const { accountId } = account;
    const request = () => ({
      account,
      password: PASSWORD.slice(),
      settings: settings(),
    });
    await host.attach({ clientId: 'tab-1', ...request() });
    await host.attach({ clientId: 'tab-2', ...request() });
    const [running] = fakeEngines.started;

    await host.detach({ clientId: 'tab-1', accountId });
    const isTornDownWithAClientLeft = running.tornDown;
    await host.detach({ clientId: 'tab-2', accountId });

    expect(isTornDownWithAClientLeft).toBe(false);
    expect(running.tornDown).toBe(true);
    await expect(
      reasonOf(
        host.signData({
          clientId: 'tab-2',
          accountId,
          data: new Uint8Array([1]),
        }),
      ),
    ).resolves.toBe('not-attached');
  });

  it('keeps an engine with an unsettled submission after its last client left, while the remaining client uses another account', async () => {
    const { host } = createHost();
    const a = await sealedAccount({ walletId: 'wallet-a' });
    const b = await sealedAccount({ walletId: 'wallet-b' });
    await host.attach({
      clientId: 'tab-1',
      account: a,
      password: PASSWORD.slice(),
      settings: settings(),
    });
    await host.attach({
      clientId: 'tab-2',
      account: b,
      password: PASSWORD.slice(),
      settings: settings(),
    });
    const [engineA, engineB] = fakeEngines.started;
    const finality = new Subject<string>();
    vi.mocked(engineA.engine.submitTransaction).mockReturnValue(finality);

    const submission = host.submit({
      clientId: 'tab-1',
      accountId: a.accountId,
      transaction: proved(engineA.engine),
    });
    await host.detachClient('tab-1');
    const isTornDownWhileUnsettled = engineA.tornDown;
    finality.next('tx-hash');
    finality.complete();

    await expect(submission).resolves.toEqual({ txId: 'tx-hash' });
    expect(isTornDownWhileUnsettled).toBe(false);
    await vi.waitFor(() => {
      expect(engineA.tornDown).toBe(true);
    });
    expect(engineB.tornDown).toBe(false);
  });

  it('releases every attachment of a client whose tab closed, including an attach still running', async () => {
    const { host } = createHost();
    const a = await sealedAccount({ walletId: 'wallet-a' });
    const b = await sealedAccount({ walletId: 'wallet-b' });
    await host.attach({
      clientId: 'tab-1',
      account: a,
      password: PASSWORD.slice(),
      settings: settings(),
    });

    const pending = host.attach({
      clientId: 'tab-1',
      account: b,
      password: PASSWORD.slice(),
      settings: settings(),
    });
    await host.detachClient('tab-1');

    await expect(reasonOf(pending)).resolves.toBe('not-attached');
    expect(fakeEngines.started.every(({ tornDown }) => tornDown)).toBe(true);
    expect(fakeEngines.of(a.accountId)).toHaveLength(1);
  });

  it('releases a client whose tab closed while its engine was starting', async () => {
    const { host } = createHost();
    const account = await sealedAccount();
    let release!: () => void;
    fakeEngines.hold = new Promise(resolve => {
      release = resolve;
    });

    const pending = host.attach({
      clientId: 'tab-1',
      account,
      password: PASSWORD.slice(),
      settings: settings(),
    });
    await vi.waitFor(() => {
      expect(fakeEngines.started).toHaveLength(1);
    });
    await host.detachClient('tab-1');
    release();

    await expect(reasonOf(pending)).resolves.toBe('not-attached');
    expect(fakeEngines.started[0].tornDown).toBe(true);
  });

  it('fails the attach with the engine start error, keeping no engine, and starts again on the next attach', async () => {
    const { host } = createHost();
    const account = await sealedAccount();
    const request = () => ({
      clientId: 'tab-1',
      account,
      password: PASSWORD.slice(),
      settings: settings(),
    });
    fakeEngines.failNextStart = new Error('indexer unreachable');

    await expect(host.attach(request())).rejects.toThrow('indexer unreachable');
    await expect(
      reasonOf(
        host.signData({
          clientId: 'tab-1',
          accountId: account.accountId,
          data: new Uint8Array([1]),
        }),
      ),
    ).resolves.toBe('not-attached');
    await expect(host.attach(request())).resolves.toMatchObject({
      accountId: account.accountId,
    });
    expect(fakeEngines.started).toHaveLength(1);
  });

  it('streams the account engine to a client only while it is attached', async () => {
    // The worker throttles the state view; a fake clock lets the throttled state through at once.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { host } = createHost();
    const account = await sealedAccount();
    const { accountId } = account;
    const request = () => ({
      account,
      password: PASSWORD.slice(),
      settings: settings(),
    });
    await host.attach({ clientId: 'tab-1', ...request() });
    const toFirst = vi.fn();
    const toSecond =
      vi.fn<(view: MidnightEngineValue<MidnightStateView>) => void>();
    host
      .streams({ clientId: 'tab-1', accountId })
      .stateView$.subscribe(toFirst);
    host
      .streams({ clientId: 'tab-2', accountId })
      .stateView$.subscribe(toSecond);
    const [running] = fakeEngines.started;

    await host.attach({ clientId: 'tab-2', ...request() });
    await host.detach({ clientId: 'tab-1', accountId });
    running.state$.next(facadeState({ availableCoins: [nightCoin(99n)] }));
    vi.advanceTimersByTime(500);

    expect(toFirst).toHaveBeenCalledTimes(1);
    expect(toSecond).toHaveBeenCalledTimes(2);
    expect(
      toSecond.mock.lastCall?.[0].value.unshielded.availableCoins[0].utxo.value,
    ).toBe(99n);
  });

  describe('an engine that fails while a submission of it settles', () => {
    const failingWhileSettling = async () => {
      const { host } = createHost();
      const account = await sealedAccount();
      const { accountId } = account;
      const attach = async (clientId: string) =>
        host.attach({
          clientId,
          account,
          password: PASSWORD.slice(),
          settings: settings(),
        });
      await attach('tab-1');
      const [failing] = fakeEngines.started;
      const finality = new Subject<string>();
      vi.mocked(failing.engine.submitTransaction).mockReturnValue(finality);
      const submission = host.submit({
        clientId: 'tab-1',
        accountId,
        transaction: proved(failing.engine),
      });
      const statuses: MidnightSessionStatus[] = [];
      host
        .streams({ clientId: 'tab-1', accountId })
        .status$.subscribe(status => statuses.push(status));
      host.streams({ clientId: 'tab-1', accountId }).syncProgress$.subscribe();
      failing.syncProgress$.error(new Error('indexer unreachable'));
      const settle = () => {
        finality.next('tx-hash');
        finality.complete();
      };
      return {
        host,
        accountId,
        attach,
        failing,
        submission,
        statuses,
        settle,
      };
    };

    it('keeps the engine through an attach, which joins it, and the submission settles with its own outcome', async () => {
      const { attach, failing, submission, settle } =
        await failingWhileSettling();

      const joined = await attach('tab-2');
      const isTornDownAfterTheAttach = failing.tornDown;
      settle();

      expect(joined.engineGeneration).toBe(
        midnightEngineGeneration(failing.engine),
      );
      expect(isTornDownAfterTheAttach).toBe(false);
      expect(fakeEngines.started).toHaveLength(1);
      await expect(submission).resolves.toEqual({ txId: 'tx-hash' });
    });

    it('publishes the failure with the pending replacement while the submission settles', async () => {
      const { failing, statuses, settle } = await failingWhileSettling();
      const whileSettling = statuses[statuses.length - 1];
      settle();

      expect(whileSettling).toEqual({
        engineGeneration: midnightEngineGeneration(failing.engine),
        resets: 0,
        failure: 'indexer unreachable',
        replacePending: true,
      });
    });

    it('refuses a new submission on the failed engine with not-running, broadcasting nothing', async () => {
      const { host, accountId, failing, settle } = await failingWhileSettling();

      const refusal = await host
        .submit({
          clientId: 'tab-1',
          accountId,
          transaction: proved(failing.engine),
        })
        .catch((error: unknown) => error);
      settle();

      expect(refusal).toMatchObject({
        reason: 'not-running',
        message: expect.stringContaining('nothing was broadcast') as string,
      });
      expect(failing.engine.submitTransaction).toHaveBeenCalledOnce();
    });

    it('replaces the engine once the submission settles, for the clients still attached', async () => {
      const { host, accountId, attach, failing, submission, statuses, settle } =
        await failingWhileSettling();
      await attach('tab-2');

      settle();
      await submission;
      await vi.waitFor(() => {
        expect(fakeEngines.started).toHaveLength(2);
      });
      const replacement = fakeEngines.current(accountId);
      await vi.waitFor(() => {
        expect(statuses[statuses.length - 1]).toEqual({
          engineGeneration: midnightEngineGeneration(replacement.engine),
          resets: 0,
        });
      });

      expect(failing.tornDown).toBe(true);
      await expect(
        host.signData({
          clientId: 'tab-2',
          accountId,
          data: new Uint8Array([1]),
        }),
      ).resolves.toMatchObject({ signature: 'signature' });
      expect(replacement.engine.signData).toHaveBeenCalledOnce();
    });

    it('ends the session once the submission settles when no client remains', async () => {
      const { host, accountId, failing, submission, settle } =
        await failingWhileSettling();
      await host.detach({ clientId: 'tab-1', accountId });
      const isTornDownWhileSettling = failing.tornDown;

      settle();
      await submission;
      await vi.waitFor(() => {
        expect(failing.tornDown).toBe(true);
      });

      expect(isTornDownWhileSettling).toBe(false);
      expect(fakeEngines.started).toHaveLength(1);
      expect(keyManagers[0].destroy).toHaveBeenCalledOnce();
    });
  });

  it('refuses a call with not-running while no engine runs, between the stop and the next start of a reset', async () => {
    const { host } = createHost();
    const account = await sealedAccount();
    const caller = { clientId: 'tab-1', accountId: account.accountId };
    await host.attach({
      clientId: 'tab-1',
      account,
      password: PASSWORD.slice(),
      settings: settings(),
    });
    const [stopped] = fakeEngines.started;
    let release!: () => void;
    fakeEngines.hold = new Promise(resolve => {
      release = resolve;
    });
    const reset = host.resetAccount({ ...caller, storage: 'memory' });
    await vi.waitFor(() => {
      expect(fakeEngines.started).toHaveLength(2);
    });

    const refusals = await Promise.all([
      reasonOf(host.signData({ ...caller, data: new Uint8Array([1]) })),
      reasonOf(host.submit({ ...caller, transaction: proved(stopped.engine) })),
    ]);
    release();
    await reset;

    expect(refusals).toEqual(['not-running', 'not-running']);
    expect(stopped.engine.submitTransaction).not.toHaveBeenCalled();
  });

  describe('the state view', () => {
    // The worker throttles the view; the fake clock decides when a throttled state passes.
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      fakeEngines.withholdValues = true;
    });

    // A state whose conversion to a view the test can count.
    const countedState = (value: bigint) => {
      const toHexString = vi.fn(() => 'c0');
      const state = {
        ...facadeState({ availableCoins: [nightCoin(value)] }),
        shielded: {
          coinPublicKey: { toHexString },
          encryptionPublicKey: { toHexString: () => 'e0' },
          state: { progress: { isStrictlyComplete: () => false } },
        },
      } as unknown as FacadeState;
      return { state, conversions: () => toHexString.mock.calls.length };
    };
    const valueOf = (view: MidnightEngineValue<MidnightStateView>) =>
      view.value.unshielded.availableCoins[0].utxo.value;

    const attachedTabs = async (...clientIds: string[]) => {
      const { host } = createHost();
      const account = await sealedAccount();
      for (const clientId of clientIds)
        await host.attach({
          clientId,
          account,
          password: PASSWORD.slice(),
          settings: settings(),
        });
      const viewsOf = (clientId: string) => {
        const views: MidnightEngineValue<MidnightStateView>[] = [];
        host
          .streams({ clientId, accountId: account.accountId })
          .stateView$.subscribe(view => views.push(view));
        return views;
      };
      return { host, accountId: account.accountId, viewsOf };
    };

    it('converts each state once for all the clients of the engine, which get the same view', async () => {
      const { viewsOf } = await attachedTabs('tab-1', 'tab-2');
      const [running] = fakeEngines.started;
      const first = viewsOf('tab-1');
      const second = viewsOf('tab-2');
      const { state, conversions } = countedState(5n);

      running.state$.next(state);

      expect(conversions()).toBe(1);
      expect(first).toHaveLength(1);
      expect(second).toEqual(first);
      expect(second[0]).toBe(first[0]);
    });

    it('throttles a burst of states to the first and the last', async () => {
      const { viewsOf } = await attachedTabs('tab-1');
      const [running] = fakeEngines.started;
      const views = viewsOf('tab-1');

      for (const value of [1n, 2n, 3n])
        running.state$.next(
          facadeState({ availableCoins: [nightCoin(value)] }),
        );
      const duringTheWindow = views.map(valueOf);
      vi.advanceTimersByTime(500);

      expect(duringTheWindow).toEqual([1n]);
      expect(views.map(valueOf)).toEqual([1n, 3n]);
    });

    it('gives a client that subscribes later the last view at once, without converting the state again', async () => {
      const { viewsOf } = await attachedTabs('tab-1', 'tab-2');
      const [running] = fakeEngines.started;
      const first = viewsOf('tab-1');
      const { state, conversions } = countedState(5n);
      running.state$.next(state);

      const later = viewsOf('tab-2');

      expect(later).toEqual(first);
      expect(conversions()).toBe(1);
    });

    it("switches the view to the replacement engine and lets the replaced engine's state go", async () => {
      const { host, accountId, viewsOf } = await attachedTabs('tab-1');
      const [replaced] = fakeEngines.started;
      const views = viewsOf('tab-1');
      replaced.state$.next(facadeState({ availableCoins: [nightCoin(1n)] }));

      await host.resetAccount({
        clientId: 'tab-1',
        accountId,
        storage: 'memory',
      });
      const replacement = fakeEngines.current(accountId);
      replaced.state$.next(facadeState({ availableCoins: [nightCoin(9n)] }));
      replacement.state$.next(facadeState({ availableCoins: [nightCoin(2n)] }));

      expect(replaced.state$.observed).toBe(false);
      expect(views.map(valueOf)).toEqual([1n, 2n]);
      expect(views.map(({ engineGeneration }) => engineGeneration)).toEqual([
        midnightEngineGeneration(replaced.engine),
        midnightEngineGeneration(replacement.engine),
      ]);
    });
  });

  describe('what the host keeps of closed clients and unused accounts', () => {
    it('forgets closed clients, their attaches and the channels of accounts nothing uses, once nothing can use them', async () => {
      const { host } = createHost();
      const sizes = trackHostCollections(host);
      const before = sizes();
      const accounts = [
        await sealedAccount({ walletId: 'wallet-a' }),
        await sealedAccount({ walletId: 'wallet-b' }),
      ];
      const whileOpen: ReturnType<typeof sizes>[] = [];

      for (const round of [1, 2, 3]) {
        const clientId = `tab-${round}`;
        const streams: Subscription[] = [];
        for (const account of accounts) {
          await host.attach({
            clientId,
            account,
            password: PASSWORD.slice(),
            settings: settings(),
          });
          streams.push(
            host
              .streams({ clientId, accountId: account.accountId })
              .status$.subscribe(),
          );
        }
        streams.push(
          host
            .streams({ clientId, accountId: 'never-attached' as AccountId })
            .status$.subscribe(),
        );
        whileOpen.push(sizes());
        await host.detachClient(clientId);
        // As the worker releases a closed page's streams.
        for (const stream of streams) stream.unsubscribe();
        await flush();
      }

      expect(before).toEqual({ channels: 0, attaches: 0, closedClients: 0 });
      expect(whileOpen.map(({ channels }) => channels)).toEqual([3, 3, 3]);
      expect(sizes()).toEqual(before);
    });

    it('still refuses a closed client an attach it made before it closed, also one waiting in a lane, and one it makes after', async () => {
      const { host } = createHost();
      const account = await sealedAccount();
      const request = (clientId: string) => ({
        clientId,
        account,
        password: PASSWORD.slice(),
        settings: settings(),
      });
      let release!: () => void;
      fakeEngines.hold = new Promise(resolve => {
        release = resolve;
      });
      const starting = host.attach(request('tab-2'));
      await vi.waitFor(() => {
        expect(fakeEngines.started).toHaveLength(1);
      });
      const queued = host.attach(request('tab-1'));

      await host.detachClient('tab-1');
      const afterTheClose = host.attach(request('tab-1'));
      release();

      await expect(starting).resolves.toMatchObject({
        accountId: account.accountId,
      });
      await expect(reasonOf(queued)).resolves.toBe('not-attached');
      await expect(reasonOf(afterTheClose)).resolves.toBe('not-attached');
      await expect(
        reasonOf(
          host.signData({
            clientId: 'tab-1',
            accountId: account.accountId,
            data: new Uint8Array([1]),
          }),
        ),
      ).resolves.toBe('not-attached');
    });

    it("keeps an account's reset count when its channel goes, and serves its next streams from the account's state", async () => {
      const { host } = createHost();
      const sizes = trackHostCollections(host);
      const account = await sealedAccount();
      const caller = { clientId: 'tab-1', accountId: account.accountId };
      const attach = async () =>
        host.attach({
          clientId: 'tab-1',
          account,
          password: PASSWORD.slice(),
          settings: settings(),
        });
      await attach();
      const watching = host.streams(caller).status$.subscribe();
      await host.resetAccount({ ...caller, storage: 'memory' });
      watching.unsubscribe();
      await host.detach(caller);
      const channelsAfterTheSession = sizes().channels;

      const again = await attach();

      expect(channelsAfterTheSession).toBe(0);
      expect(again.resets).toBe(1);
      await expect(
        firstValueFrom(host.streams(caller).status$),
      ).resolves.toEqual({
        engineGeneration: again.engineGeneration,
        resets: 1,
      });
    });
  });
});
