import { describe, expect, it } from 'vitest';

import parityScenarios from '../fixtures/parity-scenarios.json';
import subTransactionParityScenarios from '../fixtures/sub-transaction-parity-scenarios.json';

import {
  buildOutputsOf,
  buildScenario,
  buildSubTransactionScenario,
  subTransactionOutputsOf,
} from './scenario';

import type {
  BuildOutputs,
  Scenario,
  SubTransactionBuildOutputs,
  SubTransactionScenario,
} from './scenario';

/** What building a scenario is expected to give: its outputs, or a refusal. */
type Expected = BuildOutputs | { rejected: true };

/**
 * A scenario with the reference values the cardano-c transaction builder
 * gives for it and, when it builds, the ledger's minimum fee for that
 * transaction.
 */
interface ParityScenario {
  scenario: Scenario;
  ledgerMinimumFee?: string;
  expected: Expected;
}

const scenarios = Object.entries(
  parityScenarios as Record<string, ParityScenario>,
);

const builtScenarios = scenarios.flatMap(
  ([name, { scenario, ledgerMinimumFee }]) =>
    ledgerMinimumFee === undefined
      ? []
      : [[name, scenario, ledgerMinimumFee] as const],
);

/**
 * Builds each scenario and compares the fee, script data hash, collateral,
 * redeemer indices and transaction bytes with reference values from the
 * cardano-c transaction builder, or expects a refusal where it refuses.
 * The fee of every scenario that builds must also be the ledger's minimum.
 */
describe('transaction builder parity', () => {
  it.each(scenarios)('%s', async (_name, { scenario, expected }) => {
    const outcome = await buildScenario(scenario).then(buildOutputsOf, () => ({
      rejected: true,
    }));

    expect(outcome).toEqual(expected);
  });

  it.each(builtScenarios)(
    '%s pays the ledger minimum fee',
    async (_name, scenario, ledgerMinimumFee) => {
      const { fee } = buildOutputsOf(await buildScenario(scenario));

      expect(fee).toBe(ledgerMinimumFee);
    },
  );
});

/**
 * A sub transaction scenario with the reference values the cardano-c sub
 * transaction builder gives for it.
 */
interface SubTransactionParityScenario {
  scenario: SubTransactionScenario;
  expected: SubTransactionBuildOutputs | { rejected: true };
}

/**
 * Builds each sub transaction scenario and compares its unsigned bytes, id,
 * script data hash and redeemer indices with reference values from the
 * cardano-c sub transaction builder, or expects a refusal where it refuses.
 */
describe('sub transaction builder parity', () => {
  it.each(
    Object.entries(
      subTransactionParityScenarios as Record<
        string,
        SubTransactionParityScenario
      >,
    ),
  )('%s', async (_name, { scenario, expected }) => {
    const outcome = await buildSubTransactionScenario(scenario).then(
      subTransactionOutputsOf,
      () => ({ rejected: true }),
    );

    expect(outcome).toEqual(expected);
  });
});
