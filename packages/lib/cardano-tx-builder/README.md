# @lace-lib/cardano-tx-builder

The transaction builder the wallet builds every Cardano transaction with.

`TransactionBuilder` collects outputs, certificates, withdrawals, metadata, mints and script inputs, then selects
inputs, balances the transaction and prices its fee for the signatures it will carry. Transactions that run Plutus
scripts are evaluated, given their script data hash and backed by collateral. Two coin selectors pick the inputs:
`RoundRobinRandomCoinSelector`, the default, and `LargeFirstCoinSelector`, which balancing falls back to when the
default cannot cover the target.

The package also carries the rules the builder prices with, for code that assembles transactions itself: `minFee`,
`minAdaRequired`, `computeMinimumCoinQuantity` and `tokenBundleSizeExceedsLimit`, ported from
[cardano-js-sdk](https://github.com/input-output-hk/cardano-js-sdk)'s `@cardano-sdk/tx-construction` (version 0.29.1),
and the `TxEvaluator` type a script evaluator implements.

Built transactions are written in the canonical form the cardano-c transaction builder writes: inputs, collateral inputs and
reference inputs in set order, every output and the collateral return as a map, and auxiliary data under tag 259.
`minFee` and `minAdaRequired` measure transactions and outputs in that form.

It depends only on the other `@lace-lib/cardano-*` packages.

## Usage

```typescript
import {
  RoundRobinRandomCoinSelector,
  TransactionBuilder,
} from '@lace-lib/cardano-tx-builder';
import { Cardano } from '@lace-lib/cardano-core';

const tx = await new TransactionBuilder(
  Cardano.NetworkMagics.Preprod,
  protocolParameters,
)
  .setNetwork(Cardano.NetworkMagics.Preprod)
  .setChangeAddress(changeAddress)
  .setUnspentOutputs(utxos)
  .useCoinSelector(new RoundRobinRandomCoinSelector({ seed: 42n }))
  .transferValue(recipientAddress, { coins: 5_000_000n })
  .expiresIn(7200)
  .build();
```

The coin selector's seed fixes its random choices, so a build with the same inputs gives the same transaction.

## Certificates

`addCertificate` takes any certificate, and `addStakeDelegationCertificate` and `addNewStakeAddressCertificate` a stake
certificate, each with a certificate redeemer when a Plutus script credential witnesses it: the stake credential of a
stake certificate, the DRep credential of a DRep certificate or the cold credential of a committee certificate. The
redeemer is indexed at its certificate's position, and the keys the certificate needs, such as a key hash credential or
the operator and owners of a pool, are counted as signers the fee pays for. A pool registration is charged the pool
deposit once per pool across the transaction and its sub transactions, as the ledger charges it. A registration that
updates a pool already registered on chain is still charged, as the builder cannot know the pool is registered. A pool
retirement refunds nothing in the transaction, as the ledger returns its deposit at the epoch boundary.

## Mints, donations and datums

`mintAssets` mints, or burns with negative quantities, under a policy. A Plutus policy takes its mint redeemer; a native
policy takes none, as its script, attached with `attachScript` or read from a reference input, witnesses the mint. The
keys a native script attached with `attachScript` requires are counted as signers the fee pays for, and the key
management witnesser signs for them without the script in its signing context; for a script read from a reference
input, add them with `addRequiredSigner`, which also has the witnesser sign for them. `setDonation` donates lovelace to
the treasury, which balancing funds like an output; a donation of zero removes it. `addDatum` adds a datum to the
witness set, such as the datum of an output created locked by its hash, once however often it is added; the script data
hash covers it, and a transaction that runs no Plutus script needs no Plutus context for it. `SubTransactionBuilder`
takes datums the same way, and a sub transaction that runs no Plutus script needs no Plutus context for them either.

## Guards, direct deposits and balance intervals

`addGuard` requires a key hash or script hash credential, with a guarding redeemer for a Plutus script guard. The body
lists the guards as required signers while every one is a key hash, and in the credential form, valid from the Dijkstra
era, once one is a script. Also valid from the Dijkstra era, `addDirectDeposit` deposits lovelace straight into the
account behind a reward account, which balancing funds like an output, and `addAccountBalanceInterval` and
`addStartingAccountBalanceInterval` bound the balance that account must hold when the transaction is applied, or before
the transaction and its sub transactions are. None of them needs a witness from the account.

## Sub transactions

`SubTransactionBuilder` builds an unsigned CIP-118 sub transaction, as a party to a batch does: it never balances and
pays no fee, and it indexes its own redeemers and computes its own script data hash. A sub transaction runs no
PlutusV1, PlutusV2 or PlutusV3 script; native and PlutusV4 scripts are fine. Every script a sub transaction's redeemers
run must be attached to it or carried by its own inputs or reference inputs: `build` throws `ExtraneousRedeemerError`
for a redeemer whose script only another level of the batch provides, as the cardano-c sub transaction builder does.

```typescript
import { SubTransactionBuilder } from '@lace-lib/cardano-tx-builder';

const subTransaction = await new SubTransactionBuilder()
  .addInput(utxo)
  .addOutput({ address: recipientAddress, value: { coins: 5_000_000n } })
  .build();
```

Once its parties sign it, the batcher's `TransactionBuilder.addSubTransaction` adds it to the batch with the UTxOs its
inputs spend and reference. The builder balances the whole batch, prices the batch fee and keeps every sub transaction
byte for byte, so the signatures over it survive the build.
