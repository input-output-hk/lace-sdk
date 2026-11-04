import {
  AccAddress,
  AccBindingVersion,
  AccountBundleUnknownError,
  CallArgumentInvalidError,
  CalledContractNotRegisteredError,
  CircuitNotRegisteredError,
  NotAuthorisedError,
  UseCounter,
} from '@lace-contract/passport';
import { ByteArray, HexBytes } from '@lace-lib/util';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { expectedVk } from '../../src/acc/acc-module';
import { createBundleRegistry } from '../../src/acc/bundle';
import { DEPLOYED_OPERATIONS } from '../../src/acc/deployed-operations';
import { accManifest } from '../../src/acc/manifest';
import { callContract } from '../../src/flows/call-contract';

import type * as AccountCall from '../../src/flows/account-call';
import type { AcceptedAccountCall } from '../../src/flows/account-call';
import type { CallContractInput } from '../../src/flows/call-contract';
import type {
  AccountRecords,
  FlowContext,
  PassportAccountRecord,
} from '../../src/flows/types';
import type {
  AccountBundle,
  CalledContract,
  KeySessionFlow,
  PassportAccountInfo,
  PassportAuthoriser,
  PassportDevice,
} from '@lace-contract/passport';

const mocks = vi.hoisted(() => ({
  readAccountLedger: vi.fn(),
  submitAccountCall: vi.fn(),
}));

vi.mock('../../src/flows/account-call', async importOriginal => ({
  ...(await importOriginal<typeof AccountCall>()),
  readAccountLedger: mocks.readAccountLedger,
  submitAccountCall: mocks.submitAccountCall,
}));

const NETWORK = 'undeployed';
const address = 'ac'.repeat(32);
const TALLY_ADDRESS = 'ab'.repeat(32);
const UNREGISTERED_ADDRESS = '12'.repeat(32);
const TALLY_CIRCUIT = 'tally_set_with_jubjub';
const SPEND_CIRCUIT = 'spend_with_jubjub';
const BINDING_VERSION = AccBindingVersion('0.1.0-tally.1');
const RECIPIENT = '44'.repeat(32);

const tallyContract: CalledContract = {
  label: 'Tally',
  address: TALLY_ADDRESS,
  interface: 'Tally',
  module: async () => {
    throw new Error('The tally module is never loaded');
  },
  artefactUrl: 'http://artefacts.example.com/tally',
  pins: {},
};
const network = {
  networkId: NETWORK,
  indexerUrl: 'http://indexer.example.com/api/v3/graphql',
  indexerWsUrl: 'ws://indexer.example.com/api/v3/graphql/ws',
  nodeUrl: 'http://node.example.com',
  artefactUrl: 'http://artefacts.example.com/account',
};

/**
 * A build of the account with two described circuits: one calling a
 * tally with a contract argument, its derived address and a value, and
 * one spending a held coin. Its module is never loaded: the gated call
 * is mocked below the flow.
 */
const tallyBundle: AccountBundle = {
  id: 'account-tally',
  bindingVersion: BINDING_VERSION,
  module: async () => {
    throw new Error('The tally module is never loaded');
  },
  manifest: { ...accManifest, bindingVersion: BINDING_VERSION },
  operations: [...DEPLOYED_OPERATIONS, TALLY_CIRCUIT, SPEND_CIRCUIT],
  verifierKeys: {
    ...expectedVk,
    [TALLY_CIRCUIT]: 'aa'.repeat(32),
    [SPEND_CIRCUIT]: 'ab'.repeat(32),
  },
  constructorArgs: [],
  circuits: {
    [TALLY_CIRCUIT]: {
      label: 'Set the tally',
      args: [
        { name: 'tally', label: 'Tally', type: 'contract', interface: 'Tally' },
        { name: 'tally_addr', type: 'contract-address', of: 'tally' },
        {
          name: 'value',
          label: 'New total',
          type: 'uint',
          maxval: '18446744073709551615',
        },
      ],
      challenge: 'challenge_tally_set_with_jubjub',
      challengeArgs: ['tally_addr', 'value'],
      witnesses: [],
    },
    [SPEND_CIRCUIT]: {
      label: 'Spend a coin',
      args: [{ name: 'recipient', label: 'Recipient', type: 'bytes32' }],
      challenge: 'challenge_spend_with_jubjub',
      challengeArgs: ['recipient', 'held_coin'],
      witnesses: [{ name: 'held_coin', label: 'Coin' }],
    },
  },
};

const account: PassportAccountInfo = {
  address,
  bindingVersion: BINDING_VERSION,
  bundleId: tallyBundle.id,
  status: 'ready',
  networkId: NETWORK,
};
const localDevice: PassportDevice = {
  commitmentHex: '11'.repeat(32),
  isLocal: true,
};
const remoteDevice: PassportDevice = {
  commitmentHex: '22'.repeat(32),
  isLocal: false,
};
const nextLocalCommitment = '1a'.repeat(32);
const ledgerState = { auth_nonce: 7n, device_epoch: 1n };
const grants = {
  ['cd'.repeat(32)]: {
    slot: 0,
    scopeSalt: '22'.repeat(32),
    granteePublicKey: 'ab'.repeat(32),
    origin: 'lace.io',
  },
};
const record: PassportAccountRecord = {
  address,
  bindingVersion: BINDING_VERSION,
  localUseCounter: '2',
  grants,
};
const heldCoin = {
  nonceHex: 'cd'.repeat(32),
  colorHex: 'EF'.repeat(32),
  value: '5',
  mtIndex: '2',
};

const accepted = (result: unknown = undefined): AcceptedAccountCall => ({
  advancedCounter: UseCounter(3n),
  txId: 'call-tx',
  result,
  localCommitmentHex: nextLocalCommitment,
});

const input: CallContractInput = {
  account,
  devices: [localDevice, remoteDevice],
  localUseCounter: '2',
  circuit: TALLY_CIRCUIT,
  args: [TALLY_ADDRESS.toUpperCase(), '42'],
};

/** Whether the key session is open, which the record reads and writes are checked against. */
const session = { isOpen: false };
const withKeySession = vi.fn(
  async (operation: () => Promise<unknown>, _flow?: KeySessionFlow) => {
    session.isOpen = true;
    try {
      return await operation();
    } finally {
      session.isOpen = false;
    }
  },
);

const createContext = (bundles: AccountBundle[] = [tallyBundle]) => {
  const inSession: boolean[] = [];
  const accountRecords: AccountRecords = {
    read: vi.fn(async () => {
      inSession.push(session.isOpen);
      return record;
    }),
    write: vi.fn(async () => {
      inSession.push(session.isOpen);
    }),
    presence: vi.fn(),
  };
  const context: FlowContext = {
    seams: {
      passportAuthoriser: {
        scheme: 'jubjub-schnorr',
        devicePublicKey: vi.fn(),
        deviceCommitment: vi.fn(),
        authorise: vi.fn(),
        withKeySession: withKeySession as PassportAuthoriser['withKeySession'],
      },
      passportEncryptionKey: {
        readerPublicKey: vi.fn(),
        createKeys: vi.fn(),
        sealToDevice: vi.fn(),
        openInbox: vi.fn(),
        sealGrant: vi.fn(),
      },
      passportSponsor: { balanceAndSign: vi.fn() },
      passportProver: { prove: vi.fn(), check: vi.fn() },
      passportNetwork: network,
    },
    accountRecords,
    onProgress: vi.fn(),
    rpId: 'lace.io',
    bundles: createBundleRegistry(bundles, [tallyContract]),
  };
  return { context, accountRecords, inSession };
};

/** The refusals the flow raises before any prompt and what reaches the chain. */
const expectRefusedBeforePrompt = () => {
  expect(withKeySession).not.toHaveBeenCalled();
  expect(mocks.readAccountLedger).not.toHaveBeenCalled();
  expect(mocks.submitAccountCall).not.toHaveBeenCalled();
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readAccountLedger.mockResolvedValue({ indexer: {}, ledgerState });
  mocks.submitAccountCall.mockResolvedValue(accepted());
});

describe('callContract', () => {
  it('runs one gated call with the decoded arguments and the bundle on the authorisation, in a session naming the call, and publishes the refreshed roster, the counter and the call', async () => {
    const { context, accountRecords, inSession } = createContext();
    const tally = { bytes: ByteArray.fromHex(HexBytes(TALLY_ADDRESS)) };

    const result = await callContract(input, context);

    expect(result).toEqual({
      circuit: TALLY_CIRCUIT,
      txId: 'call-tx',
      devices: [
        { commitmentHex: nextLocalCommitment, isLocal: true },
        remoteDevice,
      ],
      localUseCounter: '3',
    });
    expect(result).not.toHaveProperty('result');
    expect(mocks.readAccountLedger).toHaveBeenCalledExactlyOnceWith(
      address,
      network,
      tallyBundle,
    );
    expect(withKeySession).toHaveBeenCalledExactlyOnceWith(
      expect.any(Function),
      {
        kind: 'call-contract',
        account: AccAddress(address),
        bundleId: tallyBundle.id,
        circuit: TALLY_CIRCUIT,
        args: [TALLY_ADDRESS, '42'],
        callees: [TALLY_ADDRESS],
      },
    );
    expect(mocks.submitAccountCall).toHaveBeenCalledExactlyOnceWith(
      {
        circuit: TALLY_CIRCUIT,
        args: [tally, tally, 42n],
        witnessValues: [],
        bundleId: tallyBundle.id,
        account,
        bundles: context.bundles,
        localUseCounter: '2',
        ledgerState,
        onStage: context.onProgress,
      },
      context.seams,
    );
    expect(accountRecords.write).toHaveBeenCalledExactlyOnceWith({
      address,
      bindingVersion: BINDING_VERSION,
      localUseCounter: '3',
      grants,
    });
    expect(inSession).toEqual([true, true]);
    expect(
      vi.mocked(accountRecords.write).mock.invocationCallOrder[0],
    ).toBeGreaterThan(mocks.submitAccountCall.mock.invocationCallOrder[0]);
  });

  it('seeds the coin a witness names into the private state by its colour and binds it into the challenge', async () => {
    const { context } = createContext();

    await callContract(
      {
        ...input,
        circuit: SPEND_CIRCUIT,
        args: [RECIPIENT],
        witnesses: { heldCoin },
      },
      context,
    );

    expect(mocks.submitAccountCall).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        circuit: SPEND_CIRCUIT,
        args: [ByteArray.fromHex(HexBytes(RECIPIENT))],
        witnessValues: [
          {
            nonce: ByteArray.fromHex(HexBytes(heldCoin.nonceHex)),
            color: ByteArray.fromHex(HexBytes(heldCoin.colorHex)),
            value: 5n,
            mt_index: 2n,
          },
        ],
        privateState: { coins: { ['ef'.repeat(32)]: heldCoin } },
      }),
      context.seams,
    );
    expect(withKeySession).toHaveBeenCalledExactlyOnceWith(
      expect.any(Function),
      expect.objectContaining({
        circuit: SPEND_CIRCUIT,
        args: [RECIPIENT],
        callees: [],
      }),
    );
  });

  it.each<[string, unknown, string | undefined]>([
    ['an integer as its decimal', 42n, '42'],
    ['bytes as hex', Uint8Array.from([0xab, 0xcd]), 'abcd'],
    ['a boolean as its word', true, 'true'],
    [
      'a structure as JSON',
      { total: 7n, flags: [false] },
      '{"total":"7","flags":[false]}',
    ],
    ['an empty tuple as nothing', [], undefined],
    ['no value as nothing', undefined, undefined],
  ])(
    'renders the circuit return value, %s',
    async (_rendering, returned, rendered) => {
      mocks.submitAccountCall.mockResolvedValue(accepted(returned));

      const result = await callContract(input, createContext().context);

      if (rendered === undefined) {
        expect(result).not.toHaveProperty('result');
      } else {
        expect(result.result).toBe(rendered);
      }
    },
  );

  it('refuses a circuit the bundle does not describe before any prompt', async () => {
    const call = callContract(
      { ...input, circuit: 'tally_get' },
      createContext().context,
    );

    await expect(call).rejects.toBeInstanceOf(CircuitNotRegisteredError);
    await expect(call).rejects.toThrow(
      "Account bundle 'account-tally' describes no circuit 'tally_get'.",
    );
    expectRefusedBeforePrompt();
  });

  it('refuses a callee the registry does not hold before any prompt', async () => {
    const call = callContract(
      { ...input, args: [UNREGISTERED_ADDRESS, '42'] },
      createContext().context,
    );

    await expect(call).rejects.toBeInstanceOf(CalledContractNotRegisteredError);
    expectRefusedBeforePrompt();
  });

  it('refuses a value outside its descriptor before any prompt', async () => {
    const call = callContract(
      { ...input, args: [TALLY_ADDRESS, '18446744073709551616'] },
      createContext().context,
    );

    await expect(call).rejects.toBeInstanceOf(CallArgumentInvalidError);
    await expect(call).rejects.toThrow(
      "Argument 'value' must be at most 18446744073709551615.",
    );
    expectRefusedBeforePrompt();
  });

  it.each<[string, CallContractInput['witnesses'], string]>([
    ['no witness', undefined, 'has no value.'],
    [
      'a coin whose colour is not 32 bytes of hex',
      { heldCoin: { ...heldCoin, colorHex: 'ef' } },
      'must name its nonce and colour as 32 bytes of hex each.',
    ],
    [
      'a coin whose value is not a decimal',
      { heldCoin: { ...heldCoin, value: 'five' } },
      'must give its value and tree index as decimal integers.',
    ],
  ])(
    'refuses a spend given %s before any prompt, naming the witness',
    async (_case, witnesses, rule) => {
      const call = callContract(
        {
          ...input,
          circuit: SPEND_CIRCUIT,
          args: [RECIPIENT],
          ...(witnesses ? { witnesses } : {}),
        },
        createContext().context,
      );

      await expect(call).rejects.toBeInstanceOf(CallArgumentInvalidError);
      await expect(call).rejects.toThrow(
        `Witness 'held_coin' of circuit '${SPEND_CIRCUIT}' ${rule}`,
      );
      expectRefusedBeforePrompt();
    },
  );

  it('refuses an account whose bundle is not registered before any prompt', async () => {
    const call = callContract(
      { ...input, account: { ...account, bundleId: 'account-other' } },
      createContext().context,
    );

    await expect(call).rejects.toBeInstanceOf(AccountBundleUnknownError);
    expectRefusedBeforePrompt();
  });

  it.each([
    'failed assert: invalid signature',
    'failed assert: unknown device entry',
  ])('types the contract abort "%s" as NotAuthorisedError', async abort => {
    mocks.submitAccountCall.mockRejectedValue(new Error(abort));
    const { context, accountRecords } = createContext();

    const call = callContract(input, context);

    await expect(call).rejects.toBeInstanceOf(NotAuthorisedError);
    await expect(call).rejects.toThrow(abort);
    expect(accountRecords.write).not.toHaveBeenCalled();
  });

  it('passes the called circuit refusals and other failures through unchanged', async () => {
    const failure = new Error('failed assert: tally overflow');
    mocks.submitAccountCall.mockRejectedValue(failure);

    await expect(callContract(input, createContext().context)).rejects.toBe(
      failure,
    );
  });
});
