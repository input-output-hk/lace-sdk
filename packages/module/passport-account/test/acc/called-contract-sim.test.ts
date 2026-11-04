/**
 * An account of the account-tally build calling the Tally contract in
 * process: the callContract flow runs over the module's own authoriser and
 * gated call against the generated account-tally module, and the account's
 * circuit reaches the Tally through the compact runtime's own
 * cross-contract resolution, a module provider and a state provider for
 * the callee, as midnight-js hands them to the runtime on chain. The
 * runtime checks the callee module against the keys the deployed state
 * holds and against the contract type the account declares, the callee's
 * circuit runs on its own state, and the account's authorisation gates
 * the call exactly as the ledger would. A runtime refusal is matched by
 * instanceof against this package's compact runtime, which holds only
 * when the generated fixture modules and the module's own code load the
 * one runtime instance the vitest config dedupes them to.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  AccAddress,
  CallArgumentInvalidError,
  CalledContractNotRegisteredError,
  CircuitNotRegisteredError,
  NotAuthorisedError,
} from '@lace-contract/passport';
import {
  accountTallyBundle,
  TALLY_SET_CIRCUIT,
  tallyCalledContract,
} from '@lace-fixture/passport-account-tally';
import { sha256 } from '@lace-lib/crypto';
import { ByteArray, HexBytes } from '@lace-lib/util';
import { ModuleResolutionError } from '@midnight-ntwrk/compact-runtime';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { accountBundle, createBundleRegistry } from '../../src/acc/bundle';
import { devEncryptionKey } from '../../src/acc/dev-encryption-key';
import { bytesToBigIntLE, JUBJUB_R } from '../../src/acc/signer';
import { callContract } from '../../src/flows/call-contract';

import { AccountSim, CalleeSim } from './account-sim';

import type { SimAccountModule, SimCalleeModule } from './account-sim';
import type { Ledger } from '../../src/acc/acc-module';
import type * as GatedCall from '../../src/acc/gated-call';
import type { GatedContractHandle } from '../../src/acc/gated-call';
import type { ContractCallResult } from '../../src/flows/call-contract';
import type {
  AccountRecords,
  FlowContext,
  PassportAccountRecord,
} from '../../src/flows/types';
import type {
  KeySessionFlow,
  PassportAccountInfo,
  PassportAuthoriser,
  PassportDevice,
} from '@lace-contract/passport';

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

const NETWORK = 'undeployed';
const ARTEFACT_URL = 'http://artefacts.example.com';
const TALLY_ADDRESS = '7a'.repeat(32);
const OTHER_TALLY_ADDRESS = '7b'.repeat(32);
const UNREGISTERED_ADDRESS = '11'.repeat(32);

/** Signing attempts the redirected-call case grants before it gives up. */
const MAX_SIGNING_ATTEMPTS = 1000;
const UINT64_MAX = '18446744073709551615';

const bundle = accountTallyBundle({
  artefactUrl: `${ARTEFACT_URL}/account-tally`,
  base: accountBundle,
});
const tallyContract = tallyCalledContract({
  address: TALLY_ADDRESS,
  artefactUrl: `${ARTEFACT_URL}/tally`,
});
/** A second registered Tally, which the sim never deploys. */
const otherTallyContract = tallyCalledContract({
  address: OTHER_TALLY_ADDRESS,
  artefactUrl: `${ARTEFACT_URL}/other-tally`,
});
const network = {
  networkId: NETWORK,
  indexerUrl: 'http://indexer.example.com/api/v3/graphql',
  indexerWsUrl: 'ws://indexer.example.com/api/v3/graphql/ws',
  nodeUrl: 'http://node.example.com',
  artefactUrl: `${ARTEFACT_URL}/account`,
};
const calledContracts = [tallyContract, otherTallyContract];

const fixture = async (name: string): Promise<Uint8Array> =>
  new Uint8Array(await readFile(path.join(__dirname, 'fixtures', name)));

/** The verifier keys the compiled Tally deploys with, which its module's fingerprints name. */
const tallyVerifierKeys = {
  set: await fixture('tally-set.verifier'),
  get: await fixture('tally-get.verifier'),
};
/** A verifier key of another contract, which no Tally module fingerprint names. */
const foreignVerifierKey = await fixture('counter-bump.verifier');

const accountModule =
  (await bundle.module()) as unknown as SimAccountModule<TallyAccountLedger>;
const tallyModule = async (): Promise<SimCalleeModule<TallyLedger>> =>
  (await tallyContract.module()) as unknown as SimCalleeModule<TallyLedger>;

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

const withKeySession = vi.fn(
  async (operation: () => Promise<unknown>, _flow?: KeySessionFlow) =>
    operation(),
);

/** The Tally module with its `set` taking a narrower integer than the account's Tally contract type declares. */
const narrowSetTallyModule = async (): Promise<
  SimCalleeModule<TallyLedger>
> => {
  const loaded = await tallyModule();
  return {
    ...loaded,
    circuitSignatures: {
      ...loaded.circuitSignatures,
      set: {
        ...loaded.circuitSignatures.set,
        argumentTypes: [{ tag: 'Uint', maxval: '255' }],
      },
    },
  };
};

/** Deploys the Tally with `verifierKeys` and an account of the account-tally build calling it. */
const deploy = async (
  verifierKeys = tallyVerifierKeys,
  module = tallyModule,
) => {
  const tally = await CalleeSim.create({
    address: TALLY_ADDRESS,
    module,
    verifierKeys,
  });
  const sim = await AccountSim.create({
    module: accountModule,
    bundles: [bundle],
    callee: tally,
  });
  chain.sim = sim;
  return { tally, sim };
};

/** The owner's device as a flow runs under it: the sim's authoriser inside a key session. */
const contextOver = (authoriser: PassportAuthoriser) => {
  const accountRecords = memoryRecords();
  const context: FlowContext = {
    seams: {
      passportAuthoriser: {
        ...authoriser,
        withKeySession: withKeySession as PassportAuthoriser['withKeySession'],
      },
      passportEncryptionKey: devEncryptionKey(),
      passportSponsor: { balanceAndSign: vi.fn() },
      passportProver: { prove: vi.fn(), check: vi.fn() },
      passportNetwork: network,
    },
    accountRecords,
    onProgress: vi.fn(),
    rpId: 'lace.io',
    bundles: createBundleRegistry([bundle], calledContracts),
  };
  return { context, accountRecords };
};

const accountOf = (
  sim: AccountSim<TallyAccountLedger>,
): PassportAccountInfo => ({
  address: HexBytes.fromByteArray(sim.address),
  bindingVersion: bundle.bindingVersion,
  bundleId: bundle.id,
  status: 'ready',
  networkId: NETWORK,
});

/** The entry the sim's device derives at `counter` under the account's epoch. */
const entryAt = (
  sim: AccountSim<TallyAccountLedger>,
  counter: bigint,
): string =>
  HexBytes.fromByteArray(
    sim.device().entryAt(sim.address, sim.ledger().device_epoch, counter),
  );

const localDeviceAt = (
  sim: AccountSim<TallyAccountLedger>,
  counter: bigint,
): PassportDevice => ({ commitmentHex: entryAt(sim, counter), isLocal: true });

/**
 * What a call sets the tally with: its arguments and, after a first call,
 * where that call left the device; the device starts at its first entry
 * otherwise.
 */
type TallyCall = {
  args: readonly string[];
  from?: Pick<ContractCallResult, 'devices' | 'localUseCounter'>;
};

const setTally = async (
  sim: AccountSim<TallyAccountLedger>,
  context: FlowContext,
  { args, from }: TallyCall,
): Promise<ContractCallResult> =>
  callContract(
    {
      account: accountOf(sim),
      devices: from?.devices ?? [localDeviceAt(sim, 0n)],
      localUseCounter: from?.localUseCounter,
      circuit: TALLY_SET_CIRCUIT,
      args,
    },
    context,
  );

describe(
  'an account of the account-tally build calling the Tally in process',
  { timeout: 120_000 },
  () => {
    beforeEach(() => {
      vi.clearAllMocks();
      chain.sim = undefined;
    });

    it('deploys the Tally with the keys its module fingerprints, so the runtime accepts the module for the deployed contract', async () => {
      const loaded = await tallyModule();

      expect(HexBytes.fromByteArray(sha256(tallyVerifierKeys.set))).toBe(
        loaded.expectedVk.set,
      );
      expect(HexBytes.fromByteArray(sha256(tallyVerifierKeys.get))).toBe(
        loaded.expectedVk.get,
      );
    });

    it('sets the tally through the account, advancing the callee, the account auth nonce and its device entry in one call, and again from where that call left it', async () => {
      const { tally, sim } = await deploy();
      const { context, accountRecords } = contextOver(sim.authoriser);
      const authNonce = sim.ledger().auth_nonce;

      const first = await setTally(sim, context, {
        args: [TALLY_ADDRESS, '42'],
      });

      expect(tally.ledger()).toEqual({ total: 42n, writes: 1n });
      expect(sim.ledger().tally_calls).toBe(1n);
      expect(sim.ledger().auth_nonce).toBe(authNonce + 1n);
      expect(
        sim
          .ledger()
          .devices.member(ByteArray.fromHex(HexBytes(entryAt(sim, 0n)))),
      ).toBe(false);
      expect(
        sim
          .ledger()
          .devices.member(ByteArray.fromHex(HexBytes(entryAt(sim, 1n)))),
      ).toBe(true);
      expect(first).toEqual({
        circuit: TALLY_SET_CIRCUIT,
        txId: `simulated-${TALLY_SET_CIRCUIT}`,
        devices: [localDeviceAt(sim, 1n)],
        localUseCounter: '1',
      });
      expect(withKeySession).toHaveBeenCalledExactlyOnceWith(
        expect.any(Function),
        {
          kind: 'call-contract',
          account: AccAddress(HexBytes.fromByteArray(sim.address)),
          bundleId: bundle.id,
          circuit: TALLY_SET_CIRCUIT,
          args: [TALLY_ADDRESS, '42'],
          callees: [TALLY_ADDRESS],
        },
      );
      await expect(accountRecords.read()).resolves.toMatchObject({
        address: HexBytes.fromByteArray(sim.address),
        localUseCounter: '1',
      });

      const second = await setTally(sim, context, {
        args: [TALLY_ADDRESS, '7'],
        from: first,
      });

      expect(tally.ledger()).toEqual({ total: 7n, writes: 2n });
      expect(sim.ledger().tally_calls).toBe(2n);
      expect(sim.ledger().auth_nonce).toBe(authNonce + 2n);
      expect(second.localUseCounter).toBe('2');
      expect(second.devices).toEqual([localDeviceAt(sim, 2n)]);
    });

    it('is refused by the contract on a tampered signature, as on chain, leaving the Tally and the account untouched', async () => {
      const { tally, sim } = await deploy();
      const tampered: PassportAuthoriser = {
        ...sim.authoriser,
        authorise: async request => {
          const authorisation = await sim.authoriser.authorise(request);
          return { ...authorisation, sigS: authorisation.sigS + 1n };
        },
      };
      const { context, accountRecords } = contextOver(tampered);
      const authNonce = sim.ledger().auth_nonce;

      const call = setTally(sim, context, { args: [TALLY_ADDRESS, '42'] });

      await expect(call).rejects.toBeInstanceOf(NotAuthorisedError);
      await expect(call).rejects.toThrow('invalid signature');
      expect(tally.ledger()).toEqual({ total: 0n, writes: 0n });
      expect(sim.ledger().tally_calls).toBe(0n);
      expect(sim.ledger().auth_nonce).toBe(authNonce);
      await expect(accountRecords.read()).resolves.toBeUndefined();
    });

    it('is refused by the contract when a call signed over one registered Tally is dispatched to another, since the challenge binds the callee the call reaches', async () => {
      const { tally, sim } = await deploy();
      const { pureCircuits } = await bundle.module();
      const challengeOver = pureCircuits.challenge_tally_set_with_jubjub as (
        ...values: unknown[]
      ) => Uint8Array;
      const deployedTally = {
        bytes: ByteArray.fromHex(HexBytes(TALLY_ADDRESS)),
      };
      /**
       * Signs over the deployed Tally, retrying until the digest the
       * contract recomputes over the dispatched Tally is a field element
       * under the signed grind nonce, so the signature check itself is
       * what refuses the call rather than the cast of the challenge.
       */
      const signedOverDeployedTally: PassportAuthoriser = {
        ...sim.authoriser,
        authorise: async request => {
          for (let attempt = 0; attempt < MAX_SIGNING_ATTEMPTS; attempt++) {
            const authorisation = await sim.authoriser.authorise({
              ...request,
              args: [deployedTally, ...request.args.slice(1)],
            });
            const recomputed = challengeOver(
              { bytes: sim.address },
              authorisation.sigR,
              authorisation.pk,
              ...request.args,
              request.authNonce,
              authorisation.grindNonce,
            );
            if (bytesToBigIntLE(recomputed) < JUBJUB_R) return authorisation;
          }
          throw new Error(
            'No signature left the redirected challenge a field element.',
          );
        },
      };
      const { context, accountRecords } = contextOver(signedOverDeployedTally);
      const authNonce = sim.ledger().auth_nonce;

      const call = setTally(sim, context, {
        args: [OTHER_TALLY_ADDRESS, '42'],
      });

      await expect(call).rejects.toBeInstanceOf(NotAuthorisedError);
      await expect(call).rejects.toThrow('invalid signature');
      expect(withKeySession).toHaveBeenCalledExactlyOnceWith(
        expect.any(Function),
        expect.objectContaining({ callees: [OTHER_TALLY_ADDRESS] }),
      );
      expect(tally.ledger()).toEqual({ total: 0n, writes: 0n });
      expect(sim.ledger().tally_calls).toBe(0n);
      expect(sim.ledger().auth_nonce).toBe(authNonce);
      await expect(accountRecords.read()).resolves.toBeUndefined();
    });

    it('refuses before any prompt a value outside the descriptor, a callee the registry does not hold and a circuit the bundle does not describe', async () => {
      const { tally, sim } = await deploy();
      const { context } = contextOver(sim.authoriser);

      await expect(
        setTally(sim, context, { args: [TALLY_ADDRESS, `${UINT64_MAX}0`] }),
      ).rejects.toBeInstanceOf(CallArgumentInvalidError);
      await expect(
        setTally(sim, context, { args: [UNREGISTERED_ADDRESS, '1'] }),
      ).rejects.toBeInstanceOf(CalledContractNotRegisteredError);
      await expect(
        callContract(
          {
            account: accountOf(sim),
            devices: [localDeviceAt(sim, 0n)],
            localUseCounter: undefined,
            circuit: 'tally_get_with_jubjub',
            args: [],
          },
          context,
        ),
      ).rejects.toBeInstanceOf(CircuitNotRegisteredError);
      expect(withKeySession).not.toHaveBeenCalled();
      expect(tally.ledger()).toEqual({ total: 0n, writes: 0n });
      expect(sim.ledger().tally_calls).toBe(0n);
    });

    it('is refused by the runtime, in the one runtime the account and the callee share, when the deployed Tally holds a verifier key its module does not fingerprint', async () => {
      const { tally, sim } = await deploy({
        set: foreignVerifierKey,
        get: tallyVerifierKeys.get,
      });
      const { context } = contextOver(sim.authoriser);
      const authNonce = sim.ledger().auth_nonce;

      const refusal = await setTally(sim, context, {
        args: [TALLY_ADDRESS, '42'],
      }).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(refusal).toBeInstanceOf(ModuleResolutionError);
      expect((refusal as ModuleResolutionError).failure).toMatchObject({
        kind: 'ImplementationMismatch',
        circuitId: 'set',
        actual: HexBytes.fromByteArray(sha256(foreignVerifierKey)),
      });
      expect((refusal as ModuleResolutionError).context).toMatchObject({
        calleeAddress: TALLY_ADDRESS,
        calleeCircuitId: 'set',
        interfaceName: 'Tally',
        callerAddress: HexBytes.fromByteArray(sim.address),
      });
      expect(tally.ledger()).toEqual({ total: 0n, writes: 0n });
      expect(sim.ledger().tally_calls).toBe(0n);
      expect(sim.ledger().auth_nonce).toBe(authNonce);
    });

    it('is refused by the runtime when the deployed Tally module implements set with another argument type than the account declares', async () => {
      const { tally, sim } = await deploy(
        tallyVerifierKeys,
        narrowSetTallyModule,
      );
      const { context } = contextOver(sim.authoriser);
      const authNonce = sim.ledger().auth_nonce;

      const refusal = await setTally(sim, context, {
        args: [TALLY_ADDRESS, '42'],
      }).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(refusal).toBeInstanceOf(ModuleResolutionError);
      expect((refusal as ModuleResolutionError).failure).toEqual({
        kind: 'NonconformantImplementation',
        circuitId: 'set',
        check: 'ArgumentType',
        argumentIndex: 0,
      });
      expect(tally.ledger()).toEqual({ total: 0n, writes: 0n });
      expect(sim.ledger().tally_calls).toBe(0n);
      expect(sim.ledger().auth_nonce).toBe(authNonce);
    });
  },
);
