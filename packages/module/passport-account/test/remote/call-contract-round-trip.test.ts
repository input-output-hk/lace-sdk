/**
 * A contract call from a Passport account over the hosted signer, end to
 * end: the callContract flow runs over the remote authoriser through the
 * real signer client and server, the signer handlers hold the call to the
 * account-tally bundle and the Tally they pin, the passkey signs the
 * challenge the bundle module builds, and the account-tally build runs in
 * process against a Tally deployed beside it, as the ledger would. Only
 * the network infrastructure is stood in for.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { AccAddress } from '@lace-contract/passport';
import {
  accountTallyBundle,
  TALLY_SET_CIRCUIT,
  tallyCalledContract,
} from '@lace-fixture/passport-account-tally';
import { createSignerClient, serveSignerRequests } from '@lace-lib/passkey';
import { ByteArray, HexBytes } from '@lace-lib/util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { accountBundle, createBundleRegistry } from '../../src/acc/bundle';
import { devEncryptionKey } from '../../src/acc/dev-encryption-key';
import { createPassportRegistry } from '../../src/acc/registry';
import { bytesToBigIntLE, JUBJUB_R } from '../../src/acc/signer';
import { callContract } from '../../src/flows/call-contract';
import { createRemotePassportAuthoriser } from '../../src/remote/remote-authoriser';
import { createPassportSignerHandlers } from '../../src/remote/signer-handlers';
import { AccountSim, CalleeSim } from '../acc/account-sim';

import {
  createFakePasskey,
  createInMemoryStorage,
  deviceOutput,
} from './fake-passkey';
import { createWindowPair, SIGNER_URL } from './fake-windows';

import type { Ledger } from '../../src/acc/acc-module';
import type * as GatedCall from '../../src/acc/gated-call';
import type { GatedContractHandle } from '../../src/acc/gated-call';
import type { PassportRegistry } from '../../src/acc/registry';
import type {
  AccountRecords,
  FlowContext,
  PassportAccountRecord,
} from '../../src/flows/types';
import type { SimAccountModule, SimCalleeModule } from '../acc/account-sim';
import type {
  AccountBundle,
  AuthorisationRequest,
  CalledContract,
  PassportAccountInfo,
  PassportAuthoriser,
  PassportDevice,
} from '@lace-contract/passport';
import type { SignerRequest, SignerRequestHandlers } from '@lace-lib/passkey';

/** The account-tally build's ledger: the account's with the count of tally calls. */
type TallyAccountLedger = Ledger & { readonly tally_calls: bigint };

/** The Tally contract's ledger: its total and the count of writes. */
type TallyLedger = { readonly total: bigint; readonly writes: bigint };

const chain = vi.hoisted(() => ({
  sim: undefined as AccountSim<TallyAccountLedger> | undefined,
}));

const simulated = (): AccountSim<TallyAccountLedger> => {
  if (!chain.sim) throw new Error('No simulated account is deployed');
  return chain.sim;
};

vi.mock('../../src/infra/indexer', () => ({
  createIndexerClient: () => ({
    queryContractState: async () => simulated().contractState(),
  }),
}));
vi.mock('../../src/infra/providers', () => ({
  createMidnightProviders: async () => ({}),
}));
vi.mock('../../src/acc/gated-call', async importOriginal => ({
  ...(await importOriginal<typeof GatedCall>()),
  connectAccountHandle: async (): Promise<GatedContractHandle> =>
    simulated().handle(),
}));

const NETWORK_ID = 'undeployed';
const ARTEFACT_URL = 'http://artefacts.example.com';
const TALLY_ADDRESS = '7a'.repeat(32);
const OTHER_ADDRESS = '7b'.repeat(32);

const bundle = accountTallyBundle({
  artefactUrl: `${ARTEFACT_URL}/account-tally`,
  base: accountBundle,
});
const tallyContract = tallyCalledContract({
  address: TALLY_ADDRESS,
  artefactUrl: `${ARTEFACT_URL}/tally`,
});
const network = {
  networkId: NETWORK_ID,
  indexerUrl: 'http://indexer.example.com/api/v3/graphql',
  indexerWsUrl: 'ws://indexer.example.com/api/v3/graphql/ws',
  nodeUrl: 'http://node.example.com',
  artefactUrl: `${ARTEFACT_URL}/account`,
};

/** What a signer pins when it serves the account-tally build and its Tally. */
const tallyPins = createPassportRegistry({
  bundles: [bundle],
  calledContracts: [tallyContract],
});

const fixture = async (name: string): Promise<Uint8Array> =>
  new Uint8Array(
    await readFile(path.join(__dirname, '..', 'acc', 'fixtures', name)),
  );

/** The verifier keys the compiled Tally deploys with, which its module's fingerprints name. */
const tallyVerifierKeys = {
  set: await fixture('tally-set.verifier'),
  get: await fixture('tally-get.verifier'),
};

const accountModule =
  (await bundle.module()) as unknown as SimAccountModule<TallyAccountLedger>;
const tallyModule = async (): Promise<SimCalleeModule<TallyLedger>> =>
  (await tallyContract.module()) as unknown as SimCalleeModule<TallyLedger>;

/** The device scalar the fake passkey's PRF output reduces to: the signer's device. */
const passkeyScalar = (): bigint => bytesToBigIntLE(deviceOutput()) % JUBJUB_R;

const unsupported = async (): Promise<never> => {
  throw new Error('Not served by the Passport handlers.');
};

const cleanups: (() => void)[] = [];

/**
 * The remote authoriser a dApp holds over a hosted signer serving the
 * fake passkey with `pins`, through the real signer client and server,
 * with the consent requests the signer was asked.
 */
const hostedSigner = async (pins: PassportRegistry) => {
  const pair = createWindowPair();
  const passkey = createFakePasskey();
  const handlers: SignerRequestHandlers = {
    ...createPassportSignerHandlers({
      keySource: passkey.keySource,
      createKeyValueStorage: createInMemoryStorage().createKeyValueStorage,
      registry: pins,
    }),
    'sign-cardano-tx': unsupported,
    'sign-cardano-data': unsupported,
    'cardano-account-public-key': unsupported,
    'cardano-custody-public-key': unsupported,
    'sign-cardano-custody-tx': unsupported,
    'sign-cardano-custody-data': unsupported,
  };
  const onRequest = vi.fn(
    async (_request: SignerRequest, _origin: string) => 'approve' as const,
  );
  const client = createSignerClient({
    signerUrl: SIGNER_URL,
    host: pair.dappHost,
  });
  client.open();
  const stop = serveSignerRequests({
    handlers,
    assertOriginAllowed: () => undefined,
    onRequest,
    host: pair.signerHost,
  });
  cleanups.push(stop, client.close);
  await client.connect();
  return {
    get: passkey.get,
    authoriser: createRemotePassportAuthoriser(client),
    flows: () =>
      onRequest.mock.calls.map(
        ([request]) => (request.payload as { flow: unknown }).flow,
      ),
  };
};

/** Deploys the Tally and an account of the account-tally build whose initial device is the signer's passkey. */
const deploy = async () => {
  const tally = await CalleeSim.create({
    address: TALLY_ADDRESS,
    module: tallyModule,
    verifierKeys: tallyVerifierKeys,
  });
  const sim = await AccountSim.create({
    scalar: passkeyScalar(),
    module: accountModule,
    bundles: [bundle],
    callee: tally,
  });
  chain.sim = sim;
  return { tally, sim };
};

/** A record store in memory. */
const memoryRecords = (): AccountRecords => {
  let stored: PassportAccountRecord | undefined;
  return {
    read: async () => stored,
    write: async record => {
      stored = record;
    },
    presence: async () => {
      if (!stored) return 'absent';
      return stored.deployment ? 'pending' : 'complete';
    },
  };
};

/** The dApp's flow context over the remote authoriser, registering `bundles` and the network's callees. */
const contextOver = (
  authoriser: PassportAuthoriser,
  bundles: readonly AccountBundle[] = [bundle],
  calledContracts: readonly CalledContract[] = [tallyContract],
): FlowContext => ({
  seams: {
    passportAuthoriser: authoriser,
    passportEncryptionKey: devEncryptionKey(),
    passportSponsor: { balanceAndSign: vi.fn() },
    passportProver: { prove: vi.fn(), check: vi.fn() },
    passportNetwork: network,
  },
  accountRecords: memoryRecords(),
  onProgress: vi.fn(),
  rpId: 'lace.io',
  bundles: createBundleRegistry(bundles, calledContracts),
});

const accountOf = (
  sim: AccountSim<TallyAccountLedger>,
): PassportAccountInfo => ({
  address: HexBytes.fromByteArray(sim.address),
  bindingVersion: bundle.bindingVersion,
  bundleId: bundle.id,
  status: 'ready',
  networkId: NETWORK_ID,
});

/** The entry the signer's device derives at `counter` under the account's epoch. */
const localDeviceAt = (
  sim: AccountSim<TallyAccountLedger>,
  counter: bigint,
): PassportDevice => ({
  commitmentHex: HexBytes.fromByteArray(
    sim.device().entryAt(sim.address, sim.ledger().device_epoch, counter),
  ),
  isLocal: true,
});

/** What a call asks of the account: the circuit, the tally set by default, and its arguments. */
type TallyCall = { args: readonly string[]; circuit?: string };

const setTally = async (
  sim: AccountSim<TallyAccountLedger>,
  context: FlowContext,
  { args, circuit = TALLY_SET_CIRCUIT }: TallyCall,
) =>
  callContract(
    {
      account: accountOf(sim),
      devices: [localDeviceAt(sim, 0n)],
      localUseCounter: undefined,
      circuit,
      args,
    },
    context,
  );

/** The call descriptor the signer is shown for a tally set of `value`. */
const callDescriptor = (
  sim: AccountSim<TallyAccountLedger>,
  value: string,
) => ({
  kind: 'call-contract',
  account: AccAddress(HexBytes.fromByteArray(sim.address)),
  bundleId: bundle.id,
  circuit: TALLY_SET_CIRCUIT,
  args: [TALLY_ADDRESS, value],
  callees: [TALLY_ADDRESS],
});

beforeEach(() => {
  chain.sim = undefined;
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe('a contract call over the hosted signer', { timeout: 120_000 }, () => {
  it('sets the tally through the account from one approval, the signer signing the challenge the bundle module builds', async () => {
    const { tally, sim } = await deploy();
    const signer = await hostedSigner(tallyPins);
    const context = contextOver(signer.authoriser);
    const authNonce = sim.ledger().auth_nonce;

    const result = await setTally(sim, context, {
      args: [TALLY_ADDRESS, '42'],
    });

    expect(tally.ledger()).toEqual({ total: 42n, writes: 1n });
    expect(sim.ledger().tally_calls).toBe(1n);
    expect(sim.ledger().auth_nonce).toBe(authNonce + 1n);
    expect(result).toMatchObject({
      circuit: TALLY_SET_CIRCUIT,
      txId: `simulated-${TALLY_SET_CIRCUIT}`,
      devices: [localDeviceAt(sim, 1n)],
      localUseCounter: '1',
    });
    expect(signer.flows()).toEqual([callDescriptor(sim, '42')]);
    expect(signer.get).toHaveBeenCalledOnce();
    await expect(context.accountRecords.read()).resolves.toMatchObject({
      localUseCounter: '1',
    });
  });

  it('signs the approved call once: a dApp authorising twice inside the session is refused the second time and the tally is set once', async () => {
    const { tally, sim } = await deploy();
    const signer = await hostedSigner(tallyPins);
    const context = contextOver({
      ...signer.authoriser,
      authorise: async request => {
        const authorisation = await signer.authoriser.authorise(request);
        await expect(
          signer.authoriser.authorise({
            ...request,
            authNonce: request.authNonce + 1n,
          }),
        ).rejects.toMatchObject({
          name: 'RemoteSignerError',
          code: 'flow-scope',
          message:
            'The authorisation argument "call" is not what the "call-contract" flow was approved for.',
        });
        return authorisation;
      },
    });

    await expect(
      setTally(sim, context, { args: [TALLY_ADDRESS, '42'] }),
    ).resolves.toMatchObject({ circuit: TALLY_SET_CIRCUIT });

    expect(tally.ledger()).toEqual({ total: 42n, writes: 1n });
    expect(sim.ledger().tally_calls).toBe(1n);
    expect(signer.flows()).toEqual([callDescriptor(sim, '42')]);
    expect(signer.get).toHaveBeenCalledOnce();
  });

  it('refuses before any ceremony a circuit the signer does not pin, though the dApp describes it', async () => {
    const { tally, sim } = await deploy();
    const signer = await hostedSigner(tallyPins);
    const described: AccountBundle = {
      ...bundle,
      operations: [...bundle.operations, 'tally_get_with_jubjub'],
      verifierKeys: {
        ...bundle.verifierKeys,
        tally_get_with_jubjub: 'ab'.repeat(32),
      },
      circuits: {
        ...bundle.circuits,
        tally_get_with_jubjub: {
          label: 'Read the tally',
          args: [],
          challenge: 'challenge_tally_set_with_jubjub',
          challengeArgs: [],
          witnesses: [],
        },
      },
    };
    const context = contextOver(signer.authoriser, [described]);

    await expect(
      setTally(sim, context, { args: [], circuit: 'tally_get_with_jubjub' }),
    ).rejects.toMatchObject({
      name: 'RemoteSignerError',
      code: 'flow-scope',
      message:
        'The descriptor field "circuit" of the "call-contract" flow is outside what this signer pins.',
    });
    expect(signer.get).not.toHaveBeenCalled();
    expect(tally.ledger()).toEqual({ total: 0n, writes: 0n });
    expect(sim.ledger().tally_calls).toBe(0n);
  });

  it('refuses before any ceremony a callee the signer does not pin, though the dApp registers it', async () => {
    const { tally, sim } = await deploy();
    const signer = await hostedSigner(
      createPassportRegistry({ bundles: [bundle] }),
    );
    const context = contextOver(signer.authoriser);

    await expect(
      setTally(sim, context, { args: [TALLY_ADDRESS, '42'] }),
    ).rejects.toMatchObject({
      name: 'RemoteSignerError',
      code: 'flow-scope',
      message:
        'The descriptor field "callees" of the "call-contract" flow is outside what this signer pins.',
    });
    expect(signer.get).not.toHaveBeenCalled();
    expect(tally.ledger()).toEqual({ total: 0n, writes: 0n });
    expect(sim.ledger().tally_calls).toBe(0n);
  });

  it.each<
    [string, (request: AuthorisationRequest) => AuthorisationRequest, string]
  >([
    [
      'arguments other than the approved ones',
      request => ({ ...request, args: [...request.args.slice(0, 1), 43n] }),
      'args[1]',
    ],
    [
      'another callee than the approved one',
      request => ({
        ...request,
        args: [
          { bytes: ByteArray.fromHex(HexBytes(OTHER_ADDRESS)) },
          ...request.args.slice(1),
        ],
      }),
      'args[0]',
    ],
    [
      'another bundle than the approved one',
      request => ({ ...request, bundleId: 'account' }),
      'bundleId',
    ],
  ])(
    'refuses an authorisation naming %s inside the approved session, leaving the tally untouched',
    async (_case, stray, argument) => {
      const { tally, sim } = await deploy();
      const signer = await hostedSigner(tallyPins);
      const context = contextOver({
        ...signer.authoriser,
        authorise: async request => signer.authoriser.authorise(stray(request)),
      });
      const authNonce = sim.ledger().auth_nonce;

      await expect(
        setTally(sim, context, { args: [TALLY_ADDRESS, '42'] }),
      ).rejects.toMatchObject({
        name: 'RemoteSignerError',
        code: 'flow-scope',
        message: `The authorisation argument "${argument}" is not what the "call-contract" flow was approved for.`,
      });
      expect(signer.flows()).toEqual([callDescriptor(sim, '42')]);
      expect(tally.ledger()).toEqual({ total: 0n, writes: 0n });
      expect(sim.ledger().tally_calls).toBe(0n);
      expect(sim.ledger().auth_nonce).toBe(authNonce);
    },
  );
});
