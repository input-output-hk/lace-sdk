import { TokenColor } from '@lace-contract/passport';
import { HexBytes } from '@lace-lib/util';

import { isLaceRecord } from './envelopes';

import type { Ledger } from './acc-module';
import type { IndexerClient } from '../infra/indexer';
import type { ShieldedCoin, ShieldedHolding } from '@lace-contract/passport';
import type * as LedgerV9 from '@midnightntwrk/ledger-v9';

/**
 * Opens the given inbox entries with the account encryption secrets, one
 * result per entry in order, null for an entry that does not open. The
 * walk calls it once, with every coin entry, so an implementation backed
 * by a key ceremony prompts once.
 */
export type OpenInboxEntries = (
  entries: Uint8Array[],
) => Promise<(ShieldedCoin | null)[]>;

/** The slice of the ledger binding the walk recomputes commitments with. */
export type LedgerOutputs = Pick<typeof LedgerV9, 'ZswapOutput'>;

export type InboxWalkProps = {
  /** The account address, the recipient every held coin was committed to. */
  address: string;
  ledgerState: Pick<Ledger, 'inbox_count' | 'inbox'>;
  indexer: Pick<
    IndexerClient,
    'enumerateContractActions' | 'queryShieldedOutputs'
  >;
  openEntries: OpenInboxEntries;
  /** Ledger binding loader; defaults to the vendored ledger-v9 module. */
  loadLedger?: () => Promise<LedgerOutputs>;
};

/**
 * What an inbox walk found: every coin the account holds that chain data
 * confirms, the inbox entry each holding was read from in the same order,
 * which a key rotation re-encrypts, and how many entries were passed over
 * because they did not open, described a coin the chain never created
 * for the account, or could not be read at all.
 */
export type InboxWalk = {
  holdings: ShieldedHolding[];
  holdingEntries: Uint8Array[];
  skippedEntries: number;
};

type Candidate = { coin: ShieldedCoin; commitment: string; entry: Uint8Array };

const defaultLoadLedger = async (): Promise<LedgerOutputs> =>
  import('@midnightntwrk/ledger-v9');

/** The entries the contract holds, in inbox order, the Lace records included. */
export const inboxEntries = (
  ledgerState: InboxWalkProps['ledgerState'],
): Uint8Array[] => {
  const entries: Uint8Array[] = [];
  for (let ordinal = 0n; ordinal < ledgerState.inbox_count; ordinal += 1n) {
    if (ledgerState.inbox.member(ordinal)) {
      entries.push(ledgerState.inbox.lookup(ordinal));
    }
  }
  return entries;
};

/**
 * The commitment the chain carries for a coin the account received,
 * recomputed with the ledger's own output construction: a contract-owned
 * output of this coin towards the account address, which is exactly what
 * a depositor builds and the contract claims. A description the ledger
 * refuses to commit to is no candidate.
 */
const toCandidate = (
  { ZswapOutput }: LedgerOutputs,
  address: string,
  { coin, entry }: { coin: ShieldedCoin; entry: Uint8Array },
): Candidate | null => {
  try {
    const output = ZswapOutput.newContractOwned(
      {
        type: HexBytes.fromByteArray(coin.color),
        nonce: HexBytes.fromByteArray(coin.nonce),
        value: coin.value,
      },
      undefined,
      address,
    );
    return { coin, commitment: output.commitment.toLowerCase(), entry };
  } catch {
    return null;
  }
};

/**
 * The tree index of every shielded output the chain created for the
 * account, by commitment, read from the ledger events of the transactions
 * that acted on the contract. A deposit is one such action, so its
 * transaction is among them.
 */
const receivedOutputs = async (
  address: string,
  indexer: InboxWalkProps['indexer'],
): Promise<Map<string, bigint>> => {
  const actions = await indexer.enumerateContractActions(address);
  const hashes = [...new Set(actions.map(action => action.txHash))];
  const outputs = await Promise.all(
    hashes.map(async hash => indexer.queryShieldedOutputs(hash)),
  );
  const recipient = address.toLowerCase();
  return new Map(
    outputs
      .flat()
      .filter(output => output.contractAddress === recipient)
      .map(output => [output.commitment, output.index]),
  );
};

/**
 * Walks the account's inbox the way the custody standard prescribes:
 * every entry other than the Lace records, which hold the account keys
 * and the grant bookkeeping rather than coins, is opened with the
 * encryption secrets, each coin that opens is verified by recomputing
 * its commitment and finding it among the outputs the chain created for
 * the account, and the index that output took in the commitment tree is
 * captured with it. Anyone can append any
 * bytes to the inbox, so an entry that does not open, or opens to a coin
 * the chain never created for this account, is skipped as noise and
 * counted, never raised. Two entries describing the same coin, as a
 * re-encryption after a key rotation leaves behind, yield one holding,
 * read from the first entry that described it. An empty inbox, or one
 * with nothing that opens, is answered without loading the ledger or
 * reading the chain's history. A ledger binding that fails to load is a
 * failure of the walk itself, not of any entry, so it is raised rather
 * than reported as an inbox of noise.
 */
export const walkInbox = async ({
  address,
  ledgerState,
  indexer,
  openEntries,
  loadLedger = defaultLoadLedger,
}: InboxWalkProps): Promise<InboxWalk> => {
  const entries = inboxEntries(ledgerState).filter(
    entry => !isLaceRecord(entry),
  );
  const nothing = (skippedEntries: number): InboxWalk => ({
    holdings: [],
    holdingEntries: [],
    skippedEntries,
  });
  if (entries.length === 0) return nothing(0);
  const coins = await openEntries(entries);
  if (coins.every(coin => coin === null)) return nothing(entries.length);
  const ledger = await loadLedger();
  const candidates = coins.map(
    (coin, ordinal) =>
      coin && toCandidate(ledger, address, { coin, entry: entries[ordinal] }),
  );
  if (candidates.every(candidate => candidate === null)) {
    return nothing(entries.length);
  }
  const outputs = await receivedOutputs(address, indexer);
  const holdings = new Map<string, ShieldedHolding>();
  const holdingEntries = new Map<string, Uint8Array>();
  let skippedEntries = 0;
  for (const candidate of candidates) {
    const index = candidate && outputs.get(candidate.commitment);
    if (!candidate || index === undefined) {
      skippedEntries += 1;
      continue;
    }
    if (holdings.has(candidate.commitment)) continue;
    holdings.set(candidate.commitment, {
      color: TokenColor(HexBytes.fromByteArray(candidate.coin.color)),
      value: candidate.coin.value.toString(),
      commitment: candidate.commitment,
      index: Number(index),
    });
    holdingEntries.set(candidate.commitment, candidate.entry);
  }
  return {
    holdings: [...holdings.values()],
    holdingEntries: [...holdingEntries.values()],
    skippedEntries,
  };
};
