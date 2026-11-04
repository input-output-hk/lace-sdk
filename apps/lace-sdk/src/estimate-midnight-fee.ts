import { defer } from 'rxjs';

import { midnightOperationsOf } from './midnight-engine-operations';
import { withMidnightWallet } from './midnight-wallet';
import { assertNoRegistrationTtl } from './register-midnight-dust';

import type { MidnightTransferBatch } from './build-midnight-transfers';
import type { WalletWithMidnight } from './midnight-wallet';
import type { RegisterMidnightDustProps } from './register-midnight-dust';
import type { Result } from '@lace-lib/util';
import type { MidnightWorkerTxRequest } from '@lace-module/midnight-sync/sdk';

/** An unsigned operation to estimate before requesting consumer consent. */
export type MidnightFeeRequest =
  | { kind: 'dust-registration'; registration: RegisterMidnightDustProps }
  | { kind: 'transfer'; transfer: MidnightTransferBatch };

/**
 * Estimates DUST from unsigned preparation, without registering or signing.
 * A first registration with no spendable DUST estimates zero; a repeat
 * registration is estimated like the DUST balancing it performs.
 * Estimates depend on current state/time and are not guaranteed final charges.
 * Insufficient spendable DUST returns an error.
 */
export const estimateMidnightFee = async (
  wallet: WalletWithMidnight,
  request: MidnightFeeRequest,
): Promise<Result<{ dustFee: bigint; availableDust: bigint }, Error>> => {
  const props =
    request.kind === 'transfer' ? request.transfer : request.registration;
  return withMidnightWallet(wallet, props, engine =>
    defer(() => {
      let tx: MidnightWorkerTxRequest;
      if (request.kind === 'transfer') {
        const { kind, outputs, ttl } = request.transfer;
        tx = { kind: 'transfer', transfer: { kind, outputs, ttl } };
      } else {
        assertNoRegistrationTtl(request.registration.ttl);
        tx = {
          kind: 'dust-registration',
          dustAddress: request.registration.dustAddress,
        };
      }
      return midnightOperationsOf(engine).estimate(tx);
    }),
  );
};
