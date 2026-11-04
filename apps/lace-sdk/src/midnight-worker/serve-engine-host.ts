import {
  ChannelName,
  exposeMessengerApi,
  generalizeBackgroundMessenger,
  isFactoryCallMessage,
  newMessageId,
} from '@lace-lib/extension-messaging';
import { filter, of, take } from 'rxjs';

import {
  clientIdOfChannel,
  MIDNIGHT_ENGINE_HOST_PROPERTIES,
  streamChannelsOf,
} from './engine-host-api';

import type {
  BackgroundMessenger,
  CompletionMessage,
  Messenger,
  MessengerPort,
  MinimalPort,
  MinimalRuntime,
} from '@lace-lib/extension-messaging';
import type { MidnightEngineHost } from '@lace-module/midnight-sync/sdk';
import type { Logger } from 'ts-log';

/**
 * Which clients' channels take a port. A client's channel takes one port, and none from when that port closes until
 * the host has detached the client: Messenger sends every answer to each port of a channel, so a page holding a second
 * port on another client's channel would receive that client's answers and could call as that client, and one that
 * took the channel before the detach ran could call as the client in between. Once the detach has settled, the host
 * holds nothing for that id, and the channel takes a port again.
 */
export type MidnightClientChannels = {
  /**
   * The worker Messenger's check of each port (its `isConnectionAuthorized`), which runs before the port joins its
   * channel. Every port that is not on a client's own channel passes, such as one of the channels Messenger derives
   * for a client's streams.
   */
  readonly isAdmitted: (port: MessengerPort) => boolean;
  /** Takes the client's channel for its first port; false when the channel is taken. */
  readonly take: (clientId: string) => boolean;
  /** Frees the client's channel once `detached` has settled, either way. */
  readonly freeOnceSettled: (
    clientId: string,
    detached: Promise<unknown>,
  ) => void;
};

/** The worker's record of its clients' channels, which the messenger and `serveMidnightEngineHost` share. */
export const createMidnightClientChannels = (): MidnightClientChannels => {
  const taken = new Set<string>();
  return {
    isAdmitted: port => {
      const clientId = clientIdOfChannel(port.name);
      return clientId === undefined || !taken.has(clientId);
    },
    take: clientId => {
      if (taken.has(clientId)) return false;
      taken.add(clientId);
      return true;
    },
    freeOnceSettled: (clientId, detached) => {
      void detached
        .catch(() => undefined)
        .then(() => {
          taken.delete(clientId);
        });
    },
  };
};

/** What `serveMidnightEngineHost` serves the host over. */
export type ServeMidnightEngineHostProps = {
  readonly host: MidnightEngineHost;
  /** The worker's SharedWorker host runtime, whose ports the messenger serves. */
  readonly runtime: Pick<MinimalRuntime, 'onConnect'>;
  /** Created with `channels.isAdmitted` as its `isConnectionAuthorized`. */
  readonly messenger: BackgroundMessenger;
  readonly channels: MidnightClientChannels;
  readonly logger: Logger;
};

// A request arrives decoded from the page, and the host copies and later zeroes the password it is given.
const withPasswordBytes = <
  Request extends { readonly password?: unknown } | undefined,
>(
  request: Request,
): Request => {
  if (request && !(request.password instanceof Uint8Array))
    throw new TypeError('Expected the Midnight password as bytes');
  return request;
};

// Messenger serializes an error with a `toJSON` method as that method's result alone. Effect's `FiberFailure`, which
// the wallet SDK rejects with, gives `{ _id, cause }`, so the page would get an `Error` with an empty message. Such an
// error crosses as a copy that keeps its name, message, stack and `code`, with the original as an own `cause`.
const carriedError = (error: unknown): unknown => {
  if (
    !(error instanceof Error) ||
    typeof (error as { toJSON?: unknown }).toJSON !== 'function'
  )
    return error;
  const copy: Error & { code?: unknown } = new Error(error.message);
  copy.name = error.name;
  copy.stack = error.stack;
  const { code } = error as { code?: unknown };
  if (code !== undefined) copy.code = code;
  // Assigned, not passed to the constructor: Messenger keeps only own enumerable fields besides the four above.
  copy.cause = error;
  return copy;
};

const carried = async <T>(result: Promise<T>): Promise<T> =>
  result.catch((error: unknown) => {
    throw carriedError(error);
  });

/**
 * The host as one client's channel serves it: a request naming another client is refused, since the host takes the
 * client id it is given as proof of the caller, and so is a password that is not bytes. Each operation's failure
 * reaches the page with its message.
 */
const hostForClient = (
  host: MidnightEngineHost,
  clientId: string,
): MidnightEngineHost => {
  const own = <
    Request extends {
      readonly clientId: string;
      readonly authority?: { readonly password?: unknown };
    },
  >(
    request: Request,
  ): Request => {
    if (request?.clientId !== clientId)
      throw new Error(
        'This Midnight worker channel serves another client: a call must name the client the channel is for',
      );
    withPasswordBytes(request.authority);
    return request;
  };
  return {
    attach: async request =>
      carried(host.attach(withPasswordBytes(own(request)))),
    detach: async caller => carried(host.detach(own(caller))),
    detachClient: async id => {
      own({ clientId: id });
      return carried(host.detachClient(id));
    },
    streams: caller => host.streams(own(caller)),
    build: async request => carried(host.build(own(request))),
    estimate: async request => carried(host.estimate(own(request))),
    sign: async request => carried(host.sign(own(request))),
    prove: async request => carried(host.prove(own(request))),
    discard: async request => carried(host.discard(own(request))),
    preparePendingActivity: async request =>
      carried(host.preparePendingActivity(own(request))),
    submit: async request => carried(host.submit(own(request))),
    signData: async request => carried(host.signData(own(request))),
    buildConnectorTransaction: async request =>
      carried(host.buildConnectorTransaction(own(request))),
    checkCircuit: async request => carried(host.checkCircuit(own(request))),
    proveCircuit: async request => carried(host.proveCircuit(own(request))),
    transactionHistoryEntry: async request =>
      carried(host.transactionHistoryEntry(own(request))),
    signTransaction: async request =>
      carried(host.signTransaction(own(request))),
    resetAccount: async request => carried(host.resetAccount(own(request))),
    resyncAll: async request => carried(host.resyncAll(own(request))),
    deleteWallet: async request => carried(host.deleteWallet(own(request))),
  };
};

// Messenger's consumer releases the streams of a `streams` call with a completion message on the call's channel once
// it drops them, and Messenger then ends their subscriptions and the last values it holds. A closed page sends none,
// so the worker delivers the message for it, then drops the channels, which Messenger keeps after a release.
const releaseStreams = (
  messenger: BackgroundMessenger,
  streamsChannel: ChannelName,
  port: MinimalPort,
) => {
  const release: CompletionMessage = {
    messageId: newMessageId(),
    subscribe: false,
  };
  messenger.getChannel(streamsChannel).message$.next({ data: release, port });
  messenger.shutdownChannel(streamsChannel);
  for (const channel of streamChannelsOf(streamsChannel)) {
    // Ends the posts of a stream the page never read: each waits, holding its value, for a port to join.
    messenger.getChannel(channel).ports$.complete();
    messenger.shutdownChannel(channel);
  }
};

/**
 * Serves the engine host to the app's pages, each client on its own channel, which takes one port at a time
 * (`MidnightClientChannels`). When a client's page closes or shuts its runtime down, its ports go: the worker shuts the
 * client's channels down, with the stream subscriptions and the last values they hold, and the host detaches the
 * client from every engine. A call still running then runs to its end, and its answer is dropped. Call it before the
 * runtime answers any handshake, so that no client's first port is missed.
 */
export const serveMidnightEngineHost = ({
  host,
  runtime,
  messenger,
  channels,
  logger,
}: ServeMidnightEngineHostProps): void => {
  runtime.onConnect.addListener((port: MessengerPort) => {
    const clientId = clientIdOfChannel(port.name);
    // A port the messenger refused reaches this listener too, and finds the channel taken.
    if (clientId === undefined || !channels.take(clientId)) return;
    const channel = generalizeBackgroundMessenger(
      ChannelName(port.name),
      messenger,
      logger,
    );
    const streamsChannels = new Set<ChannelName>();
    const streamsCalls = channel.message$.subscribe(({ data }) => {
      if (
        isFactoryCallMessage(data) &&
        data.factoryCall.method ===
          ('streams' satisfies keyof MidnightEngineHost)
      )
        streamsChannels.add(
          ChannelName.derive(channel.channel, data.factoryCall.channel),
        );
    });
    let isClosed = false;
    // A call still running when the page closes answers after its channel is shut down. Posting that answer would
    // create the channel again and leave the answer waiting there for a port until the worker ends, so it is dropped;
    // the call itself is never cut short, since an unsettled submission must settle.
    const answering: Messenger = {
      ...channel,
      postMessage: message =>
        isClosed ? of(undefined) : channel.postMessage(message),
    };
    const api = exposeMessengerApi(
      {
        api$: of(hostForClient(host, clientId)),
        properties: MIDNIGHT_ENGINE_HOST_PROPERTIES,
      },
      { messenger: answering, logger },
    );
    channel.disconnect$
      .pipe(
        filter(({ remaining }) => remaining.length === 0),
        take(1),
      )
      .subscribe(({ disconnected }) => {
        isClosed = true;
        streamsCalls.unsubscribe();
        api.shutdown();
        for (const streamsChannel of streamsChannels)
          releaseStreams(messenger, streamsChannel, disconnected);
        channels.freeOnceSettled(
          clientId,
          host.detachClient(clientId).catch((error: unknown) => {
            logger.error('Could not detach a closed Midnight client', error);
          }),
        );
      });
  });
};
