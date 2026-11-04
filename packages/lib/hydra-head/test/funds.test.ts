import { describe, expect, it } from 'vitest';

import {
  HYDRA_HEAD_STATE_TOKEN_NAMES,
  fromBlockfrostUtxo,
  fromCardanoUtxo,
  isHydraDepositAddress,
  reconstructHydraHeadFunds,
} from '../src';

import { toCardanoUtxo } from './fixtures/cardano';
import {
  historyOf,
  preprodHeadHistories,
  preprodRecoverTx,
  toHistoryTx,
} from './fixtures/head-histories';
import { commitDatum, depositDatum, txOutData } from './fixtures/plutus';
import { preprodUtxos } from './fixtures/preprod';

import type {
  HydraBlockfrostUtxo,
  HydraHeadHistoryTx,
  HydraUtxo,
} from '../src';
import type { RecordedHeadHistory } from './fixtures/head-histories';

const ada = (coins: bigint) => ({ coins, assets: new Map<string, bigint>() });

const NOTHING = ada(0n);

/** Payment key of the Hydra 2.3.0 participant that deposited and decommitted. */
const DECOMMIT_OWNER =
  '4d6885624e031c24dcf87fa672150660d81a706174b8470abacd0c28';

/** Payment key of the participant whose deposits were all recovered. */
const RECOVERED_OWNER =
  'ba1e067abfb07ecd833cec7005a8aa89cbdf09e10d6c87bb73da9e35';

/** Depositors of the partially fanned out head, neither of them a participant. */
const FANOUT_DEPOSITOR =
  '088d20811270899db3efe4eb2851da07182e88581a57d2645457a9a9';
const FANOUT_SECOND_DEPOSITOR =
  '97176dedd72cd47441ff92a750ca95b590e82de2f4226f1a8b75314c';

/** Participants of the partially fanned out head, whose nodes paid the fees. */
const FANOUT_PARTICIPANTS = [
  '7099552de5127f5ca4f671d47f6ab785a2a676fb415d4329e9459bf6',
  'cde0c82d83345bbdde6d8c560702799b5fb196ec1f5a046a022915bd',
];

/** Depositor of the Hydra 1.3.0 head that also decommitted. */
const V1_DECOMMIT_OWNER =
  'e754f18198eeb5b1dc0504ff463de95763a832020a3f899d2cfcb7d4';
const V1_COMMIT_OWNER =
  'a0abf91dee3e17b3b3091bbc4acdd395209b7925fd62f147aae85416';
const V1_DEPOSITOR = '96c29685d88ef49c365a0aa126de1c42a0b5da080524a6f0fdc6cce4';
const V1_DECOMMITTED_ASSET_ID =
  '33564663e57d82a7eea85f75e1207d806b14aeec53bf8df58686d3e561647364';

/** Committers of the Hydra 0.18.0 head. */
const PLUTUS2_COMMIT_OWNER =
  'eaa4396c0310dd2c8f7efafdd5d31fcaa3f1a7370b5e19323c3a75ee';
const PLUTUS2_SECOND_COMMIT_OWNER =
  '364ac8ec99a0eba0a66d956563c81afdd3d10f282dfa132eb3c93369';
const PLUTUS2_COMMITTED_ASSET_ID =
  '77211b30313564b8b11db9c9de94addc5fa305f5d47fd278140eef63534f44495441';

/** The only key committer of the Hydra 1.0.0 head; the others commit scripts. */
const SCRIPTS_KEY_COMMITTER =
  'fa5136e9e9ecbc9071da73eeb6c9a4ff73cbf436105cf8380d1c525c';

/** Depositor of the Hydra 2.0.0 head: 0.77 + 20 ada. */
const V20_DEPOSITOR =
  'a8817721ee8a283156d7638de0e17540b97df1e9e85c6b90fb435868';

/** Depositors of the Hydra 2.1.0 head, and the keys paid by its decrements. */
const V21_FIRST_DEPOSITOR =
  'ce7c7a431509c501fc4ce627f7598a6640df4c0a8be35f3bc715c1e8';
const V21_SECOND_DEPOSITOR =
  '6bc787c1d7909620c60275d10da846cd448d710ce1acc1bd8b8cd435';
const V21_FIRST_PAYEE =
  'e953468f38efe981f0fd0eda4e1c1f892674416269023c69af3f8512';
const V21_SECOND_PAYEE =
  'e95524518dbaa5688683d5d7762bf5932731d9b44d9c1aa05897eee2';

/** Depositor of the Hydra 2.2.0 head, and the keys paid by its decrements. */
const V22_DEPOSITOR = V21_SECOND_DEPOSITOR;
const V22_FIRST_PAYEE =
  '702b7cdfb84744c74a2ff671aa686b675ca224329f9ed19f2b11d956';
const V22_SECOND_PAYEE =
  '136fe6be4251a184ffb9d3fbb6a9bda1d8906e66e92f2cf2226a9c93';

/** Participant of the Hydra 2.0.0 to 2.2.0 heads, whose node paid the fees. */
const V2X_PARTICIPANT =
  '80d997ce31b99dab96ce34983a1fdda7c9285fc3afc129c9032cdc20';

const converters: [string, (utxo: HydraBlockfrostUtxo) => HydraUtxo][] = [
  ['Blockfrost JSON', fromBlockfrostUtxo],
  ['Cardano.Utxo', utxo => fromCardanoUtxo(toCardanoUtxo(utxo))],
];

/** Rebuilds the history transactions with the UTxOs of another converter. */
const convertHistory = (
  history: RecordedHeadHistory,
  convert: (utxo: HydraBlockfrostUtxo) => HydraUtxo,
): HydraHeadHistoryTx[] =>
  historyOf(history).map(({ txId, inputs, outputs }) => ({
    txId,
    inputs: inputs.map(input => convert(toBlockfrost(input))),
    outputs: outputs.map(output => convert(toBlockfrost(output))),
  }));

/** Rebuilds the Blockfrost JSON of a UTxO. */
const toBlockfrost = ({
  txId,
  index,
  address,
  value,
  inlineDatum,
}: HydraUtxo): HydraBlockfrostUtxo => ({
  tx_hash: txId,
  output_index: index,
  address,
  amount: [
    { unit: 'lovelace', quantity: value.coins.toString() },
    ...[...value.assets].map(([unit, quantity]) => ({
      unit,
      quantity: quantity.toString(),
    })),
  ],
  inline_datum: inlineDatum ?? null,
});

describe.each(converters)('reconstructHydraHeadFunds from %s', (_, convert) => {
  const fundsOf = (history: RecordedHeadHistory, keys: string[]) =>
    reconstructHydraHeadFunds(
      history.headId,
      convertHistory(history, convert),
      keys,
    );

  it('counts an absorbed deposit and a decommit, but not the fee change paid to the same key', () => {
    expect(
      fundsOf(preprodHeadHistories.closedAfterDecommitV2, [DECOMMIT_OWNER]),
    ).toEqual({ deposited: ada(15_000_000n), withdrawn: ada(7_000_000n) });
  });

  it('counts nothing for a head whose deposits were all recovered', () => {
    expect(
      fundsOf(preprodHeadHistories.recoveredDepositsV2, [RECOVERED_OWNER]),
    ).toEqual({ deposited: NOTHING, withdrawn: NOTHING });
  });

  it('attributes deposits and partial fanouts to each depositor of a shared head', () => {
    const history = preprodHeadHistories.partialFanoutV2;

    expect(fundsOf(history, [FANOUT_DEPOSITOR])).toEqual({
      deposited: ada(400_000_000n),
      withdrawn: ada(37_313_500n),
    });
    expect(fundsOf(history, [FANOUT_SECOND_DEPOSITOR])).toEqual({
      deposited: ada(110_000_000n),
      withdrawn: ada(10_000_000n),
    });
  });

  it('counts nothing for participants that only paid fees', () => {
    expect(
      fundsOf(preprodHeadHistories.partialFanoutV2, FANOUT_PARTICIPANTS),
    ).toEqual({ deposited: NOTHING, withdrawn: NOTHING });
  });

  it('adds up commits, increments and a decommit with native assets of a Hydra 1.3.0 head', () => {
    const history = preprodHeadHistories.incrementsV1;

    expect(fundsOf(history, [V1_DECOMMIT_OWNER])).toEqual({
      deposited: ada(44_000_000n),
      withdrawn: {
        coins: 30_991_661n,
        assets: new Map([[V1_DECOMMITTED_ASSET_ID, 1_083_333n]]),
      },
    });
    expect(fundsOf(history, [V1_COMMIT_OWNER])).toEqual({
      deposited: ada(105_000_000n),
      withdrawn: NOTHING,
    });
  });

  it('sums the funds of every key of the account', () => {
    expect(
      fundsOf(preprodHeadHistories.incrementsV1, [
        V1_COMMIT_OWNER,
        V1_DEPOSITOR,
      ])?.deposited,
    ).toEqual(ada(205_000_000n));
  });

  it('reads commits with Plutus V2 output references of a Hydra 0.18.0 head', () => {
    const history = preprodHeadHistories.collectV1Plutus2;

    expect(fundsOf(history, [PLUTUS2_COMMIT_OWNER])).toEqual({
      deposited: {
        coins: 801_000_000n,
        assets: new Map([[PLUTUS2_COMMITTED_ASSET_ID, 50_000n]]),
      },
      withdrawn: NOTHING,
    });
    expect(fundsOf(history, [PLUTUS2_SECOND_COMMIT_OWNER])).toEqual({
      deposited: ada(467_000_000n),
      withdrawn: NOTHING,
    });
  });

  it('leaves committed script outputs to no account', () => {
    expect(
      fundsOf(preprodHeadHistories.collectV1Scripts, [SCRIPTS_KEY_COMMITTER]),
    ).toEqual({ deposited: ada(10_000_000n), withdrawn: NOTHING });
  });

  it('adds up the increments of a Hydra 2.0.0 head', () => {
    const history = preprodHeadHistories.v20Increments;

    expect(fundsOf(history, [V20_DEPOSITOR])).toEqual({
      deposited: ada(20_770_000_000n),
      withdrawn: NOTHING,
    });
    expect(fundsOf(history, [V2X_PARTICIPANT])).toEqual({
      deposited: NOTHING,
      withdrawn: NOTHING,
    });
  });

  it('credits each depositor of a Hydra 2.1.0 head and each key its decrements pay', () => {
    const history = preprodHeadHistories.v21Decrements;

    expect(fundsOf(history, [V21_FIRST_DEPOSITOR])).toEqual({
      deposited: ada(10_000_000_000n),
      withdrawn: NOTHING,
    });
    expect(fundsOf(history, [V21_SECOND_DEPOSITOR])).toEqual({
      deposited: ada(9_539_319_340n),
      withdrawn: NOTHING,
    });
    expect(fundsOf(history, [V21_FIRST_PAYEE])).toEqual({
      deposited: NOTHING,
      withdrawn: ada(49_000_000n),
    });
    expect(fundsOf(history, [V21_SECOND_PAYEE])).toEqual({
      deposited: NOTHING,
      withdrawn: ada(9_000_000n),
    });
  });

  it('adds up the increments and four decrements of a Hydra 2.2.0 head', () => {
    const history = preprodHeadHistories.v22Decrements;

    expect(fundsOf(history, [V22_DEPOSITOR])).toEqual({
      deposited: ada(11_000_000_000n),
      withdrawn: NOTHING,
    });
    expect(fundsOf(history, [V22_FIRST_PAYEE])).toEqual({
      deposited: NOTHING,
      withdrawn: ada(58_000_000n),
    });
    expect(fundsOf(history, [V22_SECOND_PAYEE])).toEqual({
      deposited: NOTHING,
      withdrawn: ada(199_000_000n),
    });
    expect(fundsOf(history, [V21_SECOND_PAYEE])).toEqual({
      deposited: NOTHING,
      withdrawn: ada(9_000_000n),
    });
    expect(fundsOf(history, [V2X_PARTICIPANT])).toEqual({
      deposited: NOTHING,
      withdrawn: NOTHING,
    });
  });

  it('counts nothing for a key that never touched the head', () => {
    expect(
      fundsOf(preprodHeadHistories.closedAfterDecommitV2, ['ab'.repeat(28)]),
    ).toEqual({ deposited: NOTHING, withdrawn: NOTHING });
  });
});

describe('reconstructHydraHeadFunds', () => {
  const { headId } = preprodHeadHistories.closedAfterDecommitV2;
  const history = historyOf(preprodHeadHistories.closedAfterDecommitV2);
  const [initTx, incrementTx, decrementTx, closeTx] = history;
  const funds = (transactions: readonly HydraHeadHistoryTx[]) =>
    reconstructHydraHeadFunds(headId, transactions, [DECOMMIT_OWNER]);
  const fundsAfterInit = (transactions: readonly HydraHeadHistoryTx[]) =>
    funds([initTx, ...transactions]);
  const fundsAfterIncrement = (transactions: readonly HydraHeadHistoryTx[]) =>
    fundsAfterInit([incrementTx, ...transactions]);
  const fundsAfterDecrement = (transactions: readonly HydraHeadHistoryTx[]) =>
    fundsAfterIncrement([decrementTx, ...transactions]);
  const depositDeadline = Date.parse('2026-09-01T00:00:00.000Z');

  /** Replaces one output of a transaction. */
  const withOutput = (
    tx: HydraHeadHistoryTx,
    index: number,
    output: Partial<HydraUtxo>,
  ): HydraHeadHistoryTx => ({
    ...tx,
    outputs: tx.outputs.map((existing, at) =>
      at === index ? { ...existing, ...output } : existing,
    ),
  });

  /** Replaces the spent deposit of the increment. */
  const withDeposit = (deposit: Partial<HydraUtxo>): HydraHeadHistoryTx => ({
    ...incrementTx,
    inputs: incrementTx.inputs.map(input =>
      isHydraDepositAddress(input.address) ? { ...input, ...deposit } : input,
    ),
  });

  it('counts nothing for an empty history', () => {
    expect(funds([])).toEqual({ deposited: NOTHING, withdrawn: NOTHING });
  });

  it('ignores transactions that do not spend the head, such as init and recover', () => {
    const recovered = preprodHeadHistories.recoveredDepositsV2;

    expect(
      reconstructHydraHeadFunds(
        recovered.headId,
        [...historyOf(recovered), toHistoryTx(preprodRecoverTx)],
        [RECOVERED_OWNER],
      ),
    ).toEqual({ deposited: NOTHING, withdrawn: NOTHING });
  });

  it('gives up on a history that starts after the head init', () => {
    expect(funds([decrementTx, closeTx])).toBeUndefined();
  });

  it('adds up a history cut short at its end', () => {
    expect(funds([initTx, incrementTx])).toEqual({
      deposited: ada(15_000_000n),
      withdrawn: NOTHING,
    });
  });

  it('gives up on a history missing a step between two head UTxOs', () => {
    expect(funds([initTx, decrementTx])).toBeUndefined();
  });

  it('gives up on a step whose spent head UTxO was left out', () => {
    const withoutHeadInput: HydraHeadHistoryTx = {
      ...incrementTx,
      inputs: incrementTx.inputs.filter(input => input.txId !== initTx.txId),
    };

    expect(funds([initTx, withoutHeadInput])).toBeUndefined();
  });

  it('gives up on a deposit whose datum targets another head', () => {
    expect(
      fundsAfterInit([
        withDeposit({ inlineDatum: preprodUtxos.depositV2.inline_datum }),
      ]),
    ).toBeUndefined();
  });

  it('reads a deposit whose committed outputs add up to what it holds', () => {
    expect(
      fundsAfterInit([
        withDeposit({
          inlineDatum: depositDatum(headId, depositDeadline, [
            txOutData({ paymentKeyHash: DECOMMIT_OWNER, coins: 10_000_000n }),
            txOutData({ paymentKeyHash: DECOMMIT_OWNER, coins: 5_000_000n }),
          ]),
        }),
      ])?.deposited,
    ).toEqual(ada(15_000_000n));
  });

  it('gives up on a deposit whose datum commits more than it holds', () => {
    expect(
      fundsAfterInit([
        withDeposit({
          inlineDatum: depositDatum(headId, depositDeadline, [
            txOutData({ paymentKeyHash: DECOMMIT_OWNER, coins: 20_000_000n }),
          ]),
        }),
      ]),
    ).toBeUndefined();
  });

  it('gives up on a deposit whose datum commits less than it holds', () => {
    expect(
      fundsAfterInit([
        withDeposit({
          inlineDatum: depositDatum(headId, depositDeadline, [
            txOutData({ paymentKeyHash: DECOMMIT_OWNER, coins: 14_000_000n }),
          ]),
        }),
      ]),
    ).toBeUndefined();
  });

  it('gives up on a deposit whose commits net to what it holds through a negative quantity', () => {
    expect(
      fundsAfterInit([
        withDeposit({
          inlineDatum: depositDatum(headId, depositDeadline, [
            txOutData({
              paymentKeyHash: DECOMMIT_OWNER,
              coins: 1_000_000_000n,
            }),
            txOutData({
              paymentKeyHash: 'ab'.repeat(28),
              coins: -985_000_000n,
            }),
          ]),
        }),
      ]),
    ).toBeUndefined();
  });

  it('recognises the head UTxO only by the state token of its release', () => {
    const { v1, v2 } = HYDRA_HEAD_STATE_TOKEN_NAMES;
    const renameStateToken = (utxo: HydraUtxo): HydraUtxo => ({
      ...utxo,
      value: {
        ...utxo.value,
        assets: new Map(
          [...utxo.value.assets].map(([unit, quantity]) => [
            unit === headId + v2 ? headId + v1 : unit,
            quantity,
          ]),
        ),
      },
    });

    expect(fundsAfterInit([incrementTx])?.deposited).not.toEqual(NOTHING);
    expect(
      fundsAfterInit([
        {
          ...incrementTx,
          inputs: incrementTx.inputs.map(renameStateToken),
          outputs: incrementTx.outputs.map(renameStateToken),
        },
      ]),
    ).toEqual({ deposited: NOTHING, withdrawn: NOTHING });
  });

  it('gives up on a spent deposit without a datum', () => {
    expect(
      fundsAfterInit([withDeposit({ inlineDatum: undefined })]),
    ).toBeUndefined();
  });

  it('gives up when the head grows by more than it absorbs', () => {
    expect(
      fundsAfterInit([
        withOutput(incrementTx, 0, {
          value: {
            ...incrementTx.outputs[0].value,
            coins: incrementTx.outputs[0].value.coins + 1n,
          },
        }),
      ]),
    ).toBeUndefined();
  });

  it('gives up when no outputs after the head output add up to what the head released', () => {
    expect(
      fundsAfterIncrement([
        withOutput(decrementTx, 1, { value: ada(6_999_999n) }),
      ]),
    ).toBeUndefined();
  });

  it('gives up when the head releases more than the outputs after it pay', () => {
    expect(
      fundsAfterIncrement([
        { ...decrementTx, outputs: decrementTx.outputs.slice(0, 1) },
      ]),
    ).toBeUndefined();
  });

  it('gives up on a transaction that ends the head', () => {
    expect(
      fundsAfterDecrement([{ ...closeTx, outputs: closeTx.outputs.slice(1) }]),
    ).toBeUndefined();
  });
});

describe('reconstructHydraHeadFunds with Hydra 1.3.0 commits', () => {
  const { headId } = preprodHeadHistories.incrementsV1;
  const [initTx, collectTx] = historyOf(preprodHeadHistories.incrementsV1);

  /** Lovelace held by the commit UTxO whose datum commits nothing. */
  const EMPTY_COMMIT_COINS = 1_461_090n;

  /** The collect with the empty commit replaced by one committing the coins. */
  const collectCommitting = (coins: bigint): HydraHeadHistoryTx => ({
    ...collectTx,
    inputs: collectTx.inputs.map(input =>
      input.value.coins === EMPTY_COMMIT_COINS
        ? {
            ...input,
            inlineDatum: commitDatum(headId, [
              txOutData({ paymentKeyHash: V1_COMMIT_OWNER, coins }),
            ]),
          }
        : input,
    ),
  });

  const depositedBy = (transactions: readonly HydraHeadHistoryTx[]) =>
    reconstructHydraHeadFunds(
      headId,
      [initTx, ...transactions],
      [V1_COMMIT_OWNER],
    )?.deposited;

  it('counts a commit of everything its UTxO holds besides the head tokens', () => {
    expect(depositedBy([collectTx])).toEqual(ada(5_000_000n));
    expect(depositedBy([collectCommitting(EMPTY_COMMIT_COINS)])).toEqual(
      ada(5_000_000n + EMPTY_COMMIT_COINS),
    );
  });

  it('gives up on a commit whose datum commits more than its UTxO holds', () => {
    expect(
      depositedBy([collectCommitting(EMPTY_COMMIT_COINS + 1n)]),
    ).toBeUndefined();
  });
});
