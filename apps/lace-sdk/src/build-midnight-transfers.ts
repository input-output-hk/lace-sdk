import { midnightOperationsOf } from './midnight-engine-operations';
import { withMidnightWallet } from './midnight-wallet';

import type { MidnightTxRecipe } from './build-midnight-transfer';
import type {
  MidnightAccountProps,
  WalletWithMidnight,
} from './midnight-wallet';
import type { Result } from '@lace-lib/util';

/** A homogeneous batch using token IDs from the account's token state. */
export type MidnightTransferBatch = MidnightAccountProps & {
  kind: 'shielded' | 'unshielded';
  outputs: readonly [
    { to: string; tokenId: string; amount: bigint },
    ...{ to: string; tokenId: string; amount: bigint }[],
  ];
  /** One hour from now by default. */
  ttl?: Date;
};

/**
 * Builds an unsigned, unproven batch. The engine selects tokens and fee DUST
 * and reserves them (see `MidnightTxRecipe`): obtain consent from
 * `estimateMidnightFee`, which reserves nothing, before building. When the
 * fee cannot be paid, the inputs the build reserved are released and the
 * balancing error is returned; if that release fails too, the error is an
 * `AggregateError` of both failures and the coins stay reserved until a sync
 * reset.
 */
export const buildMidnightTransfers = async (
  wallet: WalletWithMidnight,
  { kind, outputs, ttl, ...account }: MidnightTransferBatch,
): Promise<Result<MidnightTxRecipe, Error>> =>
  withMidnightWallet(wallet, account, engine =>
    midnightOperationsOf(engine).build({
      kind: 'transfer',
      transfer: { kind, outputs, ttl },
    }),
  );
