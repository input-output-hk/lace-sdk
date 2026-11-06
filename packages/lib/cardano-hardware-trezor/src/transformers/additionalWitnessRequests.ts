import { KeyRole, util } from '@lace-lib/cardano-key-management';
import { isNotNil } from '@lace-lib/cardano-util';
import isArray from 'lodash/isArray.js';
import uniq from 'lodash/uniq.js';

import { resolvePaymentKeyPathForTxIn } from './keyPaths';

import type { TrezorTxTransformerContext } from '../types';
import type { Cardano } from '@lace-lib/cardano-core';
import type { Transform } from '@lace-lib/cardano-util';
import type * as Trezor from '@trezor/connect';

/**
 * The witness paths requested beyond the device's own: the payment key of
 * every own input, and the stake key of every own stake credential the
 * transaction needs a witness for (certificates, withdrawals, required
 * signers, the native scripts in the signing context). A stake key the
 * transaction does not need is never requested.
 */
export const mapAdditionalWitnessRequests: Transform<
  Cardano.TxBody,
  Trezor.DerivationPath[],
  TrezorTxTransformerContext
> = (body, context) => {
  const paymentKeyPaths = uniq<Trezor.DerivationPath>(
    body.inputs
      .map(input => resolvePaymentKeyPathForTxIn(input, context))
      .filter(isNotNil)
      .filter(isArray),
  );
  if (!context) return paymentKeyPaths;

  const stakeKeyPaths = util
    .ownSignatureKeyPaths(
      body,
      context.knownAddresses,
      context.txInKeyPathMap,
      undefined,
      context.scripts,
      context.spentOutputAddresses,
    )
    .filter(path => path.role === KeyRole.Stake)
    .map(path =>
      util.accountKeyDerivationPathToBip32Path(context.accountIndex, path),
    );
  return [...paymentKeyPaths, ...stakeKeyPaths];
};
