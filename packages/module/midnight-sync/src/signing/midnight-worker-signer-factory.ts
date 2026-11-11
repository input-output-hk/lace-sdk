import { MidnightInMemoryDataSigner } from './midnight-in-memory-data-signer';
import { MidnightWorkerTransactionSigner } from './midnight-worker-transaction-signer';

import type {
  MidnightDataSigner,
  MidnightEnginesByAccountId,
  MidnightSignerContext,
  MidnightSignerFactory,
  MidnightTransactionSigner,
} from '@lace-contract/midnight-context';
import type { SignerContext } from '@lace-contract/signer';
import type { AnyAccount } from '@lace-contract/wallet-repo';
import type { Observable } from 'rxjs';

/**
 * Worker mode's signer factory: the same accounts as the in-memory one, signed through the engine in the worker.
 * The data signer is the in-memory one, which only asks the engine to sign and imports no engine code.
 */
export class MidnightWorkerSignerFactory implements MidnightSignerFactory {
  public constructor(
    private readonly engines$: Observable<MidnightEnginesByAccountId>,
  ) {}

  public canSign(account: AnyAccount): boolean {
    return (
      account.accountType === 'InMemory' &&
      account.blockchainName === 'Midnight'
    );
  }

  public createTransactionSigner(
    context: MidnightSignerContext,
  ): MidnightTransactionSigner {
    this.#assertSupported(context);
    return new MidnightWorkerTransactionSigner({
      accountId: context.accountId,
      auth: context.auth,
      engines$: this.engines$,
    });
  }

  public createDataSigner(context: SignerContext): MidnightDataSigner {
    this.#assertSupported(context);
    return new MidnightInMemoryDataSigner(context.accountId, this.engines$);
  }

  #assertSupported(context: SignerContext): void {
    const account = context.wallet.accounts.find(
      a => a.accountId === context.accountId,
    );
    if (!account || !this.canSign(account)) {
      throw new Error(
        `MidnightWorkerSignerFactory does not support account type: ${
          account?.accountType ?? 'unknown'
        }`,
      );
    }
  }
}
