import { defer } from 'rxjs';

import { midnightOperationsOf } from './midnight-engine-operations';
import { withMidnightWallet } from './midnight-wallet';

import type { MidnightTxRecipe } from './build-midnight-transfer';
import type {
  MidnightAccountProps,
  WalletWithMidnight,
} from './midnight-wallet';
import type { Result } from '@lace-lib/util';

/** The options of `registerMidnightDust`. */
export interface RegisterMidnightDustProps extends MidnightAccountProps {
  /**
   * Optional destination on the account's network. Refused while the account
   * is designated for DUST generation; omit it to register to the account's
   * own address.
   */
  dustAddress?: string;
  /**
   * Not accepted. The engine sets a registration's validity window (one hour
   * from building) and the fee estimate uses the same window, so a supplied
   * value is refused rather than ignored.
   */
  ttl?: never;
}

/**
 * Refuses `ttl` before the engine is asked: the engine sets a registration's validity window, and the fee estimate
 * prices the same window.
 */
export const assertNoRegistrationTtl = (ttl: unknown): void => {
  if (ttl !== undefined)
    throw new Error(
      'A DUST registration does not accept ttl: the engine sets its validity window',
    );
};

/**
 * Registers every available NIGHT UTXO. Obtain consumer consent before
 * calling: registration signs internally.
 *
 * - An explicit `dustAddress` is refused while the account is designated for
 *   DUST generation (registered NIGHT, generated DUST or generation capacity),
 *   so it never redirects an existing designation.
 * - Without `dustAddress` the NIGHT is registered to the account's own DUST
 *   address, whatever it is registered to now. NIGHT registered to an external
 *   address is therefore re-registered to the account's own address. When some
 *   NIGHT is already registered, the registration is balanced with DUST.
 *
 * The returned recipe reserves the NIGHT it registers (see `MidnightTxRecipe`).
 * When the registration cannot be built, the NIGHT it reserved is released
 * and the build error is returned; if that release fails too, the error is an
 * `AggregateError` of both failures, and the NIGHT stays reserved until a
 * sync reset. The wallet library does not release it when the fee query of a
 * first registration fails; it then also stays reserved until a sync reset.
 */
export const registerMidnightDust = async (
  wallet: WalletWithMidnight,
  { ttl, dustAddress, ...account }: RegisterMidnightDustProps = {},
): Promise<Result<MidnightTxRecipe, Error>> =>
  withMidnightWallet(wallet, account, engine =>
    defer(() => {
      assertNoRegistrationTtl(ttl);
      return midnightOperationsOf(engine).build({
        kind: 'dust-registration',
        dustAddress,
      });
    }),
  );
