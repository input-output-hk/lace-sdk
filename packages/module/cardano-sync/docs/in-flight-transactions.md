# In-flight Cardano transactions

A provider accepts a Cardano transaction before a block includes it and before the wallet's synced UTxOs show the spend.
The gap usually lasts from milliseconds up to a minute, and longer only in extreme cases. In that window the settled set
still lists the inputs the transaction spends. The wallet keeps them out of every build and every balance through one
record per transaction: an entry of `cardanoContext.inFlightTransactions`. This describes what an entry asserts, who
records it, who reads it and when it goes. Read it before adding a path that submits a Cardano transaction, a view of
UTxOs or balances, or a change to the settlement or expiry rules. The decision behind the store is [ADR
74](../../../../docs/adr/74-in-flight-cardano-transactions-store.md).

## What an entry asserts

An entry asserts that a provider accepted the transaction for one network, and that the wallet has neither seen the
transaction settle into its synced UTxOs nor proved that it can no longer settle.

- **Key.** `${CardanoNetworkId}:${txId}`. Preview and Preprod share address encodings, so the same body can be valid
  on both, and each network keeps its own entry.
- **Effects.** The effects the chain applies if the transaction lands, read from the signed bytes alone, own or not:
  every input the body spends, every output it produces and its reward withdrawals, or, for a transaction flagged
  `isValid` false, its collateral inputs and collateral return. They are stored serialized, since outputs carry
  `bigint` values and asset maps.
- **Bound.** `invalidHereafter`: the body's upper validity bound, else the cut-off below. Absent only for a body
  without a bound, until the first tip of its network that the wallet receives after recording it.
- **Time.** `submittedAt`: when the provider accepted the transaction, and the time of the Pending rows derived from
  the entry.
- **Lookup.** `lookup`: the provider's answer whether the chain holds the transaction, with its network's stored tip
  slot read before the question. Absent until the provider answers, which it is asked only once that tip is past the
  bound (see [Expiry](#expiry)).
- **No owner.** An entry names no account. Every view resolves, per account and at read time, which inputs and outputs
  are the account's own.

The store is persisted, so a reservation survives a reload. Resetting an account's sync state, removing an account and
resetting activities leave entries alone; on a network with no Cardano account left, the reconcile side effect drops an
entry once that network's tip is more than `UTXO_SYNC_CONFIRMATION_DEPTH` past its bound (see [Expiry](#expiry)).

## What every writer records

Every path that submits a Cardano transaction, or learns that one was submitted, records its entry with
`inFlightTransactionOf` (cardano-context), which decodes the signed bytes, and `recordInFlightTransaction`:

- **After acceptance, never before.** A refused submission records nothing. The SDK custody submission is the one
  exception: when the provider's answer times out, the outcome is unknown, and it records the entry anyway.
- **Keyed by the network the bytes went to,** read when the submission starts, not when the provider answers.
- **Once.** The reducer keeps the entry it already holds for a key unchanged: a repeated acceptance or a second
  writer never extends the bound or moves `submittedAt`.
- **Before the next build can read state.** A writer emits the entry first. The tx-executor flows get theirs from
  `recordSubmittedTransactions` on the same `txPhaseCompleted` the flow reacts to. A side effect's actions reach the
  store a macrotask after the action it reacts to, so the entry can land after the flow's own row and result, but
  before any action a side effect emits in reaction to them.
- **From bytes a provider accepted,** so decoding them does not fail. The SDK, the tx-executor recorder, the dApp
  connectors and the guest's pull still guard the decode and record nothing for a transaction whose bytes do not
  decode: the submission completes, a dApp is answered success, and the pull records the other transactions.

| Writer                                                                                                                                                                                                                                       | Where it records                                                                                                                                                                                                                                                                                                                      | Pending row                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SDK `submitCardanoTx`                                                                                                                                                                                                                        | cardano-sync `submitTxSideEffect`, on the provider's acceptance of `cardanoContext.submitTx`: the entry, then the rows, then `submitTxCompleted`, so the available set leaves the inputs out when the submission resolves                                                                                                             | One per account on the network that the wallet can tell, when the provider answers, the transaction spends from or pays, custody accounts included. Confirmed and feature rows stay unchanged. Derived rows retain provisional balance evidence; `publishInFlightActivities` adds rows and contributions as ownership becomes known.                                                                                                                                                      |
| SDK custody submission (`apps/lace-sdk/src/custody/submit-cardano-custody-transaction.ts`)                                                                                                                                                   | Through `submitTxSideEffect` on acceptance. A submission that times out has an unknown outcome and records the entry itself, before the custody row; a later acceptance keeps that entry.                                                                                                                                             | The custody row, carrying the `custody` metadata. It replaces by id the row `submitTxSideEffect` adds to the custody account on acceptance.                                                                                                                                                                                                                                                                                                                                               |
| Every flow that submits through the tx-executor's `submitTx` phase: send, staking delegation and deregistration, earn rewards, swap, RealFi orders, Composer, cNIGHT designation, collateral, vote delegation, wallet migration's delegation | blockchain-cardano `recordSubmittedTransactions`, on the phase's success, from the request's bytes, joined to the completion by `executionId`. It is registered in `init-full.ts`, which the SDK store does not load.                                                                                                                 | The flow's own row, if it writes one. It carries the balance change and feature metadata only (cNIGHT keeps `nightDesignation`). A flow without a row of its own (staking delegation and deregistration, earn rewards, vote delegation, Composer, collateral, RealFi cancel and withdrawal) gets its rows from `publishInFlightActivities`. That row has one change per token, the account's net with the fee, deposits, refunds and withdrawals included, as its confirmed activity has. |
| Wallet migration sweep (`migrate-wallet` `run-sweep.ts`)                                                                                                                                                                                     | On the provider's acceptance of each transaction, on the source's network: a chunked sweep records each chunk's entry before it signs the next chunk                                                                                                                                                                                  | The destination's incoming row and each paying source account's outgoing row, added with `addActivities` once every chunk is submitted, so a chunk that confirmed meanwhile keeps its confirmed activity. A sweep that pauses part-way adds no rows for the chunks it submitted; `publishInFlightActivities` adds them to the own accounts those chunks touch.                                                                                                                            |
| Multi-delegation migration (`migrate-multi-delegation`, both submit sites)                                                                                                                                                                   | On acceptance, before the row                                                                                                                                                                                                                                                                                                         | The signing account's row, added with `addActivities`.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| dApp connector, extension (`dapp-connector-cardano` browser side effects)                                                                                                                                                                    | On acceptance                                                                                                                                                                                                                                                                                                                         | None of its own: `publishInFlightActivities` adds the row of every own account the transaction touches.                                                                                                                                                                                                                                                                                                                                                                                   |
| dApp connector, mobile (`dapp-connector-cardano` mobile side effects)                                                                                                                                                                        | First action of the success branch, on the network the CIP-30 handler read when the submission started (`submittedTo` of its answer), guarded: the dApp is answered success whether or not the bytes decode                                                                                                                           | None of its own: `publishInFlightActivities` adds the row of every own account the transaction touches.                                                                                                                                                                                                                                                                                                                                                                                   |
| Guest `pullPendingTxs` (`cardano-host-pull`)                                                                                                                                                                                                 | Pulls at boot and whenever the guest regains focus, again 2, 5 and 10 s later, when the account set changes, and on each new tip of the active network. Each pull records one entry per transaction the host serves, on the pulled account's network, unless the store holds its entry or the account shows the transaction confirmed | The host-attributed account's row, unless the account holds an activity with the id, added with `addActivities`. The host's attribution resolves inputs the guest's host-adjusted UTxOs no longer list, so the publisher cannot derive this row.                                                                                                                                                                                                                                          |

Whatever rows a writer adds, `publishInFlightActivities` adds one to every other own account the transaction touches,
for the tx-executor flows and the other writers alike (see [Rows that follow ownership](#rows-that-follow-ownership)).

A new path that submits a Cardano transaction must record an entry. Without one its inputs stay offered until the
synced UTxOs or confirmed spent-input evidence show the spend, and a transaction built in that window is refused by the
node. A path through the tx-executor gets its entry from `recordSubmittedTransactions` without code of its own. A flow starts its next Cardano
build from a dispatched action, such as its state machine's transition, never in the pipeline that receives the submit
completion: a build requested there can read the state before the entry lands.

`test/submission-writers.test.ts` inventories the direct provider submission sites across application and package
sources, checks their recorder calls and the tx-executor recorder's registration, and fails on a new site, including
one added to an existing writer. Update that inventory together with behavioral tests proving that the new path
records on acceptance. The structural guard complements the writer tests; it does not prove submission ordering.

## Readers

The cardano-context selectors apply the entries of each account's network:

- `selectAvailableAccountUtxos`: what a transaction can spend. The settled set minus every outpoint an entry spends,
  plus every output an entry pays to the account that the set does not hold and no entry spends, minus the reserved
  collateral. Confirmed activities' `consumedInputs` also exclude outpoints from both the settled set and the outputs
  entries offer. It is order-free: a transaction recorded before the parent whose change it spends still reserves that
  change. Send, the tx-executor's signer, the dApp connectors' `getUtxos`, swap, RealFi, the migrations and the
  collateral flow's wait for its own output read it.
- `selectSettledAvailableAccountUtxos`: the settled UTxOs that `selectAvailableAccountUtxos` also lists, what a build
  that must not chain on unconfirmed outputs spends. The staking, governance, earn-rewards, Composer and cNIGHT builders
  read it through `txExecutorCardano.cardanoSettledAvailableAccountUtxos$`, carbon's Composer offers it as the inputs to pick, and the
  collateral flow picks from it.
- `selectAccountUtxosWithInFlight`: the balance view, the same adjustment without the reserved-collateral filter.
  Value in flight between own accounts counts once. The SDK's custody account reads what an entry spends from it.
- `selectCollateralOwnershipUtxos`: what a dApp's collateral return must treat as the account's own. The settled set
  plus the outputs entries pay to the account; it does not drop spent inputs, which exist on chain until the spend
  confirms.
- `selectSettledAccountUnspendableUtxos`: the reserved collateral a transaction can name now, settled with no known
  in-flight or confirmed spend. The browser dApp connector's `getCollateral` and swap read it; the mobile connector's
  `getCollateral` and the cNIGHT builder read it through `txExecutorCardano.cardanoSettledAccountUnspendableUtxos$`.
- `selectPendingRewardWithdrawals` and `selectRewardAccountDetailsWithInFlight`: rewards an entry already withdraws,
  so a builder does not withdraw them twice and the balance does not count them twice. The Send and deregistration
  builders read the first and skip a withdrawal while one is in flight, the deregistration builder through
  `txExecutorCardano.cardanoPendingRewardWithdrawals$`.
- `selectInFlightTransactions`: every entry with its effects decoded, across networks. An unchanged entry decodes to
  the same object on every emission. The lookup and reconcile side effects read it, and the SDK exposes it as
  `selectInFlightTransactions$`.

The in-flight views never read a Pending row's metadata. A Pending Cardano activity is a display row:
its balance change and feature metadata (`custody`, `nightDesignation`) and nothing in flight. Its link to the entry is
the transaction id, which the row carries as `activityId`. Readers that ask a display question still read rows: the
activity lists, the earn-rewards offer's `hasPendingTx` gate, the wallet sync reset gate, the cNIGHT designation gate,
the Hydra retagging and the SDK's custody operation listing.

Confirmed Cardano activities are different: their optional `consumedInputs` are chain evidence. Spend, balance and
nameable collateral views apply this evidence from every own account on the same network, even after the transaction's
in-flight entry leaves. Pending rows supply no such evidence. The collateral-ownership view remains additive and does
not apply the confirmed spent-input filter.

## Rows that follow ownership

A writer adds Pending rows only for the accounts it attributes the transaction to when it records. cardano-sync's
`publishInFlightActivities` adds the rest, for every entry whatever recorded it: each own account on the entry's
network that the wallet can tell the transaction touches gets a row once it can tell. An account is touched when its
ownership set (`selectCollateralOwnershipUtxos`) holds an input the transaction spends, or an output pays one of its
addresses. That covers:

- another own account the transaction pays, such as the receiving account of a transfer between your accounts;
- an account whose input becomes known later: the output of a transaction recorded after this one, or a UTxO the
  account's synced set lists only after a refetch.

The row is what `pendingActivityOf` derives from the entry: the account's own outputs minus its own inputs per token,
with the entry's `submittedAt` as its time. Rows from `inFlightPendingActivities` also carry `provisional` balance
evidence: immutable signed token changes keyed by each owned input and output. These contributions describe the display
amount only; no UTxO or reservation view reads them. The rules:

- **Provisional amounts follow ownership.** A child whose submission response arrives before its parent's can initially
  show only its own outputs. Once the parent identifies its input, the row includes that debit. `activities.addActivities`
  unions contributions by source, so an older publication, disappearing ownership or a reload cannot erase a resolved
  input. Repeated sources count once, and partial observations of different inputs combine.
- **Confirmed and feature rows stay.** Only marked, metadata-free Pending rows merge their provisional evidence.
  Unmarked rows, confirmed activities and rows carrying feature metadata stay unchanged. The check runs in
  `activities.addActivities` when the action applies, so a confirmed or feature row that lands after derivation stays
  protected. A flow's later row replaces the derived row through `upsertActivities` and omits `provisional`.
- **Custody accounts too.** A custody account gets its row like any other account. A custody operation's own row, which
  carries the `custody` metadata, takes its place whichever lands first, and the custody listing reads only rows with
  that metadata.
- **Changed evidence only.** A burst of state changes can deliver states that predate the published row. The publisher
  remembers its last derivation per entry and account and suppresses unchanged publications; changed ownership can
  publish new contributions even before an earlier publication reaches the reducer.
- **Nothing for a removed entry.** The reconcile removes an entry before its rows, and the publisher stops reading
  the entry once it is gone. A row it derived just before can still land after the removal; it then goes as a
  [Pending row without an entry](#pending-rows-without-an-entry).
- **Idle costs nothing.** With no entry the side effect reads no other state. `whileActive` (ADR 29) stops it while
  the wallet is locked.

A receiving own account therefore shows the transaction as Pending until its confirmed activity replaces the row or the
transaction expires, and the gates that ask whether an account has a pending transaction (the earn-rewards offer's
`hasPendingTx` gate and the wallet sync reset) hold on that account until then.

## Settlement

cardano-sync's `reconcileInFlightTransactions` removes an entry once all of these hold:

- **The network shows the transaction.** Some account on the entry's network holds it in its address history or holds a
  non-Pending activity with its id, or the provider answered that the chain holds it (see [Expiry](#expiry)). A synced
  UTxO under its id is no proof: the guest's host serves the outputs of a transaction it brokered under the
  transaction's id before the transaction lands.
- **The synced UTxOs reflect the spend.** No account on the network still lists an input the transaction spends among
  its synced UTxOs.
- **No entry it spends from stays.** A transaction that spends an output of an entry that stays is kept with it,
  transitively. That entry offers the output, and synced UTxOs from before it list none of its outputs, so the absence
  of the input proves nothing.

Until then the entry stays: its inputs stay out of the available set while the settled set or a parent entry offers
them, and its outputs dedupe against the settled set by outpoint, so keeping it costs nothing. The UTxO refetch
therefore bounds the reservation of a transaction that settled. Settlement removes no activity: the confirmed activity
replaces the Pending row by id when history maps it.

Acceptance responses can arrive out of order with confirmation. A child can confirm and reconcile while its parent's
entry is still absent. If the parent entry arrives later, the child's retained confirmed `consumedInputs` prevent the
parent's spent change from reappearing in spend or balance views. The same filter excludes original inputs that retained
confirmed activities identify as spent, even while the synced snapshot still lists them. This works with unchanged
confirmed activities; it does not require history to emit again. Unspent outputs the parent offers remain available for
unconfirmed chaining. Missing or pruned confirmed spent-input evidence limits this protection (see [Residual
exposures](#residual-exposures)).

## Expiry

An entry whose network does not show the transaction expires once the provider proves that it can no longer settle.
cardano-sync's `lookUpInFlightTransactions` asks the provider about an entry (`CardanoProvider.checkTransaction`, one
light request) once the entry has a bound and its network's stored tip is more than `UTXO_SYNC_CONFIRMATION_DEPTH` (60
slots) past it, the lag the wallet allows its provider. It reads that tip slot before the request and records it with
the answer on the entry (`recordInFlightTransactionLookup`). The reconcile then decides from state alone:

- **The provider does not hold the transaction:** the entry expires. When asked, the provider's index was past the
  bound, so the transaction can no longer be included anywhere on the network.
- **The provider holds it:** the entry counts as shown and goes by [settlement](#settlement). That covers a transaction
  that landed but that no account's history shows, such as one that pays no own address.
- **The provider cannot answer:** nothing is recorded, and the side effect asks again once the network's stored tip
  moves, so an unavailable provider costs one request per tip poll.
- **The network has no Cardano account:** the entry also goes once the network's stored tip is more than
  `UTXO_SYNC_CONFIRMATION_DEPTH` past its bound. No account shows the transaction or reads its reservation there, so
  the tip suffices. The rule keeps the entry of a transaction recorded before its account exists, as a custody
  account's creation is, and lets the entries of a removed wallet go.

The provider is the proof because it decides every case alike: an account whose busy addresses' stored history does not
reach back to the submission, a restored wallet, an account whose sync fails or that has no address yet, and a
transaction no own account shows. Pending rows prove nothing about chain inclusion or absence. An entry that reaches its
bound costs one request, more only while the provider does not answer.

An entry its network shows never expires. It goes only by settlement. The answer persists with the entry, so a reload
or an unlock decides from it without asking again. `whileActive` (ADR 29) stops both side effects while the wallet is
locked.

On expiry the side effect removes the entry and the Pending rows with the transaction's id, one
`activities.removeActivities` per account. Settled and expired entries leave in one `removeInFlightTransactions`.

## Descendants

A transaction that can no longer settle takes with it every entry on its network that spends one of its outputs,
transitively, whatever their own bounds, and their Pending rows. A descendant its network shows is not taken: it
settles by its own entry, once no entry it spends from stays. An entry still without a bound expires only this way.

## Pending rows without an entry

A Pending Cardano row usually goes with its entry: history replaces it once the transaction lands, and the reconcile
removes it when the entry expires. Some rows have no entry: a row from a build before this store, a row the publisher or
the guest's pull lands just after the reconcile removed its entry, a flow's row whose bytes the recorder could not
decode, and a row an SDK app dispatches itself. cardano-sync's `expirePendingActivitiesWithoutEntry` removes them on the
proof expiry uses. It asks the provider about the row's transaction (`CardanoProvider.checkTransaction`) once all of
these hold:

- **No entry.** The store holds no entry for the transaction on the row's network.
- **A transaction id.** The activity id has exactly 64 hexadecimal characters. Other application-defined ids are not
  transaction hashes and are never sent to the provider or removed by this expiry check.
- **The network does not show it.** No account on the network holds the transaction in its history or holds a
  non-Pending activity with its id. A row whose entry settled before its own account's history mapped the transaction
  therefore stays.
- **The transaction may no longer land.** For a row that records its transaction's bound, as a custody operation's
  row does (`custody.invalidHereafter`), the network's stored tip is more than `UTXO_SYNC_CONFIRMATION_DEPTH` past that
  bound. For any other row, the transaction's newest row is older than `UNBOUNDED_IN_FLIGHT_SLOTS` plus that depth, in
  seconds: about two hours, the cut-off an entry without a bound gets, so a row never goes earlier than an entry would.
  A flow's row that lands a macrotask before its entry is never asked about.

When the provider does not hold the transaction, the side effect removes the Pending rows with its id from every
account on the network, one `activities.removeActivities` with `onlyPending: true` per account. The reducer checks the
row's type when the removal applies, so a row confirmed during the lookup or before dispatch stays. The time is only a throttle; the provider's
answer is the proof. A transaction the provider holds keeps its rows until history replaces them, and is not asked
about again while the wallet stays unlocked. A failed request is asked again once the network's stored tip moves, so
on a network that is not active it waits until that network is. A transaction valid for more than about two hours that
is still waiting in a mempool when asked loses its rows, and shows when history brings it. `whileActive` (ADR 29)
stops the side effect while the wallet is locked.

## The cut-off

`recordInFlightTransaction` stores a body without an upper validity bound without one, whatever wrote the entry. The
next `setTip` for the entry's network gives it a bound of that tip plus `UNBOUNDED_IN_FLIGHT_SLOTS` (7200 slots, about
two hours). Only the tip poll (`trackTip`) dispatches `setTip`; a tip restored from storage does not, so the cut-off
counts from a tip the wallet received after the entry was recorded, never from one hours old. The bound is never
extended afterwards. A transaction without a validity interval that never lands therefore stops reserving its inputs,
and its Pending rows go, about two hours after acceptance; one that lands later than that shows when history brings
it. The SDK documents this on `submitCardanoTx`.

## Reserved collateral and the collateral flow

- `selectAvailableAccountUtxos` applies the entries and confirmed spent-input filter, then subtracts the reserved
  collateral last, by outpoint. A reserved output stays out whether it is settled, produced by an entry, or both: the chain refresh can settle the
  output, and the collateral flow reserve it, while its transaction is still in flight.
- The balance view keeps counting the reserved collateral, and the ownership view keeps the inputs entries spend.
- A reservation holds while the ownership view holds its outpoint (`syncUnspendableUtxosWithAccountUtxos`). An output
  reserved while its transaction is in flight therefore stays reserved through settlement, and the reservation goes if
  the entry expires or once a spend of the output settles.
- The collateral flow picks an existing eligible UTxO from `selectSettledAvailableAccountUtxos`: settled, with no known
  in-flight or confirmed spend, and not reserved. It reserves the pick when the user confirms only if that still holds,
  and fails the flow otherwise.
- The collateral flow's own transaction goes through the tx-executor, so its entry reserves its inputs while it is in
  flight. The flow reserves that transaction's output as soon as the entry offers it in the available set, a macrotask
  or two after the entry, and completes then. It waits while another entry spends the output.
- `selectSettledAccountUnspendableUtxos` is the reserved collateral that is settled with no known in-flight or confirmed spend.
  `getCollateral`, the swap aggregator and the cNIGHT builder are handed only that, so they never name collateral the
  chain does not hold yet.

## Bitcoin

Bitcoin keeps its in-flight effects on its Pending rows. Its `submitTx` returns the consumed inputs and produced
outputs as row metadata, which `pendingActivityMetadata` (tx-executor) puts on the flow's row, and its views read the
rows. A bitcoin-context store of the same shape, keyed by network with the effects and a time bound, would move it to
this model without changes to the tx-executor or activities contracts.

## Residual exposures

- **Expiry waits for the network's tip.** The tip poll runs for the active network only, so an entry on another network
  keeps its reservation until that network is active again and its tip passes the bound.
- **The cut-off waits for a tip.** The tip poll runs for the active network only, and only while the wallet is
  unlocked. An entry without a body bound that is recorded for another network, or just before the wallet locks, gets
  its cut-off only from the first tip after that, so it reserves its inputs that much longer.
- **Expiry needs the provider.** A provider that does not answer delays expiry. One whose index lags more than
  `UTXO_SYNC_CONFIRMATION_DEPTH` behind the tip it reports can make the wallet drop the entry of a transaction that
  landed: without confirmed spent-input evidence, its inputs are then offered until the UTxO refetch, and the node
  refuses a transaction built on them.
- **Script failure with a flipped flag.** The node refuses a transaction whose `isValid` flag disagrees with its
  scripts, so an entry records the effects its transaction lands with. The signatures do not cover the flag, though:
  once the scripts' result changes, as after a cost-model change, anyone holding the bytes can resubmit them with the
  flag flipped, and the chain applies the effects the entry does not record. Its network shows the transaction, but
  the synced UTxOs keep listing what the entry spends, so the entry never settles, and an entry its network shows
  never expires. What it spends stays reserved and what it pays stays offered until every Cardano account on its
  network is removed.
- **Stale UTxOs after settlement.** Once a settlement is reflected and its entry removed, a provider can serve an
  older UTxO set again. Retained confirmed `consumedInputs` keep known spent inputs out of spend, balance and nameable
  collateral views. Inputs without that evidence can still be offered until the refetch converges.
- **Missing or pruned confirmed evidence.** The confirmed spent-input filter reads retained activities, not a permanent
  archive of spent outpoints. A confirmed activity without `consumedInputs`, or one that has been removed or pruned,
  supplies no evidence. Once the spending entry leaves, a stale synced snapshot or delayed parent entry can offer that
  spent outpoint again until the snapshot converges or confirmed evidence becomes available.
- **Rolled-back confirmed evidence.** The confirmed spent-input filter has no depth bound. If a confirmed transaction
  is rolled back and never included again, its retained activity can keep otherwise unspent inputs out of balance,
  spending and nameable collateral until a wallet re-sync clears that activity. Advancing the tip alone does not
  release them. `UTXO_SYNC_CONFIRMATION_DEPTH` is a provider-lag allowance, not proof that retained evidence is stale;
  dropping it after that interval could offer spent change from a delayed parent or stale UTxO snapshot again.
- **Nothing to spend until the refetch.** The staking, governance, earn-rewards, Composer and cNIGHT builders do not
  chain on unconfirmed outputs. Right after a transaction spends an account's UTxOs, they can spend only what it left
  until the UTxO refetch lists its change. When that is not enough, they fail at build, with an input-selection or
  no-UTxO error, rather than at submit.
- **Outputs after settlement.** Settlement asks whether the synced UTxOs reflect the spend, not whether they list the
  outputs. An own account the transaction pays whose synced UTxOs predate it stops counting the incoming output in its
  balance and available set once the entry settles, until that account's refetch: the amount reads low, never high.
  The outputs are no proof of settlement: the guest's host lists a brokered transaction's outputs before it lands, and
  a transaction can pay no own account.
- **Withdrawals after settlement.** A settled entry keeps its withdrawals subtracted from the reward balance until the
  UTxO refetch reflects the spend. `applyPendingRewardWithdrawals` clamps at zero, so a reward balance can read low for
  that window when new rewards arrive in it.
- **Stale reward details after settlement.** Once an entry that withdraws rewards settles and is removed, the fetched
  reward details can still show the withdrawn balance until `trackRewardAccountDetails` refetches them. A
  deregistration, or a Send that withdraws rewards, built in that window names that stale amount, and the node refuses
  it.
- **SDK timeout.** `submitCardanoTx` gives up after 60 seconds. A non-custody submission records nothing unless the
  provider answers later; if that answer is lost, its inputs are offered until the synced UTxOs or confirmed spent-input
  evidence show the spend.
- **The window before a collateral reservation lands.** The collateral flow reserves its transaction's output a
  macrotask or two after the entry offers it. A build that reads the available set in that window can pick the output.
  Its entry lands only after it is signed and submitted, by when the flow has reserved the output and completed. That
  transaction then spends the collateral, and the reservation goes once the spend settles, so the account has no
  collateral until it is set again.
- **Guest double application.** The guest's host already adjusts the UTxOs it serves for transactions it brokered, and
  the guest applies its own entries for the same transactions on top. Both remove inputs and add outputs by outpoint,
  so applying them twice changes nothing; a change that made either side count by value would count the transaction
  twice. The host lists a brokered transaction's own outputs under its id before it lands, which is why a synced UTxO
  does not settle an entry.
