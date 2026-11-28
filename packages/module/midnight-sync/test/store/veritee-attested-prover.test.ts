import {
  AkxChannelBinder,
  ChannelBindingError,
  RealLedgerClient,
} from '@input-output-hk/veritee-attestation-verifier';
import {
  createMockDependencies,
  FIXTURE_CONFIG,
} from '@input-output-hk/veritee-attestation-verifier/mocks';
import {
  MidnightSDKNetworkIds,
  VERITEE_PROOF_SERVER_MODES,
} from '@lace-contract/midnight-context';
import { describe, expect, it, vi } from 'vitest';

import {
  createStoreVeriteeAttestedProver,
  VeriteeAttestationError,
} from '../../src/store/veritee-attested-prover';

import type { AttestationProgressEvent } from '@lace-contract/midnight-context';

const VERITEE_PROOF_SERVER_URL = 'https://api.proofserver.wastedp.io';

const CONTRACT_CHECK_IDS = new Set([
  'ak-extraction',
  'epoch-key-binding',
  'pcr15-recompute',
  'pcrs-0-4-vs-record',
  'report-data-binding',
  'report-fields-vs-record',
  'snp-signature-chain',
  'tpm-quote-pcr-digest',
  'tpm-quote-signature',
]);

const createDriver = (observeHttp = false) => {
  const dependencies = createMockDependencies({ latencyMs: 0 });
  // FIXTURE_CONFIG must accompany the mock dependencies: the mock channel
  // binder validates the config's proof-server host against the fixture
  // evidence's webserver_tls endpoints (api.mock.local).
  const driver = createStoreVeriteeAttestedProver(
    {
      networkId: MidnightSDKNetworkIds.PreProd,
      proofServerApiUrl: VERITEE_PROOF_SERVER_URL,
      getLedgerIndexerUrl: async () => FIXTURE_CONFIG.indexerUrl,
      trustRoots: { amdRootCertificates: FIXTURE_CONFIG.amdRootCertificates },
    },
    {
      dependencies: observeHttp
        ? { ...dependencies, channelBinder: undefined }
        : dependencies,
      config: FIXTURE_CONFIG,
    },
  );
  const events: AttestationProgressEvent[] = [];
  const run = async () =>
    driver.establishAttestedSession(event => events.push(event));
  return { dependencies, driver, events, run };
};

const phaseEvents = (events: AttestationProgressEvent[]) =>
  events.flatMap(event =>
    event.type === 'phase' ? [`${event.phase}:${event.status}`] : [],
  );

describe('createStoreVeriteeAttestedProver', () => {
  it('throws for a proof server that is not the one baked for the network', () => {
    expect(() =>
      createStoreVeriteeAttestedProver({
        networkId: MidnightSDKNetworkIds.PreProd,
        proofServerApiUrl: 'https://unknown.example.com',
        getLedgerIndexerUrl: async () => FIXTURE_CONFIG.indexerUrl,
        trustRoots: { amdRootCertificates: FIXTURE_CONFIG.amdRootCertificates },
      }),
    ).toThrow(/no baked veritee attestation config/i);
  });

  it.each([MidnightSDKNetworkIds.QaNet])(
    'rejects ineligible network %s before attestation',
    networkId => {
      expect(() =>
        createStoreVeriteeAttestedProver({
          networkId,
          proofServerApiUrl: VERITEE_PROOF_SERVER_URL,
          getLedgerIndexerUrl: async () => FIXTURE_CONFIG.indexerUrl,
          trustRoots: {
            amdRootCertificates: FIXTURE_CONFIG.amdRootCertificates,
          },
        }),
      ).toThrow(/no baked veritee attestation config/i);
    },
  );

  it('bakes an attestation config for every network that offers the Veritee mode', () => {
    const networks = Object.keys(VERITEE_PROOF_SERVER_MODES);
    expect(networks).toEqual(
      expect.arrayContaining([
        MidnightSDKNetworkIds.MainNet,
        MidnightSDKNetworkIds.PreProd,
        MidnightSDKNetworkIds.Preview,
      ]),
    );
    for (const [networkId, mode] of Object.entries(
      VERITEE_PROOF_SERVER_MODES,
    )) {
      if (!mode) throw new Error('Missing Veritee mode');
      expect(() =>
        createStoreVeriteeAttestedProver({
          networkId: networkId,
          proofServerApiUrl: mode.url,
          getLedgerIndexerUrl: async () => FIXTURE_CONFIG.indexerUrl,
          trustRoots: {
            amdRootCertificates: FIXTURE_CONFIG.amdRootCertificates,
          },
        }),
      ).not.toThrow();
    }
  });

  it('declares the AKX step plan', () => {
    const { driver } = createDriver();
    expect(driver.phases).toEqual([
      'obtain-evidence',
      'fetch-expected-values',
      'verify-locally',
      'warden-verify',
      'bind-channel',
    ]);
  });

  it('maps the pipeline phases in order and resolves to a prover', async () => {
    const { events, run } = createDriver();
    const prover = await run();

    expect(typeof prover.prove).toBe('function');
    expect(phaseEvents(events)).toEqual([
      'obtain-evidence:started',
      'obtain-evidence:completed',
      'fetch-expected-values:started',
      'fetch-expected-values:completed',
      'verify-locally:started',
      'verify-locally:completed',
      'warden-verify:started',
      'warden-verify:completed',
      'bind-channel:started',
      'bind-channel:completed',
    ]);
  });

  it('maps per-check events onto contract check IDs only', async () => {
    const { events, run } = createDriver();
    await run();

    const checks = events.flatMap(event =>
      event.type === 'check' ? [event.check] : [],
    );
    expect(checks.length).toBeGreaterThanOrEqual(8);
    for (const check of checks) {
      expect(CONTRACT_CHECK_IDS.has(check.id)).toBe(true);
      expect(check.status).toBe('passed');
    }
  });

  it('maps a failed local check to a typed error, after emitting its failed check event', async () => {
    const { dependencies, events, run } = createDriver();
    dependencies.localVerifier.failCheck = 'pcr15-recompute';

    await expect(run()).rejects.toMatchObject({
      name: 'VeriteeAttestationError',
      phase: 'verify-locally',
      checkId: 'pcr15-recompute',
    });
    const checks = events.flatMap(event =>
      event.type === 'check' ? [event.check] : [],
    );
    expect(checks).toContainEqual(
      expect.objectContaining({ id: 'pcr15-recompute', status: 'failed' }),
    );
    expect(phaseEvents(events)).toContain('verify-locally:failed');
  });

  it('maps a revoked registration to a fetch-expected-values failure', async () => {
    const { dependencies, run } = createDriver();
    dependencies.ledgerClient.simulateRevoked = true;

    await expect(run()).rejects.toMatchObject({
      phase: 'fetch-expected-values',
    });
    await expect(run()).rejects.toBeInstanceOf(VeriteeAttestationError);
  });

  it('maps a Warden rejection to a warden-verify failure', async () => {
    const { dependencies, run } = createDriver();
    dependencies.wardenClient.simulateRejection = true;

    await expect(run()).rejects.toMatchObject({ phase: 'warden-verify' });
  });

  it('maps a channel-binding failure to a bind-channel failure', async () => {
    const { dependencies, events, run } = createDriver();
    dependencies.channelBinder.simulateBindingFailure = true;

    await expect(run()).rejects.toMatchObject({ phase: 'bind-channel' });
    expect(phaseEvents(events)).toContain('bind-channel:failed');
  });
});

describe('explicit trust-root input', () => {
  it('uses only the supplied root snapshot, even if the caller later changes its source', async () => {
    const dependencies = createMockDependencies({ latencyMs: 0 });
    const verify = vi.spyOn(dependencies.localVerifier, 'verify');
    const roots = ['caller-selected-root'];
    const provider = createStoreVeriteeAttestedProver(
      {
        networkId: MidnightSDKNetworkIds.PreProd,
        proofServerApiUrl: VERITEE_PROOF_SERVER_URL,
        getLedgerIndexerUrl: async () => FIXTURE_CONFIG.indexerUrl,
        trustRoots: { amdRootCertificates: roots },
      },
      { dependencies, config: FIXTURE_CONFIG },
    );
    roots.push('later-root');
    const session = await provider.establishAttestedSession(() => undefined);
    expect(verify).toHaveBeenCalled();
    expect(verify.mock.calls[0][2]).toEqual(['caller-selected-root']);
    await session.close();
  });

  it('rejects an empty trust set instead of using bundled roots implicitly', () => {
    expect(() =>
      createStoreVeriteeAttestedProver({
        networkId: MidnightSDKNetworkIds.PreProd,
        proofServerApiUrl: VERITEE_PROOF_SERVER_URL,
        getLedgerIndexerUrl: async () => FIXTURE_CONFIG.indexerUrl,
        trustRoots: { amdRootCertificates: [] },
      }),
    ).toThrow('requires explicit AMD trust roots');
  });

  it('propagates rejection under the supplied roots before establishing a channel', async () => {
    const dependencies = createMockDependencies({ latencyMs: 0 });
    dependencies.localVerifier.failCheck = 'snp-signature-chain';
    const bind = vi.spyOn(dependencies.channelBinder, 'bind');
    const provider = createStoreVeriteeAttestedProver(
      {
        networkId: MidnightSDKNetworkIds.PreProd,
        proofServerApiUrl: VERITEE_PROOF_SERVER_URL,
        getLedgerIndexerUrl: async () => FIXTURE_CONFIG.indexerUrl,
        trustRoots: { amdRootCertificates: ['unaccepted-root'] },
      },
      { dependencies, config: FIXTURE_CONFIG },
    );
    await expect(
      provider.establishAttestedSession(() => undefined),
    ).rejects.toMatchObject({
      providerId: 'veritee',
      stage: 'appraisal',
      checkId: 'snp-signature-chain',
    });
    expect(bind).not.toHaveBeenCalled();
  });
});

describe('resolved measurement configuration', () => {
  it('passes the full current ledger indexer URL to a fresh ledger client on each run', async () => {
    const dependencies = createMockDependencies({ latencyMs: 0 });
    const ledgerFactory = vi
      .spyOn(RealLedgerClient, 'fromConfig')
      .mockReturnValue(
        dependencies.ledgerClient as unknown as RealLedgerClient,
      );
    const getLedgerIndexerUrl = vi
      .fn()
      .mockResolvedValueOnce('https://indexer.example/graphql?apiKey=first')
      .mockResolvedValueOnce('https://indexer.example/graphql?apiKey=second');
    const { ledgerClient: _, ...overrides } = dependencies;
    const provider = createStoreVeriteeAttestedProver(
      {
        networkId: MidnightSDKNetworkIds.PreProd,
        proofServerApiUrl: VERITEE_PROOF_SERVER_URL,
        trustRoots: { amdRootCertificates: FIXTURE_CONFIG.amdRootCertificates },
        getLedgerIndexerUrl,
      },
      { dependencies: overrides, config: FIXTURE_CONFIG },
    );
    try {
      for (const apiKey of ['first', 'second']) {
        const session = await provider.establishAttestedSession(
          () => undefined,
        );
        expect(ledgerFactory).toHaveBeenLastCalledWith(
          expect.objectContaining({
            indexerUrl: `https://indexer.example/graphql?apiKey=${apiKey}`,
          }),
          { fetchImpl: expect.any(Function) as typeof fetch },
        );
        await session.close();
      }
      expect(getLedgerIndexerUrl).toHaveBeenCalledTimes(2);
    } finally {
      ledgerFactory.mockRestore();
    }
  });

  it('preserves successful binary proof bodies and rejects upstream HTTP errors', async () => {
    const { dependencies, events, run } = createDriver();
    const session = await run();
    const channel = dependencies.channelBinder.channels[0];
    const prove = vi.spyOn(channel, 'prove');
    const body = new Uint8Array([0, 255, 128, 0]);
    prove.mockResolvedValueOnce({
      status: 200,
      headers: { 'content-type': 'application/octet-stream' },
      body,
    });
    await expect(session.prove(body)).resolves.toEqual(body);
    prove.mockResolvedValueOnce({
      status: 422,
      headers: { 'content-type': 'text/plain' },
      body,
    });
    await expect(session.prove(body)).rejects.toThrow(
      'Proof server returned 422 through the attested channel',
    );
    expect(events.at(-1)).toMatchObject({
      phase: 'proving',
      status: 'failed',
      detail: expect.stringMatching(
        /First failure: proof call #2: Proof server returned HTTP 422 inside the encrypted channel/,
      ) as string,
    });
    await session.close();
  });
});

it.each([
  [
    new DOMException('secret', 'TimeoutError'),
    'Encrypted proof request timed out',
  ],
  [
    new ChannelBindingError(
      'failed to reach https://secret/proxy: signal timed out',
    ),
    'Encrypted proof request timed out',
  ],
  [
    new ChannelBindingError(
      'failed to reach https://secret/proxy: signal is aborted without reason',
    ),
    'Encrypted proof request was aborted',
  ],
  [
    new ChannelBindingError(
      'https://secret/proxy returned HTTP 502 (upstream)',
    ),
    'Attestation proxy returned HTTP 502',
  ],
  [
    new ChannelBindingError(
      'failed to reach https://secret/proxy: Failed to fetch',
    ),
    'Encrypted proof request could not reach the attestation proxy',
  ],
  [
    new ChannelBindingError('proxy response failed authentication: secret'),
    'Encrypted proof response failed authentication',
  ],
  [
    new ChannelBindingError('malformed HTTP tunnel response: secret'),
    'Encrypted proof response could not be decoded',
  ],
  [
    new ChannelBindingError(
      'failed to parse JSON from https://secret/proxy: secret',
    ),
    'Encrypted proof response could not be decoded',
  ],
  [
    new Error('secret transaction material'),
    'Encrypted proof request failed (unclassified channel error)',
  ],
] as const)(
  'reports safe channel diagnostics for %s',
  async (error, detail) => {
    const { dependencies, events, run } = createDriver();
    const session = await run();
    const prove = vi
      .spyOn(dependencies.channelBinder.channels[0], 'prove')
      .mockRejectedValue(error);
    const now = vi
      .spyOn(performance, 'now')
      .mockReturnValueOnce(1000)
      .mockReturnValueOnce(31025);
    try {
      await expect(session.prove(new Uint8Array([1]))).rejects.toHaveProperty(
        'cause',
        error,
      );
      expect(events.at(-1)).toEqual({
        type: 'phase',
        phase: 'proving',
        status: 'failed',
        detail: expect.stringContaining(`${detail} (elapsed 30.0 s;`) as string,
      });
      expect(prove).toHaveBeenCalledTimes(1);
    } finally {
      now.mockRestore();
      await session.close();
    }
  },
);

it('aborts Veritee evidence requests instead of waiting for their network timeout', async () => {
  const signals: AbortSignal[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: unknown, init: RequestInit) => {
      const signal = init.signal!;
      signals.push(signal);
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            reject(
              signal.reason instanceof Error
                ? signal.reason
                : new Error('Proof cancelled'),
            );
          },
          { once: true },
        );
      });
    }),
  );
  try {
    const driver = createStoreVeriteeAttestedProver({
      networkId: MidnightSDKNetworkIds.PreProd,
      proofServerApiUrl: VERITEE_PROOF_SERVER_URL,
      getLedgerIndexerUrl: async () => FIXTURE_CONFIG.indexerUrl,
      trustRoots: { amdRootCertificates: FIXTURE_CONFIG.amdRootCertificates },
    });
    const abort = new AbortController();
    const result = driver.establishAttestedSession(() => {}, abort.signal);
    const rejected = expect(result).rejects.toThrow();
    await vi.waitFor(() => {
      expect(signals.length).toBeGreaterThan(0);
    });
    abort.abort(new Error('Proof cancelled'));
    await rejected;
    expect(signals.every(signal => signal.aborted)).toBe(true);
  } finally {
    vi.unstubAllGlobals();
  }
});

const createObservedDriver = (fetchImpl: typeof fetch) => {
  const context = createDriver(true);
  const binder = context.dependencies.channelBinder;
  const bind = binder.bind.bind(binder);
  vi.stubGlobal('fetch', fetchImpl);
  const factory = vi
    .spyOn(AkxChannelBinder, 'fromConfig')
    .mockImplementation((_config, options) => {
      const observed = options!.fetchImpl!;
      vi.spyOn(binder, 'bind').mockImplementation(async (...args) => {
        const channel = await bind(...args);
        await observed('https://secret/tee_attestation/session/complete', {
          method: 'POST',
        });
        vi.spyOn(channel, 'prove').mockImplementation(async () => {
          const response = await observed(
            'https://secret/tee_attestation/proxy',
            { method: 'POST' },
          );
          if (!response.ok)
            throw new ChannelBindingError(
              `https://secret/proxy returned HTTP ${response.status}`,
            );
          return { status: 200, headers: {}, body: new Uint8Array([1]) };
        });
        return channel;
      });
      return binder as unknown as AkxChannelBinder;
    });
  return {
    ...context,
    cleanup: () => {
      factory.mockRestore();
      vi.unstubAllGlobals();
    },
  };
};

it.each([false, true])(
  'preserves the first HTTP failure across overlapping requests (closed=%s)',
  async closeBeforeSecondFailure => {
    const first = Promise.withResolvers<Response>();
    const second = Promise.withResolvers<Response>();
    let requests = 0;
    const context = createObservedDriver(async input => {
      if (typeof input === 'string' && input.endsWith('/complete'))
        return new Response(null, { status: 204 });
      return ++requests === 1 ? first.promise : second.promise;
    });
    try {
      const session = await context.run();
      const results = Promise.allSettled([
        session.prove(new Uint8Array([1])),
        session.prove(new Uint8Array([2])),
      ]);
      await vi.waitFor(() => {
        expect(requests).toBe(2);
      });
      second.resolve(
        new Response('record authentication failed', { status: 400 }),
      );
      await vi.waitFor(() => {
        expect(context.events.at(-1)).toMatchObject({ status: 'failed' });
      });
      const before = context.events.length;
      if (closeBeforeSecondFailure) await session.close();
      first.resolve(
        new Response('unknown or expired session', { status: 404 }),
      );
      expect(
        (await results).every(result => result.status === 'rejected'),
      ).toBe(true);
      const detail = context.events.at(-1);
      expect(detail).toMatchObject({
        detail: expect.stringContaining(
          'First HTTP failure: #2 HTTP 400',
        ) as string,
      });
      const text = JSON.stringify(detail);
      expect(text).toContain('record authentication failed');
      expect(text).toContain('peak overlapping HTTP requests: 2');
      expect(text).toContain('handshake 1, age');
      expect(text).toContain('1 other HTTP requests in flight');
      expect(text).not.toContain('secret');
      if (closeBeforeSecondFailure) expect(context.events).toHaveLength(before);
      else {
        expect(text).toContain('#1 HTTP 404');
        expect(text).toContain('First failure: proof call #2');
      }
      await session.close();
    } finally {
      context.cleanup();
    }
  },
);

it.each([
  'unknown or expired session',
  'secret transaction body',
  'record authentication failed with secret data',
])(
  'distinguishes a first-request 404 and only displays exact allowlisted reasons: %s',
  async reason => {
    const context = createObservedDriver(async input =>
      typeof input === 'string' && input.endsWith('/complete')
        ? new Response(null, { status: 204 })
        : new Response(reason, { status: 404 }),
    );
    try {
      const session = await context.run();
      await expect(session.prove(new Uint8Array([1]))).rejects.toThrow();
      const text = JSON.stringify(context.events.at(-1));
      expect(text).toContain('First HTTP failure: #1 HTTP 404');
      expect(text).toContain('peak overlapping HTTP requests: 1');
      expect(text).toContain('0 other HTTP requests in flight');
      expect(text).toContain(
        reason === 'unknown or expired session'
          ? 'proxy reason: unknown or expired session'
          : 'proxy reason: reason unavailable',
      );
      expect(text).not.toContain('secret');
      await session.close();
    } finally {
      context.cleanup();
    }
  },
);

it('bounds HTTP history while retaining the first failure and resets it for a new session', async () => {
  const context = createObservedDriver(async input =>
    typeof input === 'string' && input.endsWith('/complete')
      ? new Response(null, { status: 204 })
      : new Response('unknown or expired session', { status: 404 }),
  );
  try {
    const session = await context.run();
    for (let index = 0; index < 20; index++)
      await expect(session.prove(new Uint8Array([1]))).rejects.toThrow();
    const event = context.events.at(-1);
    if (event?.type !== 'phase') throw new Error('Missing phase');
    expect(event.detail).toContain('First HTTP failure: #1 HTTP 404');
    expect(event.detail).toContain('Proxy requests: 20');
    expect(
      event.detail!.split('server arrival order is unknown):\n')[1].split('\n'),
    ).toHaveLength(12);
    await session.close();
    const fresh = await context.run();
    await expect(fresh.prove(new Uint8Array([1]))).rejects.toThrow();
    expect(context.events.at(-1)).toMatchObject({
      detail: expect.stringContaining('Proxy requests: 1;') as string,
    });
    await fresh.close();
  } finally {
    context.cleanup();
  }
});

it('reports session age for an isolated 404 without claiming expiry as the cause', async () => {
  let time = 1000;
  const now = vi.spyOn(performance, 'now').mockImplementation(() => time);
  const context = createObservedDriver(async input =>
    typeof input === 'string' && input.endsWith('/complete')
      ? new Response(null, { status: 204 })
      : new Response('unknown or expired session', { status: 404 }),
  );
  try {
    const session = await context.run();
    time += 301000;
    await expect(session.prove(new Uint8Array([1]))).rejects.toThrow();
    expect(context.events.at(-1)).toMatchObject({
      detail: expect.stringContaining(
        'handshake 1, age 301.000 s, 0 other HTTP requests',
      ) as string,
    });
    await session.close();
  } finally {
    now.mockRestore();
    context.cleanup();
  }
});

it.each(['fragmented', 'oversized', 'stalled'] as const)(
  'bounds diagnostic body reads and leaves the original response unread: %s',
  async scenario => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start: controller => {
          const encode = (text: string) => new TextEncoder().encode(text);
          if (scenario === 'fragmented') {
            controller.enqueue(encode('record authentication '));
            controller.enqueue(encode('failed'));
            controller.close();
          } else if (scenario === 'oversized') {
            controller.enqueue(encode('secret'.repeat(100)));
            controller.close();
          }
        },
      }),
      { status: 400 },
    );
    const context = createObservedDriver(async input =>
      typeof input === 'string' && input.endsWith('/complete')
        ? new Response(null, { status: 204 })
        : response,
    );
    try {
      const session = await context.run();
      await expect(session.prove(new Uint8Array([1]))).rejects.toThrow();
      expect(response.bodyUsed).toBe(false);
      const text = JSON.stringify(context.events.at(-1));
      expect(text).toContain(
        scenario === 'fragmented'
          ? 'proxy reason: record authentication failed'
          : 'proxy reason: reason unavailable',
      );
      expect(text).not.toContain('secret');
      await response.body?.cancel();
      await session.close();
    } finally {
      context.cleanup();
    }
  },
);
