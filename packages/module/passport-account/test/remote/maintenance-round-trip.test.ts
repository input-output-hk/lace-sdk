/**
 * The maintenance authority of an unlocked account over the hosted
 * signer, end to end: the real flows run over an Account Custody
 * Contract executed in process, with a development device that creates
 * the account and a passkey served by the signer handlers through the
 * real signer client and server. The passkey device installs missing
 * operations, removes the creating device, which moves the authority to
 * the fresh roster key, and installs again under the moved authority; a
 * removal over an authority no roster key of the device derives is
 * refused before its rotation. An account of a second registered build
 * installs the operations of its roster under that build.
 * Only the network infrastructure is stood in for, and the verifier
 * keys are one fixture pinned for every operation of the default build,
 * with a second one for the operation the other build adds.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  AccBindingVersion,
  MaintenanceAuthorityMismatchError,
} from '@lace-contract/passport';
import { sha256 } from '@lace-lib/crypto';
import { createSignerClient, serveSignerRequests } from '@lace-lib/passkey';
import { ByteArray, HexBytes } from '@lace-lib/util';
import * as ledgerV9 from '@midnightntwrk/ledger-v9';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createBundleRegistry } from '../../src/acc/bundle';
import { DEPLOYED_OPERATIONS } from '../../src/acc/deployed-operations';
import { devJubjubAuthoriser } from '../../src/acc/dev-authoriser';
import { devEncryptionKey } from '../../src/acc/dev-encryption-key';
import { deviceEntryOf } from '../../src/acc/device-readers';
import { encodeDevicePublicKey } from '../../src/acc/envelopes';
import { GRANTEE_WITHDRAWAL_CIRCUITS } from '../../src/acc/grant-circuits';
import { accManifest } from '../../src/acc/manifest';
import { createPassportRegistry } from '../../src/acc/registry';
import { randomJubjubScalar } from '../../src/acc/signer';
import { createPasskeyEncryptionKey } from '../../src/ceremony/encryption-key';
import { createPasskeyAuthoriser } from '../../src/ceremony/passkey';
import { createAccount } from '../../src/flows/create-account';
import { addDevice, removeDevice } from '../../src/flows/devices';
import { installOperations } from '../../src/flows/install-operations';
import { signIn } from '../../src/flows/sign-in';
import { createRemotePassportAuthoriser } from '../../src/remote/remote-authoriser';
import { createRemoteEncryptionKey } from '../../src/remote/remote-encryption-key';
import { createPassportSignerHandlers } from '../../src/remote/signer-handlers';
import { AccountSim } from '../acc/account-sim';

import { createFakePasskey, createInMemoryStorage } from './fake-passkey';
import { createWindowPair, SIGNER_URL } from './fake-windows';

import type * as AccModule from '../../src/acc/acc-module';
import type * as Deploy from '../../src/acc/deploy';
import type * as GatedCall from '../../src/acc/gated-call';
import type { GatedContractHandle } from '../../src/acc/gated-call';
import type * as AccountCall from '../../src/flows/account-call';
import type {
  AccountRecords,
  FlowContext,
  PassportAccountRecord,
} from '../../src/flows/types';
import type {
  AccountBundle,
  MaintenanceVerifyingKey,
  PassportAuthoriser,
  PassportEncryptionKey,
} from '@lace-contract/passport';
import type { SignerRequest, SignerRequestHandlers } from '@lace-lib/passkey';

const pins = vi.hoisted(() => ({ expectedVk: {} as Record<string, string> }));

const chain = vi.hoisted(() => ({
  sim: undefined as AccountSim | undefined,
  scalar: 0n,
  operations: [] as string[],
  /** The sha256 of the verifier key the chain holds for each operation. */
  verifierKeys: {} as Record<string, string>,
  committee: undefined as MaintenanceVerifyingKey[] | undefined,
  updates: [] as ledgerV9.MaintenanceUpdate[],
}));

const simulated = (): AccountSim => {
  if (!chain.sim) throw new Error('No simulated account is deployed');
  return chain.sim;
};

const COUNTER_OPERATION = 'counter_bump_with_jubjub';
const COUNTER_BUNDLE_ID = 'account-counter';

/**
 * A verifier key the pinned compiler line emits, standing in for every
 * operation's: the test pins its digest for the whole deployed roster.
 */
const verifierKey = new Uint8Array(
  await readFile(
    path.join(__dirname, '..', 'acc', 'fixtures', 'counter-bump.verifier'),
  ),
);
for (const operation of DEPLOYED_OPERATIONS) {
  pins.expectedVk[operation] = HexBytes.fromByteArray(sha256(verifierKey));
}
/** Another key under the same header: what the counter build pins for its own operation. */
const counterKey = verifierKey.slice();
counterKey[counterKey.length - 1] ^= 1;
const COUNTER_PIN = HexBytes.fromByteArray(sha256(counterKey));

/**
 * A build of the account with one more operation, pinning its own
 * verifier key for it. Its module is the default build's, which the
 * simulation runs and whose decoder reads the simulated ledger.
 */
const counterBundle: AccountBundle = {
  id: COUNTER_BUNDLE_ID,
  bindingVersion: AccBindingVersion('0.1.0-counter.1'),
  module: async () => import('../../src/acc/acc-module'),
  manifest: {
    ...accManifest,
    bindingVersion: AccBindingVersion('0.1.0-counter.1'),
  },
  operations: [...DEPLOYED_OPERATIONS, COUNTER_OPERATION],
  verifierKeys: { ...pins.expectedVk, [COUNTER_OPERATION]: COUNTER_PIN },
  constructorArgs: [],
  circuits: {},
};

vi.mock('../../src/acc/acc-module', async importOriginal => ({
  ...(await importOriginal<typeof AccModule>()),
  expectedVk: pins.expectedVk,
}));
vi.mock('../../src/infra/indexer', () => ({
  createIndexerClient: () => ({
    queryContractState: async () => simulated().contractState(),
    enumerateContractActions: async () => [],
    queryShieldedOutputs: async () => [],
  }),
}));
vi.mock('../../src/flows/account-call', async importOriginal => ({
  ...(await importOriginal<typeof AccountCall>()),
  queryAccountVerifierKeys: async () =>
    new Map(
      simulated()
        .contractState()
        .operations()
        .flatMap(operation => {
          const hash = chain.verifierKeys[operation];
          return hash ? [[operation, hash] as const] : [];
        }),
    ),
}));
vi.mock('../../src/infra/providers', () => ({
  createMidnightProviders: async () => ({
    zkConfigProvider: {
      getVerifierKey: async (operation: string) =>
        operation === COUNTER_OPERATION ? counterKey : verifierKey,
    },
  }),
}));
vi.mock('../../src/acc/gated-call', async importOriginal => ({
  ...(await importOriginal<typeof GatedCall>()),
  connectAccountHandle: async (): Promise<GatedContractHandle> =>
    simulated().handle(),
}));
vi.mock('../../src/acc/deploy', async importOriginal => ({
  ...(await importOriginal<typeof Deploy>()),
  deployAccount: async ({
    encPublicKey,
    lockAccount,
    handoverAuthority,
    onDeployed,
  }: {
    encPublicKey: Uint8Array;
    lockAccount: boolean;
    handoverAuthority: MaintenanceVerifyingKey;
    onDeployed: (address: string, pending: unknown) => Promise<void>;
  }) => {
    chain.sim = await AccountSim.create({
      encKey: encPublicKey,
      scalar: chain.scalar,
      operations: chain.operations,
      committee: chain.committee ?? (lockAccount ? [] : [handoverAuthority]),
    });
    const address = HexBytes.fromByteArray(chain.sim.address);
    await onDeployed(address, {
      operations: [],
      lockAccount,
      verifierKeysDigest: '00'.repeat(32),
      saltHex: '00'.repeat(32),
      authorityKey: { tag: 'schnorr', value: '00' },
      handoverAuthority,
    });
    return {
      address,
      salt: new Uint8Array(32),
      isActivated: true,
      activate: async () => undefined,
    };
  },
  resumeAccountDeployment: async () => {
    throw new Error('No deployment is resumed here');
  },
  readMaintenanceAuthority: async () => simulated().maintenanceAuthority(),
  submitMaintenanceUpdate: async ({
    update,
    signature,
  }: {
    update: ledgerV9.MaintenanceUpdate;
    signature: ledgerV9.Signature;
  }) => {
    simulated().maintain(update.addSignature(0n, signature));
    chain.updates.push(update);
  },
}));

const network = {
  networkId: 'undeployed',
  indexerUrl: 'http://indexer.example.com/api/v3/graphql',
  indexerWsUrl: 'ws://indexer.example.com/api/v3/graphql/ws',
  nodeUrl: 'http://node.example.com',
  artefactUrl: 'http://artefacts.example.com/account',
};

const K256_WITHDRAWALS = GRANTEE_WITHDRAWAL_CIRCUITS['secp256k1-ecdsa'];

/** The flow context of a device over its two key seams, with its own record store. */
const contextOver = (
  passportAuthoriser: PassportAuthoriser,
  passportEncryptionKey: PassportEncryptionKey,
) => {
  let stored: PassportAccountRecord | undefined;
  const accountRecords: AccountRecords = {
    read: async () => stored,
    write: async record => {
      stored = record;
    },
    presence: async () => {
      if (!stored) return 'absent';
      return stored.deployment ? 'pending' : 'complete';
    },
  };
  const context: FlowContext = {
    seams: {
      passportAuthoriser,
      passportEncryptionKey,
      passportSponsor: { balanceAndSign: vi.fn() },
      passportProver: { prove: vi.fn(), check: vi.fn() },
      passportNetwork: network,
    },
    accountRecords,
    onProgress: vi.fn(),
    rpId: 'lace.io',
    bundles: createBundleRegistry([counterBundle]),
  };
  return {
    context,
    adopt: (record: PassportAccountRecord) => {
      stored = record;
    },
  };
};

const unsupported = async (): Promise<never> => {
  throw new Error('Not served by the Passport handlers.');
};

const cleanups: (() => void)[] = [];

/**
 * The seams a dApp holds over the hosted signer serving `passkey`,
 * through the real signer client and server, with the consent requests
 * the signer was asked. The signer pins the counter build beside the
 * default, as the module registers it.
 */
const hostedSigner = async (passkey: ReturnType<typeof createFakePasskey>) => {
  const pair = createWindowPair();
  const handlers: SignerRequestHandlers = {
    ...createPassportSignerHandlers({
      keySource: passkey.keySource,
      createKeyValueStorage: createInMemoryStorage().createKeyValueStorage,
      registry: createPassportRegistry({ bundles: [counterBundle] }),
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
    authoriser: createRemotePassportAuthoriser(client),
    encryptionKey: createRemoteEncryptionKey(client),
    flows: () =>
      onRequest.mock.calls.map(
        ([request]) =>
          (
            request.payload as {
              flow: { kind: string; operations?: string[]; bundleId?: string };
            }
          ).flow,
      ),
  };
};

/** The operations each submitted verifier key install inserts. */
const insertedPerUpdate = (): string[][] =>
  chain.updates
    .filter(update =>
      update.updates.every(
        single => single instanceof ledgerV9.VerifierKeyInsert,
      ),
    )
    .map(update =>
      update.updates.map(single =>
        String((single as ledgerV9.VerifierKeyInsert).operation),
      ),
    );

beforeEach(() => {
  chain.sim = undefined;
  chain.committee = undefined;
  chain.updates = [];
  chain.operations = DEPLOYED_OPERATIONS.filter(
    operation => !K256_WITHDRAWALS.includes(operation),
  );
  chain.verifierKeys = { ...pins.expectedVk };
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/**
 * An unlocked account a development device created, from the bundle
 * `bundleId` names or the default, with a passkey device enrolled through
 * it with the account keys and signed in over the hosted signer.
 */
const enrolledOverSigner = async (bundleId?: string) => {
  const scalar = randomJubjubScalar();
  chain.scalar = scalar;
  const first = contextOver(
    devJubjubAuthoriser(scalar),
    devEncryptionKey(
      undefined,
      createPassportRegistry({ bundles: [counterBundle] }),
    ),
  );
  const created = await createAccount(
    { lockAccount: false, ...(bundleId === undefined ? {} : { bundleId }) },
    first.context,
  );
  const { account } = created;
  const passkey = createFakePasskey();
  const local = createPasskeyAuthoriser({ keySource: passkey.keySource });
  const signer = await hostedSigner(passkey);
  const hosted = contextOver(signer.authoriser, signer.encryptionKey);
  const devicePublicKey = encodeDevicePublicKey(await local.devicePublicKey());
  const readerPublicKey = await createPasskeyEncryptionKey(
    passkey.keySource,
  ).readerPublicKey(network.networkId);
  await addDevice(
    {
      account,
      devices: created.devices,
      localUseCounter: created.localUseCounter,
      commitmentHex: deviceEntryOf(
        {
          address: account.address,
          epoch: simulated().ledger().device_epoch,
        },
        devicePublicKey,
        0n,
      )!,
      reader: {
        readerPublicKey: HexBytes.fromByteArray(readerPublicKey),
        devicePublicKey,
      },
    },
    first.context,
  );
  hosted.adopt({
    address: account.address,
    bindingVersion: account.bindingVersion,
    localUseCounter: '0',
  });
  const signedIn = await signIn(hosted.context);
  return { account, signer, hosted, signedIn };
};

describe(
  'the maintenance authority over the hosted signer',
  { timeout: 60_000 },
  () => {
    it('installs missing operations, moves the authority on a removal and installs the rest under the moved authority, skipping the operation already installed', async () => {
      expect(K256_WITHDRAWALS.length).toBeGreaterThan(1);
      const { account, signer, hosted, signedIn } = await enrolledOverSigner();
      const handedOver = simulated().maintenanceAuthority();
      expect(handedOver.committee).toHaveLength(1);

      const [firstOperation, ...laterOperations] = K256_WITHDRAWALS;
      await expect(
        installOperations(
          { account, operations: [firstOperation] },
          hosted.context,
        ),
      ).resolves.toEqual({
        operations: [firstOperation],
        alreadyInstalled: [],
      });
      expect(simulated().maintenanceAuthority()).toEqual({
        ...handedOver,
        counter: handedOver.counter + 1n,
      });

      await removeDevice(
        {
          account,
          devices: signedIn.devices,
          localUseCounter: signedIn.localUseCounter,
          commitmentHex: signedIn.devices.find(row => !row.isLocal)!
            .commitmentHex,
        },
        hosted.context,
      );
      const moved = simulated().maintenanceAuthority();
      expect(moved.committee).toHaveLength(1);
      expect(moved.committee).not.toEqual(handedOver.committee);
      expect(moved.counter).toBe(handedOver.counter + 2n);

      await expect(
        installOperations(
          { account, operations: K256_WITHDRAWALS },
          hosted.context,
        ),
      ).resolves.toEqual({
        operations: laterOperations,
        alreadyInstalled: [firstOperation],
      });
      expect(simulated().maintenanceAuthority().committee).toEqual(
        moved.committee,
      );
      expect(insertedPerUpdate().flat()).toEqual(K256_WITHDRAWALS);
      expect(
        signer.flows().filter(flow => flow.kind === 'install-operations'),
      ).toEqual([
        {
          kind: 'install-operations',
          account: account.address,
          operations: [firstOperation],
        },
        {
          kind: 'install-operations',
          account: account.address,
          operations: laterOperations,
        },
      ]);
    });

    it('installs on an account of the counter build the operations its roster lacks, under that build', async () => {
      chain.operations = [...chain.operations, COUNTER_OPERATION];
      chain.verifierKeys[COUNTER_OPERATION] = COUNTER_PIN;
      const { account, signer, hosted } = await enrolledOverSigner(
        COUNTER_BUNDLE_ID,
      );
      expect(account.bundleId).toBe(COUNTER_BUNDLE_ID);

      await expect(
        installOperations(
          { account, operations: K256_WITHDRAWALS },
          hosted.context,
        ),
      ).resolves.toEqual({
        operations: K256_WITHDRAWALS,
        alreadyInstalled: [],
      });

      expect(insertedPerUpdate().flat()).toEqual(K256_WITHDRAWALS);
      expect(
        signer.flows().filter(flow => flow.kind === 'install-operations'),
      ).toEqual([
        {
          kind: 'install-operations',
          account: account.address,
          operations: K256_WITHDRAWALS,
          bundleId: COUNTER_BUNDLE_ID,
        },
      ]);
    });

    it('refuses a removal over an authority no roster key of the device derives before its rotation, after one prompt', async () => {
      const stranger = await devEncryptionKey().createKeys(network.networkId, {
        devicePublicKey: 'd1'.repeat(32),
      });
      chain.committee = [stranger.authority];
      const { account, signer, hosted, signedIn } = await enrolledOverSigner();
      const before = simulated().ledger();
      const target = signedIn.devices.find(row => !row.isLocal)!;

      await expect(
        removeDevice(
          {
            account,
            devices: signedIn.devices,
            localUseCounter: signedIn.localUseCounter,
            commitmentHex: target.commitmentHex,
          },
          hosted.context,
        ),
      ).rejects.toBeInstanceOf(MaintenanceAuthorityMismatchError);

      const after = simulated().ledger();
      expect(after.enc_key).toEqual(before.enc_key);
      expect(after.inbox_count).toBe(before.inbox_count);
      expect(
        after.devices.member(ByteArray.fromHex(HexBytes(target.commitmentHex))),
      ).toBe(true);
      expect(chain.updates).toEqual([]);
      expect(simulated().maintenanceAuthority().committee).toEqual([
        stranger.authority,
      ]);
      expect(
        signer.flows().filter(flow => flow.kind === 'remove-device'),
      ).toHaveLength(1);
    });
  },
);
