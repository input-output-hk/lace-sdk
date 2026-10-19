import { Subject } from 'rxjs';

import type {
  AttestationProgressEvent,
  SendProofProgressEvent,
} from '@lace-contract/midnight-context';
import type { AccountId } from '@lace-contract/wallet-repo';

const progress = new Subject<SendProofProgressEvent>();
export const teeAttestationProgress$ = progress.asObservable();

/** Only an explicitly started wallet send can own the send checklist. */
export const beginSendProofProgress = (accountId: AccountId) => {
  const operationId = crypto.randomUUID();
  progress.next({ type: 'begin', operationId, accountId });
  return (event: AttestationProgressEvent) => {
    progress.next({ type: 'progress', operationId, event });
  };
};
