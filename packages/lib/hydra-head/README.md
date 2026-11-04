# @lace-lib/hydra-head

Pure, IO-free primitives for recognising [Hydra](https://hydra.family) Head
activity on Cardano layer 1. Hydra moves funds into a head by depositing them
at a deposit validator, holds them at a head validator while the head is open,
and returns them to layer 1 by recover, decommit or fanout.

## Relation to the draft CIP

The Hydra team's draft CIP
[Hydra Head UTxO Recognition](https://github.com/cardano-foundation/CIPs/pull/1254)
defines how a wallet recognises Hydra heads and verifies in-head balances.
This library implements its layer 1 parts:

- locating a head state UTxO and reading its state datum (steps 1 and 2);
- recognising deposits at the deposit validator, with their pending or
  recoverable status from the deadline (step 8);
- the closing head state with its contestation deadline (part of step 9).

It does not implement the verified in-head balance from the participants'
signed snapshot (steps 3 to 7), so it never tells what an account holds
inside an open head. The CIP covers only `HydraHeadV2` heads; the library
also reads the `HydraHeadV1` heads of releases 0.13.0 to 1.3.0, which goes
beyond it.

## What it provides

- **Script registry**: head and deposit validator addresses per Hydra protocol
  version, split into a testnet registry (Preprod and Preview share addresses)
  and a mainnet registry, with the head minting script template of each
  release. Deposit validators exist from version 0.20.0.
  Lookups are constant-time set and map reads.
- **State token names**: the hex asset names of the head state token
  (`HydraHeadV1`, `HydraHeadV2`). The policy id of that token is the head id.
- **Metadata marker**: every Hydra node transaction carries label `55555` with
  a text value such as `HydraV2/DepositTx`. `parseHydraTxTag` returns the
  protocol and transaction name.
- **Datum decoding**: `decodeHydraDepositDatum` and `decodeHydraHeadState`
  read deposit and head datums. Malformed or foreign datums return
  `undefined`; the decoders never throw.
- **Account matchers**: `findAccountHydraDeposits` and `findAccountHydraHeads`
  pick an account's deposits and heads out of the UTxOs at the validator
  addresses, matching exactly on decoded payment key hashes.
  `findHydraHeadsById` picks heads by id for an account that deposited into
  them without holding a participation token.
- **Genuine heads**: `isHydraHeadMintingScript` tells whether a script is
  the Hydra head minting script of a head, which proves the head genuine.
- **Address classification**: `classifyHydraTxByAddresses` names the Hydra
  action of a transaction from where its inputs and outputs sit, for
  consumers that have resolved inputs but no metadata.
- **Funds reconstruction**: `reconstructHydraHeadFunds` tells what a head
  absorbed that was committed to an account's keys and what it paid back to
  them, from the head's layer 1 history.
- **Positions and cards**: `toHydraHeadPositions` tells where an account
  stands in each head it has funds in at a given instant, and when that next
  changes; `toHydraHeadCards` tells what the card of each head says, so every
  consumer shows the same figures.
- **History read limits**: `HYDRA_HEAD_HISTORY_LIMITS` bounds how much of
  the layer 1 history a consumer reads to reconstruct those funds.
- **Sweep policy**: the rules every wallet stack sweeps with, so the stacks
  keep only their IO. `getHydraValidatorAddresses` and
  `HYDRA_VALIDATOR_READ_LIMITS` say what a sweep reads and
  `settleHydraValidatorReads` what it goes on from. `matchAccountHydra`
  matches an account, `findHydraDepositedHeadIds` takes the head hints from
  its own deposits, `selectHydraHeadsToCheck` and `selectHydraHeadsToRead`
  pick the heads whose minting script and history are read, and
  `settleHydraAccountHeads` which heads are listed and which head ids are
  kept. `getHydraHeadHistoryWindow`, `continuesHydraHeadHistory` and
  `countHydraHeadHistoryOutsideInputs` continue a kept history, and
  `getHydraHeadAccountFunds` gives figures only for a history that ends at
  the head UTxO found.
- **UTxO converters**: the matchers read a plain `HydraUtxo`.
  `fromCardanoUtxo` builds it from a `@cardano-sdk/core` UTxO and
  `fromBlockfrostUtxo` from Blockfrost JSON, so both feed the same logic.

## Deposits

A deposit UTxO sits at the deposit validator. Its inline datum is the tuple
`(headId, deadline, [Commit])`, where `deadline` is a POSIX time in
milliseconds and each `Commit` holds the spent output reference and the
committed output. The committed output is CBOR of its Plutus ledger API
`TxOut` encoding (address, value, datum, reference script), not a ledger
transaction output, so the depositor's address and value are rebuilt from
Plutus data. The deadline is given in epoch milliseconds, like every instant
the library takes or gives. A deadline before the epoch or beyond the range a
JavaScript `Date` can hold makes the datum undecodable, and the same applies
to the contestation deadline of a head.

Committed values are read strictly. The ledger never stores a zero or
negative quantity in an output and every output holds some lovelace, so a
value without lovelace, with a quantity of zero or less, with a policy that
holds no tokens, or with a repeated policy id or asset name makes the datum
undecodable. Output and pointer indexes beyond the largest safe JavaScript
integer do too. Without these rules a datum could commit a large amount to
one key and a negative amount to another, and still add up to what the
deposit holds.

A deposit UTxO holds exactly the outputs its datum commits, but anyone can
pay a little ada to the deposit validator with a datum claiming any amount
for any key. `findAccountHydraDeposits` therefore reports a deposit only when
its committed values add up exactly to the value of the UTxO.

The head may absorb a deposit while the transaction validity ends at or
before the deadline. Recover needs the validity to start strictly after it,
so a deposit is `pending` up to and including the deadline and `recoverable`
afterwards. `getHydraDepositStatus` applies that rule, so a consumer holding a
deposit found earlier can tell its status at any later instant.

## Heads

A head UTxO sits at the head validator of its release and holds the state
token, whose policy id is the head id, plus one participation token per
participant named after the participant's payment key hash. Releases up to
1.3.0 name the state token `HydraHeadV1` and releases from 2.0.0
`HydraHeadV2`.

The head datum layout changes between releases independently of the token
name, so `decodeHydraHeadState` takes the release, which the head address
reveals. Each registered release maps to one of these layouts, as declared in
`Hydra.Contract.HeadState` of that release:

| Releases        | 0                 | 1                          | 2                          | 3                                 |
| --------------- | ----------------- | -------------------------- | -------------------------- | --------------------------------- |
| 0.13.0 - 0.16.0 | `Initial` (4)     | `Open` (4)                 | `Closed` (7, at 3)         | `Final`                           |
| 0.18.0, 0.19.0  | `Initial` (4)     | `Open` record (5)          | `Closed` record (9, at 8)  | `Final`                           |
| 0.20.0 - 1.3.0  | `Initial` (4)     | `Open` record (5)          | `Closed` record (10, at 9) | `Final`                           |
| 2.0.0, 2.1.0    | `Open` record (6) | `Closed` record (10, at 9) | `Final`                    |                                   |
| 2.2.0, 2.3.0    | `Open` record (7) | `Closed` record (9, at 6)  | `Final`                    | `FanoutProgress` record (5, at 2) |

Columns are constructor alternatives. Numbers give the field count and the
position of the contestation deadline. Up to 0.16.0 the fields sit directly
on the constructor; later releases wrap them in a record that is the
constructor's single field.

Releases from 2.0.0 have no initial state: the init transaction opens the
head and funds join it through deposits. From 2.2.0 a large head is fanned
out over several transactions, tagged `PartialFanoutTx`, during which the
head UTxO carries `FanoutProgress`. From 2.3.0 the last of them is tagged
`FinalPartialFanoutTx`. Releases up to 1.3.0 keep participation
tokens at the initial validator until collected, so an `initial` head never
matches an account.

Constructors and field counts are checked strictly against the layout of the
release, so a datum that does not fit is skipped rather than misread, and a
release missing from the registry decodes nothing. Every registered release
is covered. Heads of 0.13.0 store a datum hash instead of an inline datum, so
`findAccountHydraHeads` skips them unless the caller resolves the datum and
passes it as the inline datum.

## Genuine heads

A head counts only when its id is the policy id of the Hydra head minting
script of a known release. Anyone can pay a lookalike state token and
participation tokens under a policy of their own to a head validator, but
only the real minting script can mint tokens under the real head id, so a
head that fails this check is a lookalike and is ignored: it gets no
figures and no card.

Every head of a release is minted by the same script applied to the seed,
the output reference its init transaction spends. The registry keeps a
template of that script per release: its Plutus language, the length and
digest of the fixed code before the seed, and how the seed is applied.
`isHydraHeadMintingScript(headId, headAddress, scriptCbor)` takes the
release from the head address and accepts the script only when it is that
prefix, a seed transaction id and the exact encoding of a seed output index,
with nothing more, and when the script hashes under the release's language
to the head id. Malformed input, native scripts and scripts of another
release are refused.

The script is the CBOR byte string around the flat code. A consumer reads
it once per head: the `bytes` of a Plutus witness script of the init
transaction, or the `cbor` that Blockfrost `scripts/{headId}/cbor` returns,
which carries no language and needs none. The verdict for a head id never
changes, so a consumer keeps it rather than reading the script again.

## Funds moved through a head

Layer 1 never shows a participant's current share inside a head, but it
records every transaction that moves the head state token, and those tell
exactly what was committed to an account's keys and paid back to them. That
list of transactions is the head's history. `reconstructHydraHeadFunds`
reads it, oldest first, with spent inputs resolved, and returns two values
kept apart rather than netted:

- **Deposited**: the outputs the head absorbed that pay the account's payment
  keys. From 0.20.0 an increment spends a deposit UTxO and the head takes the
  outputs listed in its datum. Up to 1.3.0 the collect step spends one commit
  UTxO per participant, holding that participant's participation token, whose
  datum `(party, [Commit], headId)` lists the committed outputs in the same
  `Commit` record a deposit uses. Releases before 0.20.0 encode the output
  reference of a commit with Plutus V2, which wraps the transaction id in a
  constructor.
- **Withdrawn**: the outputs a decrement or a partial fanout pays to the
  account's keys while the head keeps running. Both place the paid outputs
  right after the head output, followed by the change of the node that paid
  the fee. The node's key is usually a participant's own key, so the change
  must not count: the paid outputs are the shortest run after the head output
  whose values add up to what the head UTxO released.

A recovered deposit never touches the head, so it counts as neither. Init,
close and contest leave the head value unchanged and add nothing.

The history must start at the head's init, which produces the head UTxO
without spending one, and each transaction that spends the head UTxO must spend
the one the transaction before it produced. A history that starts later, or
that is missing a step, or has a step whose spent head UTxO was left out,
gives no result rather than a lower one. A history cut short
at its end still adds up the steps it holds, so a consumer that shows current
figures checks that the last transaction produced the head UTxO it found at the
validator, as Lace does.

Every step is checked against the head UTxO, which must change by exactly the
absorbed inputs minus the paid outputs. The head UTxO is recognised by the
state token named for the release of its address. A deposit UTxO holds
exactly the outputs its datum commits, so the committed values must add up to
the value of the deposit; a commit UTxO also holds the participation token
and its minimum ada, so its committed values may add up to less, but never to
more than it holds besides the head tokens. Anything that does not fit, a
spent deposit or commit whose datum does not decode or targets another head,
a deposit whose datum commits other than what it holds, a commit whose datum
commits more than it holds, or a transaction that ends the head makes the
result undefined rather than approximate. A final fanout ends the head and
its change cannot be told from its payouts, so a finished head has no result.

Ownership is decided on payment key hashes, so each participant or depositor
of a shared head gets only the funds committed or paid to its own keys. A
commit counts for the account whose key its datum names, which says nothing
about who paid it. From 2.0.0 anyone can deposit into
an open head, so a depositor need not be a participant.

## Positions

`toHydraHeadPositions` turns an account's heads and deposits into one
position per head that still holds funds: open, closed, or fanning out. Each
position carries the head's state, contestation deadline and value, the
number of participants other than the account, what was committed to the
account's keys and paid back to them when the head's history could be read,
and the account's deposits the head has not absorbed yet, summed by their
status at the given instant. Pending and recoverable deposits are kept apart, and nothing is
netted.

A head the account only deposited into is listed as soon as it is given,
even before the head absorbs the deposit and credits anything to the
account. A deposit naming a head that is not listed is left out, since
anyone can lock a deposit naming any head id: the consumer passes in only
heads it has proven genuine, and a head no longer live cannot absorb it.

`nextChangeAt` is the next instant at which a position changes with time
alone: a closed head reaching the end of its contestation period, or a
pending deposit becoming recoverable just after its deadline. The instant a
position is computed for and the instants it carries are epoch milliseconds.

## Cards

`toHydraHeadCards` tells what the card of each position says, as of the same
instant and from the same heads and deposits: what the head is doing, with
the time left for a closing head split into whole days, hours and minutes;
the lovelace the head holds; the lovelace the head absorbed for the account
and, when any, paid back to it; the account's deposits still waiting for the
head, by status; who else is in the head; and whether the account's own
figures lead the card, with the head total demoted to its detail, or the
total does. Its `nextChangeAt` adds the instant a closing head's countdown
drops by a whole minute to the changes of the positions. Only lovelace is
given, since that is what the layer 1 records vouch for, and nothing is
netted. Wording and number formatting belong to the consumer, so both wallet
stacks and SDK consumers show the same figures from one implementation.

## Validator sweep cost

The matchers read the UTxOs at every distinct head and deposit validator
address of a network's registry, 17 addresses on each network. A consumer
reads them all in one sweep, however many accounts match against it, at one
request per listing page of each address.

Outputs nobody can spend pile up at script addresses, so those listings grow
with network-wide Hydra usage and spam, not with the account. Lace reads at
most 20 pages of 100 UTxOs per address, so a sweep costs at most
17 \* 20 = 340 requests. Failures are isolated per address
(`settleHydraValidatorReads`): an address whose read fails, or whose last
allowed page is full and so may hold more, stands in with what the previous
sweep found there rather than leave out a deposit or head, so only the
deposits and heads at that address go stale while the other addresses stay
current. Those previous reads are kept in memory, so after a restart such an
address has nothing to stand in for it. The sweep is then partial: the other
addresses are served, the address is named unread rather than read as
empty, and what the wallet kept of it, such as the persisted head ids, is
merged rather than replaced. One crowded or failing address therefore never
switches recognition off for the others. A sweep fails as a whole, and the
previous result stands, only when every address fails. On Preprod the 17 addresses
hold about 3,900 UTxOs, the largest about 950, so a sweep costs about 50
requests.

When sweeps run differs by stack:

- **Legacy**: once the network and accounts are known and again when they
  change, on a new tip at most once every 5 minutes, and on a new Hydra
  activity at most once a minute. Unlocking the wallet, or a new tip, does
  not repeat a sweep of the same network and accounts that finished less
  than 5 minutes ago.
- **lace-next**: every 5 minutes while an account view is open, and when a
  Hydra activity newer than the view appears. Every view shares one read of
  the network's validators.

The head checks and history reads below come on top of each sweep.

## History read limits

Anyone can place a lookalike head at a head validator, holding a state token
and a participation token named after an account's payment key hash, and
move that token through as many transactions as they like. Reading the
history of such a head would cost at least one request per transaction and
one per spent input produced outside the history.
`HYDRA_HEAD_HISTORY_LIMITS`, typed `HydraHeadHistoryLimits`, bounds those
reads per head and per account, so the costs add up rather than multiply,
and consumers apply it the same way:

| Limit                      | Value | Past it                                                         |
| -------------------------- | ----- | --------------------------------------------------------------- |
| `maxTransactionsPerHead`   | 200   | the history is listed and read up to this length and no further |
| `maxResolvedInputsPerHead` | 100   | reading stops before the transaction that would go past it      |
| `maxHeadsPerAccount`       | 10    | the history of the account's further genuine heads is not read  |
| `maxHeadChecksPerAccount`  | 30    | the account's further unchecked heads wait for a later check    |

`maxResolvedInputsPerHead` counts the spent inputs of the whole history
that were produced outside it, such as deposits and commits. A consumer
whose transaction reads do not include the spent outputs pays one read for
each; one that gets them with the transaction applies the same bound, so
every consumer gives a head figures alike.

A head past a limit keeps no figures, so it shows only what its UTxO holds.
A history that reached `maxTransactionsPerHead` is not read any further
while the consumer keeps it. Lace keeps histories in memory or in a query
cache, not on disk, so such a head is read again once per session, or once
per cache lifetime. A history stopped by `maxResolvedInputsPerHead` is
checked again on a later refresh, which costs the listing pages from the
last kept transaction on plus one transaction read, and stops there again.

With 100 transactions per listing page, a fresh start costs each head at
most 2 listing requests, 200 transaction reads and, where inputs are
resolved separately, 100 input requests. The cost of a transaction read
differs by stack. On the legacy stack it is `getTransactionDetails`, which
issues 3 Blockfrost requests (`txs/{id}`, `txs/{id}/cbor` and
`txs/{id}/utxos`), so a head costs at most 2 + 3 \* 200 + 100 = 702
requests and an account at most 7,020 per start, before retries of failed
requests. On lace-next a transaction read is one request and the spent
outputs come with it, so a head costs at most 2 + 200 = 202 requests and an
account at most 2,020, before retries of failed requests. A listing that no
longer continues the kept history is read again from its first page, which
adds at most 2 listing requests.

Only a head proven genuine by its minting script has its history read.
On the legacy stack the check reads the first listing pages of the head
and the details of its init, at most 2 + 3 = 5 requests, so the checks of
an account cost at most 30 \* 5 = 150 requests per sweep. The history read
of a genuine head starts from the listing and init its check read, so a
genuine head costs no request more. The verdict is kept in memory while the
head stays live, so each head is checked once per session. On lace-next the
check is one read of the head's minting script (`scripts/{headId}/cbor`),
kept in the query cache, so the checks of an account cost at most 30
requests per sweep and a genuine head costs at most 1 + 202 = 203 requests
on a fresh start. A script the provider has not indexed yet, as right
after a head's init, gives no verdict and is read again on the next sweep.

Only genuine heads count towards `maxHeadsPerAccount`, so a lookalike
never takes the place of a genuine head: it uses up one check of the
account, once, and is then ignored. `maxHeadChecksPerAccount` applies only
to heads without a kept verdict, so a head already found genuine or a
lookalike costs no check. Every genuine head is listed; the first
`maxHeadsPerAccount` of them get figures and the others are listed without
figures. Heads named by the account's own deposits, the deposit ids it kept
and those of the deposits it sent, are checked and read first, whether or
not the account also participates in them, and each group is taken in head
id order. Heads the account only participates in, without a deposit of its
own, come after them: enough heads with lower head ids delay their first
check by one sweep per `maxHeadChecksPerAccount` heads, but cannot keep
them from being checked or push out a head already found genuine.

Real heads stay far below these values: recorded Preprod heads have a few
dozen transactions at most and resolve at most a dozen inputs. A real head
that grows past `maxTransactionsPerHead` shows only what its UTxO holds.
This is a deliberate trade-off: a cap generous for real heads and a fixed
cost for any head, rather than figures for very long-lived heads.

## Trust caveat

The metadata marker is a discovery hint, never proof. Anyone can attach it to
any transaction. Anything that affects balances must be anchored on script
addresses, state tokens and datums.

Anchoring proves where a UTxO sits, not who created it. Anyone can pay to a
validator address with a lookalike token and datum, so a head found there is
genuine only once its minting script passes the check described under
[Genuine heads](#genuine-heads), and a deposit is evidence of Hydra activity
rather than proof that its head is genuine. Such values are shown apart from
spendable balances.

Deposits, commits and withdrawals are attributed to the account whose payment
keys they name, not to whoever paid them, so the figures are what was
committed to and paid back to the account's keys. None of them is a balance.
