import { ActivityType } from '@lace-contract/activities';
import {
  CardanoPaymentAddress,
  FEATURE_FLAG_HYDRA_HEADS,
  extractOwnedPaymentCredentials,
  fromHydraHeadsIndexHistory,
  isCardanoAddressOfSupportedNetwork,
} from '@lace-contract/cardano-context';
import { whileActive } from '@lace-contract/wallet-active-state';
import {
  HYDRA_HEAD_HISTORY_LIMITS,
  HYDRA_VALIDATOR_READ_LIMITS,
  findHydraDepositedHeadIds,
  fromCardanoUtxo,
  getHydraHeadAccountFunds,
  getHydraValidatorAddresses,
  matchAccountHydra,
  selectHydraHeadsToCheck,
  selectHydraHeadsToRead,
  settleHydraValidatorReads,
} from '@lace-lib/hydra-head';
import {
  EMPTY,
  asyncScheduler,
  catchError,
  combineLatest,
  concat,
  debounceTime,
  defer,
  distinctUntilChanged,
  exhaustMap,
  filter,
  from,
  map,
  merge,
  mergeMap,
  of,
  scan,
  switchMap,
  take,
  tap,
  throttleTime,
  toArray,
} from 'rxjs';

import { unwrapProviderResult } from '../helpers/unwrap-provider-result';

import { checkHead$, readHeadHistory$ } from './head-history';

import type {
  HeadCheck,
  HeadHistoryReader,
  HeadHistoryStart,
} from './head-history';
import type { SideEffect } from '../../contracts';
import type { Cardano } from '@cardano-sdk/core';
import type {
  Activity,
  BlockchainSpecificActivityMetadata,
} from '@lace-contract/activities';
import type { AnyAddress } from '@lace-contract/addresses';
import type {
  CardanoAddressData,
  HydraHeadsIndexSliceState,
} from '@lace-contract/cardano-context';
import type { AccountId } from '@lace-contract/wallet-repo';
import type {
  HydraAccountHead,
  HydraAccountMatch,
  HydraHeadHistoryLimits,
  HydraHeadHistoryTx,
} from '@lace-lib/hydra-head';
import type { Observable } from 'rxjs';

/**
 * The shortest time between two sweeps that tip changes trigger, and how
 * long a sweep stays fresh enough that starting again, as on unlock, does
 * not repeat it.
 */
const RESWEEP_INTERVAL_MS = 5 * 60 * 1000;

/**
 * How long the network and the accounts must stay unchanged before a sweep
 * reads with them, so the bursts of address discovery and account creation
 * at load collapse into one sweep.
 */
const INPUTS_SETTLE_MS = 1000;

/** The shortest time between two sweeps that new Hydra activities trigger. */
const HYDRA_ACTIVITY_THROTTLE_MS = 60 * 1000;

/** How many validator addresses a sweep reads at the same time. */
const SWEEP_READ_CONCURRENCY = 4;

/** How many transactions each page of a head's history listing holds. */
const HISTORY_PAGE_SIZE = 100;

/** A Cardano account of the active network and its payment key hashes. */
type SweepAccount = {
  accountId: AccountId;
  /** Hex payment key hashes, sorted. */
  paymentKeyHashes: string[];
};

/** What a sweep reads with: the network and the accounts it matches. */
type SweepInputs = {
  chainId: Cardano.ChainId;
  accounts: SweepAccount[];
};

/**
 * The accounts with at least one key-hash payment address on the network.
 * Accounts whose addresses are all scripts own no participation token or
 * committed output and are left out.
 */
const toSweepInputs = (
  chainId: Cardano.ChainId,
  addresses: readonly AnyAddress[],
): SweepInputs => {
  const addressesByAccount = new Map<
    AccountId,
    AnyAddress<CardanoAddressData>[]
  >();
  for (const address of addresses) {
    if (!isCardanoAddressOfSupportedNetwork(address, chainId)) continue;
    addressesByAccount.set(address.accountId, [
      ...(addressesByAccount.get(address.accountId) ?? []),
      address,
    ]);
  }
  const accounts = [...addressesByAccount]
    .map(([accountId, accountAddresses]) => ({
      accountId,
      paymentKeyHashes: [
        ...extractOwnedPaymentCredentials(accountAddresses),
      ].sort(),
    }))
    .filter(({ paymentKeyHashes }) => paymentKeyHashes.length > 0)
    .sort((a, b) => a.accountId.localeCompare(b.accountId));
  return { chainId, accounts };
};

/**
 * True when two sweeps would read the same network for the same keys. Relies
 * on `toSweepInputs` sorting the accounts and their key hashes.
 */
const isSameSweepInputs = (a: SweepInputs, b: SweepInputs): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

/**
 * True when two chain ids name the same chain. The network id alone does
 * not: Preprod and Preview share it, and their validators hold different
 * UTxOs.
 */
const isSameChain = (a: Cardano.ChainId, b: Cardano.ChainId): boolean =>
  a.networkId === b.networkId && a.networkMagic === b.networkMagic;

/**
 * The UTxOs the last successful read of each validator address found, by
 * address. Kept in memory for the current network and accounts, so an
 * address whose read fails keeps what it held, and only the deposits and
 * heads there go stale rather than the whole sweep.
 */
type KeptValidatorReads = Map<string, Cardano.Utxo[]>;

/**
 * The UTxOs at a validator address, at most
 * `HYDRA_VALIDATOR_READ_LIMITS.maxPages` pages, or undefined when the read
 * fails.
 */
const readValidatorAddress$ = (
  address: string,
  chainId: Cardano.ChainId,
  dependencies: Parameters<SideEffect>[2],
): Observable<{ address: string; utxos: Cardano.Utxo[] | undefined }> =>
  unwrapProviderResult(() =>
    dependencies.cardanoProvider.getUtxosAtAddress(
      {
        address: CardanoPaymentAddress(address),
        pageSize: HYDRA_VALIDATOR_READ_LIMITS.pageSize,
        maxPages: HYDRA_VALIDATOR_READ_LIMITS.maxPages,
      },
      { chainId },
    ),
  ).pipe(
    map(utxos => ({ address, utxos })),
    catchError(() => of({ address, utxos: undefined })),
  );

/**
 * Reads every validator address of the network, each failure isolated by
 * `settleHydraValidatorReads`: an address whose read fails, or that fills
 * its last allowed page, stands in with what its last successful read
 * found. An address that failed and was never read has nothing to stand in
 * for it, so it is named unread rather than read as empty. Errors only when
 * every address fails, since nothing is current then.
 */
const readValidatorAddresses$ = (
  chainId: Cardano.ChainId,
  keptReads: KeptValidatorReads,
  dependencies: Parameters<SideEffect>[2],
): Observable<{ utxos: Cardano.Utxo[]; unreadAddresses: string[] }> =>
  from(getHydraValidatorAddresses(chainId.networkId)).pipe(
    mergeMap(
      address => readValidatorAddress$(address, chainId, dependencies),
      SWEEP_READ_CONCURRENCY,
    ),
    toArray(),
    map(reads => {
      const settled = settleHydraValidatorReads(reads, address =>
        keptReads.get(address),
      );
      if (!settled) {
        throw new Error('Every Hydra validator address failed to read');
      }
      for (const [address, utxos] of settled.utxosByAddress) {
        keptReads.set(address, [...utxos]);
      }
      return {
        utxos: [...settled.utxosByAddress.values()].flat(),
        unreadAddresses: [...settled.unreadAddresses],
      };
    }),
  );

/** The activities of every account, by account. */
type ActivitiesByAccount = Partial<Record<AccountId, Activity[]>>;

/**
 * Timestamp of the newest activity labelled as a Hydra Head step, or
 * `-Infinity` when there is none.
 */
const newestHydraActivityTime = (
  activitiesByAccount: ActivitiesByAccount,
): number =>
  Object.values(activitiesByAccount).reduce(
    (newest, activities) =>
      (activities ?? []).reduce(
        (newestOfAccount, { blockchainSpecific, timestamp }) =>
          (blockchainSpecific as BlockchainSpecificActivityMetadata | undefined)
            ?.Cardano?.hydra
            ? Math.max(newestOfAccount, timestamp)
            : newestOfAccount,
        newest,
      ),
    Number.NEGATIVE_INFINITY,
  );

/**
 * The ids of the heads named by deposits the account itself sent, by the
 * deposit hint rule of `findHydraDepositedHeadIds`. An activity is a Send
 * when the account's own coin went down.
 */
const depositedHeadIdsOf = (
  activities: readonly Activity[] | undefined,
): string[] =>
  findHydraDepositedHeadIds(
    (activities ?? []).map(({ type, blockchainSpecific }) => {
      const hydra = (
        blockchainSpecific as BlockchainSpecificActivityMetadata | undefined
      )?.Cardano?.hydra;
      return {
        isSent: type === ActivityType.Send,
        txName: hydra?.txName,
        headId: hydra?.headId,
      };
    }),
  );

/** The deposited head ids kept by earlier sweeps, by account. */
type KeptDepositedHeadIds =
  HydraHeadsIndexSliceState['depositedHeadIdsByAccount'];

/** The head histories kept by earlier sweeps, by head id. */
type KeptHistories = HydraHeadsIndexSliceState['historyByHeadId'];

/**
 * Whether each head kept by earlier sweeps is genuine (true) or a lookalike
 * (false), by head id. A head without a verdict has not been checked yet.
 */
type KeptVerdicts = HydraHeadsIndexSliceState['genuineByHeadId'];

/** The heads of the verdicts that are genuine. */
const genuineIn =
  (verdicts: KeptVerdicts) =>
  ({ headId }: HydraAccountHead): boolean =>
    verdicts[headId] === true;

/** The heads of every account, each read once however many accounts share it. */
const distinctHeads = (
  heads: readonly HydraAccountHead[],
): HydraAccountHead[] => [
  ...new Map(heads.map(head => [head.headId, head])).values(),
];

/**
 * Checks every head, at most `SWEEP_READ_CONCURRENCY` at a time. A head whose
 * check could not read its init is left out, so it stays unverified until a
 * later sweep checks it again.
 */
const checkHeads$ = (
  heads: readonly HydraAccountHead[],
  reader: HeadHistoryReader,
) =>
  from(heads).pipe(
    mergeMap(
      head =>
        checkHead$(head, reader).pipe(
          map(check => [[head.headId, check] as const]),
          catchError(() => of([])),
        ),
      SWEEP_READ_CONCURRENCY,
    ),
    toArray(),
    map(checks => new Map<string, HeadCheck>(checks.flat())),
  );

/**
 * Reads the history of every head, at most `SWEEP_READ_CONCURRENCY` at a
 * time, starting from the history kept by earlier sweeps, or from the
 * listing and init its check just read. A head whose listing fails maps to
 * its kept history, or to undefined when there is none, instead of failing
 * the sweep.
 */
const readHeadHistories$ = (
  heads: readonly HydraAccountHead[],
  {
    keptHistories,
    starts,
  }: {
    keptHistories: KeptHistories;
    starts: ReadonlyMap<string, HeadHistoryStart>;
  },
  reader: HeadHistoryReader,
) =>
  from(heads).pipe(
    mergeMap(head => {
      const indexed = keptHistories[head.headId];
      const kept = indexed ? fromHydraHeadsIndexHistory(indexed) : undefined;
      return readHeadHistory$(
        head,
        { kept: kept ?? [], start: starts.get(head.headId) },
        reader,
      ).pipe(
        map(history => [head.headId, history] as const),
        catchError(() => of([head.headId, kept] as const)),
      );
    }, SWEEP_READ_CONCURRENCY),
    toArray(),
    map(reads => new Map(reads)),
  );

/** The history read for each head, absent where the read fell short. */
type HeadHistories = ReadonlyMap<
  string,
  readonly HydraHeadHistoryTx[] | undefined
>;

/** An account's deposits and heads a sweep found at the validator addresses. */
type MatchedAccount = HydraAccountMatch & SweepAccount;

/**
 * What the sweep stores for an account once the head histories are read: its
 * heads and the funds each genuine head holds for it. The slice settles
 * which heads are listed with `settleHydraAccountHeads`.
 */
const toAccountHeadFunds = (
  { accountId, paymentKeyHashes, heads, candidateHeads }: MatchedAccount,
  histories: HeadHistories,
  verdicts: KeptVerdicts,
) => ({
  accountId,
  heads,
  candidateHeads,
  fundsByHeadId: Object.fromEntries(
    [...heads, ...candidateHeads]
      .filter(genuineIn(verdicts))
      .map(head => [
        head.headId,
        getHydraHeadAccountFunds(
          head,
          histories.get(head.headId),
          paymentKeyHashes,
        ),
      ]),
  ),
});

/**
 * What a sweep stores once the head histories are read: each account's heads
 * and funds, the history of every genuine head found, read now or kept from
 * an earlier sweep, and the verdicts.
 */
const toHeadFunds = (
  {
    matched,
    foundHeadIds,
    keptHistories,
    verdicts,
  }: {
    matched: readonly MatchedAccount[];
    foundHeadIds: ReadonlySet<string>;
    keptHistories: KeptHistories;
    verdicts: Readonly<Record<string, boolean>>;
  },
  histories: HeadHistories,
) => ({
  accounts: matched.map(account =>
    toAccountHeadFunds(account, histories, verdicts),
  ),
  headHistories: Object.fromEntries(
    [...foundHeadIds]
      .filter(headId => verdicts[headId])
      .flatMap(headId => {
        const kept = keptHistories[headId];
        const history = histories.has(headId)
          ? histories.get(headId)
          : kept && fromHydraHeadsIndexHistory(kept);
        return history ? [[headId, history] as const] : [];
      }),
  ),
  genuineByHeadId: verdicts,
});

/**
 * Reads every validator address once and matches the UTxOs found there to
 * every account, so the number of reads does not grow with the accounts, and
 * stores the deposits and the heads earlier sweeps found genuine. Then checks
 * the heads not checked yet, reads the history of each genuine head once and
 * stores which heads are genuine and what each account deposited into each
 * genuine head and withdrew from it, so slow history reads never hold back
 * the deposits and heads. An address whose read fails, or that fills its last
 * allowed page, stands in with what its last
 * successful read found, so only the deposits and heads there go stale and
 * no figure is ever built from a partial listing. Such an address never read
 * leaves the sweep partial: the other addresses are served, and the slice
 * keeps what it held of the unread ones rather than dropping it. The sweep
 * fails, keeping the previous snapshots, only when every address fails. The
 * address reads cost one request per page, at most 340 per sweep. A failed
 * history listing keeps the head's previous history, whose figures still
 * stand while it ends at the head UTxO found, and leaves only that head's
 * figures out otherwise.
 *
 * A head counts only once `checkHead$` found its init minted by the Hydra
 * head minting script of its head id. A lookalike is never read past its
 * init and is listed nowhere; a head whose init could not be read stays
 * unverified, unlisted, until a later sweep checks it again. Each account
 * checks at most `maxHeadChecksPerAccount` unverified heads per sweep, and a
 * head whose verdict is kept costs no check. Only genuine heads count towards
 * `maxHeadsPerAccount`, so lookalikes use up checks but never take the place
 * of a genuine head. Both picks follow the same order, heads named by the
 * account's own deposits first. Heads past either limit are not read for that
 * account, so they get no figures unless another account reads them, and
 * keep the history an earlier sweep read for them.
 *
 * Checks cost each unverified head the first listing pages and one details
 * read of its init, at most 2 + 3 = 5 requests with the default limits and
 * page size, and an account at most 30 checks, 150 requests, per sweep on top
 * of the history reads `readHeadHistory$` describes. A genuine head's history
 * read starts from what its check read, so it costs nothing more.
 *
 * The reads, the checks, the picks and the listing follow the policy of
 * `@lace-lib/hydra-head`, shared with lace-next.
 *
 * Heads an account deposited into without a participation token are found
 * from the head ids named by the deposits it sent itself, together with the
 * ids earlier sweeps kept for it, so a head stays found once its deposit
 * activity is no longer loaded. Only ids of head UTxOs the sweep already read
 * are kept, so a forged or stale id costs no read. Such a head is listed
 * while a deposit of the account waits for it, before the head absorbs it,
 * and otherwise once its history attributes a deposit to the account. Its id
 * is kept while either holds. The id of a lookalike is not kept.
 */
const sweep$ = (
  {
    chainId,
    accounts,
    keptHistories,
    keptVerdicts,
    keptDepositedHeadIds,
    keptReads,
    activitiesByAccount,
  }: SweepInputs & {
    keptHistories: KeptHistories;
    keptVerdicts: KeptVerdicts;
    keptDepositedHeadIds: KeptDepositedHeadIds;
    keptReads: KeptValidatorReads;
    activitiesByAccount: ActivitiesByAccount;
  },
  dependencies: Parameters<SideEffect>[2],
  {
    now,
    historyPageSize,
    historyLimits,
  }: {
    now: () => Date;
    historyPageSize: number;
    historyLimits: HydraHeadHistoryLimits;
  },
) =>
  readValidatorAddresses$(chainId, keptReads, dependencies).pipe(
    switchMap(({ utxos: reads, unreadAddresses }) => {
      const utxos = reads.map(fromCardanoUtxo);
      const syncedAt = now();
      const depositHeadIdsByAccount = new Map(
        accounts.map(({ accountId }) => [
          accountId,
          new Set([
            ...(keptDepositedHeadIds[accountId] ?? []),
            ...depositedHeadIdsOf(activitiesByAccount[accountId]),
          ]),
        ]),
      );
      const matched: MatchedAccount[] = accounts.map(
        ({ accountId, paymentKeyHashes }) => ({
          accountId,
          paymentKeyHashes,
          ...matchAccountHydra({
            utxos,
            paymentKeyHashes,
            candidateHeadIds: depositHeadIdsByAccount.get(accountId) ?? [],
            now: syncedAt.getTime(),
          }),
        }),
      );
      const pickOf = (
        { accountId }: MatchedAccount,
        verdicts: KeptVerdicts,
      ) => ({
        depositedHeadIds: depositHeadIdsByAccount.get(accountId) ?? new Set(),
        genuineByHeadId: new Map(
          Object.entries(verdicts).flatMap(([headId, isGenuine]) =>
            isGenuine === undefined ? [] : [[headId, isGenuine] as const],
          ),
        ),
        limits: historyLimits,
      });
      const foundHeadIds = new Set(
        matched
          .flatMap(account => [...account.heads, ...account.candidateHeads])
          .map(({ headId }) => headId),
      );
      const reader: HeadHistoryReader = {
        provider: dependencies.cardanoProvider,
        context: { chainId },
        pageSize: historyPageSize,
        limits: historyLimits,
      };
      const isKeptGenuine = genuineIn(keptVerdicts);
      return concat(
        of(
          dependencies.actions.hydraHeadsIndex.sweepCompleted({
            syncedAt,
            unreadAddresses,
            accounts: matched.map(account => ({
              ...account,
              heads: account.heads.filter(isKeptGenuine),
              candidateHeads: account.candidateHeads.filter(isKeptGenuine),
            })),
          }),
        ),
        checkHeads$(
          distinctHeads(
            matched.flatMap(account =>
              selectHydraHeadsToCheck(account, pickOf(account, keptVerdicts)),
            ),
          ),
          reader,
        ).pipe(
          switchMap(checks => {
            const verdicts = Object.fromEntries(
              [...foundHeadIds].flatMap(headId => {
                const isGenuine =
                  keptVerdicts[headId] ?? checks.get(headId)?.isGenuine;
                return isGenuine === undefined ? [] : [[headId, isGenuine]];
              }),
            ) as Record<string, boolean>;
            const starts = new Map(
              [...checks].flatMap(([headId, check]) =>
                check.isGenuine ? [[headId, check.start] as const] : [],
              ),
            );
            return readHeadHistories$(
              distinctHeads(
                matched.flatMap(account =>
                  selectHydraHeadsToRead(account, pickOf(account, verdicts)),
                ),
              ),
              { keptHistories, starts },
              reader,
            ).pipe(
              map(histories =>
                dependencies.actions.hydraHeadsIndex.headFundsResolved({
                  ...toHeadFunds(
                    { matched, foundHeadIds, keptHistories, verdicts },
                    histories,
                  ),
                  isPartial: unreadAddresses.length > 0,
                }),
              ),
            );
          }),
        ),
      );
    }),
    catchError(() =>
      of(
        dependencies.actions.hydraHeadsIndex.sweepFailed({
          accountIds: accounts.map(({ accountId }) => accountId),
        }),
      ),
    ),
  );

/**
 * Keeps the Hydra Head index of every Cardano account of the active network
 * current while the Hydra Head feature flag is on.
 *
 * A sweep runs once the network and the accounts have been unchanged for
 * `inputsSettleMs`, again when they change, on a tip change at most once per
 * `resweepIntervalMs`, and when any account gains a Hydra activity newer than
 * every one seen so far, at most once per `hydraActivityThrottleMs`. That
 * watermark starts at the time sweeping starts for the current network and
 * accounts, because the initial sweep already covers older transactions, such
 * as the history synced for a restored wallet, and the tip re-sweep covers
 * indexing lag. Activity timestamps are block times, so a device clock far
 * ahead delays recognition until the next tip re-sweep. A sweep requested
 * while one is in flight is dropped. With the flag off nothing is read.
 *
 * Neither the first sweep nor a tip change sweeps while the last sweep that
 * finished for the same network and accounts is less than
 * `resweepIntervalMs` old, so unlocking the wallet again and again reads
 * nothing more. That time is kept in memory, so a restart sweeps at once.
 * A failed sweep does not count, so the next trigger retries it. What each
 * validator address held at its last successful read is kept in memory for
 * the network too, whatever the accounts, since the validators hold the same
 * UTxOs for every account, and stands in for the address while a read of it
 * fails. Those reads start empty on every start, so an address that fails
 * from the first sweep on leaves only its own deposits and heads unknown.
 *
 * Each sweep stores the deposits and the heads known to be genuine first,
 * then checks that the heads not checked yet are genuine, reads the history
 * of every genuine head an account participates in, names in its own deposit
 * activities or was found to have deposited into by an earlier sweep, reusing
 * the history kept by earlier sweeps, and stores what each account deposited
 * into each head and withdrew from it. Lookalike heads are never listed. The
 * checks and reads stop at `historyLimits`, which defaults to
 * `HYDRA_HEAD_HISTORY_LIMITS`. A head checked for the first time, and a head
 * the account only deposited into, is listed from that second step on, unless
 * it was found genuine before and a deposit of the account waits for it. Each
 * sweep reads the activities as they are, so a deposit activity synced after
 * a sweep is picked up by the next one. On a fresh restore, an old deposit
 * found among the activities loaded after the initial sweep is not newer
 * than the watermark, so the next tip re-sweep picks it up, up to
 * `resweepIntervalMs` (5 minutes by default) later. A sweep is in flight
 * until both steps are stored.
 */
export const makeHydraHeadsIndexSweep =
  ({
    resweepIntervalMs = RESWEEP_INTERVAL_MS,
    inputsSettleMs = INPUTS_SETTLE_MS,
    hydraActivityThrottleMs = HYDRA_ACTIVITY_THROTTLE_MS,
    historyPageSize = HISTORY_PAGE_SIZE,
    historyLimits = HYDRA_HEAD_HISTORY_LIMITS,
    now = () => new Date(),
  }: {
    resweepIntervalMs?: number;
    inputsSettleMs?: number;
    hydraActivityThrottleMs?: number;
    historyPageSize?: number;
    historyLimits?: HydraHeadHistoryLimits;
    now?: () => Date;
  } = {}): SideEffect =>
  (
    _,
    {
      activities: { selectAllMap$ },
      addresses: { selectAllAddresses$ },
      cardanoContext: { selectChainId$, selectTip$ },
      features: { selectLoadedFeatures$ },
      hydraHeadsIndex: {
        selectHistoryByHeadId$,
        selectGenuineByHeadId$,
        selectDepositedHeadIdsByAccount$,
      },
    },
    dependencies,
  ) => {
    let lastFinished: { inputs: SweepInputs; at: number } | undefined;
    const { headFundsResolved } = dependencies.actions.hydraHeadsIndex;
    const isFresh = (inputs: SweepInputs) =>
      lastFinished !== undefined &&
      isSameSweepInputs(lastFinished.inputs, inputs) &&
      asyncScheduler.now() - lastFinished.at < resweepIntervalMs;
    return selectLoadedFeatures$.pipe(
      map(({ featureFlags }) =>
        featureFlags.some(flag => flag.key === FEATURE_FLAG_HYDRA_HEADS),
      ),
      distinctUntilChanged(),
      switchMap(enabled => {
        if (!enabled) return EMPTY;
        let keptReads:
          | { chainId: Cardano.ChainId; reads: KeptValidatorReads }
          | undefined;
        const keptReadsOn = (chainId: Cardano.ChainId): KeptValidatorReads => {
          if (!keptReads || !isSameChain(keptReads.chainId, chainId)) {
            keptReads = { chainId, reads: new Map() };
          }
          return keptReads.reads;
        };
        const tipChanges$ = selectTip$.pipe(
          filter(Boolean),
          distinctUntilChanged((a, b) => a.hash === b.hash),
        );
        const newHydraActivity$ = defer(() => {
          const startedAt = now().getTime();
          return selectAllMap$.pipe(
            map(newestHydraActivityTime),
            scan((newest, time) => Math.max(newest, time), startedAt),
            distinctUntilChanged(),
            filter(newest => newest > startedAt),
          );
        }).pipe(
          throttleTime(hydraActivityThrottleMs, asyncScheduler, {
            leading: true,
            trailing: true,
          }),
        );
        return combineLatest([
          selectChainId$.pipe(filter(Boolean)),
          selectAllAddresses$,
        ]).pipe(
          map(([chainId, addresses]) => toSweepInputs(chainId, addresses)),
          debounceTime(inputsSettleMs),
          distinctUntilChanged(isSameSweepInputs),
          switchMap(inputs => {
            if (inputs.accounts.length === 0) return EMPTY;
            const keptReads = keptReadsOn(inputs.chainId);
            return merge(
              concat(of(undefined), tipChanges$).pipe(
                filter(() => !isFresh(inputs)),
                throttleTime(resweepIntervalMs),
              ),
              newHydraActivity$,
            ).pipe(
              exhaustMap(() =>
                combineLatest([
                  selectHistoryByHeadId$,
                  selectGenuineByHeadId$,
                  selectDepositedHeadIdsByAccount$,
                  selectAllMap$,
                ]).pipe(
                  take(1),
                  switchMap(
                    ([
                      keptHistories,
                      keptVerdicts,
                      keptDepositedHeadIds,
                      activitiesByAccount,
                    ]) =>
                      sweep$(
                        {
                          ...inputs,
                          keptHistories,
                          keptVerdicts,
                          keptDepositedHeadIds,
                          keptReads,
                          activitiesByAccount,
                        },
                        dependencies,
                        { now, historyPageSize, historyLimits },
                      ),
                  ),
                  tap(action => {
                    if (headFundsResolved.match(action)) {
                      lastFinished = { inputs, at: asyncScheduler.now() };
                    }
                  }),
                ),
              ),
            );
          }),
        );
      }),
      whileActive(dependencies.isWalletActive$),
    );
  };
