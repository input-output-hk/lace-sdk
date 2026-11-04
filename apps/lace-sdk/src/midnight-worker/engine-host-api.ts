import {
  ChannelName,
  RemoteApiPropertyType,
} from '@lace-lib/extension-messaging';

import type { RemoteApiProperties } from '@lace-lib/extension-messaging';
import type {
  MidnightEngineHost,
  MidnightSessionStreams,
} from '@lace-module/midnight-sync/sdk';

// How a page reaches the engine host in the worker over Messenger. Messenger sends each response and stream value to
// every port of a channel, so each client gets a channel of its own, named after its unguessable client id: another
// page's results never reach it.

const CHANNEL_PREFIX = 'lace-midnight-engine/';
const CLIENT_CHANNEL = new RegExp(
  `^${CHANNEL_PREFIX}([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$`,
);

/**
 * The Messenger channel of one client.
 *
 * @param clientId - The client's id, a random UUID.
 */
export const engineChannelOf = (clientId: string): ChannelName =>
  ChannelName(`${CHANNEL_PREFIX}${clientId}`);

/**
 * The client whose own channel a port joins; `undefined` for any other port, such as one of the channels Messenger
 * derives from a client's channel for its streams.
 *
 * @param channel - The port's name.
 */
export const clientIdOfChannel = (channel: string): string | undefined =>
  CLIENT_CHANNEL.exec(channel)?.[1];

// A method still pending when the worker ends rejects; it is never posted again, since the host may have run it.
const method = {
  propType: RemoteApiPropertyType.MethodReturningPromise,
  requestOptions: { onDisconnect: 'fail' },
} as const;

const STREAM_PROPERTIES: RemoteApiProperties<MidnightSessionStreams> = {
  address$: RemoteApiPropertyType.HotObservable,
  areKeysAvailable$: RemoteApiPropertyType.HotObservable,
  coinsByTokenType$: RemoteApiPropertyType.HotObservable,
  syncProgress$: RemoteApiPropertyType.HotObservable,
  transactionHistory$: RemoteApiPropertyType.HotObservable,
  stateView$: RemoteApiPropertyType.HotObservable,
  progress$: RemoteApiPropertyType.HotObservable,
  status$: RemoteApiPropertyType.HotObservable,
};

/** How Messenger carries each member of the engine host: one call per operation, and the streams per caller. */
export const MIDNIGHT_ENGINE_HOST_PROPERTIES: RemoteApiProperties<MidnightEngineHost> =
  {
    attach: method,
    detach: method,
    detachClient: method,
    // `streams` answers synchronously, so Messenger serves each caller's streams on a channel derived for them.
    streams: {
      propType: RemoteApiPropertyType.ApiFactory,
      getApiProperties: () => STREAM_PROPERTIES,
    },
    build: method,
    estimate: method,
    sign: method,
    prove: method,
    discard: method,
    preparePendingActivity: method,
    submit: method,
    signData: method,
    buildConnectorTransaction: method,
    checkCircuit: method,
    proveCircuit: method,
    transactionHistoryEntry: method,
    signTransaction: method,
    resetAccount: method,
    resyncAll: method,
    deleteWallet: method,
  };

/**
 * The channels Messenger derives from the channel of one `streams` call: one per stream.
 *
 * @param streamsChannel - The channel Messenger derives for the call from the client's channel.
 */
export const streamChannelsOf = (streamsChannel: ChannelName): ChannelName[] =>
  Object.keys(STREAM_PROPERTIES).map(stream =>
    ChannelName.derive(streamsChannel, stream),
  );

/**
 * The error classes a page restores from the worker by name. Others arrive as `Error` with their own properties,
 * which keeps the `reason` of the host's refusals.
 */
export const MIDNIGHT_ENGINE_ERROR_TYPES = [
  AggregateError,
  RangeError,
  TypeError,
];

/**
 * The `type` of the notice `{ type, message }` that the worker posts on the port of each page it holds when it fails,
 * just before it closes: its engine did not load, or it cannot hold the runtime lock through which pages learn that it
 * has gone. `message` is the error's message, a string; the worker sends nothing else of the error. The notice is not
 * a frame of the SharedWorker runtime: without it, a page waiting for its handshake would wait for its deadline, and a
 * page the worker served would not learn that it closed while another context held its lock.
 */
export const MIDNIGHT_WORKER_FAILED = 'lace-midnight-engine:worker-failed';
