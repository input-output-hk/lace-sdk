import { activitiesActions, ActivityType } from '@lace-contract/activities';
import {
  cardanoContextActions,
  CardanoPaymentAddress,
  CardanoTxId,
  inFlightTransactionOf,
  LOVELACE_TOKEN_ID,
  pendingActivityOf,
} from '@lace-contract/cardano-context';
import {
  cardanoCustodyAccount,
  custodyAddress,
} from '@lace-contract/cardano-context/test/custody-mocks';
import {
  cardanoAccount0Addr,
  cardanoAccount1Addr,
  cardanoAccount2Addr1,
  chainId,
  midnightWallet,
  previewAccountCardanoWalletAccounts,
  threeAccountCardanoWallet,
  threeAccountCardanoWalletAccounts,
} from '@lace-contract/cardano-context/test/mocks';
import {
  Cardano,
  ProviderError,
  ProviderFailure,
  Serialization,
} from '@lace-lib/cardano-core';
import { BigNumber, Err, HexBytes, Ok, Timestamp } from '@lace-lib/util';
import { testSideEffect } from '@lace-lib/util-dev';
import { map, ReplaySubject } from 'rxjs';
import { dummyLogger } from 'ts-log';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { submitTxSideEffect } from '../../../src/store/side-effects/submit-tx';

import type { Activity } from '@lace-contract/activities';
import type { AnyAddress } from '@lace-contract/addresses';
import type * as CardanoContext from '@lace-contract/cardano-context';
import type {
  AccountUtxoMap,
  CardanoProviderDependencies,
  cardanoContextSelectors,
} from '@lace-contract/cardano-context';
import type { AccountId, AnyWallet } from '@lace-contract/wallet-repo';
import type { Result } from '@lace-lib/util';
import type { Observable } from 'rxjs';
import type { RunHelpers } from 'rxjs/testing';
import type { Logger } from 'ts-log';

vi.mock('@lace-contract/cardano-context', async importOriginal => {
  const actual = await importOriginal<typeof CardanoContext>();
  return {
    ...actual,
    inFlightTransactionOf: vi.fn(actual.inFlightTransactionOf),
    pendingActivityOf: vi.fn(actual.pendingActivityOf),
  };
});

const actions = {
  ...cardanoContextActions,
  ...activitiesActions,
};

const NOW = new Date('2026-01-02T03:04:05Z').getTime();

const [KEY_A, KEY_B, KEY_C] = threeAccountCardanoWalletAccounts;
const ADDRESS_A = Cardano.PaymentAddress(cardanoAccount0Addr.address);
const ADDRESS_B = Cardano.PaymentAddress(cardanoAccount1Addr.address);
const ADDRESS_C = Cardano.PaymentAddress(cardanoAccount2Addr1.address);

const BODY_BOUND = Cardano.Slot(0x07_14_29_9b);

const decode = (serializedTx: HexBytes): Cardano.Tx =>
  Serialization.Transaction.fromCbor(
    Serialization.TxCBOR(serializedTx),
  ).toCore();

const buildTx = (body: Cardano.TxBody): HexBytes =>
  HexBytes(
    Serialization.Transaction.fromCore({
      body,
      id: Cardano.TransactionId('0'.repeat(64)),
      witness: { signatures: new Map() },
    }).toCbor(),
  );

/**
 * Spends one UTxO (`f7c5…#1`) into two outputs at `PAYEE`, valid until
 * `BODY_BOUND`.
 */
const signedTx = HexBytes(
  '84a400d9010281825820f7c54f6688ebc50457a843d89e447ca346308a732a55ec28b8c60ec9341e5ada01018282583900ace9f2847b65f0add15c4ecd4e56177a0d6db39f865f0ac6bf144093593ffd4fbfac6f367105f8261a5f1e93bc97b9af7252be58d42b966e1a0012c4b082583900ace9f2847b65f0add15c4ecd4e56177a0d6db39f865f0ac6bf144093593ffd4fbfac6f367105f8261a5f1e93bc97b9af7252be58d42b966e1b0000000253e135ee021a00029259031a0714299ba100d9010281825820962a64b06b564133ecf53cec9d7ae40cdbcdbc281a84f421f06c72823afe60be5840f9c3706b2df03b6346c8d8db85db5f018b7f6482dda65c04061b2eaf440f690841b60c06cfff1ac38846242149649978eebd683990d797e70ba125f177193103f5f6',
);
const txId = CardanoTxId.fromCbor(signedTx);
const SIGNED_INPUT = decode(signedTx).body.inputs[0];
const PAYEE = decode(signedTx).body.outputs[0].address;
const SIGNED_INPUT_COINS = 9_998_601_463n;
const SIGNED_OUTPUT_COINS = 9_998_432_926n;

const PREVIOUS_TX = Cardano.TransactionId('39'.repeat(32));
const input = (index: number): Cardano.TxIn => ({ txId: PREVIOUS_TX, index });

const utxoAt = (
  txIn: Cardano.TxIn,
  address: Cardano.PaymentAddress,
  coins: bigint,
): Cardano.Utxo => [
  { ...txIn, address },
  { address, value: { coins } },
];

const addressEntry = (
  accountId: AccountId,
  address: Cardano.PaymentAddress,
): AnyAddress => ({
  address: CardanoPaymentAddress(address),
  accountId,
  blockchainName: 'Cardano',
  name: address.slice(-6),
  data: { networkId: chainId.networkId, networkMagic: chainId.networkMagic },
});

/** The in-flight entry the side effect is expected to record. */
const recorded = (serializedTx: HexBytes, submittedTo = chainId) =>
  actions.cardanoContext.recordInFlightTransaction(
    inFlightTransactionOf({ serializedTx, chainId: submittedTo }),
  );

/** The Pending activity the side effect is expected to record: a display row with no in-flight effects. */
const pendingRow = ({
  accountId,
  serializedTx,
  lovelace,
}: {
  accountId: AccountId;
  serializedTx: HexBytes;
  lovelace?: bigint;
}): Activity => ({
  accountId,
  activityId: String(decode(serializedTx).id),
  timestamp: Timestamp(NOW),
  tokenBalanceChanges:
    lovelace === undefined
      ? []
      : [{ tokenId: LOVELACE_TOKEN_ID, amount: BigNumber(lovelace) }],
  type: ActivityType.Pending,
});

const added = (row: Activity) =>
  actions.activities.addActivities({
    accountId: row.accountId,
    activities: [
      { ...row, provisional: expect.any(Object) as Activity['provisional'] },
    ],
  });

const completed = (serializedTx: HexBytes) =>
  actions.cardanoContext.submitTxCompleted({
    txId: CardanoTxId.fromCbor(serializedTx),
  });

type ActiveCardanoAccounts = ReturnType<
  typeof cardanoContextSelectors.cardanoContext.selectActiveCardanoAccounts
>;

/**
 * A state stream that changes during the test: its values on a marble whose
 * frames count from the start of the test, the latest replayed to each
 * subscriber.
 */
type Timeline<T> = { marble: string; values: Record<string, T> };

/** The wallet state the side effect reads when the provider answers. */
type World = {
  chainId?: Cardano.ChainId;
  accounts: ActiveCardanoAccounts;
  addresses: AnyAddress[];
  ownershipUtxos: AccountUtxoMap;
  activitiesByAccount?: Record<AccountId, Activity[]>;
  /** Replaces the constant of the same name. */
  timelines?: {
    chainId?: Timeline<Cardano.ChainId>;
    accounts?: Timeline<ActiveCardanoAccounts>;
    activitiesByAccount?: Timeline<Record<AccountId, Activity[]>>;
  };
};

/** Account A holds the fixture's input; nothing else is set up. */
const SPENDER_ONLY: World = {
  accounts: [KEY_A],
  addresses: [addressEntry(KEY_A.accountId, ADDRESS_A)],
  ownershipUtxos: {
    [KEY_A.accountId]: [utxoAt(SIGNED_INPUT, ADDRESS_A, SIGNED_INPUT_COINS)],
  },
};

/** Account A spends the fixture's input and account B receives its outputs. */
const SPENDER_AND_PAYEE: World = {
  accounts: [KEY_A, KEY_B],
  addresses: [
    addressEntry(KEY_A.accountId, ADDRESS_A),
    addressEntry(KEY_B.accountId, PAYEE),
  ],
  ownershipUtxos: SPENDER_ONLY.ownershipUtxos,
};

type Answer = (cold: RunHelpers['cold']) => Observable<Result<unknown, Error>>;

const accepted =
  (serializedTx: HexBytes, marble = 'a'): Answer =>
  cold =>
    cold(marble, { a: Ok(CardanoTxId.fromCbor(serializedTx)) });

/**
 * Runs the side effect over `submitted` transactions dispatched on the
 * `submissions` marble, the provider answering each call with the next of
 * `answers`, and expects `expected`.
 */
const expectSubmission = ({
  world,
  submitted = [signedTx],
  submissions = '-a',
  answers = submitted.map(serializedTx => accepted(serializedTx)),
  expected,
  values,
  logger = dummyLogger,
  onProvider,
}: {
  world: World;
  submitted?: HexBytes[];
  submissions?: string;
  answers?: Answer[];
  expected: string;
  values: Record<string, unknown>;
  logger?: Logger;
  onProvider?: (submitTx: ReturnType<typeof vi.fn>) => void;
}) => {
  const submitTx = vi.fn();
  testSideEffect(submitTxSideEffect, ({ hot, cold, expectObservable }) => {
    for (const answer of answers) submitTx.mockReturnValueOnce(answer(cold));
    const replayed = <T>({ marble, values }: Timeline<T>) => {
      const latest = new ReplaySubject<T>(1);
      hot(marble, values).subscribe(latest);
      return latest;
    };
    const { timelines } = world;
    return {
      actionObservables: {
        cardanoContext: {
          submitTx$: hot(
            submissions,
            Object.fromEntries(
              submitted.map((serializedTx, index) => [
                'ab'[index],
                actions.cardanoContext.submitTx({ serializedTx }),
              ]),
            ),
          ),
        },
      },
      // Every state observable replays its latest value on subscription,
      // as the store's do.
      stateObservables: {
        cardanoContext: {
          selectChainId$: timelines?.chainId
            ? replayed(timelines.chainId)
            : cold('a', { a: world.chainId }),
          selectCollateralOwnershipUtxos$: cold('a', {
            a: world.ownershipUtxos,
          }),
        },
        wallets: {
          selectAll$: (timelines?.accounts
            ? replayed(timelines.accounts)
            : cold('a', { a: world.accounts })
          ).pipe(
            map(accounts => [
              { ...threeAccountCardanoWallet, accounts } as AnyWallet,
              midnightWallet,
            ]),
          ),
        },
        addresses: { selectAllAddresses$: cold('a', { a: world.addresses }) },
        activities: {
          selectAllMap$: timelines?.activitiesByAccount
            ? replayed(timelines.activitiesByAccount)
            : cold('a', { a: world.activitiesByAccount ?? {} }),
        },
      },
      dependencies: {
        cardanoProvider: {
          submitTx,
        } as unknown as CardanoProviderDependencies['cardanoProvider'],
        actions,
        logger,
      },
      assertion: sideEffect$ => {
        expectObservable(sideEffect$).toBe(expected, values);
      },
    };
  });
  onProvider?.(submitTx);
};

describe('submitTxSideEffect', () => {
  const world = (overrides: Partial<World> & Pick<World, 'accounts'>) => ({
    chainId,
    addresses: [],
    ownershipUtxos: {},
    ...overrides,
  });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('records the entry, then the spending account’s Pending activity, then submitTxCompleted', () => {
    expectSubmission({
      world: { chainId, ...SPENDER_ONLY },
      expected: '-(abc)',
      values: {
        a: recorded(signedTx),
        b: added(
          pendingRow({
            accountId: KEY_A.accountId,
            serializedTx: signedTx,
            lovelace: -SIGNED_INPUT_COINS,
          }),
        ),
        c: completed(signedTx),
      },
    });
  });

  it('records one Pending activity per own account the transaction spends from', () => {
    const twoSpenders = buildTx({
      inputs: [input(0), input(1)],
      outputs: [
        { address: PAYEE, value: { coins: 4_000_000n } },
        { address: ADDRESS_A, value: { coins: 3_800_000n } },
      ],
      fee: 200_000n,
      validityInterval: { invalidHereafter: BODY_BOUND },
    });
    expectSubmission({
      world: world({
        accounts: [KEY_A, KEY_B],
        addresses: [
          addressEntry(KEY_A.accountId, ADDRESS_A),
          addressEntry(KEY_B.accountId, ADDRESS_B),
        ],
        ownershipUtxos: {
          [KEY_A.accountId]: [utxoAt(input(0), ADDRESS_A, 5_000_000n)],
          [KEY_B.accountId]: [utxoAt(input(1), ADDRESS_B, 3_000_000n)],
        },
      }),
      submitted: [twoSpenders],
      expected: '-(abcd)',
      values: {
        a: recorded(twoSpenders),
        b: added(
          pendingRow({
            accountId: KEY_A.accountId,
            serializedTx: twoSpenders,
            lovelace: -1_200_000n,
          }),
        ),
        c: added(
          pendingRow({
            accountId: KEY_B.accountId,
            serializedTx: twoSpenders,
            lovelace: -3_000_000n,
          }),
        ),
        d: completed(twoSpenders),
      },
    });
  });

  it('credits an own account the transaction only pays', () => {
    expectSubmission({
      world: { chainId, ...SPENDER_AND_PAYEE },
      expected: '-(abcd)',
      values: {
        a: recorded(signedTx),
        b: added(
          pendingRow({
            accountId: KEY_A.accountId,
            serializedTx: signedTx,
            lovelace: -SIGNED_INPUT_COINS,
          }),
        ),
        c: added(
          pendingRow({
            accountId: KEY_B.accountId,
            serializedTx: signedTx,
            lovelace: SIGNED_OUTPUT_COINS,
          }),
        ),
        d: completed(signedTx),
      },
    });
  });

  it('records no Pending activity for an account the transaction does not touch', () => {
    expectSubmission({
      world: {
        ...SPENDER_ONLY,
        chainId,
        // B has no known address yet.
        accounts: [KEY_A, KEY_B, KEY_C],
        addresses: [
          ...SPENDER_ONLY.addresses,
          addressEntry(KEY_C.accountId, ADDRESS_C),
        ],
      },
      expected: '-(abc)',
      values: {
        a: recorded(signedTx),
        b: added(
          pendingRow({
            accountId: KEY_A.accountId,
            serializedTx: signedTx,
            lovelace: -SIGNED_INPUT_COINS,
          }),
        ),
        c: completed(signedTx),
      },
    });
  });

  it.each([true, false])(
    'records the entry of a spend no account is known to touch, and no Pending activity (body bound: %s)',
    hasBodyBound => {
      const serializedTx = buildTx({
        inputs: [input(9)],
        outputs: [{ address: PAYEE, value: { coins: 9_600_000n } }],
        fee: 200_000n,
        ...(hasBodyBound && {
          validityInterval: { invalidHereafter: BODY_BOUND },
        }),
      });
      expectSubmission({
        world: world({ accounts: [KEY_A], addresses: SPENDER_ONLY.addresses }),
        submitted: [serializedTx],
        expected: '-(ab)',
        values: { a: recorded(serializedTx), b: completed(serializedTx) },
      });
    },
  );

  it('records a Pending activity for an account of a kind a feature adds, as for any account', () => {
    // The feature's own row, written once the submission resolves, replaces
    // this one by ID.
    const withCustodyInput = buildTx({
      inputs: [input(0), input(2)],
      outputs: [{ address: PAYEE, value: { coins: 7_800_000n } }],
      fee: 200_000n,
      validityInterval: { invalidHereafter: BODY_BOUND },
    });
    expectSubmission({
      world: world({
        accounts: [KEY_A, cardanoCustodyAccount],
        addresses: [
          addressEntry(KEY_A.accountId, ADDRESS_A),
          addressEntry(cardanoCustodyAccount.accountId, custodyAddress),
        ],
        ownershipUtxos: {
          [KEY_A.accountId]: [utxoAt(input(0), ADDRESS_A, 5_000_000n)],
          [cardanoCustodyAccount.accountId]: [
            utxoAt(input(2), custodyAddress, 3_000_000n),
          ],
        },
      }),
      submitted: [withCustodyInput],
      expected: '-(abcd)',
      values: {
        a: recorded(withCustodyInput),
        b: added(
          pendingRow({
            accountId: KEY_A.accountId,
            serializedTx: withCustodyInput,
            lovelace: -5_000_000n,
          }),
        ),
        c: added(
          pendingRow({
            accountId: cardanoCustodyAccount.accountId,
            serializedTx: withCustodyInput,
            lovelace: -3_000_000n,
          }),
        ),
        d: completed(withCustodyInput),
      },
    });
  });

  const confirmed: Activity = {
    accountId: KEY_A.accountId,
    activityId: String(txId),
    timestamp: Timestamp(NOW - 1000),
    tokenBalanceChanges: [],
    type: ActivityType.Send,
  };

  it('skips an account that already holds an activity with the transaction ID', () => {
    expectSubmission({
      world: {
        chainId,
        ...SPENDER_AND_PAYEE,
        activitiesByAccount: { [KEY_A.accountId]: [confirmed] },
      },
      expected: '-(abc)',
      values: {
        a: recorded(signedTx),
        b: added(
          pendingRow({
            accountId: KEY_B.accountId,
            serializedTx: signedTx,
            lovelace: SIGNED_OUTPUT_COINS,
          }),
        ),
        c: completed(signedTx),
      },
    });
  });

  it('skips an account whose activity with the transaction ID arrives while the provider call runs', () => {
    expectSubmission({
      world: {
        chainId,
        ...SPENDER_AND_PAYEE,
        timelines: {
          activitiesByAccount: {
            marble: 'a--b',
            values: { a: {}, b: { [KEY_A.accountId]: [confirmed] } },
          },
        },
      },
      answers: [accepted(signedTx, '----a')],
      expected: '-----(abc)',
      values: {
        a: recorded(signedTx),
        b: added(
          pendingRow({
            accountId: KEY_B.accountId,
            serializedTx: signedTx,
            lovelace: SIGNED_OUTPUT_COINS,
          }),
        ),
        c: completed(signedTx),
      },
    });
  });

  it('records a spend of pending change, which only the ownership set resolves', () => {
    const pendingParent = Cardano.TransactionId('ab'.repeat(32));
    const pendingChange = { txId: pendingParent, index: 1 };
    const childTx = buildTx({
      inputs: [pendingChange],
      outputs: [{ address: PAYEE, value: { coins: 4_800_000n } }],
      fee: 200_000n,
      validityInterval: { invalidHereafter: BODY_BOUND },
    });
    expectSubmission({
      world: world({
        accounts: [KEY_A],
        addresses: [addressEntry(KEY_A.accountId, ADDRESS_A)],
        // The settled UTxO the parent spends, and the parent's own change,
        // which only the parent's in-flight entry holds.
        ownershipUtxos: {
          [KEY_A.accountId]: [
            utxoAt(input(3), ADDRESS_A, 7_000_000n),
            utxoAt(pendingChange, ADDRESS_A, 5_000_000n),
          ],
        },
      }),
      submitted: [childTx],
      expected: '-(abc)',
      values: {
        a: recorded(childTx),
        b: added(
          pendingRow({
            accountId: KEY_A.accountId,
            serializedTx: childTx,
            lovelace: -5_000_000n,
          }),
        ),
        c: completed(childTx),
      },
    });
  });

  it('logs and skips an account whose Pending activity cannot be derived, and still records the entry and completes', () => {
    const error = new Error('underivable');
    vi.mocked(pendingActivityOf).mockImplementationOnce(() => {
      throw error;
    });
    const logger = { ...dummyLogger, warn: vi.fn() };
    expectSubmission({
      world: { chainId, ...SPENDER_AND_PAYEE },
      logger,
      expected: '-(abc)',
      values: {
        a: recorded(signedTx),
        b: added(
          pendingRow({
            accountId: KEY_B.accountId,
            serializedTx: signedTx,
            lovelace: SIGNED_OUTPUT_COINS,
          }),
        ),
        c: completed(signedTx),
      },
    });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      '[cardano-sync] could not derive the pending activity of a submitted transaction',
      { txId, accountId: KEY_A.accountId, error },
    );
  });

  it('logs and completes without an entry or a Pending activity when the accepted bytes do not decode', () => {
    const error = new Error('undecodable');
    vi.mocked(inFlightTransactionOf).mockImplementationOnce(() => {
      throw error;
    });
    const logger = { ...dummyLogger, warn: vi.fn() };
    expectSubmission({
      world: { chainId, ...SPENDER_AND_PAYEE },
      logger,
      expected: '-a',
      values: { a: completed(signedTx) },
    });
    expect(logger.warn).toHaveBeenCalledWith(
      '[cardano-sync] could not record a submitted transaction in flight',
      { error },
    );
  });

  it('records nothing and dispatches submitTxFailed when the provider refuses the transaction', () => {
    expectSubmission({
      world: { chainId, ...SPENDER_AND_PAYEE },
      answers: [
        cold =>
          cold('a', {
            a: Err(new ProviderError(ProviderFailure.ConnectionFailure)),
          }),
      ],
      expected: '-a',
      values: {
        a: actions.cardanoContext.submitTxFailed({
          txId,
          error: new ProviderError(ProviderFailure.ConnectionFailure).message,
        }),
      },
    });
  });

  it('records nothing and dispatches submitTxFailed when chainId is not available', () => {
    expectSubmission({
      world: { ...SPENDER_AND_PAYEE, chainId: undefined },
      expected: '-a',
      values: {
        a: actions.cardanoContext.submitTxFailed({
          txId,
          error: 'Chain ID not found',
        }),
      },
      onProvider: submitTx => {
        expect(submitTx).not.toHaveBeenCalled();
      },
    });
  });

  it('records each submission when the provider answers them out of order', () => {
    const laterSpend = buildTx({
      inputs: [input(4)],
      outputs: [{ address: PAYEE, value: { coins: 1_800_000n } }],
      fee: 200_000n,
      validityInterval: { invalidHereafter: BODY_BOUND },
    });
    expectSubmission({
      world: {
        ...SPENDER_ONLY,
        chainId,
        ownershipUtxos: {
          [KEY_A.accountId]: [
            utxoAt(SIGNED_INPUT, ADDRESS_A, SIGNED_INPUT_COINS),
            utxoAt(input(4), ADDRESS_A, 2_000_000n),
          ],
        },
      },
      submitted: [signedTx, laterSpend],
      submissions: '-ab',
      answers: [accepted(signedTx, '---------a'), accepted(laterSpend, '-a')],
      expected: '---(def)--(abc)',
      values: {
        a: recorded(signedTx),
        b: added(
          pendingRow({
            accountId: KEY_A.accountId,
            serializedTx: signedTx,
            lovelace: -SIGNED_INPUT_COINS,
          }),
        ),
        c: completed(signedTx),
        d: recorded(laterSpend),
        e: added(
          pendingRow({
            accountId: KEY_A.accountId,
            serializedTx: laterSpend,
            lovelace: -2_000_000n,
          }),
        ),
        f: completed(laterSpend),
      },
    });
  });

  it('records against the submission network after the active network changes during the provider call', () => {
    const [previewAccount] = previewAccountCardanoWalletAccounts;
    const previewAddress: AnyAddress = {
      ...addressEntry(previewAccount.accountId, ADDRESS_A),
      data: { ...Cardano.ChainIds.Preview },
    };
    expectSubmission({
      world: {
        ...SPENDER_ONLY,
        accounts: [...SPENDER_ONLY.accounts, previewAccount],
        addresses: [...SPENDER_ONLY.addresses, previewAddress],
        ownershipUtxos: {
          ...SPENDER_ONLY.ownershipUtxos,
          [previewAccount.accountId]: [
            utxoAt(SIGNED_INPUT, ADDRESS_A, SIGNED_INPUT_COINS),
          ],
        },
        timelines: {
          chainId: {
            marble: 'a--b',
            values: { a: chainId, b: Cardano.ChainIds.Preview },
          },
        },
      },
      answers: [accepted(signedTx, '----a')],
      expected: '-----(abc)',
      values: {
        a: recorded(signedTx, chainId),
        b: added(
          pendingRow({
            accountId: KEY_A.accountId,
            serializedTx: signedTx,
            lovelace: -SIGNED_INPUT_COINS,
          }),
        ),
        c: completed(signedTx),
      },
      onProvider: submitTx => {
        expect(submitTx).toHaveBeenCalledWith(
          { signedTransaction: signedTx },
          { chainId },
        );
      },
    });
  });

  it('uses the accounts still in the wallet when the provider answers', () => {
    expectSubmission({
      world: {
        ...SPENDER_ONLY,
        chainId,
        timelines: {
          accounts: {
            marble: 'a--b',
            values: { a: SPENDER_ONLY.accounts, b: [] },
          },
        },
      },
      answers: [accepted(signedTx, '----a')],
      expected: '-----(ab)',
      values: { a: recorded(signedTx), b: completed(signedTx) },
    });
  });

  it('records a body that sets no upper validity bound without a bound of its own, leaving the cut-off to the store', () => {
    const unbounded = buildTx({
      inputs: [input(5)],
      outputs: [{ address: PAYEE, value: { coins: 2_800_000n } }],
      fee: 200_000n,
    });
    const record = recorded(unbounded);
    expect(record.payload).not.toHaveProperty('invalidHereafter');
    expectSubmission({
      world: world({
        accounts: [KEY_A],
        addresses: [addressEntry(KEY_A.accountId, ADDRESS_A)],
        ownershipUtxos: {
          [KEY_A.accountId]: [utxoAt(input(5), ADDRESS_A, 3_000_000n)],
        },
      }),
      submitted: [unbounded],
      answers: [accepted(unbounded, '----a')],
      expected: '-----(abc)',
      values: {
        a: record,
        b: added(
          pendingRow({
            accountId: KEY_A.accountId,
            serializedTx: unbounded,
            lovelace: -3_000_000n,
          }),
        ),
        c: completed(unbounded),
      },
    });
  });
});
