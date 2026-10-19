// What a consumer writes against the published declarations, which the check
// reads in full: every module they import is a declared dependency.
import { Cip30Wallet } from '@laceio/cardano/dapp-connector';
import {
  roundRobinRandomImprove,
  type SelectionSkeleton,
} from '@laceio/cardano/input-selection';
import { KeyRole, type GroupedAddress } from '@laceio/cardano/key-management';
import {
  minAdaRequired,
  type TxEvaluator,
} from '@laceio/cardano/tx-construction';

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
// @ts-expect-error A number is not a selection.
0 satisfies SelectionSkeleton;
// @ts-expect-error A number is not an evaluator.
0 satisfies TxEvaluator;

void KeyRole.External;
void roundRobinRandomImprove;
void minAdaRequired;
void Cip30Wallet;
