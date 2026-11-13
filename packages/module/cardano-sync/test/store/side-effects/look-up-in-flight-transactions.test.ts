import {
  cardanoContextActions,
  CardanoNetworkId,
  UTXO_SYNC_CONFIRMATION_DEPTH,
} from '@lace-contract/cardano-context';
import {
  Cardano,
  ProviderError,
  ProviderFailure,
} from '@lace-lib/cardano-core';
import { Err, Ok, Timestamp } from '@lace-lib/util';
import { testSideEffect } from '@lace-lib/util-dev';
import { describe, expect, it, vi } from 'vitest';

import { lookUpInFlightTransactions } from '../../../src/store/side-effects/look-up-in-flight-transactions';

import type {
  CardanoNetworkInfo,
  CardanoProviderDependencies,
  CardanoTransactionInclusion,
  CardanoTxId,
  DecodedInFlightTransaction,
  InFlightTransactionKey,
  InFlightTransactionLookup,
} from '@lace-contract/cardano-context';
import type { Result } from '@lace-lib/util';
import type { Observable } from 'rxjs';
import type { Logger } from 'ts-log';

const actions = cardanoContextActions;

const BOUND = 1_000;
/** The last tip slot at which the provider is not asked. */
const AT_DEPTH = BOUND + UTXO_SYNC_CONFIRMATION_DEPTH;
const PAST = AT_DEPTH + 1;
const PREPROD = CardanoNetworkId(Cardano.ChainIds.Preprod.networkMagic);
const PREVIEW = CardanoNetworkId(Cardano.ChainIds.Preview.networkMagic);

const TX = Cardano.TransactionId('d1'.repeat(32));
const UNBOUNDED_TX = Cardano.TransactionId('d3'.repeat(32));

const INCLUSION: CardanoTransactionInclusion = {
  blockHash: Cardano.BlockId('ab'.repeat(32)),
  blockHeight: Cardano.BlockNo(42),
  slot: Cardano.Slot(BOUND - 10),
  txIndex: Cardano.TxIndex(3),
  isValid: true,
};

const entry = (
  id: Cardano.TransactionId,
  {
    invalidHereafter,
    chainId = Cardano.ChainIds.Preprod,
    lookup,
  }: {
    invalidHereafter?: number;
    chainId?: Cardano.ChainId;
    lookup?: InFlightTransactionLookup;
  } = {},
): DecodedInFlightTransaction => ({
  chainId,
  txId: id as CardanoTxId,
  effects: { consumedInputs: [], producedOutputs: [] },
  ...(invalidHereafter !== undefined && {
    invalidHereafter: Cardano.Slot(invalidHereafter),
  }),
  submittedAt: Timestamp(0),
  ...(lookup && { lookup }),
});

const keyOf = ({
  chainId,
  txId: id,
}: DecodedInFlightTransaction): InFlightTransactionKey =>
  `${CardanoNetworkId(chainId.networkMagic)}:${id}`;

const inFlightOf = (...entries: DecodedInFlightTransaction[]) =>
  Object.fromEntries(entries.map(item => [keyOf(item), item])) as Record<
    InFlightTransactionKey,
    DecodedInFlightTransaction
  >;

const boundEntry = entry(TX, { invalidHereafter: BOUND });

const tipAt = (slot: number): Cardano.Tip => ({
  slot: Cardano.Slot(slot),
  blockNo: Cardano.BlockNo(slot),
  hash: Cardano.BlockId(slot.toString(16).padStart(64, '0')),
});

const preprodTipAt = (
  slot: number,
): Partial<Record<CardanoNetworkId, CardanoNetworkInfo>> => ({
  [PREPROD]: { tip: tipAt(slot) },
});

const recorded = (
  inFlight: DecodedInFlightTransaction,
  tipSlot: number,
  inclusion: CardanoTransactionInclusion | null,
) =>
  actions.cardanoContext.recordInFlightTransactionLookup({
    key: keyOf(inFlight),
    lookup: { tipSlot: Cardano.Slot(tipSlot), inclusion },
  });

type Answer = Result<CardanoTransactionInclusion | null, ProviderError>;

const unavailable = Err<ProviderError>(
  new ProviderError(ProviderFailure.Unhealthy),
);

/**
 * Runs the side effect over the in-flight entries and network info below,
 * with the provider answering each request as `answer` does, and expects
 * `expected`. Returns the provider mock and the logger.
 */
const expectLookups = ({
  inFlight,
  networkInfo,
  answer = '-a|',
  answers = { a: Ok(null) },
  isWalletActive = 't',
  expected,
  values = {},
}: {
  inFlight: {
    marble: string;
    values: Record<
      string,
      Record<InFlightTransactionKey, DecodedInFlightTransaction>
    >;
  };
  networkInfo: {
    marble: string;
    values: Record<
      string,
      Partial<Record<CardanoNetworkId, CardanoNetworkInfo>>
    >;
  };
  answer?: string;
  answers?: Record<string, Answer>;
  isWalletActive?: string;
  expected: string;
  values?: Record<string, unknown>;
}) => {
  const checkTransaction =
    vi.fn<CardanoProviderDependencies['cardanoProvider']['checkTransaction']>();
  const logger = { warn: vi.fn() } as unknown as Logger;
  testSideEffect(lookUpInFlightTransactions, ({ cold, expectObservable }) => {
    // Each request subscribes anew, so each answers `answer` after its start.
    const answer$ = cold(answer, answers) as Observable<Answer>;
    checkTransaction.mockReturnValue(answer$);
    return {
      actionObservables: {},
      stateObservables: {
        cardanoContext: {
          selectInFlightTransactions$: cold(inFlight.marble, inFlight.values),
          selectAllNetworkInfo$: cold(networkInfo.marble, networkInfo.values),
        },
      },
      dependencies: {
        actions,
        cardanoProvider: {
          checkTransaction,
        } as unknown as CardanoProviderDependencies['cardanoProvider'],
        logger,
        isWalletActive$: cold(isWalletActive, { t: true, f: false }),
      },
      assertion: sideEffect$ => {
        expectObservable(sideEffect$, '^---------!').toBe(expected, values);
      },
    };
  });
  return { checkTransaction, logger };
};

describe('lookUpInFlightTransactions', () => {
  it('asks nothing until the tip is past the bound by the depth, and nothing for an entry without a bound', () => {
    const { checkTransaction } = expectLookups({
      inFlight: {
        marble: 'a',
        values: {
          a: inFlightOf(boundEntry, entry(UNBOUNDED_TX)),
        },
      },
      networkInfo: {
        marble: 'ab',
        values: { a: preprodTipAt(BOUND), b: preprodTipAt(AT_DEPTH) },
      },
      expected: '',
    });

    expect(checkTransaction).not.toHaveBeenCalled();
  });

  it("asks once the tip passes, on the entry's network, and records that the provider does not hold it", () => {
    const previewEntry = entry(TX, {
      invalidHereafter: BOUND,
      chainId: Cardano.ChainIds.Preview,
    });
    const { checkTransaction } = expectLookups({
      inFlight: { marble: 'a', values: { a: inFlightOf(previewEntry) } },
      networkInfo: {
        marble: 'ab',
        values: {
          a: { ...preprodTipAt(PAST), [PREVIEW]: { tip: tipAt(AT_DEPTH) } },
          b: { ...preprodTipAt(PAST), [PREVIEW]: { tip: tipAt(PAST) } },
        },
      },
      expected: '--a',
      values: { a: recorded(previewEntry, PAST, null) },
    });

    expect(checkTransaction).toHaveBeenCalledTimes(1);
    expect(checkTransaction).toHaveBeenCalledWith(TX, {
      chainId: Cardano.ChainIds.Preview,
    });
  });

  it('records where the chain included a transaction the provider holds', () => {
    expectLookups({
      inFlight: { marble: 'a', values: { a: inFlightOf(boundEntry) } },
      networkInfo: { marble: 'a', values: { a: preprodTipAt(PAST) } },
      answers: { a: Ok(INCLUSION) },
      expected: '-a',
      values: { a: recorded(boundEntry, PAST, INCLUSION) },
    });
  });

  it('records the tip slot read before the request although the tip moves while the provider answers', () => {
    const { checkTransaction } = expectLookups({
      inFlight: { marble: 'a', values: { a: inFlightOf(boundEntry) } },
      networkInfo: {
        marble: 'ab',
        values: { a: preprodTipAt(PAST), b: preprodTipAt(PAST + 20) },
      },
      answer: '---a|',
      // Each tip slot asks once, so the new tip asks too.
      expected: '---ab',
      values: {
        a: recorded(boundEntry, PAST, null),
        b: recorded(boundEntry, PAST + 20, null),
      },
    });

    expect(checkTransaction).toHaveBeenCalledTimes(2);
  });

  it('asks again only once the tip moves after a request the provider could not answer', () => {
    const { checkTransaction, logger } = expectLookups({
      inFlight: {
        marble: 'a-b',
        values: { a: inFlightOf(boundEntry), b: inFlightOf(boundEntry) },
      },
      networkInfo: {
        marble: 'a---b',
        values: { a: preprodTipAt(PAST), b: preprodTipAt(PAST + 20) },
      },
      answers: { a: unavailable },
      expected: '',
    });

    expect(checkTransaction).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it('does not ask again about an entry the provider answered for', () => {
    const answered = entry(TX, {
      invalidHereafter: BOUND,
      lookup: { tipSlot: Cardano.Slot(PAST), inclusion: null },
    });
    const { checkTransaction } = expectLookups({
      inFlight: {
        marble: 'a--b',
        values: { a: inFlightOf(boundEntry), b: inFlightOf(answered) },
      },
      networkInfo: {
        marble: 'a----b',
        values: { a: preprodTipAt(PAST), b: preprodTipAt(PAST + 20) },
      },
      expected: '-a',
      values: { a: recorded(boundEntry, PAST, null) },
    });

    expect(checkTransaction).toHaveBeenCalledTimes(1);
  });

  it('asks a request that fails by throwing again at the next tip', () => {
    const { checkTransaction, logger } = expectLookups({
      inFlight: { marble: 'a', values: { a: inFlightOf(boundEntry) } },
      networkInfo: { marble: 'a', values: { a: preprodTipAt(PAST) } },
      answer: '#',
      expected: '',
    });

    expect(checkTransaction).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('asks nothing while the wallet is locked', () => {
    const { checkTransaction } = expectLookups({
      inFlight: { marble: 'a', values: { a: inFlightOf(boundEntry) } },
      networkInfo: { marble: 'a', values: { a: preprodTipAt(PAST) } },
      isWalletActive: 'f',
      expected: '',
    });

    expect(checkTransaction).not.toHaveBeenCalled();
  });
});
