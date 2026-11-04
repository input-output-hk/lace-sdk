import {
  AccAddress,
  DeviceEpoch,
  DeviceEntryNotFoundError,
  TokenColor,
  UseCounter,
} from '@lace-contract/passport';
import { HexBytes } from '@lace-lib/util';
import { jubjub } from '@noble/curves/misc.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Contract, pureCircuits } from '../../src/acc/acc-module';
import { accountBundle } from '../../src/acc/bundle';
import { devJubjubAuthoriser } from '../../src/acc/dev-authoriser';
import {
  connectAccountHandle,
  executeGatedCall,
} from '../../src/acc/gated-call';
import { ISSUE_GRANT_CIRCUIT } from '../../src/acc/grant-circuits';
import { prepareIssueGrant } from '../../src/acc/grants';

import type { AccProviders } from '../../src/acc/deploy';
import type {
  AccountModule,
  Authorisation,
  GrantScopeInput,
} from '@lace-contract/passport';

const contractsMocks = vi.hoisted(() => ({
  findDeployedContract:
    vi.fn<
      (
        providers: unknown,
        options: { privateStateId: string },
      ) => Promise<unknown>
    >(),
}));

vi.mock('@midnight-ntwrk/midnight-js-contracts', () => contractsMocks);

const address = AccAddress('ac'.repeat(32));
const deviceEpoch = 1n;
const authNonce = 7n;
const newEntry = new Uint8Array(32).fill(3);

const commitmentFor = (counter: bigint): string =>
  counter.toString(16).padStart(64, '0');

const spendScope: GrantScopeInput = {
  grantee: {
    scheme: 'jubjub-schnorr',
    publicKey: HexBytes.fromByteArray(
      jubjub.Point.fromAffine(
        pureCircuits.compute_public_point_with_jubjub(55n),
      ).toBytes(),
    ),
  },
  operations: ['withdraw-unshielded'],
  color: TokenColor('00'.repeat(32)),
  recipient: { kind: 'any' },
  maxCoinValue: '300',
  perCallCap: '300',
  cap: '450',
  expiresAt: null,
};

/**
 * The Authorisation fields expand to the reference trailing argument
 * order: (pk, use_counter, sig_r, sig_s, grind_nonce). Sentinel values
 * keep each position distinguishable.
 */
const cannedAuthorisation: Authorisation = {
  scheme: 'jubjub-schnorr',
  pk: { x: 11n, y: 22n },
  useCounter: 2n,
  sigR: { x: 33n, y: 44n },
  sigS: 55n,
  grindNonce: 66n,
};

const createTestContext = ({ liveCounters = [2n] } = {}) => {
  const live = new Set(liveCounters.map(commitmentFor));
  const authoriser = {
    scheme: 'jubjub-schnorr' as const,
    devicePublicKey: vi.fn(),
    deviceCommitment: vi.fn(
      async (_account: unknown, _epoch: unknown, counter: bigint) =>
        commitmentFor(counter),
    ),
    authorise: vi.fn(async () => cannedAuthorisation),
  };
  const ledgerState = {
    device_epoch: deviceEpoch,
    auth_nonce: authNonce,
    devices: {
      member: vi.fn((entry: Uint8Array) =>
        live.has(HexBytes.fromByteArray(entry)),
      ),
    },
  };
  const call = vi.fn(async (): Promise<unknown> => ({ txId: 'call-tx' }));
  const handle = { callTx: { add_device_with_jubjub: call } };

  return { authoriser, ledgerState, call, handle };
};

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('executeGatedCall', () => {
  it('appends the auth args after the circuit args in the reference order', async () => {
    const context = createTestContext();

    await executeGatedCall({
      handle: context.handle,
      authoriser: context.authoriser as never,
      circuit: 'add_device_with_jubjub',
      args: [newEntry],
      address,
      ledgerState: context.ledgerState,
    });

    expect(context.call).toHaveBeenCalledExactlyOnceWith(
      newEntry,
      cannedAuthorisation.pk,
      cannedAuthorisation.useCounter,
      cannedAuthorisation.sigR,
      cannedAuthorisation.sigS,
      cannedAuthorisation.grindNonce,
    );
  });

  it('forwards the issue argument list ahead of the auth args with no witness value', async () => {
    const context = createTestContext();
    const call = vi.fn(async (): Promise<unknown> => ({ txId: 'issue-tx' }));
    const { call: issue } = prepareIssueGrant({
      contractAddress: new Uint8Array(32).fill(0xac),
      scope: spendScope,
      originHash: new Uint8Array(32).fill(0x11),
      roster: [],
    });

    await executeGatedCall({
      handle: { callTx: { [ISSUE_GRANT_CIRCUIT]: call } },
      authoriser: context.authoriser as never,
      circuit: issue.circuit,
      args: issue.args,
      address,
      ledgerState: context.ledgerState,
    });

    expect(context.authoriser.authorise).toHaveBeenCalledExactlyOnceWith({
      account: address,
      circuit: ISSUE_GRANT_CIRCUIT,
      args: issue.args,
      witnessValues: [],
      authNonce,
      useCounter: 2n,
    });
    expect(call).toHaveBeenCalledExactlyOnceWith(
      ...issue.args,
      cannedAuthorisation.pk,
      cannedAuthorisation.useCounter,
      cannedAuthorisation.sigR,
      cannedAuthorisation.sigS,
      cannedAuthorisation.grindNonce,
    );
    expect(call.mock.calls[0]).toHaveLength(23);
  });

  it('signs over the resolved counter and the observed auth nonce', async () => {
    const context = createTestContext({ liveCounters: [5n] });

    await executeGatedCall({
      handle: context.handle,
      authoriser: context.authoriser as never,
      circuit: 'add_device_with_jubjub',
      args: [newEntry],
      address,
      ledgerState: context.ledgerState,
      knownUseCounter: UseCounter(2n),
    });

    expect(context.authoriser.authorise).toHaveBeenCalledExactlyOnceWith({
      account: address,
      circuit: 'add_device_with_jubjub',
      args: [newEntry],
      witnessValues: [],
      authNonce,
      useCounter: 5n,
    });
    expect(context.authoriser.deviceCommitment).toHaveBeenNthCalledWith(
      1,
      address,
      deviceEpoch,
      2n,
    );
  });

  it('returns the advanced counter after a successful call', async () => {
    const context = createTestContext({ liveCounters: [5n] });

    await expect(
      executeGatedCall({
        handle: context.handle,
        authoriser: context.authoriser as never,
        circuit: 'add_device_with_jubjub',
        args: [newEntry],
        address,
        ledgerState: context.ledgerState,
      }),
    ).resolves.toEqual({ advancedCounter: 6n, result: undefined });
  });

  it('binds the witness values and the bundle into the authorisation of a described circuit', async () => {
    const context = createTestContext();
    const call = vi.fn(async (): Promise<unknown> => ({ txId: 'tally-tx' }));
    const heldCoin = {
      nonce: newEntry,
      color: newEntry,
      value: 5n,
      mt_index: 2n,
    };

    await executeGatedCall({
      handle: { callTx: { tally_set_with_jubjub: call } },
      authoriser: context.authoriser as never,
      circuit: 'tally_set_with_jubjub',
      args: [{ bytes: newEntry }, 7n],
      witnessValues: [heldCoin],
      bundleId: 'account-tally',
      address,
      ledgerState: context.ledgerState,
    });

    expect(context.authoriser.authorise).toHaveBeenCalledExactlyOnceWith({
      account: address,
      circuit: 'tally_set_with_jubjub',
      args: [{ bytes: newEntry }, 7n],
      witnessValues: [heldCoin],
      authNonce,
      useCounter: 2n,
      bundleId: 'account-tally',
    });
    expect(call).toHaveBeenCalledExactlyOnceWith(
      { bytes: newEntry },
      7n,
      cannedAuthorisation.pk,
      cannedAuthorisation.useCounter,
      cannedAuthorisation.sigR,
      cannedAuthorisation.sigS,
      cannedAuthorisation.grindNonce,
    );
  });

  it('reports the transaction id and the return value the finalized call carries', async () => {
    const context = createTestContext({ liveCounters: [5n] });
    context.call.mockResolvedValueOnce({
      public: { txId: 'call-tx', status: 'SucceedEntirely' },
      private: { result: 42n },
    });

    await expect(
      executeGatedCall({
        handle: context.handle,
        authoriser: context.authoriser as never,
        circuit: 'add_device_with_jubjub',
        args: [newEntry],
        address,
        ledgerState: context.ledgerState,
      }),
    ).resolves.toEqual({ advancedCounter: 6n, txId: 'call-tx', result: 42n });
  });

  it('produces a request the jubjub authoriser accepts end to end', async () => {
    const authoriser = devJubjubAuthoriser(7n);
    const commitment = await authoriser.deviceCommitment(
      address,
      DeviceEpoch(deviceEpoch),
      UseCounter(0n),
    );
    const live = new Set<string>([commitment]);
    const call = vi.fn(async () => ({ txId: 'call-tx' }));
    let authorisation: Authorisation | undefined;
    const capture = authoriser.authorise.bind(authoriser);
    authoriser.authorise = async request => {
      authorisation = await capture(request);
      return authorisation;
    };

    await executeGatedCall({
      handle: { callTx: { add_device_with_jubjub: call } },
      authoriser,
      circuit: 'add_device_with_jubjub',
      args: [newEntry],
      address,
      ledgerState: {
        device_epoch: deviceEpoch,
        auth_nonce: authNonce,
        devices: { member: entry => live.has(HexBytes.fromByteArray(entry)) },
      },
    });

    expect(authorisation).toBeDefined();
    expect(call).toHaveBeenCalledExactlyOnceWith(
      newEntry,
      authorisation?.pk,
      authorisation?.useCounter,
      authorisation?.sigR,
      authorisation?.sigS,
      authorisation?.grindNonce,
    );
    expect(authorisation?.useCounter).toBe(0n);
  });

  it('retries a dust-race rejection and resolves once the resubmission lands', async () => {
    vi.useFakeTimers();
    const context = createTestContext();
    context.call
      .mockRejectedValueOnce(new Error('DustDoubleSpend'))
      .mockResolvedValue({ txId: 'call-tx' });

    const pending = executeGatedCall({
      handle: context.handle,
      authoriser: context.authoriser as never,
      circuit: 'add_device_with_jubjub',
      args: [newEntry],
      address,
      ledgerState: context.ledgerState,
    });
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(pending).resolves.toMatchObject({ advancedCounter: 3n });
    expect(context.call).toHaveBeenCalledTimes(2);
  });

  it('returns the advanced counter when the call finalizes as succeeded', async () => {
    const context = createTestContext({ liveCounters: [5n] });
    context.call.mockResolvedValueOnce({
      public: { status: 'SucceedEntirely' },
    });

    await expect(
      executeGatedCall({
        handle: context.handle,
        authoriser: context.authoriser as never,
        circuit: 'add_device_with_jubjub',
        args: [newEntry],
        address,
        ledgerState: context.ledgerState,
      }),
    ).resolves.toMatchObject({ advancedCounter: 6n });
  });

  it.each(['FailEntirely', 'FailFallible'])(
    'rejects a call that finalizes as %s without advancing the counter',
    async status => {
      const context = createTestContext({ liveCounters: [5n] });
      context.call.mockResolvedValueOnce({ public: { status } });

      await expect(
        executeGatedCall({
          handle: context.handle,
          authoriser: context.authoriser as never,
          circuit: 'add_device_with_jubjub',
          args: [newEntry],
          address,
          ledgerState: context.ledgerState,
        }),
      ).rejects.toThrow(`Call to add_device_with_jubjub failed: "${status}"`);
      expect(context.call).toHaveBeenCalledTimes(1);
    },
  );

  it('propagates a contract abort without retrying', async () => {
    const context = createTestContext();
    context.call.mockRejectedValue(
      new Error('failed assert: invalid signature'),
    );

    await expect(
      executeGatedCall({
        handle: context.handle,
        authoriser: context.authoriser as never,
        circuit: 'add_device_with_jubjub',
        args: [newEntry],
        address,
        ledgerState: context.ledgerState,
      }),
    ).rejects.toThrow('failed assert: invalid signature');
    expect(context.call).toHaveBeenCalledTimes(1);
  });

  it('propagates an unresolvable counter before signing or calling', async () => {
    const context = createTestContext({ liveCounters: [] });

    await expect(
      executeGatedCall({
        handle: context.handle,
        authoriser: context.authoriser as never,
        circuit: 'add_device_with_jubjub',
        args: [newEntry],
        address,
        ledgerState: context.ledgerState,
      }),
    ).rejects.toThrow(DeviceEntryNotFoundError);
    expect(context.authoriser.authorise).not.toHaveBeenCalled();
    expect(context.call).not.toHaveBeenCalled();
  });

  it('rejects a circuit the handle does not expose', async () => {
    const context = createTestContext();

    await expect(
      executeGatedCall({
        handle: { callTx: {} },
        authoriser: context.authoriser as never,
        circuit: 'remove_device_with_jubjub',
        args: [newEntry],
        address,
        ledgerState: context.ledgerState,
      }),
    ).rejects.toThrow(
      "Account contract handle has no circuit 'remove_device_with_jubjub'",
    );
    expect(context.authoriser.authorise).not.toHaveBeenCalled();
  });
});

describe('connectAccountHandle', () => {
  const providers: AccProviders = {
    publicDataProvider: 'public-data',
    zkConfigProvider: 'zk-config',
    proofProvider: 'proof',
    privateStateProvider: 'private-state',
    walletProvider: 'wallet',
    midnightProvider: 'midnight',
    contractModuleProvider: 'contract-modules',
  };

  it('finds the deployed contract with the private state holding no encryption secret and no coins', async () => {
    const handle = { callTx: {} };
    contractsMocks.findDeployedContract.mockResolvedValue(handle);

    await expect(
      connectAccountHandle(providers, 'ac'.repeat(32)),
    ).resolves.toBe(handle);

    expect(contractsMocks.findDeployedContract).toHaveBeenCalledExactlyOnceWith(
      providers,
      {
        contractAddress: 'ac'.repeat(32),
        compiledContract: expect.anything() as unknown,
        privateStateId: expect.stringMatching(
          /^account-[0-9a-f]{16}$/,
        ) as string,
        initialPrivateState: { coins: {} },
      },
    );
  });

  it('scopes each connection under its own private state id', async () => {
    contractsMocks.findDeployedContract.mockResolvedValue({ callTx: {} });

    await connectAccountHandle(providers, 'ac'.repeat(32));
    await connectAccountHandle(providers, 'ac'.repeat(32));

    const [first, second] = contractsMocks.findDeployedContract.mock.calls.map(
      ([, options]) => options.privateStateId,
    );
    expect(first).not.toBe(second);
  });

  it('compiles the given bundle module and seeds the private state it is given', async () => {
    contractsMocks.findDeployedContract.mockResolvedValue({ callTx: {} });
    const module = vi.fn(
      async (): Promise<AccountModule> =>
        ({ Contract } as unknown as AccountModule),
    );
    const privateState = {
      coins: {
        ['ab'.repeat(32)]: {
          nonceHex: 'cd'.repeat(32),
          colorHex: 'ab'.repeat(32),
          value: '5',
          mtIndex: '2',
        },
      },
    };

    await connectAccountHandle(providers, 'ac'.repeat(32), {
      bundle: { ...accountBundle, id: 'account-tally', module },
      privateState,
    });

    expect(module).toHaveBeenCalledOnce();
    expect(contractsMocks.findDeployedContract).toHaveBeenCalledExactlyOnceWith(
      providers,
      expect.objectContaining({
        contractAddress: 'ac'.repeat(32),
        initialPrivateState: privateState,
      }),
    );
  });
});
