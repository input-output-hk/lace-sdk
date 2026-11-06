import { Cardano } from '@lace-lib/cardano-core';
import {
  continuesHydraHeadHistory,
  countHydraHeadHistoryOutsideInputs,
  fromCardanoUtxo,
  getHydraHeadHistoryWindow,
  getHydraHeadStateTokenUnit,
  getHydraScriptRegistry,
  isHydraHeadMintingScript,
} from '@lace-lib/hydra-head';
import {
  EMPTY,
  catchError,
  concatMap,
  defer,
  from,
  map,
  of,
  switchMap,
  tap,
  toArray,
} from 'rxjs';

import { unwrapProviderResult } from '../helpers/unwrap-provider-result';

import type {
  CardanoProvider,
  CardanoProviderContext,
  CardanoTransactionHistoryItem,
  ExtendedTxDetails,
} from '@lace-contract/cardano-context';
import type {
  HydraAccountHead,
  HydraHeadHistoryLimits,
  HydraHeadHistoryTx,
  HydraUtxo,
} from '@lace-lib/hydra-head';
import type { Observable } from 'rxjs';

/** The provider reads a head's history takes. */
type HeadHistoryProvider = Pick<
  CardanoProvider,
  'getAssetTransactionHistory' | 'getTransactionDetails' | 'resolveInput'
>;

/**
 * The provider and network a head's history is read from, how many
 * transactions each page of the listing holds, and the limits the read stops
 * at.
 */
export type HeadHistoryReader = {
  provider: HeadHistoryProvider;
  context: CardanoProviderContext;
  pageSize: number;
  limits: HydraHeadHistoryLimits;
};

/**
 * The first page of a genuine head's history listing and the details of its
 * init, as read by the check, so the history read starts from them instead
 * of reading them again.
 */
export type HeadHistoryStart = {
  listed: CardanoTransactionHistoryItem[];
  init: ExtendedTxDetails;
};

/**
 * What checking a head found: a lookalike, or a genuine head with the start
 * of its history.
 */
export type HeadCheck =
  | { isGenuine: false }
  | { isGenuine: true; start: HeadHistoryStart };

/** Key of an output reference. */
const outRefKey = ({ txId, index }: { txId: string; index: number }) =>
  `${txId}#${index}`;

/** True when the address is locked by a script rather than a payment key. */
const isScriptAddress = (address: string): boolean =>
  Cardano.Address.fromString(address)?.getProps().paymentPart?.type ===
  Cardano.CredentialType.ScriptHash;

/**
 * Lists the transactions of the head's state token from the page `page` on,
 * reading only the pages that hold the first `maxTransactionsPerHead`
 * transactions of the history.
 */
const listHeadHistory$ = (
  head: HydraAccountHead,
  page: number,
  { provider, context, pageSize, limits }: HeadHistoryReader,
) => {
  const skipped = (page - 1) * pageSize;
  return unwrapProviderResult(() =>
    provider.getAssetTransactionHistory(
      {
        assetId: Cardano.AssetId(getHydraHeadStateTokenUnit(head)),
        page,
        pageSize,
        maxPages: Math.ceil(
          (limits.maxTransactionsPerHead - skipped) / pageSize,
        ),
      },
      context,
    ),
  );
};

/**
 * Reads one transaction of a head's history. Script inputs are resolved
 * from the outputs of the history read so far, and from the provider when
 * they were produced elsewhere, such as a deposit. Inputs locked by a
 * payment key only pay fees and are left out.
 *
 * @param known - The outputs of the history read so far, by output
 * reference, how many script inputs the provider may still resolve for the
 * head, and the transaction's details when they were read already.
 * @throws when the transaction would resolve more inputs than
 * `resolveBudget` allows, before resolving any, or when a script input
 * cannot be resolved
 */
const readHistoryTx$ = (
  txId: Cardano.TransactionId,
  {
    knownOutputs,
    resolveBudget,
    details,
  }: {
    knownOutputs: ReadonlyMap<string, HydraUtxo>;
    resolveBudget: number;
    details?: ExtendedTxDetails;
  },
  { provider, context }: HeadHistoryReader,
): Observable<HydraHeadHistoryTx> =>
  (details
    ? of(details)
    : unwrapProviderResult(() => provider.getTransactionDetails(txId, context))
  ).pipe(
    switchMap(({ body }) => {
      const scriptInputs = body.inputs.filter(({ address }) =>
        isScriptAddress(address),
      );
      const toResolve = scriptInputs.filter(
        txIn => !knownOutputs.has(outRefKey(txIn)),
      ).length;
      if (toResolve > resolveBudget) {
        throw new Error(
          `${txId} resolves ${toResolve} inputs, ` +
            `more than the ${resolveBudget} left`,
        );
      }
      return from(scriptInputs).pipe(
        concatMap(txIn => {
          const known = knownOutputs.get(outRefKey(txIn));
          if (known) return of(known);
          return unwrapProviderResult(() =>
            provider.resolveInput(txIn, context),
          ).pipe(
            map(txOut => {
              if (!txOut) {
                throw new Error(
                  `Input ${outRefKey(txIn)} of ${txId} could not be resolved`,
                );
              }
              return fromCardanoUtxo([txIn, txOut]);
            }),
          );
        }),
        toArray(),
        map(inputs => ({
          txId,
          inputs,
          outputs: body.outputs.map((txOut, index) =>
            fromCardanoUtxo([{ txId, index, address: txOut.address }, txOut]),
          ),
        })),
      );
    }),
  );

/**
 * Reads the listed transactions after the known history, in order, until the
 * history holds `maxTransactionsPerHead` transactions. The inputs resolved
 * for the whole history, the known part included, stay within
 * `maxResolvedInputsPerHead`. A read that fails or would go past that budget
 * stops there: the history read up to it is returned, so a later sweep
 * resumes from it rather than starting over. `read` holds the details of a
 * transaction read already, which costs no further read.
 */
const readNewTransactions$ = (
  {
    known,
    newer,
    read,
  }: {
    known: readonly HydraHeadHistoryTx[];
    newer: readonly CardanoTransactionHistoryItem[];
    read?: ExtendedTxDetails;
  },
  reader: HeadHistoryReader,
): Observable<HydraHeadHistoryTx[]> => {
  const knownOutputs = new Map(
    known.flatMap(({ outputs }) =>
      outputs.map(output => [outRefKey(output), output] as const),
    ),
  );
  let resolveBudget =
    reader.limits.maxResolvedInputsPerHead -
    countHydraHeadHistoryOutsideInputs(known, outRefKey);
  return from(
    newer.slice(0, reader.limits.maxTransactionsPerHead - known.length),
  ).pipe(
    concatMap(({ txId }) =>
      readHistoryTx$(
        txId,
        {
          knownOutputs,
          resolveBudget,
          details: read?.id === txId ? read : undefined,
        },
        reader,
      ),
    ),
    tap(({ inputs, outputs }) => {
      resolveBudget -= inputs.filter(
        input => !knownOutputs.has(outRefKey(input)),
      ).length;
      for (const output of outputs) {
        knownOutputs.set(outRefKey(output), output);
      }
    }),
    catchError(() => EMPTY),
    toArray(),
    map(transactions => [...known, ...transactions]),
  );
};

/**
 * True when one of the Plutus scripts witnessing the transaction is the
 * Hydra head minting script of the head, at the head validator of its
 * release on the reader's network.
 */
const mintsHead = (
  head: HydraAccountHead,
  { witness }: ExtendedTxDetails,
  { context }: HeadHistoryReader,
): boolean => {
  const headAddress = getHydraScriptRegistry(context.chainId.networkId).find(
    ({ version }) => version === head.version,
  )?.headAddress;
  return (
    headAddress !== undefined &&
    (witness?.scripts ?? []).some(
      script =>
        Cardano.isPlutusScript(script) &&
        isHydraHeadMintingScript(head.headId, headAddress, script.bytes),
    )
  );
};

/**
 * Checks that a head is genuine rather than a lookalike under a policy of
 * someone's choosing. The first transaction of the head's history is its
 * init, which minted the state token, so the head is genuine only when a
 * Plutus script witnessing the init is the Hydra head minting script of the
 * head id. The verdict never changes, so a caller keeps it and checks each
 * head once.
 *
 * Costs the first listing pages, up to `ceil(maxTransactionsPerHead / P)`
 * requests with `pageSize` P, and one details read of the init, which on the
 * Blockfrost provider issues 3 requests. A genuine head's history read starts
 * from both, so a genuine head costs no read more than its history read.
 *
 * @param head - The head, as found at its validator.
 * @returns the verdict, with the start of the history of a genuine head, or
 * an error when the listing is empty or the listing or the init could not be
 * read, so the head is unverified for now
 */
export const checkHead$ = (
  head: HydraAccountHead,
  reader: HeadHistoryReader,
): Observable<HeadCheck> =>
  defer(() => listHeadHistory$(head, 1, reader)).pipe(
    switchMap(listed => {
      const [init] = listed;
      if (!init) throw new Error(`Head ${head.headId} has no history yet`);
      return unwrapProviderResult(() =>
        reader.provider.getTransactionDetails(init.txId, reader.context),
      ).pipe(
        map(
          (details): HeadCheck =>
            mintsHead(head, details, reader)
              ? { isGenuine: true, start: { listed, init: details } }
              : { isGenuine: false },
        ),
      );
    }),
  );

/**
 * Reads the history of a head: every transaction that moved its state
 * token, oldest first. History on chain does not change, so only the
 * transactions after the kept ones are read, and the listing starts at the
 * page holding the last kept transaction, so it overlaps the kept history by
 * at least one transaction. When the listing does not continue the kept
 * history, the whole history is listed and read again.
 *
 * The history is listed and read up to `maxTransactionsPerHead`
 * transactions, and a kept history of that length is returned as it is
 * without any read. Kept histories are not persisted, so a head past the
 * limit is read again once per session. Reading stops before the
 * transaction that would resolve more than `maxResolvedInputsPerHead`
 * inputs for the head; each later sweep lists the history again from the
 * page of the last kept transaction and reads that one transaction again,
 * then stops there.
 *
 * Costs the listing requests from that page on, plus for each new transaction
 * one details read and one resolve request per script input produced outside
 * the history. A details read is `getTransactionDetails`, which on the
 * Blockfrost provider issues 3 requests (`txs/{id}`, `txs/{id}/cbor` and
 * `txs/{id}/utxos`); the cost per transaction differs by stack. With
 * `pageSize` P that is at most `2 * ceil(maxTransactionsPerHead / P)` listing
 * requests, the second half only when the listing does not continue the kept
 * history, plus `maxTransactionsPerHead` details reads and
 * `maxResolvedInputsPerHead` resolve requests per head. With the default
 * limits and page size a fresh start costs a head at most
 * 2 + 3 * 200 + 100 = 702 requests, and an account, whose histories are read
 * for `maxHeadsPerAccount` genuine heads, at most 7,020, before retries of
 * failed requests. A head's history is read only once `checkHead$` found it
 * genuine, and a fresh read starts from the listing and init that check
 * read. A real head that grows past `maxTransactionsPerHead` shows only what
 * its UTxO holds; that is the price of a fixed cost per head.
 *
 * @param head - The head, as found at its validator, checked genuine.
 * @param from - The history read by an earlier sweep, empty if none, and
 * the listing and init the check of the head just read, if any, from which
 * a read with nothing kept starts without listing again.
 * @returns the history read, which ends early when reading a transaction
 * fails, or an error when the listing fails
 */
export const readHeadHistory$ = (
  head: HydraAccountHead,
  {
    kept,
    start,
  }: { kept: readonly HydraHeadHistoryTx[]; start?: HeadHistoryStart },
  reader: HeadHistoryReader,
): Observable<HydraHeadHistoryTx[]> =>
  defer(() => {
    if (kept.length === 0 && start) {
      return readNewTransactions$(
        { known: [], newer: start.listed, read: start.init },
        reader,
      );
    }
    const window = getHydraHeadHistoryWindow(
      kept.length,
      reader.pageSize,
      reader.limits,
    );
    if (!window) return of([...kept]);
    const { page, skipped } = window;
    return listHeadHistory$(head, page, reader).pipe(
      switchMap(listed => {
        if (
          continuesHydraHeadHistory(
            kept.map(({ txId }) => txId),
            listed.map(({ txId }) => txId),
            skipped,
          )
        ) {
          return readNewTransactions$(
            { known: kept, newer: listed.slice(kept.length - skipped) },
            reader,
          );
        }
        if (page === 1) {
          return readNewTransactions$({ known: [], newer: listed }, reader);
        }
        return listHeadHistory$(head, 1, reader).pipe(
          switchMap(all =>
            readNewTransactions$({ known: [], newer: all }, reader),
          ),
        );
      }),
    );
  });
