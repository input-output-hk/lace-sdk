# Midnight sync

## Startup and DUST recovery

Here, SDK refers to the Midnight Wallet SDK (`@midnightntwrk/wallet-sdk`),
which provides the wallet engine used by the monolith and the Lace SDK (`@laceio/sdk`).
The v8/v9 boundary below refers to ledger protocol epochs, not SDK releases.

The startup coordinator serializes local snapshot restoration and key derivation.
Accounts awaiting storage or authentication leave preparation membership until
their inputs arrive, so they cannot indefinitely hold ready accounts. Returning
accounts queue local work behind any active DUST discovery.

Once the ready accounts finish local preparation, fresh DUST wallets (including
authorized DUST-only rebuilds) discover their v8/v9 boundary before SDK wallet
initialization. Restored accounts in the same group wait for that phase before
starting replay and persistence. Ordinary restores retain their checkpoint and
do not request discovery.

`DustTimelineDiscovery` shares only in-flight public metadata for the same
network, HTTP indexer endpoint and fork boundary within one engine. Each binary
search lookup owns a WebSocket connection and requests only `id`, `maxId` and
`protocolVersion`. Closing that connection prevents a previous subscription's
queued replay from blocking the next lookup. The returned cursor is the last
v8 DUST event, accounting for gaps in the shared event-ID sequence; the first v9
event must still be applied by the wallet.

The limits remain 10 seconds per lookup and 30 seconds for discovery overall.
Failure closes the active connection before returning the SDK fallback result.
Removing one account detaches it; removing the final consumer aborts the search.
No completed result or failure is cached. The SDK receives a prepared probe
result, so it cannot launch another independently timed DUST search during
initialization. Diagnostics distinguish lookup timeout, overall timeout and
unavailable metadata without logging endpoints or wallet data.

This scheduling does not stop already-running wallets or other chains. Later
startup groups can still compete with earlier replay, persistence or SDK
initialization. Timers cannot preempt synchronous JavaScript/WASM.

The extension's expanded account sync status uses a filled lightning bolt for an account
whose DUST wallet reports projection sync. This records the observed mode, not
just the Faster DUST preference, and survives DUST completion, overall completion
and failures. The bolt uses the same syncing, synced and error colours as the dot.
An observed event-sync state clears the marker; resetting or removing an account
clears its sync record. The last observed mode is persisted for display during
restoration after a full extension reload. Unknown SDK progress leaves it intact
until a confirmed mode arrives; it does not imply that the current session has
synced. Older profiles establish it on their first observed SDK progress. The
aggregate pill always keeps its dot.

Tests cover exact cursors across gaps, fresh SDK event/projection initialization,
fallback, restore preservation, sharing and cancellation, delayed inputs and
startup ordering. Synthetic metadata fixtures do not establish funded-wallet
balances or transaction correctness; manual multi-wallet qualification remains
necessary before release.
