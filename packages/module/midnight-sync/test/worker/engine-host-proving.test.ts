import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  assertPlainData,
  fakeEngines,
  PASSWORD,
  sealedAccount,
  settings,
  useFastKeyDerivation,
} from './engine-host-fakes';
import { createHost } from './engine-host-setup';

import type { MidnightEngineSettings } from '../../src/worker/protocol';
import type { ProofServerMode } from '@lace-contract/midnight-context';

const ledgerMocks = vi.hoisted(() => ({
  createCheckPayload: vi.fn(() => new Uint8Array([0xcc])),
  createProvingPayload: vi.fn(() => new Uint8Array([0xdd])),
  parseCheckResult: vi.fn(() => [42n, undefined]),
}));

vi.mock('@midnight-ntwrk/ledger-v8', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...ledgerMocks,
}));

vi.mock('../../src/store/dependencies', async importOriginal => {
  const fakes = await import('./engine-host-fakes');
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    createStartMidnightAccountWallet: fakes.fakeEngines.createStart,
  };
});

const reasonOf = async (call: Promise<unknown>) =>
  call.then(
    () => 'resolved',
    (error: unknown) =>
      (error as { reason?: string }).reason ?? (error as Error).message,
  );

const withProofServer = (
  proofServer: ProofServerMode,
): MidnightEngineSettings =>
  settings({ config: { ...settings().config, proofServer } });

const keyMaterial = {
  proverKey: new Uint8Array([1]),
  verifierKey: new Uint8Array([2]),
  ir: new Uint8Array([3]),
};

describe('engine-host-proving', () => {
  beforeAll(useFastKeyDerivation);
  beforeEach(() => {
    fakeEngines.reset();
    vi.clearAllMocks();
  });

  it('starts engines that prove through a proof server given by URL, local or delegated', async () => {
    const { host } = createHost();

    for (const [index, proofServer] of [
      { kind: 'local-host', url: 'http://127.0.0.1:6300' },
      { kind: 'delegated', url: 'https://prover.example', label: 'prover' },
    ].entries())
      await host.attach({
        clientId: 'tab-1',
        account: await sealedAccount({ accountIndex: index }),
        password: PASSWORD.slice(),
        settings: withProofServer(proofServer as ProofServerMode),
      });

    expect(
      fakeEngines.started.map(({ params }) => params.config.proofServer.kind),
    ).toEqual(['local-host', 'delegated']);
  });

  it.each<[string, Partial<MidnightEngineSettings>, string]>([
    ['an attested prover', { attestedProver: true }, 'attested-prover'],
    [
      'a tee-delegated proof server',
      withProofServer({
        kind: 'tee-delegated',
        url: 'https://api.proofserver.wastedp.io',
        label: 'Veritee',
      }),
      'attested-prover',
    ],
    [
      'a TEE host presented as an ordinary delegated server',
      withProofServer({
        kind: 'delegated',
        url: 'https://api.proofserver.wastedp.io',
        label: 'Veritee',
      }),
      'Cannot attest a TEE proof server through ordinary HTTP; select tee-delegated',
    ],
    [
      'an in-process prover',
      withProofServer({ kind: 'in-process' }),
      'Unsupported Midnight proof server mode "in-process"',
    ],
    [
      'a paired device',
      withProofServer({
        kind: 'paired-device',
        url: 'https://device.example',
        pairingId: 'p',
      }),
      'Unsupported Midnight proof server mode "paired-device"',
    ],
  ])('refuses %s before starting an engine', async (_, requested, reason) => {
    const { host } = createHost();

    await expect(
      reasonOf(
        host.attach({
          clientId: 'tab-1',
          account: await sealedAccount(),
          password: PASSWORD.slice(),
          settings: settings(requested),
        }),
      ),
    ).resolves.toBe(reason);
    expect(fakeEngines.started).toHaveLength(0);
  });

  describe('dApp circuits', () => {
    const attached = async () => {
      const { host } = createHost();
      const accounts = [
        await sealedAccount({ walletId: 'wallet-a' }),
        await sealedAccount({ walletId: 'wallet-b' }),
      ];
      for (const account of accounts)
        await host.attach({
          clientId: 'tab-1',
          account,
          password: PASSWORD.slice(),
          settings: settings(),
        });
      const [a, b] = fakeEngines.started;
      return { host, a, b, accounts };
    };

    it('checks a circuit with page-supplied key material through the account own port, carrying bytes only', async () => {
      const { host, a, b, accounts } = await attached();
      const preimage = new Uint8Array([9, 9]);

      const result = await host.checkCircuit({
        clientId: 'tab-1',
        accountId: accounts[1].accountId,
        serializedPreimage: preimage,
        keyLocation: 'contract/circuit',
        keyMaterial,
      });

      expect(result).toEqual([42n, undefined]);
      expect(ledgerMocks.createCheckPayload).toBeCalledWith(
        preimage,
        keyMaterial.ir,
      );
      expect(b.proofServerTransport.check).toBeCalledWith(
        new Uint8Array([0xcc]),
        undefined,
      );
      expect(
        vi.mocked(b.proofServerTransport.check).mock.calls[0],
      ).toHaveLength(2);
      expect(ledgerMocks.parseCheckResult).toBeCalledWith(
        new Uint8Array([0xc1]),
      );
      expect(a.proofServerTransport.check).not.toBeCalled();
    });

    it('proves a circuit with page-supplied key material and returns the proof bytes', async () => {
      const { host, a, accounts } = await attached();
      const preimage = new Uint8Array([8]);

      const proof = await host.proveCircuit({
        clientId: 'tab-1',
        accountId: accounts[0].accountId,
        serializedPreimage: preimage,
        keyLocation: 'contract/circuit',
        keyMaterial,
        overwriteBindingInput: 5n,
      });

      expect(proof).toEqual(new Uint8Array([0xb1]));
      expect(proof).toBeInstanceOf(Uint8Array);
      expect(ledgerMocks.createProvingPayload).toBeCalledWith(
        preimage,
        5n,
        keyMaterial,
      );
      expect(a.proofServerTransport.prove).toBeCalledWith(
        new Uint8Array([0xdd]),
        undefined,
      );
      expect(() => {
        assertPlainData(vi.mocked(a.proofServerTransport.prove).mock.calls);
      }).not.toThrow();
    });

    it('proves with the material the proof server holds when the page sends none', async () => {
      const { host, accounts } = await attached();

      await host.checkCircuit({
        clientId: 'tab-1',
        accountId: accounts[0].accountId,
        serializedPreimage: new Uint8Array([1]),
        keyLocation: 'midnight/zswap/spend',
      });
      await host.proveCircuit({
        clientId: 'tab-1',
        accountId: accounts[0].accountId,
        serializedPreimage: new Uint8Array([1]),
        keyLocation: 'midnight/zswap/spend',
      });

      expect(ledgerMocks.createCheckPayload).toBeCalledWith(
        new Uint8Array([1]),
        undefined,
      );
      expect(ledgerMocks.createProvingPayload).toBeCalledWith(
        new Uint8Array([1]),
        undefined,
        undefined,
      );
    });

    it('rejects with the proof server failure', async () => {
      const { host, a, accounts } = await attached();
      vi.mocked(a.proofServerTransport.prove).mockRejectedValue(
        new Error('Proof server returned 500: boom'),
      );

      await expect(
        host.proveCircuit({
          clientId: 'tab-1',
          accountId: accounts[0].accountId,
          serializedPreimage: new Uint8Array([1]),
          keyLocation: 'contract/circuit',
          keyMaterial,
        }),
      ).rejects.toThrow('Proof server returned 500: boom');
    });
  });
});
