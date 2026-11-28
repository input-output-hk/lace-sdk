import { ProtocolVersion } from '@midnightntwrk/wallet-sdk-abstractions';
import { Option } from 'effect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DustTimelineDiscovery } from '../../src/store/dust-timeline';

import type { DefaultDustConfiguration } from '@midnightntwrk/wallet-sdk/dust';

const config: Pick<
  DefaultDustConfiguration,
  'forks' | 'indexerClientConnection' | 'networkId'
> = {
  networkId: 'undeployed',
  forks: { v9: ProtocolVersion.ProtocolVersion(2_000_000n) },
  indexerClientConnection: {
    indexerHttpUrl: 'https://indexer.example/graphql',
  },
};
const entries = [
  { id: 2, protocolVersion: 1_000_000 },
  { id: 10, protocolVersion: 1_000_000 },
  { id: 21, protocolVersion: 2_000_000 },
  { id: 40, protocolVersion: 2_001_000 },
];
type Request = {
  type: string;
  id?: string;
  payload?: { query: string; variables: { id: number | null } };
};
class Socket {
  public static all: Socket[] = [];
  public static respond: (socket: Socket, request: Request) => void;
  public onopen: (() => void) | null = null;
  public onmessage: ((event: { data: string }) => void) | null = null;
  public onerror: (() => void) | null = null;
  public onclose: (() => void) | null = null;
  public closed = false;
  public requests: Request[] = [];
  public constructor(readonly url: string, readonly protocol: string) {
    Socket.all.push(this);
    queueMicrotask(() => this.onopen?.());
  }
  public send(raw: string) {
    const request = JSON.parse(raw) as Request;
    this.requests.push(request);
    Socket.respond(this, request);
  }
  public emit(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  public close() {
    this.closed = true;
  }
}
const respond = (socket: Socket, request: Request, events = entries) => {
  if (request.type === 'connection_init')
    socket.emit({ type: 'connection_ack' });
  if (request.type !== 'subscribe') return;
  const row = events.find(
    entry => entry.id >= (request.payload!.variables.id ?? 0),
  );
  if (row)
    socket.emit({
      type: 'next',
      id: request.id,
      payload: {
        data: { dustLedgerEvents: { ...row, maxId: events.at(-1)!.id } },
      },
    });
};
const find = async (
  discovery = new DustTimelineDiscovery(),
  signal = new AbortController().signal,
  configuration = config,
) => discovery.find(configuration, signal);
const tick = async () => vi.advanceTimersByTimeAsync(0);

describe('bounded shared DUST boundary discovery', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Socket.all = [];
    Socket.respond = respond;
    vi.stubGlobal('WebSocket', Socket);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('finds the exact last v8 event across gaps, without raw payloads or reused connections', async () => {
    const result = find();
    await tick();
    expect(Option.getOrNull((await result).start)).toEqual({
      cursor: 10n,
      version: config.forks.v9,
    });
    expect(Socket.all.length).toBeGreaterThan(2);
    for (const socket of Socket.all) {
      expect(socket.protocol).toBe('graphql-transport-ws');
      const queries = socket.requests.filter(r => r.type === 'subscribe');
      expect(queries).toHaveLength(1);
      expect(queries[0].payload!.query).not.toContain('raw');
      expect(socket.closed).toBe(true);
    }
    expect(vi.getTimerCount()).toBe(0);
  });
  it('shares one search between three accounts and never caches the completed result', async () => {
    const discovery = new DustTimelineDiscovery();
    const results = [find(discovery), find(discovery), find(discovery)];
    await tick();
    expect((await Promise.all(results)).map(r => r.outcome)).toEqual([
      'found',
      'found',
      'found',
    ]);
    const count = Socket.all.length;
    const later = find(discovery);
    await tick();
    await later;
    expect(Socket.all).toHaveLength(count * 2);
  });
  it.each(['network', 'endpoint', 'fork'] as const)(
    'does not share different %s configurations',
    async kind => {
      const changed = {
        ...config,
        ...(kind === 'network' ? { networkId: 'preview' as const } : {}),
        ...(kind === 'endpoint'
          ? {
              indexerClientConnection: {
                indexerHttpUrl: 'https://other.example/graphql',
              },
            }
          : {}),
        ...(kind === 'fork'
          ? { forks: { v9: ProtocolVersion.ProtocolVersion(2_001_000n) } }
          : {}),
      };
      const discovery = new DustTimelineDiscovery();
      const a = find(discovery),
        b = find(discovery, undefined, changed);
      await tick();
      await Promise.all([a, b]);
      expect(
        Socket.all.filter(s =>
          s.requests.some(
            r => r.type === 'subscribe' && r.payload!.variables.id === null,
          ),
        ),
      ).toHaveLength(2);
    },
  );
  it('detaches one account without cancelling a peer or a late joiner', async () => {
    Socket.respond = (socket, request) =>
      setTimeout(() => {
        respond(socket, request);
      }, 20);
    const discovery = new DustTimelineDiscovery(),
      controller = new AbortController();
    const a = find(discovery, controller.signal).catch(
        (error: Error) => error.message,
      ),
      b = find(discovery);
    await tick();
    controller.abort();
    const c = find(discovery);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await a).toContain('cancelled');
    expect((await b).outcome).toBe('found');
    expect(await c).toEqual(await b);
    expect(
      Socket.all.filter(s =>
        s.requests.some(
          r => r.type === 'subscribe' && r.payload!.variables.id === null,
        ),
      ),
    ).toHaveLength(1);
  });
  it('cancels before acknowledgement, closes the socket and allows immediate retry', async () => {
    Socket.respond = () => undefined;
    const discovery = new DustTimelineDiscovery(),
      controller = new AbortController();
    const first = find(discovery, controller.signal).catch(
      (error: Error) => error.message,
    );
    await tick();
    controller.abort();
    expect(await first).toContain('cancelled');
    expect(Socket.all[0].closed).toBe(true);
    Socket.respond = respond;
    const retry = find(discovery);
    await tick();
    expect((await retry).outcome).toBe('found');
    expect(vi.getTimerCount()).toBe(0);
  });
  it('never connects for an already cancelled account', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(find(undefined, controller.signal)).rejects.toThrow(
      'cancelled',
    );
    expect(Socket.all).toEqual([]);
  });

  it('preserves endpoint query parameters while deriving the WebSocket path', async () => {
    const result = find(undefined, undefined, {
      ...config,
      indexerClientConnection: {
        indexerHttpUrl: 'https://indexer.example/graphql/?project=test',
      },
    });
    await tick();
    expect((await result).outcome).toBe('found');
    expect(Socket.all[0].url).toBe(
      'wss://indexer.example/graphql/ws?project=test',
    );
  });

  it('retries after a transient failure instead of caching a missing boundary', async () => {
    Socket.respond = socket => socket.onerror?.();
    const discovery = new DustTimelineDiscovery();
    const failed = find(discovery);
    await tick();
    expect((await failed).outcome).toBe('unavailable');
    Socket.respond = respond;
    const retried = find(discovery);
    await tick();
    expect((await retried).outcome).toBe('found');
  });
  it('closes a silent connection at the per-lookup deadline even without an acknowledgement', async () => {
    Socket.respond = () => undefined;
    const result = find();
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await result).outcome).toBe('lookup-timeout');
    expect(Socket.all).toHaveLength(1);
    expect(Socket.all[0].closed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('aborts the active lookup at the overall deadline and starts no further lookups', async () => {
    Socket.respond = (socket, request) => {
      if (request.type === 'subscribe')
        setTimeout(() => {
          respond(socket, request);
        }, 9000);
      else respond(socket, request);
    };
    const result = find();
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await result).outcome).toBe('search-timeout');
    const count = Socket.all.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(Socket.all).toHaveLength(count);
    expect(Socket.all.every(s => s.closed)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each([{ events: entries.slice(0, 2) }, { events: entries.slice(2) }])(
    'does not invent a boundary on a single-version timeline',
    async ({ events }) => {
      Socket.respond = (socket, request) => {
        respond(socket, request, events);
      };
      const result = find();
      await tick();
      expect((await result).outcome).toBe('not-applicable');
      expect(Option.isNone((await result).start)).toBe(true);
    },
  );
  it.each([
    null,
    { id: -1, maxId: 40, protocolVersion: 2_000_000 },
    { id: 2, maxId: 1, protocolVersion: 2_000_000 },
  ])('falls back safely on malformed metadata %j', async row => {
    Socket.respond = (socket, request) => {
      if (request.type === 'subscribe')
        socket.emit({
          type: 'next',
          id: request.id,
          payload: { data: { dustLedgerEvents: row } },
        });
      else respond(socket, request);
    };
    const result = find();
    await tick();
    expect((await result).outcome).toBe('unavailable');
    expect(Socket.all.every(s => s.closed)).toBe(true);
  });
});
