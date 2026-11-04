import { readGrants } from '../acc/read-grants';
import { createIndexerClient } from '../infra/indexer';

import { queryAccountByBuild } from './account-call';
import { storedGrantSlots } from './stored-grants';

import type { FlowContext, PassportAccountRecord } from './types';
import type { GrantRecord } from '@lace-contract/passport';

/**
 * What the chain says of a restored account: the id of the bundle its
 * verifier keys resolve to and its grant roster, read with the slots the
 * record kept.
 */
export type RestoredAccount = {
  bundleId: string;
  grants: GrantRecord[];
};

/**
 * Reads the restored account from one read of its contract state. It
 * needs no ceremony, only the indexer.
 *
 * @throws {@link AccountContractMissingError} when the indexer serves no
 * contract at the record's address.
 * @throws {@link AccountBundleUnknownError} when no registered bundle
 * covers the account's build.
 */
export const restoreAccount = async (
  record: PassportAccountRecord,
  { seams: { passportNetwork }, bundles }: FlowContext,
): Promise<RestoredAccount> => {
  const { bundle, ledgerState } = await queryAccountByBuild(
    createIndexerClient({
      indexerUrl: passportNetwork.indexerUrl,
      indexerWsUrl: passportNetwork.indexerWsUrl,
    }),
    record.address,
    bundles,
  );
  return {
    bundleId: bundle.id,
    grants: readGrants(ledgerState, storedGrantSlots(record.grants)),
  };
};
