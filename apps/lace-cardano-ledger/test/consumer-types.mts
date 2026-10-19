// What a consumer writes against the published declarations: the key agent,
// and the domain layer's types it is expressed in, which resolve through
// @laceio/cardano.

import type { Cardano } from '@laceio/cardano/core';
import type { KeyAgent } from '@laceio/cardano/key-management';
import type { LedgerKeyAgent } from '@laceio/cardano-ledger';

// @ts-expect-error A number is not a key agent.
0 satisfies LedgerKeyAgent;
// @ts-expect-error A number is not an address.
0 satisfies Cardano.PaymentAddress;
// The adapter is a key agent of the domain layer.
({}) as LedgerKeyAgent satisfies KeyAgent;
