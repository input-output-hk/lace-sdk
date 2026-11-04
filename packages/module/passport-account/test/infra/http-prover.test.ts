import { createHash } from 'node:crypto';

import { ArtefactIntegrityError } from '@lace-contract/passport';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { accManifest } from '../../src/acc/manifest';
import {
  createHttpProver,
  createManifestKeyMaterialResolver,
  ProofServerError,
  UnresolvedContractCircuitError,
} from '../../src/infra/http-prover';

import type { AccCircuitManifestEntry } from '../../src/acc/manifest';
import type {
  KeyMaterialResolver,
  ProverFetch,
} from '../../src/infra/http-prover';
import type { AccountBundle, CalledContract } from '@lace-contract/passport';

const framing = vi.hoisted(() => {
  type KeyMaterial = {
    proverKey: Uint8Array;
    verifierKey: Uint8Array;
    ir: Uint8Array;
  };
  const createProvingPayload = vi.fn(
    (
      preimage: Uint8Array,
      _overwriteBindingInput: bigint | undefined,
      keyMaterial?: KeyMaterial,
    ) =>
      Uint8Array.from([
        0x50,
        ...preimage,
        ...(keyMaterial ? [...keyMaterial.proverKey, ...keyMaterial.ir] : []),
      ]),
  );
  const createCheckPayload = vi.fn((preimage: Uint8Array, ir?: Uint8Array) =>
    Uint8Array.from([0x43, ...preimage, ...(ir ?? [])]),
  );
  return { createProvingPayload, createCheckPayload };
});

vi.mock('@midnight-ntwrk/midnight-js-protocol/ledger', () => framing);

const baseUrl = 'https://proof-server.example:6300';
const preimage = new Uint8Array([1, 2, 3, 4]);
const proofBytes = new Uint8Array([9, 8, 7]);
const keyLocation = 'keys/add_device_with_jubjub';
const keyMaterial = {
  proverKey: new Uint8Array([4, 5]),
  verifierKey: new Uint8Array([6]),
  ir: new Uint8Array([7, 8]),
};

const okResponse = (bytes: Uint8Array) => ({
  ok: true,
  status: 200,
  statusText: 'OK',
  arrayBuffer: async () =>
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
});

const errorResponse = (status: number, statusText: string) => ({
  ok: false,
  status,
  statusText,
  arrayBuffer: async () => new ArrayBuffer(0),
});

const materialResolver = (): KeyMaterialResolver & ReturnType<typeof vi.fn> =>
  vi.fn(async () => keyMaterial) as KeyMaterialResolver &
    ReturnType<typeof vi.fn>;

describe('createHttpProver', () => {
  afterEach(() => {
    vi.useRealTimers();
    framing.createProvingPayload.mockClear();
    framing.createCheckPayload.mockClear();
  });

  it('resolves the key material, frames the proving payload, and posts it as an octet-stream body to /prove', async () => {
    const fetchHttp = vi.fn(async () => okResponse(proofBytes));
    const resolveKeyMaterial = materialResolver();
    const prover = createHttpProver(baseUrl, {
      fetchHttp: fetchHttp as ProverFetch,
      resolveKeyMaterial,
    });

    const proof = await prover.prove(preimage, keyLocation);

    expect(proof).toEqual(proofBytes);
    expect(resolveKeyMaterial).toHaveBeenCalledWith(keyLocation);
    expect(framing.createProvingPayload).toHaveBeenCalledWith(
      preimage,
      undefined,
      keyMaterial,
    );
    expect(fetchHttp).toHaveBeenCalledTimes(1);
    const [url, init] = fetchHttp.mock
      .calls[0] as unknown as Parameters<ProverFetch>;
    expect(url).toBe(`${baseUrl}/prove`);
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      'Content-Type': 'application/octet-stream',
    });
    expect(init.body).toEqual(Uint8Array.from([0x50, 1, 2, 3, 4, 4, 5, 7, 8]));
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('frames the check payload with the circuit IR, posts to /check, and tolerates a trailing slash', async () => {
    const fetchHttp = vi.fn(async () => okResponse(proofBytes));
    const resolveKeyMaterial = materialResolver();
    const prover = createHttpProver(`${baseUrl}/`, {
      fetchHttp: fetchHttp as ProverFetch,
      resolveKeyMaterial,
    });

    await prover.check(preimage, keyLocation);

    expect(resolveKeyMaterial).toHaveBeenCalledWith(keyLocation);
    expect(framing.createCheckPayload).toHaveBeenCalledWith(
      preimage,
      keyMaterial.ir,
    );
    const [url, init] = fetchHttp.mock
      .calls[0] as unknown as Parameters<ProverFetch>;
    expect(url).toBe(`${baseUrl}/check`);
    expect(init.body).toEqual(Uint8Array.from([0x43, 1, 2, 3, 4, 7, 8]));
  });

  it('forwards the binding input overwrite into the proving payload', async () => {
    const fetchHttp = vi.fn(async () => okResponse(proofBytes));
    const prover = createHttpProver(baseUrl, {
      fetchHttp: fetchHttp as ProverFetch,
      resolveKeyMaterial: materialResolver(),
    });

    await prover.prove(preimage, keyLocation, 42n);

    expect(framing.createProvingPayload).toHaveBeenCalledWith(
      preimage,
      42n,
      keyMaterial,
    );
  });

  it('sends a protocol builtin location without key material for the proof server to supply', async () => {
    const fetchHttp = vi.fn(async () => okResponse(proofBytes));
    const resolveKeyMaterial = vi.fn(async () => undefined);
    const prover = createHttpProver(baseUrl, {
      fetchHttp: fetchHttp as ProverFetch,
      resolveKeyMaterial,
    });

    await prover.prove(preimage, 'midnight/zswap/spend');

    expect(resolveKeyMaterial).toHaveBeenCalledWith('midnight/zswap/spend');
    expect(framing.createProvingPayload).toHaveBeenCalledWith(
      preimage,
      undefined,
      undefined,
    );
    const [, init] = fetchHttp.mock
      .calls[0] as unknown as Parameters<ProverFetch>;
    expect(init.body).toEqual(Uint8Array.from([0x50, 1, 2, 3, 4]));
  });

  it('requires a key material resolver or an artefact url', () => {
    expect(() => createHttpProver(baseUrl)).toThrow(
      'createHttpProver needs resolveKeyMaterial or an artefactUrl',
    );
  });

  it.each([500, 503])('retries once on a %i and succeeds', async status => {
    const fetchHttp = vi
      .fn()
      .mockResolvedValueOnce(errorResponse(status, 'Transient'))
      .mockResolvedValueOnce(okResponse(proofBytes));
    const prover = createHttpProver(baseUrl, {
      fetchHttp: fetchHttp as ProverFetch,
      resolveKeyMaterial: materialResolver(),
    });

    const proof = await prover.prove(preimage, keyLocation);

    expect(proof).toEqual(proofBytes);
    expect(fetchHttp).toHaveBeenCalledTimes(2);
  });

  it('throws a ProofServerError carrying the status when the retry fails too', async () => {
    const fetchHttp = vi.fn(async () => errorResponse(503, 'Unavailable'));
    const prover = createHttpProver(baseUrl, {
      fetchHttp: fetchHttp as ProverFetch,
      resolveKeyMaterial: materialResolver(),
    });

    const failure = prover.prove(preimage, keyLocation);

    await expect(failure).rejects.toThrow(ProofServerError);
    await expect(failure).rejects.toMatchObject({ status: 503 });
    expect(fetchHttp).toHaveBeenCalledTimes(2);
  });

  it('does not retry statuses outside 500 and 503', async () => {
    const fetchHttp = vi.fn(async () => errorResponse(404, 'Not Found'));
    const prover = createHttpProver(baseUrl, {
      fetchHttp: fetchHttp as ProverFetch,
      resolveKeyMaterial: materialResolver(),
    });

    await expect(prover.check(preimage, keyLocation)).rejects.toMatchObject({
      status: 404,
    });
    expect(fetchHttp).toHaveBeenCalledTimes(1);
  });

  it('aborts and throws a ProofServerError after the five minute timeout', async () => {
    vi.useFakeTimers();
    const fetchHttp = vi.fn(
      async (_url: string, init: { signal: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
        }),
    );
    const prover = createHttpProver(baseUrl, {
      fetchHttp: fetchHttp as unknown as ProverFetch,
      resolveKeyMaterial: materialResolver(),
    });

    const failure = prover.prove(preimage, keyLocation);
    const assertion = expect(failure).rejects.toThrow(
      /timed out after 300000ms/,
    );
    await vi.waitFor(() => {
      expect(fetchHttp).toHaveBeenCalledTimes(1);
    });
    await vi.advanceTimersByTimeAsync(300_000);

    await assertion;
    expect(fetchHttp).toHaveBeenCalledTimes(1);
  });

  it('rethrows transport failures unchanged', async () => {
    const fetchHttp = vi.fn(async () => {
      throw new Error('connection refused');
    });
    const prover = createHttpProver(baseUrl, {
      fetchHttp: fetchHttp as unknown as ProverFetch,
      resolveKeyMaterial: materialResolver(),
    });

    await expect(prover.prove(preimage, keyLocation)).rejects.toThrow(
      'connection refused',
    );
  });
});

const sha256Hex = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

/** One circuit's assets as served from `artefactUrl`, with the pin that matches them. */
const circuitFixture = (artefactUrl: string, name: string, seed: number) => {
  const zkir = new Uint8Array([seed, 1]);
  const proverKey = new Uint8Array([seed, 2, 3]);
  const verifierKey = new Uint8Array([seed, 4]);
  const entry: AccCircuitManifestEntry = {
    name,
    keyLocation: `keys/${name}`,
    zkirSha256: sha256Hex(zkir),
    proverKeySha256: sha256Hex(proverKey),
    verifierKeySha256: sha256Hex(verifierKey),
  };
  return {
    entry,
    bytes: {
      [`${artefactUrl}/zkir/${name}.bzkir`]: zkir,
      [`${artefactUrl}/keys/${name}.prover`]: proverKey,
      [`${artefactUrl}/keys/${name}.verifier`]: verifierKey,
    },
    material: { proverKey, verifierKey, ir: zkir },
  };
};

const networkUrl = 'https://artefacts.example/acc';
const tallyAccountUrl = 'https://artefacts.example/acc-tally';
const tallyUrl = 'https://artefacts.example/tally';
const circuit = 'add_device_with_jubjub';
const TALLY_CIRCUIT = 'tally_set_with_jubjub';
const ACCOUNT_ADDRESS = 'ab'.repeat(32);
const TALLY_ADDRESS = 'cd'.repeat(32);

const accountAddDevice = circuitFixture(networkUrl, circuit, 1);
const tallyAddDevice = circuitFixture(tallyAccountUrl, circuit, 2);
const tallySet = circuitFixture(tallyAccountUrl, TALLY_CIRCUIT, 3);
const calleeSet = circuitFixture(tallyUrl, 'set', 4);

const fixtures: Record<string, Uint8Array> = {
  ...accountAddDevice.bytes,
  ...tallyAddDevice.bytes,
  ...tallySet.bytes,
  ...calleeSet.bytes,
};

const bundleOf = (
  id: string,
  circuits: Record<string, AccCircuitManifestEntry>,
  artefactUrl?: string,
): AccountBundle => ({
  id,
  bindingVersion: accManifest.bindingVersion,
  module: async () => ({
    Contract: class {},
    ledger: () => ({}),
    pureCircuits: {},
    expectedVk: {},
    circuitSignatures: {},
    declaredInterfaces: {},
  }),
  manifest: { ...accManifest, circuits },
  operations: Object.keys(circuits),
  verifierKeys: {},
  constructorArgs: [],
  circuits: {},
  ...(artefactUrl === undefined ? {} : { artefactUrl }),
});

/** The default bundle, whose artefacts the network serves. */
const accountFixture = bundleOf('account', {
  [circuit]: accountAddDevice.entry,
});

/** A build extending the account, with its own artefacts and its own key for a shared circuit name. */
const tallyBundle = bundleOf(
  'account-tally',
  { [circuit]: tallyAddDevice.entry, [TALLY_CIRCUIT]: tallySet.entry },
  tallyAccountUrl,
);

const tally: CalledContract = {
  label: 'Tally',
  address: TALLY_ADDRESS,
  interface: 'Tally',
  module: async () => ({
    Contract: class {},
    pureCircuits: {},
    expectedVk: {},
    circuitSignatures: {},
    declaredInterfaces: {},
  }),
  artefactUrl: tallyUrl,
  pins: { set: calleeSet.entry },
};

const fetchFixtures = () =>
  vi.fn(async (url: string) => {
    const bytes = fixtures[url];
    if (!bytes) throw new Error(`No fixture for ${url}`);
    return bytes;
  });

const canonical = (address: string, name: string, vk?: string): string =>
  `contract:${address}/${name}${vk === undefined ? '' : `?vk=${vk}`}`;

describe('createManifestKeyMaterialResolver', () => {
  const resolverOver = (
    fetchBytes = fetchFixtures(),
    bundles: readonly AccountBundle[] = [accountFixture, tallyBundle],
    calledContracts: readonly CalledContract[] = [tally],
  ) =>
    createManifestKeyMaterialResolver({
      artefactUrl: networkUrl,
      fetchBytes,
      bundles,
      calledContracts,
    });

  it('maps a manifest key location to the verified prover key, verifier key, and IR of the default bundle', async () => {
    await expect(resolverOver()(`keys/${circuit}`)).resolves.toEqual(
      accountAddDevice.material,
    );
  });

  it('accepts the bare circuit name as the key location', async () => {
    await expect(resolverOver()(circuit)).resolves.toEqual(
      accountAddDevice.material,
    );
  });

  it('resolves a canonical account location to the bundle pinning its verifier key hash, from that bundle artefact URL', async () => {
    const fetchBytes = fetchFixtures();
    const resolver = resolverOver(fetchBytes);

    await expect(
      resolver(
        canonical(
          ACCOUNT_ADDRESS,
          circuit,
          accountAddDevice.entry.verifierKeySha256,
        ),
      ),
    ).resolves.toEqual(accountAddDevice.material);
    await expect(
      resolver(
        canonical(
          ACCOUNT_ADDRESS,
          circuit,
          tallyAddDevice.entry.verifierKeySha256,
        ),
      ),
    ).resolves.toEqual(tallyAddDevice.material);

    const urls = fetchBytes.mock.calls.map(([url]) => url);
    expect(urls.filter(url => url.startsWith(`${networkUrl}/`))).toHaveLength(
      3,
    );
    expect(
      urls.filter(url => url.startsWith(`${tallyAccountUrl}/`)),
    ).toHaveLength(3);
  });

  it('picks the first registered bundle when two pin the same verifier key hash under one circuit name', async () => {
    const fetchBytes = fetchFixtures();
    const extended = bundleOf(
      'account-extended',
      { [circuit]: accountAddDevice.entry },
      'https://artefacts.example/acc-extended',
    );
    const resolver = resolverOver(fetchBytes, [accountFixture, extended]);

    await expect(
      resolver(
        canonical(
          ACCOUNT_ADDRESS,
          circuit,
          accountAddDevice.entry.verifierKeySha256,
        ),
      ),
    ).resolves.toEqual(accountAddDevice.material);
    expect(
      fetchBytes.mock.calls.every(([url]) => url.startsWith(`${networkUrl}/`)),
    ).toBe(true);
  });

  it('resolves a canonical location without a vk pin by name in the first bundle listing the circuit', async () => {
    const resolver = resolverOver();

    await expect(
      resolver(canonical(ACCOUNT_ADDRESS, circuit)),
    ).resolves.toEqual(accountAddDevice.material);
    await expect(
      resolver(canonical(ACCOUNT_ADDRESS, TALLY_CIRCUIT)),
    ).resolves.toEqual(tallySet.material);
  });

  it('throws ArtefactIntegrityError when no bundle listing the circuit pins the verifier key the chain expects', async () => {
    const fetchBytes = fetchFixtures();
    const driftedPin = 'f'.repeat(64);

    const failure = resolverOver(fetchBytes)(
      canonical(ACCOUNT_ADDRESS, circuit, driftedPin),
    );

    await expect(failure).rejects.toThrow(ArtefactIntegrityError);
    await expect(failure).rejects.toMatchObject({
      code: 'artefact-integrity',
      message: `verifier key pin mismatch for ${circuit}: the chain expects ${driftedPin}, the registered account bundles pin ${accountAddDevice.entry.verifierKeySha256} ('account'), ${tallyAddDevice.entry.verifierKeySha256} ('account-tally')`,
    });
    expect(fetchBytes).not.toHaveBeenCalled();
  });

  it('resolves a called contract circuit through its pins from its own artefact URL', async () => {
    const fetchBytes = fetchFixtures();

    await expect(
      resolverOver(fetchBytes)(
        canonical(TALLY_ADDRESS, 'set', calleeSet.entry.verifierKeySha256),
      ),
    ).resolves.toEqual(calleeSet.material);
    expect(
      fetchBytes.mock.calls.every(([url]) => url.startsWith(`${tallyUrl}/`)),
    ).toBe(true);
  });

  it('refuses a called contract vk pin that differs from the registered pin', async () => {
    const fetchBytes = fetchFixtures();
    const driftedPin = 'e'.repeat(64);

    const failure = resolverOver(fetchBytes)(
      canonical(TALLY_ADDRESS, 'set', driftedPin),
    );

    await expect(failure).rejects.toThrow(ArtefactIntegrityError);
    await expect(failure).rejects.toThrow(
      `verifier key pin mismatch for set: the chain expects ${driftedPin}, called contract 'Tally' pins ${calleeSet.entry.verifierKeySha256}`,
    );
    expect(fetchBytes).not.toHaveBeenCalled();
  });

  it('throws a named error for a circuit of a called contract outside its pins', async () => {
    const vk = '2'.repeat(64);

    const failure = resolverOver()(canonical(TALLY_ADDRESS, 'reset', vk));

    await expect(failure).rejects.toThrow(UnresolvedContractCircuitError);
    await expect(failure).rejects.toMatchObject({
      code: 'unresolved-contract-circuit',
      contractAddress: TALLY_ADDRESS,
      circuit: 'reset',
      verifierKeyHash: vk,
    });
  });

  it('throws a named error naming the registrations for a contract location whose circuit nothing pins', async () => {
    const fetchBytes = fetchFixtures();
    const address = 'ef'.repeat(32);
    const vk = '1'.repeat(64);

    const failure = resolverOver(fetchBytes)(
      canonical(address, 'bridge_deposit', vk),
    );

    await expect(failure).rejects.toThrow(UnresolvedContractCircuitError);
    await expect(failure).rejects.toMatchObject({
      code: 'unresolved-contract-circuit',
      contractAddress: address,
      circuit: 'bridge_deposit',
      verifierKeyHash: vk,
    });
    await expect(failure).rejects.toThrow(
      `No key material for circuit "bridge_deposit" of contract ${address} (vk=${vk}): the prover resolves the circuits of the account bundles 'account', 'account-tally' and of the called contracts 'Tally' (${TALLY_ADDRESS}).`,
    );
    expect(fetchBytes).not.toHaveBeenCalled();
  });

  it('says no called contract is registered when none is', async () => {
    const failure = resolverOver(
      fetchFixtures(),
      [accountFixture],
      [],
    )(canonical(ACCOUNT_ADDRESS, 'bridge_deposit'));

    await expect(failure).rejects.toThrow(
      `the prover resolves the circuits of the account bundles 'account' and of no called contract.`,
    );
  });

  it('resolves an unknown location to undefined without downloading anything', async () => {
    const fetchBytes = fetchFixtures();

    await expect(
      resolverOver(fetchBytes)('midnight/zswap/spend'),
    ).resolves.toBeUndefined();
    expect(fetchBytes).not.toHaveBeenCalled();
  });
});

describe('createHttpProver key material registries', () => {
  it('builds the default resolver over the vendored bundle from artefactUrl alone, downloading from it against the vendored pins', async () => {
    const fetchBytes = fetchFixtures();
    const prover = createHttpProver(baseUrl, {
      artefactUrl: networkUrl,
      fetchBytes,
      fetchHttp: vi.fn(async () => okResponse(proofBytes)) as ProverFetch,
    });

    await expect(prover.prove(preimage, `keys/${circuit}`)).rejects.toThrow(
      ArtefactIntegrityError,
    );
    expect(fetchBytes.mock.calls.map(([url]) => url).sort()).toEqual([
      `${networkUrl}/keys/${circuit}.prover`,
      `${networkUrl}/keys/${circuit}.verifier`,
      `${networkUrl}/zkir/${circuit}.bzkir`,
    ]);
  });

  it('proves a call into a registered called contract with the material its pins name', async () => {
    const fetchHttp = vi.fn(async () => okResponse(proofBytes));
    const prover = createHttpProver(baseUrl, {
      artefactUrl: networkUrl,
      registry: { bundles: [tallyBundle], calledContracts: [tally] },
      fetchBytes: fetchFixtures(),
      fetchHttp: fetchHttp as ProverFetch,
    });

    await prover.prove(
      preimage,
      canonical(TALLY_ADDRESS, 'set', calleeSet.entry.verifierKeySha256),
    );

    expect(framing.createProvingPayload).toHaveBeenCalledWith(
      preimage,
      undefined,
      calleeSet.material,
    );
  });
});
