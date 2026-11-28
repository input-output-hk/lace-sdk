import { ProtocolVersion } from '@midnightntwrk/wallet-sdk-abstractions';
import { Option } from 'effect';

import type {
  DefaultDustConfiguration,
  DustTimelineStartProbe,
} from '@midnightntwrk/wallet-sdk/dust';

type TimelineStart = Awaited<ReturnType<DustTimelineStartProbe>>;
type DiscoveryResult = {
  start: TimelineStart;
  outcome:
    | 'found'
    | 'lookup-timeout'
    | 'not-applicable'
    | 'search-timeout'
    | 'unavailable';
};
type Metadata = { id: number; maxId: number; protocolVersion: number };
const metadataQuery = `subscription DustBoundaryMetadata($id: Int) {
  dustLedgerEvents(id: $id) { id maxId protocolVersion }
}`;

const cancelled = () => new Error('Midnight wallet startup cancelled');
class LookupTimeout extends Error {}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;
const isIndex = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

// A cancelled replay can keep delivering queued frames. Each lookup owns a
// connection so that backlog cannot delay the next lookup's first result.
const firstEvent = async (
  url: string,
  id: number | null,
  signal: AbortSignal,
) =>
  new Promise<Metadata>((resolve, reject) => {
    if (signal.aborted) {
      reject(cancelled());
      return;
    }
    const socket = new WebSocket(url, 'graphql-transport-ws');
    let isSettled = false;
    let hasSubscribed = false;
    const finish = (error?: Error, value?: Metadata) => {
      if (isSettled) return;
      isSettled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
      // Closing must also work before connection_ack; awaiting graphql-ws
      // dispose here can wait indefinitely for that acknowledgement.
      try {
        socket.close();
      } catch {
        /* A failed connection may already be closed. */
      }
      if (error) reject(error);
      else resolve(value!);
    };
    const abort = () => {
      finish(cancelled());
    };
    const timer = setTimeout(() => {
      finish(new LookupTimeout());
    }, 10_000);
    signal.addEventListener('abort', abort, { once: true });
    socket.onopen = () => {
      socket.send(JSON.stringify({ type: 'connection_init' }));
    };
    socket.onerror = socket.onclose = () => {
      finish(new Error('DUST discovery connection failed'));
    };
    socket.onmessage = event => {
      if (isSettled) return;
      try {
        const message: unknown = JSON.parse(String(event.data));
        if (!isRecord(message)) throw new Error('Invalid discovery message');
        if (message.type === 'ping') {
          socket.send(
            JSON.stringify({ type: 'pong', payload: message.payload }),
          );
        } else if (message.type === 'connection_ack' && !hasSubscribed) {
          hasSubscribed = true;
          socket.send(
            JSON.stringify({
              id: 'boundary',
              type: 'subscribe',
              payload: { query: metadataQuery, variables: { id } },
            }),
          );
        } else if (message.id === 'boundary' && message.type === 'next') {
          const payload = message.payload;
          const data = isRecord(payload) && !payload.errors && payload.data;
          const row = isRecord(data) && data.dustLedgerEvents;
          if (
            !isRecord(row) ||
            !isIndex(row.id) ||
            !isIndex(row.maxId) ||
            !isIndex(row.protocolVersion) ||
            row.id > row.maxId ||
            (id !== null && row.id < id)
          )
            throw new Error('Invalid discovery metadata');
          socket.send(JSON.stringify({ id: 'boundary', type: 'complete' }));
          finish(undefined, {
            id: row.id,
            maxId: row.maxId,
            protocolVersion: row.protocolVersion,
          });
        } else if (message.type === 'error' || message.type === 'complete') {
          finish(new Error('DUST discovery ended without metadata'));
        }
      } catch {
        finish(new Error('Invalid DUST discovery response'));
      }
    };
  });

const search = async (
  httpUrl: string,
  boundary: bigint,
  signal: AbortSignal,
): Promise<TimelineStart> => {
  const endpoint = new URL(httpUrl);
  endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:';
  endpoint.pathname = `${endpoint.pathname.replace(/\/$/, '')}/ws`;
  const url = endpoint.toString();
  const first = await firstEvent(url, null, signal);
  const last = await firstEvent(url, first.maxId, signal);
  if (
    BigInt(first.protocolVersion) >= boundary ||
    BigInt(last.protocolVersion) < boundary
  )
    return Option.none();
  let low = first.id + 1;
  let high = last.id;
  let atHigh = last;
  // IDs have gaps shared with zswap. low - 1 must remain the last v8 DUST
  // event, not the first v9 event (which the resumed wallet must still read).
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const event = await firstEvent(url, middle, signal);
    if (
      event.id > atHigh.id ||
      (event.id === atHigh.id &&
        event.protocolVersion !== atHigh.protocolVersion)
    )
      throw new Error('DUST discovery timeline changed');
    if (BigInt(event.protocolVersion) >= boundary) {
      high = middle;
      atHigh = event;
    } else {
      low = event.id + 1;
    }
  }
  return Option.some({
    cursor: BigInt(low - 1),
    version: ProtocolVersion.ProtocolVersion(BigInt(atHigh.protocolVersion)),
  });
};

/** Shares only in-flight public discovery within one engine, never account state. */
export class DustTimelineDiscovery {
  private readonly pending = new Map<
    string,
    {
      controller: AbortController;
      consumers: Set<object>;
      result: Promise<DiscoveryResult>;
    }
  >();

  public async find(
    configuration: Pick<
      DefaultDustConfiguration,
      'forks' | 'indexerClientConnection' | 'networkId'
    >,
    signal: AbortSignal,
  ): Promise<DiscoveryResult> {
    if (signal.aborted) return Promise.reject(cancelled());
    const { indexerHttpUrl } = configuration.indexerClientConnection;
    const key = JSON.stringify([
      configuration.networkId,
      String(indexerHttpUrl),
      String(configuration.forks.v9),
    ]);
    let entry = this.pending.get(key);
    if (!entry) {
      const controller = new AbortController();
      let hasTimedOut = false;
      const timer = setTimeout(() => {
        hasTimedOut = true;
        controller.abort();
      }, 30_000);
      const result = search(
        indexerHttpUrl,
        configuration.forks.v9,
        controller.signal,
      )
        .then(
          (start): DiscoveryResult => ({
            start,
            outcome: Option.isSome(start) ? 'found' : 'not-applicable',
          }),
        )
        .catch(
          (error: unknown): DiscoveryResult => ({
            start: Option.none(),
            outcome: hasTimedOut
              ? 'search-timeout'
              : error instanceof LookupTimeout
              ? 'lookup-timeout'
              : 'unavailable',
          }),
        )
        .finally(() => {
          clearTimeout(timer);
          if (this.pending.get(key)?.controller === controller)
            this.pending.delete(key);
        });
      entry = { controller, consumers: new Set(), result };
      this.pending.set(key, entry);
    }
    const shared = entry;
    const consumer = {};
    shared.consumers.add(consumer);
    return new Promise((resolve, reject) => {
      const leave = () => {
        signal.removeEventListener('abort', abort);
        shared.consumers.delete(consumer);
        if (shared.consumers.size === 0) {
          if (this.pending.get(key) === shared) this.pending.delete(key);
          shared.controller.abort();
        }
      };
      const abort = () => {
        leave();
        reject(cancelled());
      };
      signal.addEventListener('abort', abort, { once: true });
      void shared.result.then(result => {
        leave();
        resolve(result);
      });
    });
  }
}
