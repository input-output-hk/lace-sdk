import { Cardano } from '@lace-lib/cardano-core';

import { decodeHydraCommitDatum } from './commit-datum';
import { decodeHydraDepositDatum } from './deposit-datum';
import { isHydraDepositAddress, findHydraHeadStateTokenName } from './registry';
import {
  EMPTY_HYDRA_VALUE,
  addHydraValues,
  isEmptyHydraValue,
  subtractHydraValues,
  sumHydraValues,
} from './utxo';

import type {
  HydraCommittedOutput,
  HydraHeadFunds,
  HydraHeadHistoryTx,
  HydraOutRef,
  HydraUtxo,
  HydraValue,
} from './types';

/** Value paid to, or taken from, the holder of a payment key. */
interface HydraTransfer {
  /** Hex payment key hash, absent when the payment part is a script. */
  readonly paymentKeyHash?: string;
  readonly value: HydraValue;
}

/** What one transaction of a head's history moved into and out of the head. */
interface HydraHeadStep {
  readonly absorbed: readonly HydraTransfer[];
  readonly paidOut: readonly HydraTransfer[];
}

/** Step of a transaction that does not spend the head UTxO, such as init. */
const NO_STEP: HydraHeadStep = { absorbed: [], paidOut: [] };

/** True when any quantity of the value is negative. */
const hasNegativeQuantity = ({ coins, assets }: HydraValue): boolean =>
  coins < 0n || [...assets.values()].some(quantity => quantity < 0n);

/** Hex payment key hash of a bech32 address, absent for script payments. */
const paymentKeyHashOf = (address: string): string | undefined => {
  const paymentPart =
    Cardano.Address.fromString(address)?.getProps().paymentPart;
  return paymentPart?.type === Cardano.CredentialType.KeyHash
    ? paymentPart.hash
    : undefined;
};

/**
 * True when the UTxO is the head UTxO of the head: it sits at a head address
 * and holds the state token named for that address's release.
 */
const isHeadUtxo = (utxo: HydraUtxo, headId: string): boolean => {
  const stateTokenName = findHydraHeadStateTokenName(utxo.address);
  return (
    stateTokenName !== undefined &&
    utxo.value.assets.get(headId + stateTokenName) === 1n
  );
};

/** True when the UTxO holds a token minted by the head's policy. */
const holdsHeadToken = (utxo: HydraUtxo, headId: string): boolean =>
  [...utxo.value.assets.keys()].some(unit => unit.startsWith(headId));

/** The value without the tokens minted by the head's policy. */
const withoutHeadTokens = (value: HydraValue, headId: string): HydraValue => ({
  coins: value.coins,
  assets: new Map(
    [...value.assets].filter(([unit]) => !unit.startsWith(headId)),
  ),
});

/**
 * The committed outputs a spent deposit or commit UTxO brings into the head,
 * or undefined when its datum does not decode, targets another head or
 * commits more than the UTxO holds.
 *
 * A deposit UTxO holds exactly the outputs its datum commits, so a deposit
 * whose datum claims any other value is rejected. A commit UTxO also holds
 * the participation token and its minimum ada, so its committed outputs may
 * add up to less than it holds, but never to more than it holds besides the
 * head tokens.
 */
const readAbsorbedOutputs = (
  input: HydraUtxo,
  headId: string,
): readonly HydraCommittedOutput[] | undefined => {
  const networkId = Cardano.Address.fromString(input.address)?.getNetworkId();
  if (!input.inlineDatum || networkId === undefined) return undefined;
  if (isHydraDepositAddress(input.address)) {
    const datum = decodeHydraDepositDatum(input.inlineDatum, networkId);
    if (datum?.headId !== headId) return undefined;
    const uncommitted = subtractHydraValues(
      input.value,
      sumHydraValues(datum.committed),
    );
    return isEmptyHydraValue(uncommitted) ? datum.committed : undefined;
  }
  const datum = decodeHydraCommitDatum(input.inlineDatum, networkId);
  if (datum?.headId !== headId) return undefined;
  const uncommitted = subtractHydraValues(
    withoutHeadTokens(input.value, headId),
    sumHydraValues(datum.committed),
  );
  return hasNegativeQuantity(uncommitted) ? undefined : datum.committed;
};

/**
 * Picks the outputs a transaction pays out of the head. The head lays them
 * out right after the head output, in order, and the fee change follows
 * them, so they are the shortest run of outputs after the head output whose
 * values add up to what the head released. Returns undefined when no run
 * adds up exactly.
 */
const readPaidOutOutputs = (
  released: HydraValue,
  outputsAfterHead: readonly HydraUtxo[],
): readonly HydraUtxo[] | undefined => {
  if (isEmptyHydraValue(released)) return [];
  let total = EMPTY_HYDRA_VALUE;
  for (const [index, output] of outputsAfterHead.entries()) {
    total = addHydraValues(total, output.value);
    const remaining = subtractHydraValues(released, total);
    if (isEmptyHydraValue(remaining))
      return outputsAfterHead.slice(0, index + 1);
    if (hasNegativeQuantity(remaining)) return undefined;
  }
  return undefined;
};

/**
 * Reads what one transaction moved into and out of the head. Funds enter
 * through spent deposit UTxOs (increment) or commit UTxOs, which hold a
 * participation token (collect). Funds leave through the outputs that follow
 * the head output (decrement, partial fanout). The head UTxO must change by
 * exactly the absorbed inputs minus the paid out outputs.
 *
 * @returns the step, or undefined when the transaction cannot be explained
 * that way, including one that ends the head.
 */
const readHeadStep = (
  headId: string,
  { inputs, outputs }: HydraHeadHistoryTx,
): HydraHeadStep | undefined => {
  const headInput = inputs.find(utxo => isHeadUtxo(utxo, headId));
  if (!headInput) return NO_STEP;
  const headOutputIndex = outputs.findIndex(utxo => isHeadUtxo(utxo, headId));
  if (headOutputIndex === -1) return undefined;

  const absorbedInputs = inputs.filter(
    utxo =>
      utxo !== headInput &&
      (isHydraDepositAddress(utxo.address) || holdsHeadToken(utxo, headId)),
  );
  const absorbed: HydraCommittedOutput[] = [];
  for (const input of absorbedInputs) {
    const committed = readAbsorbedOutputs(input, headId);
    if (!committed) return undefined;
    absorbed.push(...committed);
  }

  const released = subtractHydraValues(
    addHydraValues(headInput.value, sumHydraValues(absorbedInputs)),
    outputs[headOutputIndex].value,
  );
  if (hasNegativeQuantity(released)) return undefined;
  const paidOut = readPaidOutOutputs(
    released,
    outputs.slice(headOutputIndex + 1),
  );
  if (!paidOut) return undefined;

  return {
    absorbed,
    paidOut: paidOut.map(({ address, value }) => ({
      paymentKeyHash: paymentKeyHashOf(address),
      value,
    })),
  };
};

/**
 * The head UTxO the transaction produces, or the one the history held before
 * it when the transaction does not touch the head UTxO.
 *
 * @returns undefined when the transaction breaks the chain of head UTxOs: it
 * spends a head UTxO other than the one the history last produced, including
 * when the history has produced none yet because it starts after the head's
 * init, or it produces a head UTxO without spending the one the history
 * already holds, as when a transaction is missing from the history or its
 * head input was left out.
 */
const followHeadUtxo = (
  headId: string,
  previous: HydraOutRef | undefined,
  { txId, inputs, outputs }: HydraHeadHistoryTx,
): { headUtxo: HydraOutRef | undefined } | undefined => {
  const headInput = inputs.find(utxo => isHeadUtxo(utxo, headId));
  const headOutputIndex = outputs.findIndex(utxo => isHeadUtxo(utxo, headId));
  if (headInput) {
    if (
      !previous ||
      headInput.txId !== previous.txId ||
      headInput.index !== previous.index
    ) {
      return undefined;
    }
  } else if (headOutputIndex !== -1 && previous) {
    return undefined;
  }
  return {
    headUtxo:
      headOutputIndex === -1 ? previous : { txId, index: headOutputIndex },
  };
};

/** Sums the transfers of the account's payment keys. */
const sumOwned = (
  transfers: readonly HydraTransfer[],
  owned: ReadonlySet<string>,
): HydraValue =>
  sumHydraValues(
    transfers.filter(
      ({ paymentKeyHash }) =>
        paymentKeyHash !== undefined && owned.has(paymentKeyHash),
    ),
  );

/**
 * Reconstructs what a head absorbed that was committed to an account's keys
 * and what it paid back to them, from the head's layer 1 history. Deposits and commits count once the head
 * absorbs them; a recovered deposit never reaches the head and counts as
 * neither. Payouts count when a decrement or partial fanout pays them to the
 * account while the head keeps running. Ownership is decided on payment key
 * hashes, so each participant of a shared head gets only its own funds.
 *
 * Transactions are recognised from the head UTxO they spend and produce, the
 * deposit and commit UTxOs they consume and their datums, never from
 * metadata. The result is exact or absent: a break in the chain of head
 * UTxOs, any transaction that does not fit a known shape, a spent deposit or
 * commit whose datum does not decode, a
 * spent deposit whose datum commits other than what it holds, a spent
 * commit whose datum commits more than it holds besides the head tokens, or
 * a transaction that ends the head makes it undefined.
 *
 * Only the transactions passed are read, so a history cut short at its end
 * gives the figures up to that point. A caller showing current figures checks
 * that the last transaction produced the head UTxO it holds.
 *
 * @remarks The figures are meaningful only for a head that passes
 * `isHydraHeadMintingScript`. Deposits and commits count for the
 * account whose keys their datum names, not for whoever paid them. Neither
 * figure is a balance: the account's current share inside the head is not
 * visible on layer 1.
 *
 * @param headId - Hex policy id of the head state token.
 * @param transactions - Every transaction of the head's history, oldest
 * first, as listed for the head state token. The history starts at the
 * head's init, which produces the head UTxO without spending one, and each
 * later transaction that spends the head UTxO must spend the one the
 * transaction before it produced. Transactions that do not spend the head
 * UTxO add nothing.
 * @param ownedPaymentKeyHashes - Hex payment key hashes of the account.
 */
export const reconstructHydraHeadFunds = (
  headId: string,
  transactions: readonly HydraHeadHistoryTx[],
  ownedPaymentKeyHashes: Iterable<string>,
): HydraHeadFunds | undefined => {
  const owned = new Set(ownedPaymentKeyHashes);
  let deposited = EMPTY_HYDRA_VALUE;
  let withdrawn = EMPTY_HYDRA_VALUE;
  let headUtxo: HydraOutRef | undefined;
  for (const transaction of transactions) {
    const followed = followHeadUtxo(headId, headUtxo, transaction);
    if (!followed) return undefined;
    headUtxo = followed.headUtxo;
    const step = readHeadStep(headId, transaction);
    if (!step) return undefined;
    deposited = addHydraValues(deposited, sumOwned(step.absorbed, owned));
    withdrawn = addHydraValues(withdrawn, sumOwned(step.paidOut, owned));
  }
  return { deposited, withdrawn };
};
