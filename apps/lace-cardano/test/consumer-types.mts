// What a consumer writes against the published declarations, which the check
// reads in full: every module they import is a declared dependency.
import { Cip30Wallet } from '@laceio/cardano/dapp-connector';
import { KeyRole, type GroupedAddress } from '@laceio/cardano/key-management';
import {
  minAdaRequired,
  RoundRobinRandomCoinSelector,
  SubTransactionBuilder,
  TransactionBuilder,
  type CoinSelector,
  type TransactionBuilderProtocolParameters,
  type TxEvaluator,
} from '@laceio/cardano/tx-builder';

import type { Cardano, Serialization } from '@laceio/cardano/core';
import type * as Crypto from '@laceio/cardano/crypto';
import type { HexBlob } from '@laceio/cardano/util';

// @ts-expect-error A number is not an address.
0 satisfies Cardano.PaymentAddress;
// @ts-expect-error A number is not a UTxO.
0 satisfies Cardano.Utxo;
// @ts-expect-error A number is not a transaction.
0 satisfies Serialization.Transaction;
// @ts-expect-error A number is not a hex blob.
0 satisfies HexBlob;
// @ts-expect-error A number is not a key hash.
0 satisfies Crypto.Ed25519KeyHashHex;
// @ts-expect-error A number is not a grouped address.
0 satisfies GroupedAddress;
// @ts-expect-error A number is not a coin selector.
0 satisfies CoinSelector;
// @ts-expect-error A number is not an evaluator.
0 satisfies TxEvaluator;

declare const networkMagic: Cardano.NetworkMagics;
declare const protocolParameters: TransactionBuilderProtocolParameters;
const builder: TransactionBuilder = new TransactionBuilder(
  networkMagic,
  protocolParameters,
).useCoinSelector(new RoundRobinRandomCoinSelector({ seed: 42n }));
const built: Promise<Serialization.Transaction> = builder.build();
const subTransaction: Promise<Serialization.SubTransaction> =
  new SubTransactionBuilder().build();

void KeyRole.External;
void built;
void subTransaction;
void minAdaRequired;
void Cip30Wallet;
