import type { Storage } from 'redux-persist';

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** The specific V1 migration defect, rather than every Preview account ID. */
export const isMisroutedPreviewAccount = (value: unknown): boolean => {
  const account = asRecord(value);
  const chainId = asRecord(asRecord(account?.blockchainSpecific)?.chainId);
  return (
    account?.blockchainName === 'Cardano' &&
    account.blockchainNetworkId === 'cardano-2' &&
    chainId?.networkId === 0 &&
    chainId.networkMagic === 1
  );
};

/**
 * Read the wallets snapshot before redux-persist starts rehydrating any slice.
 * A prior boot may have written wallets v6 but died before another slice wrote
 * its migration. In that case the original defect is gone, so the remaining
 * slices use all Cardano Preview account IDs from the repaired wallet snapshot.
 */
export const readMisroutedPreviewAccountIds = async (
  storage: Storage,
): Promise<ReadonlySet<string>> => {
  const raw: unknown = await storage.getItem('persist:wallets');
  if (typeof raw !== 'string') return new Set();
  try {
    const envelope = asRecord(JSON.parse(raw));
    const serializedPersist = envelope?._persist;
    const persist = asRecord(
      typeof serializedPersist === 'string'
        ? JSON.parse(serializedPersist)
        : serializedPersist,
    );
    const hasWalletsReachedVersion6 =
      typeof persist?.version === 'number' && persist.version >= 6;
    const serializedEntities = envelope?.entities;
    const entities = asRecord(
      typeof serializedEntities === 'string'
        ? JSON.parse(serializedEntities)
        : serializedEntities,
    );
    const ids = new Set<string>();
    for (const wallet of Object.values(entities ?? {})) {
      const accounts = asRecord(wallet)?.accounts;
      if (!Array.isArray(accounts)) continue;
      for (const account of accounts) {
        const record = asRecord(account);
        if (
          !record ||
          (hasWalletsReachedVersion6
            ? record.blockchainName !== 'Cardano' ||
              record.blockchainNetworkId !== 'cardano-2'
            : !isMisroutedPreviewAccount(record))
        ) {
          continue;
        }
        const accountId = record.accountId;
        if (typeof accountId === 'string') ids.add(accountId);
      }
    }
    return ids;
  } catch {
    // Preserve unrelated persisted data when the wallets envelope is damaged.
    return new Set();
  }
};
