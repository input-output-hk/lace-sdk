import {
  NIGHT_TOKEN_ID,
  toUnshieldedTokenType,
} from '@lace-contract/midnight-context';

import { midnightOperationsOf } from './midnight-engine-operations';
import { withMidnightWallet } from './midnight-wallet';

import type {
  MidnightAccountProps,
  WalletWithMidnight,
} from './midnight-wallet';
import type { Result } from '@lace-lib/util';
import type { OpaqueMidnightRecipe } from '@lace-module/midnight-sync/sdk';

/**
 * A built transaction and what balances it: signed by `signMidnightTx`, proved
 * by `proveMidnightTx`, or released by `discardMidnightTx`. It is an opaque
 * value: the serialized ledger transactions, the account that built it and the
 * engine instance that built it, with no ledger methods. It survives
 * `structuredClone` and `postMessage`; pass it back to the SDK unchanged.
 *
 * The engine reserves the coins a recipe spends when it is built: they leave
 * the available balance until the transaction is submitted or the recipe is
 * discarded, and the reservation is persisted, so an abandoned recipe keeps
 * them out of later builds until a sync reset. A recipe built before its
 * account's engine restarted or was reset is refused with
 * `MidnightStaleTxError`: build it again.
 */
export type MidnightTxRecipe = OpaqueMidnightRecipe;

/** The options of `buildMidnightTransfer`: the recipient and amount of NIGHT. */
export interface BuildMidnightTransferProps extends MidnightAccountProps {
  /** Bech32m unshielded address (`mn_addr_...`) of the active network. */
  to: string;
  /** NIGHT in its smallest unit. */
  amount: bigint;
  /** When the transaction stops being valid; one hour from now by default. */
  ttl?: Date;
}

/**
 * Builds an unshielded NIGHT transfer, selecting the inputs and the DUST
 * that pays its fee. The recipe is unsigned and unproven, and reserves its
 * inputs (see `MidnightTxRecipe`): obtain consent from `estimateMidnightFee`,
 * which reserves nothing, before building. When the fee cannot be paid, the
 * inputs the build reserved are released and the balancing error is returned;
 * if that release fails too, the error is an `AggregateError` of both failures
 * and the NIGHT stays reserved until a sync reset.
 */
export const buildMidnightTransfer = async (
  wallet: WalletWithMidnight,
  { to, amount, ttl, ...account }: BuildMidnightTransferProps,
): Promise<Result<MidnightTxRecipe, Error>> =>
  withMidnightWallet(wallet, account, engine =>
    midnightOperationsOf(engine).build({
      kind: 'transfer',
      transfer: {
        kind: 'unshielded',
        outputs: [
          {
            to,
            tokenId: toUnshieldedTokenType(NIGHT_TOKEN_ID, engine.networkId),
            amount,
          },
        ],
        ttl,
      },
    }),
  );
