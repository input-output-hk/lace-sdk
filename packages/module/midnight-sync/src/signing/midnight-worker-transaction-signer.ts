import { isRemoteMidnightEngine } from '@lace-contract/midnight-context';
import { AuthenticationCancelledError } from '@lace-contract/signer';
import { defer, switchMap, take, tap, throwError } from 'rxjs';

import { beginSendProofProgress } from '../store/send-proof-progress';

import type {
  MidnightEnginesByAccountId,
  MidnightSignRequest,
  MidnightSignResult,
  MidnightTransactionSigner,
} from '@lace-contract/midnight-context';
import type { SignerAuth } from '@lace-contract/signer';
import type { AccountId } from '@lace-contract/wallet-repo';
import type { Observable } from 'rxjs';

/**
 * Signs Midnight transactions through the account's engine in the worker: the same pipeline the in-memory signer
 * runs on this page for an in-process engine, with authentication staying on this page. It imports no engine code,
 * so a Worker-mode page can hold it.
 */
export class MidnightWorkerTransactionSigner
  implements MidnightTransactionSigner
{
  readonly #accountId: AccountId;
  readonly #auth: SignerAuth;

  readonly #engines$: Observable<MidnightEnginesByAccountId>;

  public constructor(params: {
    accountId: AccountId;
    auth: SignerAuth;
    engines$: Observable<MidnightEnginesByAccountId>;
  }) {
    this.#accountId = params.accountId;
    this.#auth = params.auth;
    this.#engines$ = params.engines$;
  }

  public sign(request: MidnightSignRequest): Observable<MidnightSignResult> {
    return defer(() => {
      const onProgress = beginSendProofProgress(this.#accountId);
      return this.#auth.authenticate().pipe(
        switchMap(confirmed => {
          if (!confirmed)
            return throwError(() => new AuthenticationCancelledError());
          return this.#engines$.pipe(
            take(1),
            switchMap(engines => {
              const engine = engines[this.#accountId];
              if (!engine)
                throw new Error(
                  `Could not load midnight wallet for account ${
                    this.#accountId
                  }`,
                );
              if (!isRemoteMidnightEngine(engine))
                throw new Error(
                  `The Midnight engine of account ${
                    this.#accountId
                  } runs on this page, which Worker mode's signer does not serve`,
                );
              return engine.signTransaction(request, onProgress);
            }),
          );
        }),
        tap({
          error: () => {
            onProgress({
              type: 'phase',
              phase: 'transaction-failed',
              status: 'failed',
            });
          },
        }),
      );
    });
  }
}
