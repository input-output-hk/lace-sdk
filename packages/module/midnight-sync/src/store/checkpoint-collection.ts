import type { SerializedMidnightWallet } from '@lace-contract/midnight-context';
import type { CreateCollectionStorageProps } from '@lace-contract/storage';

/**
 * The collection every Midnight engine keeps its checkpoints in, one document per account, whether it runs on the
 * page or in the SDK's worker, so that an engine started in either mode resumes from the same checkpoint.
 */
export const MIDNIGHT_CHECKPOINT_COLLECTION: CreateCollectionStorageProps<SerializedMidnightWallet> =
  {
    collectionId: 'midnightWalletState',
    // accountId is the id every lookup keys on, and unlike walletId+networkId it cannot collide between two entries —
    // a collision here would silently merge two accounts' documents.
    computeDocId: wallet => String(wallet.accountId),
  };
