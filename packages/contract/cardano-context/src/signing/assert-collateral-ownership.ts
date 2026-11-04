import { collateralRefusalMessage } from '@lace-lib/core/dapp-connector/signing';

import type { CollateralOwnershipErrorCase } from '@lace-lib/core/dapp-connector/signing';

export {
  collateralRefusalMessage,
  type CollateralOwnershipErrorCase,
} from '@lace-lib/core/dapp-connector/signing';

/**
 * Thrown when the collateral-return ownership rule refuses a transaction.
 * Distinct type + per-case token so a caller can fail closed and a UI layer
 * can select its copy without string-matching the message.
 */
export class CollateralOwnershipError extends Error {
  public readonly case: CollateralOwnershipErrorCase;

  public constructor(errorCase: CollateralOwnershipErrorCase) {
    super(collateralRefusalMessage(errorCase));
    this.name = 'CollateralOwnershipError';
    this.case = errorCase;
  }
}
