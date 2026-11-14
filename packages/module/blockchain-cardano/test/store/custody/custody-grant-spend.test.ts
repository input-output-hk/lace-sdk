import { Cardano, Serialization } from '@lace-lib/cardano-core';
import {
  custodyGrantAfterSpend,
  custodyRecipientFromAddress,
  decodeCustodyGrant,
  findCustodyScopeViolations,
  inspectCustodyTransaction,
} from '@lace-lib/cardano-custody';
import { assertWithinTransactionLimits } from '@lace-lib/cardano-tx-builder';
import { HexBlob } from '@lace-lib/cardano-util';
import { describe, expect, it, vi } from 'vitest';

import { changeReserveAt } from '../../../src/store/custody/custody-assembly';
import { custodyExecutionEstimate } from '../../../src/store/custody/custody-execution-estimate';

import {
  accountId,
  accountState,
  chainId,
  collateralFunding,
  collateralUtxo,
  compareInputs,
  CONTRACT_ADDRESS,
  CONTRACT_HASH,
  CONTRACT_SCRIPT,
  controlUtxo,
  currentLogic,
  custodyAccount,
  evaluateAll,
  expectFailure,
  expectSuccess,
  fakeProvider,
  fundUtxo,
  granteeKeyHash,
  grantUtxo,
  identity,
  logicRewardAccountOf,
  lovelaceGrant,
  MEASURED,
  otherGranteeKeyHash,
  OTHER_CONTRACT_HASH,
  OTHER_CONTRACT_SCRIPT,
  otherRecipientAddress,
  parkedScriptUtxos,
  protocolParameters,
  recipientAddress,
  RUN_REDEEMER_CBOR,
  runBuild,
  TESTNET_BYRON_ADDRESS,
  transactionOf,
  unparkedChainId,
  utxo,
  version,
} from './fixtures';

import type { ChainFixture, StoreFixture } from './fixtures';
import type {
  CardanoCustodyBuildError,
  CardanoCustodyBuildRequest,
  CardanoCustodyBuildResult,
  CardanoCustodyCollateralFunding,
  CardanoCustodyContractCall,
  RedeemerExecutionUnits,
} from '@lace-contract/cardano-context';
import type * as Crypto from '@lace-lib/cardano-crypto';
import type {
  CustodyAccountState,
  CustodyGrant,
  CustodyScopeViolation,
} from '@lace-lib/cardano-custody';

const TOKEN_POLICY = HexBlob('99'.repeat(28));
const TOKEN_NAME = HexBlob('746f6b656e');
const TOKEN = Cardano.AssetId(`${TOKEN_POLICY}${TOKEN_NAME}`);
const OTHER_TOKEN = Cardano.AssetId(`${'98'.repeat(28)}746f6b656e`);

/** What the default fee bound lowers the caps by before the first build. */
const FEE_BOUND = 1_500_000n;
/** What the second build adds to the first build's fee. */
const MARGIN = 10_000n;
const SPEND_WITH_GRANT = 'd87a80';
const FUND = 'd87c80';

const payment = (
  coins = 5_000_000n,
  address = recipientAddress,
  assets?: Cardano.TokenMap,
): Cardano.TxOut => ({
  address,
  value: { coins, ...(assets && { assets }) },
});

const spendRequest = (
  outputs: Cardano.TxOut[] = [payment()],
  {
    grantee = granteeKeyHash,
    slot,
    feeBound,
    excludedInputs,
    contract,
    funding = collateralFunding(),
  }: {
    grantee?: Crypto.Ed25519KeyHashHex;
    slot?: bigint;
    feeBound?: bigint;
    excludedInputs?: Cardano.TxIn[];
    contract?: CardanoCustodyContractCall;
    funding?: CardanoCustodyCollateralFunding;
  } = {},
): CardanoCustodyBuildRequest => ({
  requestId: 'spend-1',
  accountId,
  operation: {
    type: 'grant-spend',
    grantee,
    outputs,
    ...(slot !== undefined && { slot }),
    ...(feeBound !== undefined && { feeBound }),
    ...(excludedInputs && { excludedInputs }),
    ...(contract && { contract }),
  },
  funding,
});

/** A state that issued `grants` and revoked or superseded none. */
const stateOf = (
  grants: readonly CustodyGrant[],
  overrides: Partial<CustodyAccountState> = {},
): CustodyAccountState =>
  accountState({
    nextSlot: grants.reduce(
      (next, { slot }) => (slot >= next ? slot + 1n : next),
      0n,
    ),
    outstanding: BigInt(grants.length),
    ...overrides,
  });

const keyOf = ({ txId, index }: Cardano.TxIn) => `${txId}#${index}`;

/** What `outputs` hold at the account: lovelace, and each asset by lower-case id. */
const accountValueOf = (outputs: readonly Cardano.TxOut[]) => {
  const atAccount = outputs.filter(
    ({ address }) => address === identity.address,
  );
  const assets = new Map<Cardano.AssetId, bigint>();
  for (const { value } of atAccount) {
    for (const [assetId, quantity] of value.assets ?? []) {
      const id = assetId.toLowerCase() as Cardano.AssetId;
      assets.set(id, (assets.get(id) ?? 0n) + quantity);
    }
  }
  return {
    lovelace: atAccount.reduce((sum, { value }) => sum + value.coins, 0n),
    assets,
  };
};

/**
 * Answers with `answer`, but first applies the logic's grant rules to the
 * transaction, as the logic does to every one the provider evaluates, the
 * balanced draft included. The outflow is the account's spent inputs less
 * its outputs, so it counts the transaction's fee. It must stay within the
 * old grant's caps (`stays_within_scope`), and the recreated caps may not
 * pass the old ones less the outflow (`carries_grant_within`).
 */
const underGrantRules =
  (
    utxos: readonly Cardano.Utxo[],
    answer: NonNullable<ChainFixture['evaluate']> = evaluateAll(),
  ) =>
  (tx: Serialization.Transaction): Error | RedeemerExecutionUnits[] => {
    const body = tx.body().toCore();
    const byKey = new Map(utxos.map(utxo => [keyOf(utxo[0]), utxo[1]]));
    const spent = body.inputs.flatMap(input => byKey.get(keyOf(input)) ?? []);
    const grantOf = (output: Cardano.TxOut | undefined) => {
      const decoded = output?.datum && decodeCustodyGrant(output.datum);
      return decoded && decoded.ok ? decoded.value : undefined;
    };
    const old = spent.map(grantOf).find(grant => grant !== undefined);
    if (!old) return answer(tx);
    const recreated = grantOf(body.outputs[0])!;
    const into = accountValueOf(spent);
    const out = accountValueOf(body.outputs);
    const leaving = {
      lovelace: into.lovelace - out.lovelace,
      assets: new Map(
        [...new Set([...into.assets.keys(), ...out.assets.keys()])].map(
          id =>
            [
              id,
              (into.assets.get(id) ?? 0n) - (out.assets.get(id) ?? 0n),
            ] as const,
        ),
      ),
    };
    const allowed = custodyGrantAfterSpend(old, leaving).scope;
    const isRefused =
      findCustodyScopeViolations(old.scope, leaving).length > 0 ||
      recreated.scope.cap > allowed.cap ||
      recreated.scope.lovelaceCap > allowed.lovelaceCap;
    return isRefused
      ? new Error('Withdraw[0] the validator crashed: the grant rules refuse')
      : answer(tx);
  };

interface Scenario {
  readonly grants?: CustodyGrant[];
  readonly state?: CustodyAccountState;
  readonly funds?: Cardano.Utxo[];
  readonly chain?: ChainFixture;
  readonly store?: Partial<StoreFixture>;
  /** The network the account lives on; Preprod, where the scripts are parked, by default. */
  readonly network?: Cardano.ChainId;
}

/** An account whose store and chain agree on its control, grant and fund UTxOs. */
const scenario = ({
  grants = [lovelaceGrant()],
  state = stateOf(grants),
  funds = [fundUtxo(1, 20_000_000n)],
  chain,
  store,
  network,
}: Scenario = {}) => {
  const control = controlUtxo(state);
  const grantUtxos = grants.map(grant => grantUtxo(grant));
  const utxos = [control, ...grantUtxos, ...funds];
  const fake = fakeProvider({
    utxosAt: address => (address === identity.address ? utxos : []),
    ...chain,
    evaluate: underGrantRules(utxos, chain?.evaluate),
  });
  return {
    ...fake,
    control,
    grantUtxos,
    utxos,
    run: async (request: CardanoCustodyBuildRequest = spendRequest()) =>
      runBuild(request, {
        provider: fake.provider,
        // The agent opens the account without a device binding.
        store: {
          settledUtxos: utxos,
          account: custodyAccount(null as never, network),
          ...(network && { chainId: network }),
          ...store,
        },
      }),
  };
};

const bodyOf = (result: CardanoCustodyBuildResult) =>
  transactionOf(result).body().toCore();

const inputKeysOf = (result: CardanoCustodyBuildResult) =>
  bodyOf(result).inputs.map(keyOf);

/** The recreated grant UTxO, the first output, and the grant its datum carries. */
const recreatedOf = (result: CardanoCustodyBuildResult) => {
  const [output] = bodyOf(result).outputs;
  const decoded = decodeCustodyGrant(output.datum!);
  if (!decoded.ok) throw new Error('grant datum');
  return { output, grant: decoded.value };
};

/** The scope the recreated grant of a transaction the provider evaluates carries. */
const grantScopeOf = (tx: Serialization.Transaction) => {
  const [output] = tx.body().toCore().outputs;
  const decoded = decodeCustodyGrant(output.datum!);
  if (!decoded.ok) throw new Error('grant datum');
  return decoded.value.scope;
};

const spendRedeemersOf = (result: CardanoCustodyBuildResult) =>
  (transactionOf(result).witnessSet().redeemers()?.toCore() ?? []).filter(
    ({ purpose }) => purpose === Cardano.RedeemerPurpose.spend,
  );

/** The spend redeemers by the outpoint each spends, as CBOR. */
const redeemersByInput = (result: CardanoCustodyBuildResult) => {
  const sorted = [...inputKeysOf(result)].sort();
  return new Map(
    spendRedeemersOf(result).map(({ index, data }) => [
      sorted[index],
      Serialization.PlutusData.fromCore(data).toCbor(),
    ]),
  );
};

/** Answers the grant's redeemer, each fund's and the logic run's with their own budgets. */
const evaluateByRedeemer =
  (
    grant: Cardano.ExUnits,
    fund: Cardano.ExUnits,
    logic: Cardano.ExUnits = MEASURED,
  ) =>
  (tx: Serialization.Transaction): RedeemerExecutionUnits[] =>
    (tx.witnessSet().redeemers()?.toCore() ?? []).map(
      ({ purpose, index, data }) => ({
        purpose,
        index,
        budget:
          purpose === Cardano.RedeemerPurpose.withdrawal
            ? logic
            : Serialization.PlutusData.fromCore(data).toCbor() ===
              SPEND_WITH_GRANT
            ? grant
            : fund,
      }),
    );

/**
 * What upstream's devnet run with Preprod's parameters measured for a
 * grant spend over twelve deposits (docs/devnet-evidence.md, step 39),
 * each fund at the dearest of the twelve.
 */
const evaluateLikeDevnet = evaluateByRedeemer(
  { memory: 356_470, steps: 116_326_846 },
  { memory: 140_876, steps: 63_852_170 },
  { memory: 2_485_810, steps: 846_636_264 },
);

type CapViolation = Exclude<
  CustodyScopeViolation,
  { code: 'foreign-asset-outflow' }
>;

/** The cap violations of a scope refusal; any other failure fails the test. */
const capViolationsOf = (error: CardanoCustodyBuildError): CapViolation[] => {
  if (error.code !== 'grant-spend' || error.reason !== 'scope') {
    throw new Error(`expected a scope refusal, got ${error.code}`);
  }
  return error.violations.filter(
    (violation): violation is CapViolation =>
      violation.code !== 'foreign-asset-outflow',
  );
};

const recipientOf = (address: Cardano.PaymentAddress) => {
  const recipient = custodyRecipientFromAddress(
    Cardano.Address.fromBech32(address),
  );
  if (!recipient.ok) throw new Error('recipient');
  return recipient.value;
};

const tokenGrant = (overrides: Partial<CustodyGrant['scope']> = {}) =>
  lovelaceGrant({
    asset: { policyId: TOKEN_POLICY, assetName: TOKEN_NAME },
    perCallCap: 10n,
    cap: 50n,
    lovelacePerCallCap: 5_000_000n,
    lovelaceCap: 10_000_000n,
    ...overrides,
  });

const tokenFund = (seed: number, coins: bigint, tokens: bigint) =>
  fundUtxo(seed, coins, {
    value: { coins, assets: new Map([[TOKEN, tokens]]) },
  });

/** A reserve in the format Lace writes: inline `d87980`, no reference script. */
const reserveUtxo = (seed: number, coins: bigint) =>
  fundUtxo(seed, coins, {
    datum: Serialization.PlutusData.fromCbor(HexBlob('d87980')).toCore(),
  });

/** The least lovelace a plain change output at the account holds. */
const CHANGE_MINIMUM = changeReserveAt(
  identity.address,
  protocolParameters.coinsPerUtxoByte,
);

/**
 * The fee the builder balanced the first transaction the provider evaluated
 * at, before evaluation: what the spent funds had to cover.
 */
const balancedFeeOf = (evaluated: readonly Serialization.Transaction[]) =>
  evaluated[0].body().fee();

/** What `units` of execution cost at the test parameters' prices. */
const executionFeeOf = ({ memory, steps }: Cardano.ExUnits) =>
  BigInt(
    Math.ceil(
      protocolParameters.prices.memory * memory +
        protocolParameters.prices.steps * steps,
    ),
  );

describe('custody grant spends', () => {
  describe('transaction shape', () => {
    it('references the control UTxO and spends the grant UTxO and plain funds', async () => {
      const { run, control, grantUtxos } = scenario();
      const result = expectSuccess(await run());
      const body = bodyOf(result);

      expect(body.referenceInputs?.map(keyOf)).toEqual(
        [control[0], ...parkedScriptUtxos.map(([input]) => input)]
          .sort(compareInputs)
          .map(keyOf),
      );
      expect(inputKeysOf(result).sort()).toEqual(
        [keyOf(grantUtxos[0][0]), keyOf(fundUtxo(1, 0n)[0])].sort(),
      );
      expect(redeemersByInput(result)).toEqual(
        new Map([
          [keyOf(grantUtxos[0][0]), SPEND_WITH_GRANT],
          [keyOf(fundUtxo(1, 0n)[0]), FUND],
        ]),
      );
      expect(body.requiredExtraSignatures).toEqual([granteeKeyHash]);
      expect(body.mint).toBeUndefined();
      expect(body.certificates).toBeUndefined();
      // Exactly one withdrawal, of zero from the logic: its run.
      expect(body.withdrawals).toEqual([
        { stakeAddress: logicRewardAccountOf(), quantity: 0n },
      ]);
      expect(
        (transactionOf(result).witnessSet().redeemers()?.toCore() ?? [])
          .filter(
            ({ purpose }) => purpose === Cardano.RedeemerPurpose.withdrawal,
          )
          .map(({ data }) => Serialization.PlutusData.fromCore(data).toCbor()),
      ).toEqual([RUN_REDEEMER_CBOR]);
      expect(
        transactionOf(result).witnessSet().toCore().scripts,
      ).toBeUndefined();
      expect(
        body.outputs.some(({ value }) =>
          value.assets?.has(identity.stateNftAssetId),
        ),
      ).toBe(false);
      expect(result.resolvedInputs).toEqual(
        expect.arrayContaining([
          control,
          grantUtxos[0],
          ...parkedScriptUtxos,
          collateralUtxo,
        ]),
      );
    });

    it('attaches the proxy and the logic on a network without parked copies', async () => {
      const { run, control } = scenario({ network: unparkedChainId });
      const result = expectSuccess(await run());
      expect(bodyOf(result).referenceInputs?.map(keyOf)).toEqual([
        keyOf(control[0]),
      ]);
      expect(transactionOf(result).witnessSet().toCore().scripts).toEqual([
        version.accountValidator,
        currentLogic.script,
      ]);
    });

    it('refuses, before any evaluation, a spend whose logic credential is not registered', async () => {
      const { run, provider } = scenario({
        chain: {
          logicRewardAccount: { isRegistered: false, withdrawableAmount: 0n },
        },
      });
      expect(expectFailure(await run())).toEqual({
        code: 'logic-not-registered',
        rewardAccount: logicRewardAccountOf(),
      });
      expect(provider.evaluateTx).not.toHaveBeenCalled();
    });

    it('builds no spend that draws a logic reward balance, which inspection refuses for a grant spend', async () => {
      const { run } = scenario({
        chain: {
          logicRewardAccount: {
            isRegistered: true,
            withdrawableAmount: 1_500_000n,
          },
        },
      });
      expect(expectFailure(await run())).toMatchObject({
        code: 'inspection-refused',
        refusals: [
          {
            code: 'custody-unsupported-operation',
            reason: 'logic-draw-leaves-account',
            logic: currentLogic.hash,
            quantity: 1_500_000n,
          },
        ],
      });
    });

    it('recreates the grant UTxO with its value, no reference script and the cap lowered by the outputs and the fee', async () => {
      const grant = lovelaceGrant();
      const { run, grantUtxos } = scenario({ grants: [grant] });
      const result = expectSuccess(await run());
      const { output, grant: after } = recreatedOf(result);

      expect(output.address).toBe(identity.address);
      expect(output.value).toEqual(grantUtxos[0][1].value);
      expect(output.scriptReference).toBeUndefined();
      // Both builds measure the same budgets and encode caps of one width,
      // so the second build's fee is the first's.
      expect(after).toEqual({
        ...grant,
        scope: {
          ...grant.scope,
          cap: 50_000_000n - 5_000_000n - result.fee - MARGIN,
        },
      });
    });

    it('pays the requested outputs and returns the change to the account as a plain output', async () => {
      const { run } = scenario();
      const result = expectSuccess(await run());
      const [, paid, ...change] = bodyOf(result).outputs;

      expect(paid).toEqual(payment());
      expect(change).toEqual([
        {
          address: identity.address,
          value: { coins: 20_000_000n - 5_000_000n - result.fee },
        },
      ]);
    });

    it('keeps a grant UTxO that holds more than its minimum at its whole value', async () => {
      const grant = lovelaceGrant();
      const rich = grantUtxo(grant, { coins: 7_654_321n });
      const state = stateOf([grant]);
      const utxos = [controlUtxo(state), rich, fundUtxo(1, 20_000_000n)];
      const { provider } = fakeProvider({
        utxosAt: address => (address === identity.address ? utxos : []),
      });
      const result = expectSuccess(
        await runBuild(spendRequest(), {
          provider,
          store: {
            settledUtxos: utxos,
            account: custodyAccount(null as never),
          },
        }),
      );
      expect(recreatedOf(result).output.value).toEqual(rich[1].value);
    });

    it('passes the shared inspection as a grant spend of the referenced control', async () => {
      const { run, control, grantUtxos } = scenario();
      const result = expectSuccess(await run());
      const transaction = transactionOf(result);
      const inspection = inspectCustodyTransaction(
        transaction,
        result.resolvedInputs,
        {
          chainId,
          now: Date.now(),
          slotToPosixMs: slot => slot * 1000,
          accountRecord: result.accountRecord,
          allowGrantSpend: true,
        },
      );
      if (!inspection.ok) throw new Error('inspection refused');
      const [account] = inspection.value.accounts;
      expect(account.operations).toEqual([{ kind: 'grant-spend', slot: 0n }]);
      expect(keyOf(account.referencedControl!.input)).toBe(keyOf(control[0]));
      expect(account.controlInput).toBeUndefined();
      expect(account.controlOutput).toBeUndefined();
      expect(keyOf(account.grantSpend!.input)).toBe(keyOf(grantUtxos[0][0]));
      expect(account.grantSpend).toMatchObject({
        outputIndex: 0,
        after: recreatedOf(result).grant,
      });
    });
  });

  describe('caps', () => {
    it('lowers only the cap of a lovelace grant, whose lovelace caps stay zero', async () => {
      const { run } = scenario();
      const { scope } = recreatedOf(expectSuccess(await run())).grant;
      expect(scope.lovelacePerCallCap).toBe(0n);
      expect(scope.lovelaceCap).toBe(0n);
      expect(scope.perCallCap).toBe(20_000_000n);
    });

    it("lowers a token grant's cap by the tokens and its lovelace cap by the lovelace and the fee", async () => {
      const { run } = scenario({
        grants: [tokenGrant()],
        funds: [tokenFund(1, 10_000_000n, 100n)],
      });
      const result = expectSuccess(
        await run(
          spendRequest([
            payment(1_500_000n, recipientAddress, new Map([[TOKEN, 4n]])),
          ]),
        ),
      );
      const { scope } = recreatedOf(result).grant;
      expect(scope.cap).toBe(46n);
      expect(scope.perCallCap).toBe(10n);
      expect(scope.lovelaceCap).toBe(
        10_000_000n - 1_500_000n - result.fee - MARGIN,
      );
      expect(scope.lovelacePerCallCap).toBe(5_000_000n);
    });

    it('builds once, lowering the caps by the fee bound, when the bound is within the margin of the fee', async () => {
      const { fee } = expectSuccess(await scenario().run());
      const feeBound = fee + MARGIN / 2n;
      const { run, evaluated } = scenario();
      const result = expectSuccess(
        await run(spendRequest([payment()], { feeBound })),
      );
      expect(result.fee).toBe(fee);
      expect(recreatedOf(result).grant.scope.cap).toBe(
        50_000_000n - 5_000_000n - feeBound,
      );
      // One build: a draft and the final bytes.
      expect(evaluated).toHaveLength(2);
    });

    it('keeps the caps lowered by the fee bound when the tighter build costs more than the margin', async () => {
      const boundCap = 50_000_000n - 5_000_000n - FEE_BOUND;
      const { run } = scenario({
        chain: {
          evaluate: tx =>
            evaluateAll(
              grantScopeOf(tx).cap === boundCap
                ? MEASURED
                : { memory: 1_000_000, steps: 300_000_000 },
            )(tx),
        },
      });
      const result = expectSuccess(await run());
      expect(recreatedOf(result).grant.scope.cap).toBe(boundCap);
    });

    it('keeps the first build when the provider refuses the second', async () => {
      const boundCap = 50_000_000n - 5_000_000n - FEE_BOUND;
      const { run, evaluated } = scenario({
        chain: {
          evaluate: tx =>
            grantScopeOf(tx).cap === boundCap
              ? evaluateAll()(tx)
              : new Error('the validator crashed'),
        },
      });
      const result = expectSuccess(await run());
      expect(recreatedOf(result).grant.scope.cap).toBe(boundCap);
      expect(evaluated).toHaveLength(3);
    });

    it("keeps the first build when the second build's fee breaks a per call cap the first fits", async () => {
      const boundCap = 50_000_000n - 5_000_000n - FEE_BOUND;
      // The second build measures a little dearer, within the margin.
      const evaluate =
        (secondBudget: Cardano.ExUnits) => (tx: Serialization.Transaction) =>
          evaluateAll(
            grantScopeOf(tx).cap === boundCap ? MEASURED : secondBudget,
          )(tx);
      const firstFee = expectSuccess(
        await scenario({
          chain: {
            evaluate: evaluate({ memory: 1_000_000, steps: 300_000_000 }),
          },
        }).run(),
      ).fee;
      const { run } = scenario({
        grants: [lovelaceGrant({ perCallCap: 5_000_000n + firstFee })],
        chain: {
          evaluate: evaluate({
            memory: MEASURED.memory + 10_000,
            steps: MEASURED.steps,
          }),
        },
      });
      const result = expectSuccess(await run());
      expect(result.fee).toBe(firstFee);
      expect(recreatedOf(result).grant.scope.cap).toBe(boundCap);
    });

    it('writes zero caps when the fee bound passes them and the tighter build is dearer', async () => {
      const { run } = scenario({
        grants: [lovelaceGrant({ perCallCap: 6_000_000n, cap: 6_000_000n })],
        chain: {
          evaluate: tx =>
            evaluateAll(
              grantScopeOf(tx).cap === 0n
                ? MEASURED
                : { memory: 1_000_000, steps: 300_000_000 },
            )(tx),
        },
      });
      expect(recreatedOf(expectSuccess(await run())).grant.scope.cap).toBe(0n);

      const token = scenario({
        grants: [tokenGrant({ lovelaceCap: 2_500_000n })],
        funds: [tokenFund(1, 10_000_000n, 100n)],
        chain: {
          evaluate: tx =>
            evaluateAll(
              grantScopeOf(tx).lovelaceCap === 0n
                ? MEASURED
                : { memory: 1_000_000, steps: 300_000_000 },
            )(tx),
        },
      });
      const result = expectSuccess(
        await token.run(
          spendRequest([
            payment(1_500_000n, recipientAddress, new Map([[TOKEN, 4n]])),
          ]),
        ),
      );
      expect(recreatedOf(result).grant.scope).toMatchObject({
        cap: 46n,
        lovelaceCap: 0n,
      });
    });

    it('spends a grant whose per call cap fits the payment and the fee but not the fee bound', async () => {
      const { run } = scenario({
        grants: [lovelaceGrant({ perCallCap: 6_000_000n, cap: 6_000_000n })],
      });
      const result = expectSuccess(await run());
      const { cap } = recreatedOf(result).grant.scope;
      // The first build writes zero; the second encodes a wider cap, so its
      // fee may sit a few bytes above the first fee it lowered the cap by.
      expect(cap).toBeGreaterThan(0n);
      expect(cap).toBeLessThanOrEqual(1_000_000n - result.fee);
      expect(cap).toBeGreaterThanOrEqual(1_000_000n - result.fee - MARGIN);
    });

    it('refuses, before any evaluation, metadata on a grant spend', async () => {
      const { run, provider } = scenario();
      const request = spendRequest();
      expect(
        expectFailure(
          await run({
            ...request,
            operation: {
              ...request.operation,
              metadata: new Map([[1971n, 'pi_42']]),
            },
          } as CardanoCustodyBuildRequest),
        ),
      ).toMatchObject({
        code: 'invalid-operation',
        reason: 'invalid-metadata',
      });
      expect(provider.evaluateTx).not.toHaveBeenCalled();
    });

    it('refuses, before any evaluation, a bound below the fee of the body without execution', async () => {
      const { run, provider } = scenario();
      const error = expectFailure(
        await run(spendRequest([payment()], { feeBound: 100_000n })),
      );
      expect(error).toEqual({
        code: 'grant-spend',
        reason: 'fee-above-bound',
        fee: expect.any(BigInt) as unknown,
        feeBound: 100_000n,
      });
      if (error.code !== 'grant-spend' || error.reason !== 'fee-above-bound') {
        throw new Error('fee-above-bound');
      }
      expect(error.fee).toBeGreaterThan(100_000n);
      expect(provider.evaluateTx).not.toHaveBeenCalled();
    });

    it('refuses a fee the scripts measure above the bound', async () => {
      const { run } = scenario({
        chain: {
          evaluate: evaluateAll({ memory: 3_000_000, steps: 1_500_000_000 }),
        },
      });
      const feeBound = 1_000_000n;
      const error = expectFailure(
        await run(spendRequest([payment()], { feeBound })),
      );
      if (error.code !== 'grant-spend' || error.reason !== 'fee-above-bound') {
        throw new Error(`expected fee-above-bound, got ${error.code}`);
      }
      expect(error.feeBound).toBe(feeBound);
      // Three redeemers at the measurement and its margin.
      expect(error.fee).toBeGreaterThan(
        executionFeeOf({ memory: 9_900_000, steps: 4_950_000_000 }),
      );
    });

    it('balances every draft it evaluates within the fee its caps were lowered by', async () => {
      const { run, evaluated } = scenario();
      const result = expectSuccess(await run());
      // Each build's draft, then its final bytes.
      expect(evaluated).toHaveLength(4);
      for (const tx of evaluated) {
        const lowering = 50_000_000n - 5_000_000n - grantScopeOf(tx).cap;
        expect(tx.body().fee()).toBeLessThanOrEqual(lowering);
      }
      expect(recreatedOf(result).grant.scope.cap).toBe(
        50_000_000n - 5_000_000n - result.fee - MARGIN,
      );
    });

    it('spends under a bound between the fee and the fee the estimate prices the draft at', async () => {
      const probe = scenario();
      const { fee } = expectSuccess(await probe.run());
      const estimated = balancedFeeOf(probe.evaluated);
      const feeBound = fee + (estimated - fee) / 2n;
      expect(feeBound - fee).toBeGreaterThan(MARGIN);
      const { run, evaluated } = scenario();
      const result = expectSuccess(
        await run(spendRequest([payment()], { feeBound })),
      );
      expect(result.fee).toBe(fee);
      expect(balancedFeeOf(evaluated)).toBeLessThanOrEqual(feeBound);
      expect(recreatedOf(result).grant.scope.cap).toBe(
        50_000_000n - 5_000_000n - fee - MARGIN,
      );
    });

    it('refuses a fee bound that is not a positive amount before any evaluation', async () => {
      for (const feeBound of [0n, -1n]) {
        const { run, provider } = scenario();
        expect(
          expectFailure(await run(spendRequest([payment()], { feeBound }))),
        ).toMatchObject({
          code: 'invalid-operation',
          reason: 'invalid-fee-bound',
        });
        expect(provider.evaluateTx).not.toHaveBeenCalled();
      }
    });
  });

  describe('grant selection', () => {
    it("spends the grantee's own grant among other grantees' grants", async () => {
      const grants = [
        lovelaceGrant({}, 0n, { grantee: otherGranteeKeyHash }),
        lovelaceGrant({}, 1n),
      ];
      const { run, grantUtxos } = scenario({ grants });
      const result = expectSuccess(await run());
      expect(inputKeysOf(result)).toContain(keyOf(grantUtxos[1][0]));
      expect(inputKeysOf(result)).not.toContain(keyOf(grantUtxos[0][0]));
      expect(recreatedOf(result).grant.slot).toBe(1n);
    });

    it('matches the grantee whatever the case of its hex', async () => {
      const { run } = scenario();
      expectSuccess(
        await run(
          spendRequest([payment()], {
            grantee: granteeKeyHash.toUpperCase() as Crypto.Ed25519KeyHashHex,
          }),
        ),
      );
    });

    it('spends the current grant of a grantee whose replaced grant is revoked', async () => {
      const grants = [lovelaceGrant({}, 0n), lovelaceGrant({}, 1n)];
      const { run } = scenario({
        grants,
        state: stateOf(grants, { revoked: [0n] }),
      });
      expect(recreatedOf(expectSuccess(await run())).grant.slot).toBe(1n);
    });

    it('refuses a grantee with more than one current grant unless a slot is named', async () => {
      const grants = [lovelaceGrant({}, 0n), lovelaceGrant({}, 1n)];
      const { run } = scenario({ grants });
      expect(expectFailure(await run())).toEqual({
        code: 'grant-spend',
        reason: 'ambiguous-grant',
        grantee: granteeKeyHash,
        slots: [0n, 1n],
      });
      const named = expectSuccess(
        await run(spendRequest([payment()], { slot: 1n })),
      );
      expect(recreatedOf(named).grant.slot).toBe(1n);
    });

    it('refuses a grantee that holds no grant', async () => {
      const { run, provider } = scenario({
        grants: [lovelaceGrant({}, 0n, { grantee: otherGranteeKeyHash })],
      });
      expect(expectFailure(await run())).toEqual({
        code: 'grant-spend',
        reason: 'unknown-grant',
        grantee: granteeKeyHash,
      });
      expect(provider.evaluateTx).not.toHaveBeenCalled();
    });

    it("refuses a named slot that holds another grantee's grant or none", async () => {
      const { run } = scenario({
        grants: [
          lovelaceGrant({}, 0n),
          lovelaceGrant({}, 1n, { grantee: otherGranteeKeyHash }),
        ],
      });
      for (const slot of [1n, 5n]) {
        expect(
          expectFailure(await run(spendRequest([payment()], { slot }))),
        ).toEqual({
          code: 'grant-spend',
          reason: 'unknown-grant',
          grantee: granteeKeyHash,
          slot,
        });
      }
    });

    it('refuses a revoked grant', async () => {
      const grants = [lovelaceGrant()];
      const { run } = scenario({
        grants,
        state: stateOf(grants, { revoked: [0n] }),
      });
      expect(expectFailure(await run())).toEqual({
        code: 'grant-spend',
        reason: 'dead-grant',
        slot: 0n,
        liveness: 'revoked',
      });
    });

    it('refuses a grant a revoke-all superseded', async () => {
      const grants = [lovelaceGrant()];
      const { run } = scenario({
        grants,
        state: stateOf(grants, { grantGeneration: 1n }),
      });
      expect(
        expectFailure(await run(spendRequest([payment()], { slot: 0n }))),
      ).toEqual({
        code: 'grant-spend',
        reason: 'dead-grant',
        slot: 0n,
        liveness: 'superseded',
      });
    });

    it('refuses an expired grant', async () => {
      const { run, provider } = scenario({
        grants: [lovelaceGrant({ expiresAt: BigInt(Date.now() - 1000) })],
      });
      expect(expectFailure(await run())).toEqual({
        code: 'grant-spend',
        reason: 'dead-grant',
        slot: 0n,
        liveness: 'expired',
      });
      expect(provider.evaluateTx).not.toHaveBeenCalled();
    });

    it('refuses a grant that expires within the current slot', async () => {
      const slotStart = 1_800_000_000_000;
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(slotStart + 100);
      try {
        const { run } = scenario({
          grants: [lovelaceGrant({ expiresAt: BigInt(slotStart + 500) })],
        });
        expect(expectFailure(await run())).toEqual({
          code: 'grant-spend',
          reason: 'dead-grant',
          slot: 0n,
          liveness: 'expired',
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it("names the latest grant's death when the grantee holds no current grant", async () => {
      const grants = [
        lovelaceGrant({}, 0n),
        lovelaceGrant({ expiresAt: BigInt(Date.now() - 1000) }, 1n),
      ];
      const { run } = scenario({
        grants,
        state: stateOf(grants, { revoked: [0n] }),
      });
      expect(expectFailure(await run())).toEqual({
        code: 'grant-spend',
        reason: 'dead-grant',
        slot: 1n,
        liveness: 'expired',
      });
    });

    it('refuses a grant whose UTxO an unsettled spend of this wallet already spends', async () => {
      const { utxos, grantUtxos, provider } = scenario();
      expect(
        expectFailure(
          await runBuild(spendRequest(), {
            provider,
            store: {
              settledUtxos: utxos,
              inFlightUtxos: utxos.filter(utxo => utxo !== grantUtxos[0]),
              account: custodyAccount(null as never),
            },
          }),
        ),
      ).toEqual({ code: 'operation-in-progress' });
      expect(provider.evaluateTx).not.toHaveBeenCalled();
    });
  });

  describe('validity', () => {
    it('ends validity at the slot holding the expiry when it comes before the window', async () => {
      const expiresAt = Date.now() + 120_000;
      const { run } = scenario({
        grants: [lovelaceGrant({ expiresAt: BigInt(expiresAt) })],
      });
      const result = expectSuccess(await run());
      expect(result.invalidHereafter).toBe(Math.floor(expiresAt / 1000));
    });

    it('ends validity at the funding window when the grant outlives it', async () => {
      const funding = collateralFunding();
      const { run } = scenario();
      const result = expectSuccess(
        await run(spendRequest([payment()], { funding })),
      );
      expect(result.invalidHereafter).toBe(
        Math.floor(funding.validUntil / 1000),
      );
      expect(bodyOf(result).validityInterval?.invalidBefore).toBeUndefined();
    });

    it('refuses a funding window that leaves no slot after the current one', async () => {
      const validUntil = Date.now() - 1000;
      const { run } = scenario();
      expect(
        expectFailure(
          await run(
            spendRequest([payment()], {
              funding: collateralFunding({ validUntil }),
            }),
          ),
        ),
      ).toEqual({ code: 'validity-window', validUntil });
    });
  });

  describe('scope', () => {
    it('refuses a payment above the per call cap before any build, without a fee', async () => {
      const { run, provider } = scenario();
      expect(
        expectFailure(await run(spendRequest([payment(25_000_000n)]))),
      ).toEqual({
        code: 'grant-spend',
        reason: 'scope',
        violations: [
          {
            code: 'per-call-cap-exceeded',
            outflow: 25_000_000n,
            limit: 20_000_000n,
          },
        ],
      });
      expect(provider.evaluateTx).not.toHaveBeenCalled();
    });

    it('refuses a spend whose fee takes it over the cap, reporting the fee', async () => {
      const { run } = scenario({
        grants: [lovelaceGrant({ perCallCap: 5_000_000n })],
      });
      const [violation, ...others] = capViolationsOf(
        expectFailure(await run()),
      );
      expect(others).toEqual([]);
      expect(violation).toMatchObject({
        code: 'per-call-cap-exceeded',
        limit: 5_000_000n,
      });
      expect(violation.outflow - violation.fee!).toBe(5_000_000n);
      expect(violation.fee).toBeGreaterThan(0n);
    });

    it('reports the fee on a token grant only where it counts, against the lovelace caps', async () => {
      const { run } = scenario({
        grants: [tokenGrant({ lovelacePerCallCap: 1_600_000n })],
        funds: [tokenFund(1, 10_000_000n, 100n)],
      });
      const [violation, ...others] = capViolationsOf(
        expectFailure(
          await run(
            spendRequest([
              payment(1_500_000n, recipientAddress, new Map([[TOKEN, 4n]])),
            ]),
          ),
        ),
      );
      expect(others).toEqual([]);
      expect(violation).toMatchObject({
        code: 'lovelace-per-call-cap-exceeded',
        limit: 1_600_000n,
      });
      expect(violation.outflow - violation.fee!).toBe(1_500_000n);
    });

    it('refuses an outflow of another asset', async () => {
      const { run } = scenario({
        funds: [
          fundUtxo(1, 20_000_000n, {
            value: {
              coins: 20_000_000n,
              assets: new Map([[OTHER_TOKEN, 5n]]),
            },
          }),
        ],
      });
      expect(
        expectFailure(
          await run(
            spendRequest([
              payment(
                2_000_000n,
                recipientAddress,
                new Map([[OTHER_TOKEN, 1n]]),
              ),
            ]),
          ),
        ),
      ).toMatchObject({
        code: 'grant-spend',
        reason: 'scope',
        violations: [{ code: 'foreign-asset-outflow' }],
      });
    });

    it('pays only a listed recipient when the grant lists recipients', async () => {
      const { run } = scenario({
        grants: [
          lovelaceGrant({ recipients: [recipientOf(recipientAddress)] }),
        ],
      });
      expectSuccess(await run());
      expect(
        expectFailure(
          await run(spendRequest([payment(5_000_000n, otherRecipientAddress)])),
        ),
      ).toEqual({
        code: 'grant-spend',
        reason: 'recipient-not-allowed',
        outputIndex: 0,
      });
    });

    it('ignores a listed recipient no address can stand for', async () => {
      const unrepresentable = {
        paymentCredential: {
          type: Cardano.CredentialType.KeyHash,
          hash: HexBlob('ab'),
        },
      };
      const { run } = scenario({
        grants: [
          lovelaceGrant({
            recipients: [unrepresentable, recipientOf(recipientAddress)],
          }),
        ],
      });
      expectSuccess(await run());
    });

    it('matches a listed recipient given as hex', async () => {
      const { run } = scenario({
        grants: [
          lovelaceGrant({ recipients: [recipientOf(recipientAddress)] }),
        ],
      });
      const hex = Cardano.Address.fromBech32(
        recipientAddress,
      ).toBytes() as unknown as Cardano.PaymentAddress;
      expectSuccess(await run(spendRequest([payment(5_000_000n, hex)])));
    });

    it('refuses an output the account cannot pay as asked', async () => {
      const { run } = scenario();
      expect(
        expectFailure(await run(spendRequest([payment(1000n)]))),
      ).toMatchObject({ code: 'invalid-operation', reason: 'invalid-output' });
    });

    it('refuses a Byron output before any evaluation when the grant lists recipients', async () => {
      const { run, provider } = scenario({
        grants: [
          lovelaceGrant({ recipients: [recipientOf(recipientAddress)] }),
        ],
      });
      expect(
        expectFailure(
          await run(spendRequest([payment(5_000_000n, TESTNET_BYRON_ADDRESS)])),
        ),
      ).toEqual({
        code: 'invalid-operation',
        reason: 'invalid-output',
        message:
          'Output 0 is a Byron address, which a Plutus transaction cannot pay',
      });
      expect(provider.evaluateTx).not.toHaveBeenCalled();
    });
  });

  describe('funds', () => {
    it('never spends a reserve, however short the plain funds are', async () => {
      const reserve = reserveUtxo(2, 50_000_000n);
      const paid = scenario({ funds: [reserve, fundUtxo(1, 20_000_000n)] });
      expect(inputKeysOf(expectSuccess(await paid.run()))).not.toContain(
        keyOf(reserve[0]),
      );
      const { run, provider } = scenario({ funds: [reserve] });
      expect(expectFailure(await run())).toMatchObject({
        code: 'insufficient-funds',
      });
      expect(provider.evaluateTx).not.toHaveBeenCalled();
    });

    it('never spends a fund UTxO that carries a reference script, however short the other funds are', async () => {
      const withScript = fundUtxo(2, 50_000_000n, {
        scriptReference: identity.contractVersion.accountValidator,
      });
      const paid = scenario({
        funds: [withScript, fundUtxo(1, 20_000_000n)],
      });
      expect(inputKeysOf(expectSuccess(await paid.run()))).not.toContain(
        keyOf(withScript[0]),
      );
      const { run } = scenario({
        funds: [withScript, fundUtxo(1, 4_000_000n)],
      });
      expect(expectFailure(await run())).toMatchObject({
        code: 'insufficient-funds',
      });
    });

    it('builds two grants of one account in parallel on disjoint fund inputs', async () => {
      const grants = [
        lovelaceGrant({}, 0n),
        lovelaceGrant({}, 1n, { grantee: otherGranteeKeyHash }),
      ];
      const first = fundUtxo(1, 20_000_000n);
      const second = fundUtxo(2, 15_000_000n);
      const { run, control, grantUtxos } = scenario({
        grants,
        funds: [first, second],
      });
      const agentSpend = expectSuccess(await run());
      const fundsOf = (result: CardanoCustodyBuildResult) =>
        inputKeysOf(result).filter(
          key => !grantUtxos.some(([input]) => keyOf(input) === key),
        );
      expect(fundsOf(agentSpend)).toEqual([keyOf(first[0])]);

      // Unaware of the first spend, the second agent would pick its fund.
      const contended = expectSuccess(
        await run(spendRequest([payment()], { grantee: otherGranteeKeyHash })),
      );
      expect(fundsOf(contended)).toEqual([keyOf(first[0])]);

      const otherSpend = expectSuccess(
        await run(
          spendRequest([payment()], {
            grantee: otherGranteeKeyHash,
            excludedInputs: bodyOf(agentSpend).inputs,
          }),
        ),
      );
      expect(fundsOf(otherSpend)).toEqual([keyOf(second[0])]);
      expect(inputKeysOf(otherSpend)).toContain(keyOf(grantUtxos[1][0]));
      for (const result of [agentSpend, otherSpend]) {
        expect(bodyOf(result).referenceInputs?.map(keyOf)).toEqual(
          [control[0], ...parkedScriptUtxos.map(([input]) => input)]
            .sort(compareInputs)
            .map(keyOf),
        );
      }
    });

    it('refuses as insufficient a spend that only the excluded inputs could pay', async () => {
      const { run, provider } = scenario();
      expect(
        expectFailure(
          await run(
            spendRequest([payment()], {
              excludedInputs: [fundUtxo(1, 0n)[0]],
            }),
          ),
        ),
      ).toMatchObject({ code: 'insufficient-funds' });
      expect(provider.evaluateTx).not.toHaveBeenCalled();
    });

    it('refuses when the account cannot pay the outputs and the fee', async () => {
      const { run } = scenario({ funds: [fundUtxo(1, 4_000_000n)] });
      expect(expectFailure(await run())).toMatchObject({
        code: 'insufficient-funds',
      });
    });

    it('refuses funds short of the spend as insufficient, not as over the input cap', async () => {
      const dust = Array.from({ length: 25 }, (_, index) =>
        fundUtxo(1 + index, 150_000n),
      );
      const { run, provider } = scenario({ funds: dust });
      expect(
        expectFailure(await run(spendRequest([payment(10_000_000n)]))),
      ).toEqual({
        code: 'insufficient-funds',
        message: expect.stringContaining('least fee') as unknown,
      });
      expect(provider.evaluateTx).not.toHaveBeenCalled();
    });

    it('refuses funds short of a requested token as insufficient', async () => {
      for (const held of [4n, 0n]) {
        const { run, provider } = scenario({
          grants: [tokenGrant()],
          funds: [tokenFund(1, 20_000_000n, held)],
        });
        expect(
          expectFailure(
            await run(
              spendRequest([
                payment(1_500_000n, recipientAddress, new Map([[TOKEN, 8n]])),
              ]),
            ),
          ),
        ).toMatchObject({ code: 'insufficient-funds' });
        expect(provider.evaluateTx).not.toHaveBeenCalled();
      }
    });

    it('needs plain funds of only the outputs, the fee at the execution estimate and a change minimum', async () => {
      const probe = scenario();
      const probed = expectSuccess(await probe.run());
      const balancedFee = balancedFeeOf(probe.evaluated);
      // Balancing reserves no more above the real fee than the estimate's
      // execution fee, far below the per-transaction limit's.
      expect(balancedFee - probed.fee).toBeLessThanOrEqual(
        executionFeeOf(
          custodyExecutionEstimate({
            spendWithGrant: 1,
            fund: 1,
            logic: 'agent',
          }),
        ),
      );
      const least = 5_000_000n + balancedFee + CHANGE_MINIMUM;

      const { run } = scenario({ funds: [fundUtxo(1, least)] });
      const result = expectSuccess(await run());
      expect(result.fee).toBe(probed.fee);
      expect(recreatedOf(result).grant.scope.cap).toBe(
        50_000_000n - 5_000_000n - result.fee - MARGIN,
      );
      expect(
        expectFailure(
          await scenario({ funds: [fundUtxo(1, least - 1n)] }).run(),
        ),
      ).toMatchObject({ code: 'insufficient-funds' });
    });

    it('spends up to 12 fund inputs and refuses more before any evaluation', async () => {
      const funds = Array.from({ length: 14 }, (_, index) =>
        fundUtxo(1 + index, 1_000_000n),
      );
      const grants = [lovelaceGrant({ perCallCap: 30_000_000n })];
      const probe = scenario({ grants, funds });
      const probed = expectSuccess(
        await probe.run(spendRequest([payment(9_500_000n)])),
      );
      expect(bodyOf(probed).inputs).toHaveLength(1 + 12);
      // The largest payment twelve 1 ADA UTxOs cover at the fee the builder
      // balances them at, with the change at its minimum.
      const fitting =
        12_000_000n - balancedFeeOf(probe.evaluated) - CHANGE_MINIMUM;
      const result = expectSuccess(
        await scenario({ grants, funds }).run(spendRequest([payment(fitting)])),
      );
      expect(bodyOf(result).inputs).toHaveLength(1 + 12);

      const { run, provider } = scenario({ grants, funds });
      expect(
        expectFailure(await run(spendRequest([payment(fitting + 1n)]))),
      ).toEqual({
        code: 'grant-spend',
        reason: 'fund-input-cap',
        maxFundInputs: 12,
        requiredFundInputs: 13,
      });
      expect(provider.evaluateTx).not.toHaveBeenCalled();
    });

    it('refuses as over the fund input cap a spend whose measured budgets exceed the execution limit', async () => {
      const funds = Array.from({ length: 12 }, (_, index) =>
        fundUtxo(1 + index, 1_000_000n),
      );
      const { run } = scenario({
        grants: [lovelaceGrant({ perCallCap: 30_000_000n })],
        funds,
        chain: {
          // Twelve funds at 1.155M memory with the margin, and the grant and
          // the logic at 330k each, pass the 14M limit.
          evaluate: evaluateByRedeemer(MEASURED, {
            memory: 1_050_000,
            steps: 100_000_000,
          }),
        },
      });
      expect(
        expectFailure(await run(spendRequest([payment(9_200_000n)]))),
      ).toEqual({
        code: 'grant-spend',
        reason: 'fund-input-cap',
        // (14M - 660k) / 1.155M memory binds before the steps.
        maxFundInputs: 11,
        requiredFundInputs: 12,
      });
    });

    it('refuses as over the fund input cap a spend that measures far above the estimate, the limit and the fee bound', async () => {
      const funds = Array.from({ length: 6 }, (_, index) =>
        fundUtxo(1 + index, 3_000_000n),
      );
      const { run, evaluated } = scenario({
        grants: [lovelaceGrant({ perCallCap: 30_000_000n })],
        funds,
        chain: {
          // Six funds at 3.3M memory with the margin need a fee the
          // estimate's balancing never funded.
          evaluate: evaluateByRedeemer(MEASURED, {
            memory: 3_000_000,
            steps: 100_000_000,
          }),
        },
      });
      expect(
        expectFailure(await run(spendRequest([payment(14_000_000n)]))),
      ).toEqual({
        code: 'grant-spend',
        reason: 'fund-input-cap',
        // (14M - 660k) / 3.3M memory.
        maxFundInputs: 4,
        requiredFundInputs: 6,
      });
      // The draft's measurement prices a fee above the bound, and too many
      // funds explain it, so no reseeded build follows.
      expect(evaluated).toHaveLength(1);
    });

    it('refuses as over the fund input cap, fitting none, a spend without a call whose logic alone passes the execution limit', async () => {
      const { run } = scenario({
        chain: {
          evaluate: evaluateByRedeemer(MEASURED, MEASURED, {
            memory: 15_000_000,
            steps: 100_000_000,
          }),
        },
      });
      expect(expectFailure(await run())).toEqual({
        code: 'grant-spend',
        reason: 'fund-input-cap',
        maxFundInputs: 0,
        requiredFundInputs: 1,
      });
    });
  });

  describe('fee bound', () => {
    it.each([
      ['referenced', undefined],
      ['attached', unparkedChainId],
    ])(
      'keeps a spend over twelve funds under the default fee bound with the scripts %s, at the budgets upstream measured',
      async (_how, network) => {
        const funds = Array.from({ length: 12 }, (_, index) =>
          fundUtxo(1 + index, 1_000_000n),
        );
        const { run } = scenario({
          grants: [lovelaceGrant({ perCallCap: 30_000_000n })],
          funds,
          chain: { evaluate: evaluateLikeDevnet },
          network,
        });
        const result = expectSuccess(
          await run(spendRequest([payment(9_000_000n)])),
        );
        expect(bodyOf(result).inputs).toHaveLength(1 + 12);
        expect(result.fee).toBeLessThanOrEqual(FEE_BOUND);
        expect(
          assertWithinTransactionLimits(
            transactionOf(result),
            result.resolvedInputs,
            protocolParameters,
          ).signedTxSize,
        ).toBeLessThanOrEqual(protocolParameters.maxTxSize);
      },
    );
  });

  describe('evaluation', () => {
    it('declares the budgets the provider measures, with a margin', async () => {
      const { run } = scenario({
        chain: {
          evaluate: evaluateByRedeemer(
            { memory: 2_000_000, steps: 800_000_000 },
            { memory: 200_000, steps: 60_000_000 },
          ),
        },
      });
      const result = expectSuccess(await run());
      const sorted = [...inputKeysOf(result)].sort();
      const declared = new Map(
        spendRedeemersOf(result).map(({ index, executionUnits }) => [
          sorted[index],
          executionUnits,
        ]),
      );
      expect(declared).toEqual(
        new Map([
          [
            keyOf(grantUtxo(lovelaceGrant())[0]),
            { memory: 2_200_000, steps: 880_000_000 },
          ],
          [keyOf(fundUtxo(1, 0n)[0]), { memory: 220_000, steps: 66_000_000 }],
        ]),
      );
    });

    it('fails when the provider leaves a redeemer unevaluated', async () => {
      const { run } = scenario({ chain: { evaluate: () => [] } });
      expect(expectFailure(await run())).toMatchObject({
        code: 'script-evaluation-failed',
      });
    });

    it('fails with the provider message when the validator refuses the spend', async () => {
      const { run } = scenario({
        chain: { evaluate: () => new Error('SpendWithGrant failed') },
      });
      expect(expectFailure(await run())).toEqual({
        code: 'script-evaluation-failed',
        message: expect.stringContaining('SpendWithGrant failed') as unknown,
      });
    });
  });

  describe('contract calls', () => {
    const POOL_TOKEN = Cardano.AssetId(`${'77'.repeat(28)}706f6f6c`);
    const POOL_DATUM: Cardano.PlutusData = 42n;
    const SWAP_REDEEMER: Cardano.PlutusData = 7n;
    const SWAP_REDEEMER_CBOR = '07';
    const POOL_COINS = 50_000_000n;

    /** The pool UTxO a swap spends: lovelace and pool tokens under an inline datum. */
    const poolUtxo = utxo(700, {
      address: CONTRACT_ADDRESS,
      value: { coins: POOL_COINS, assets: new Map([[POOL_TOKEN, 1000n]]) },
      datum: POOL_DATUM,
    });

    /** The pool's continuing output once `coins` lovelace went in and `tokens` came out. */
    const poolOutput = (coins = 5_000_000n, tokens = 100n): Cardano.TxOut => ({
      address: CONTRACT_ADDRESS,
      value: {
        coins: POOL_COINS + coins,
        assets: new Map([[POOL_TOKEN, 1000n - tokens]]),
      },
      datum: POOL_DATUM,
    });

    /** The pool's validator bytes under PlutusV2, a language a call may not run. */
    const CONTRACT_SCRIPT_V2: Cardano.PlutusScript = {
      ...CONTRACT_SCRIPT,
      version: Cardano.PlutusLanguageVersion.V2,
    };

    /** A UTxO of the pool that carries a native script, which a call may not read. */
    const nativeCarrier = utxo(706, {
      address: CONTRACT_ADDRESS,
      value: { coins: 10_000_000n },
      scriptReference: {
        __type: Cardano.ScriptType.Native,
        kind: Cardano.NativeScriptKind.RequireAllOf,
        scripts: [],
      },
    });

    /** A pool UTxO that carries the PlutusV2 script, which a call may not spend. */
    const v2Carrier = utxo(707, {
      address: CONTRACT_ADDRESS,
      value: { coins: 5_000_000n },
      scriptReference: CONTRACT_SCRIPT_V2,
      datum: POOL_DATUM,
    });

    /** The UTxO that parks the pool's script, outside every account. */
    const scriptCarrier = utxo(701, {
      address: CONTRACT_ADDRESS,
      value: { coins: 10_000_000n },
      scriptReference: CONTRACT_SCRIPT,
    });

    const swap = (
      witness: Pick<
        CardanoCustodyContractCall,
        'referenceInputs' | 'scripts'
      > = {
        scripts: [CONTRACT_SCRIPT],
      },
    ): CardanoCustodyContractCall => ({
      inputs: [{ utxo: poolUtxo, redeemer: SWAP_REDEEMER }],
      ...witness,
    });

    const swapRequest = (
      contract: CardanoCustodyContractCall = swap(),
      outputs: Cardano.TxOut[] = [poolOutput()],
    ) => spendRequest(outputs, { contract });

    const ORDER_NAME = Cardano.AssetName('6f72646572');
    const RECEIPT_NAME = Cardano.AssetName('72656365697074');
    const ORDER_TOKEN = Cardano.AssetId.fromParts(
      Cardano.PolicyId(CONTRACT_HASH),
      ORDER_NAME,
    );
    const RECEIPT_TOKEN = Cardano.AssetId.fromParts(
      Cardano.PolicyId(OTHER_CONTRACT_HASH),
      RECEIPT_NAME,
    );

    /** A call that mints an order token and five receipts, each policy under its own redeemer. */
    const mintCall: CardanoCustodyContractCall = {
      mint: [
        {
          policyId: Cardano.PolicyId(CONTRACT_HASH),
          assets: new Map([[ORDER_NAME, 1n]]),
          redeemer: 1n,
        },
        {
          policyId: Cardano.PolicyId(OTHER_CONTRACT_HASH),
          assets: new Map([[RECEIPT_NAME, 5n]]),
          redeemer: 2n,
        },
      ],
      scripts: [CONTRACT_SCRIPT, OTHER_CONTRACT_SCRIPT],
    };

    /** The order output a minting call pays: lovelace and the minted order token. */
    const orderOutput = (coins = 2_000_000n): Cardano.TxOut => ({
      address: CONTRACT_ADDRESS,
      value: { coins, assets: new Map([[ORDER_TOKEN, 1n]]) },
      datum: POOL_DATUM,
    });

    /** Answers the call's swap redeemer with `budget` and every other with `MEASURED`. */
    const evaluateSwapAt =
      (budget: Cardano.ExUnits) =>
      (tx: Serialization.Transaction): RedeemerExecutionUnits[] =>
        (tx.witnessSet().redeemers()?.toCore() ?? []).map(
          ({ purpose, index, data }) => ({
            purpose,
            index,
            budget:
              Serialization.PlutusData.fromCore(data).toCbor() ===
              SWAP_REDEEMER_CBOR
                ? budget
                : MEASURED,
          }),
        );

    const invalidCall = (message: string): CardanoCustodyBuildError => ({
      code: 'invalid-operation',
      reason: 'invalid-contract-call',
      message,
    });

    it.each<
      [string, Pick<CardanoCustodyContractCall, 'referenceInputs' | 'scripts'>]
    >([
      ['attached', { scripts: [CONTRACT_SCRIPT] }],
      ['referenced', { referenceInputs: [scriptCarrier] }],
    ])(
      'spends a pool UTxO under its redeemer and pays its continuing output, with the script %s',
      async (how, witness) => {
        const { run, control, grantUtxos } = scenario();
        const result = expectSuccess(await run(swapRequest(swap(witness))));
        const body = bodyOf(result);

        expect(redeemersByInput(result)).toEqual(
          new Map([
            [keyOf(grantUtxos[0][0]), SPEND_WITH_GRANT],
            [keyOf(fundUtxo(1, 0n)[0]), FUND],
            [keyOf(poolUtxo[0]), SWAP_REDEEMER_CBOR],
          ]),
        );
        expect(body.referenceInputs?.map(keyOf)).toEqual(
          [
            control[0],
            ...parkedScriptUtxos.map(([input]) => input),
            ...(how === 'referenced' ? [scriptCarrier[0]] : []),
          ]
            .sort(compareInputs)
            .map(keyOf),
        );
        expect(transactionOf(result).witnessSet().toCore().scripts).toEqual(
          how === 'attached' ? [CONTRACT_SCRIPT] : undefined,
        );
        expect(body.requiredExtraSignatures).toEqual([granteeKeyHash]);
        expect(result.resolvedInputs).toEqual(
          expect.arrayContaining([
            poolUtxo,
            ...(how === 'referenced' ? [scriptCarrier] : []),
          ]),
        );
        const [, paid, change] = body.outputs;
        expect(paid).toEqual(poolOutput());
        expect(change).toEqual({
          address: identity.address,
          value: {
            coins: 20_000_000n - 5_000_000n - result.fee,
            assets: new Map([[POOL_TOKEN, 100n]]),
          },
        });
      },
    );

    it('lowers the cap by the net outflow, not by the gross payment to the pool', async () => {
      const { run } = scenario();
      const result = expectSuccess(await run(swapRequest()));
      expect(recreatedOf(result).grant.scope.cap).toBe(
        50_000_000n - 5_000_000n - result.fee - MARGIN,
      );
    });

    it('keeps the cap when the call pays the account more than the spend costs', async () => {
      const { run } = scenario();
      const result = expectSuccess(
        await run(swapRequest(swap(), [poolOutput(-10_000_000n, 0n)])),
      );
      expect(recreatedOf(result).grant.scope.cap).toBe(50_000_000n);
      expect(bodyOf(result).outputs.at(-1)).toEqual({
        address: identity.address,
        value: { coins: expect.any(BigInt) as unknown as bigint },
      });
    });

    it('refuses before any build a call whose net outflow passes the per call cap', async () => {
      const { run, provider } = scenario();
      const error = expectFailure(
        await run(swapRequest(swap(), [poolOutput(25_000_000n, 0n)])),
      );
      expect(capViolationsOf(error)).toEqual([
        {
          code: 'per-call-cap-exceeded',
          outflow: 25_000_000n,
          limit: 20_000_000n,
        },
      ]);
      expect(provider.evaluateTx).not.toHaveBeenCalled();
    });

    describe('of a token grant scoped to the pool token', () => {
      const poolTokenGrant = tokenGrant({
        asset: {
          policyId: HexBlob('77'.repeat(28)),
          assetName: HexBlob('706f6f6c'),
        },
        lovelacePerCallCap: 10_000_000n,
        lovelaceCap: 20_000_000n,
      });

      it.each<[string, Cardano.TxOut, bigint]>([
        ['keeps the cap when the call supplies', poolOutput(5_000_000n), 50n],
        [
          'lowers the cap when the call takes',
          poolOutput(-3_000_000n, -4n),
          46n,
        ],
      ])('%s the scope asset', async (_what, output, cap) => {
        const holder = fundUtxo(2, 2_000_000n, {
          value: { coins: 2_000_000n, assets: new Map([[POOL_TOKEN, 10n]]) },
        });
        const { run } = scenario({
          grants: [poolTokenGrant],
          funds: [fundUtxo(1, 20_000_000n), holder],
        });
        const result = expectSuccess(await run(swapRequest(swap(), [output])));
        expect(recreatedOf(result).grant.scope.cap).toBe(cap);
      });
    });

    it('selects the fund UTxO holding the scope token a call burns and lowers the cap by the burn', async () => {
      const lpFund = fundUtxo(2, 2_000_000n, {
        value: { coins: 2_000_000n, assets: new Map([[ORDER_TOKEN, 10n]]) },
      });
      const { run } = scenario({
        grants: [
          tokenGrant({
            asset: {
              policyId: HexBlob(CONTRACT_HASH),
              assetName: HexBlob(ORDER_NAME),
            },
          }),
        ],
        funds: [fundUtxo(1, 20_000_000n), lpFund],
      });
      const withdraw: CardanoCustodyContractCall = {
        ...swap(),
        mint: [
          {
            policyId: Cardano.PolicyId(CONTRACT_HASH),
            assets: new Map([[ORDER_NAME, -4n]]),
            redeemer: 1n,
          },
        ],
      };
      const result = expectSuccess(
        await run(
          spendRequest([poolOutput(-3_000_000n, 0n)], { contract: withdraw }),
        ),
      );
      expect(inputKeysOf(result)).toContain(keyOf(lpFund[0]));
      expect(inputKeysOf(result)).not.toContain(
        keyOf(fundUtxo(1, 20_000_000n)[0]),
      );
      expect(bodyOf(result).mint).toEqual(new Map([[ORDER_TOKEN, -4n]]));
      expect(recreatedOf(result).grant.scope.cap).toBe(46n);
    });

    it('mints under two policies, each with its own redeemer at its policy index', async () => {
      const { run } = scenario();
      const result = expectSuccess(
        await run(spendRequest([orderOutput()], { contract: mintCall })),
      );
      const body = bodyOf(result);
      expect(body.mint).toEqual(
        new Map([
          [ORDER_TOKEN, 1n],
          [RECEIPT_TOKEN, 5n],
        ]),
      );
      const sortedPolicies = [CONTRACT_HASH, OTHER_CONTRACT_HASH].sort();
      const redeemerOfPolicy = new Map([
        [CONTRACT_HASH as string, '01'],
        [OTHER_CONTRACT_HASH as string, '02'],
      ]);
      const mintRedeemers = (
        transactionOf(result).witnessSet().redeemers()?.toCore() ?? []
      ).filter(({ purpose }) => purpose === Cardano.RedeemerPurpose.mint);
      expect(
        mintRedeemers.map(({ index, data }) => [
          index,
          Serialization.PlutusData.fromCore(data).toCbor(),
        ]),
      ).toEqual(
        sortedPolicies.map((policyId, index) => [
          index,
          redeemerOfPolicy.get(policyId),
        ]),
      );
      expect(transactionOf(result).witnessSet().toCore().scripts).toEqual([
        CONTRACT_SCRIPT,
        OTHER_CONTRACT_SCRIPT,
      ]);
      expect(body.outputs.at(-1)?.value.assets).toEqual(
        new Map([[RECEIPT_TOKEN, 5n]]),
      );
      expect(recreatedOf(result).grant.scope.cap).toBe(
        50_000_000n - 2_000_000n - result.fee - MARGIN,
      );
    });

    it.each<[Cardano.PlutusData, string]>([
      [SWAP_REDEEMER, SWAP_REDEEMER_CBOR],
      [0n, '00'],
    ])(
      'spends a script UTxO that carries a datum hash under redeemer %s, with its datum in the witness set',
      async (redeemer, redeemerCbor) => {
        const locked = utxo(702, {
          address: CONTRACT_ADDRESS,
          value: { coins: 10_000_000n },
          datumHash: Serialization.PlutusData.fromCore(POOL_DATUM).hash(),
        });
        const { run } = scenario();
        const result = expectSuccess(
          await run(
            spendRequest(
              [{ address: CONTRACT_ADDRESS, value: { coins: 12_000_000n } }],
              {
                contract: {
                  inputs: [{ utxo: locked, redeemer, datum: POOL_DATUM }],
                  scripts: [CONTRACT_SCRIPT],
                },
              },
            ),
          ),
        );
        expect(redeemersByInput(result).get(keyOf(locked[0]))).toBe(
          redeemerCbor,
        );
        expect(transactionOf(result).witnessSet().toCore().datums).toEqual([
          POOL_DATUM,
        ]);
        expect(recreatedOf(result).grant.scope.cap).toBe(
          50_000_000n - 2_000_000n - result.fee - MARGIN,
        );
      },
    );

    it('spends a script UTxO that carries its own script, with nothing attached or referenced', async () => {
      const carrying = utxo(702, {
        address: CONTRACT_ADDRESS,
        value: { coins: 10_000_000n },
        scriptReference: CONTRACT_SCRIPT,
        datum: POOL_DATUM,
      });
      const { run, control } = scenario();
      const result = expectSuccess(
        await run(
          spendRequest(
            [{ address: CONTRACT_ADDRESS, value: { coins: 12_000_000n } }],
            {
              contract: {
                inputs: [{ utxo: carrying, redeemer: SWAP_REDEEMER }],
              },
            },
          ),
        ),
      );
      expect(redeemersByInput(result).get(keyOf(carrying[0]))).toBe(
        SWAP_REDEEMER_CBOR,
      );
      expect(
        transactionOf(result).witnessSet().toCore().scripts,
      ).toBeUndefined();
      expect(bodyOf(result).referenceInputs?.map(keyOf)).toEqual(
        [control[0], ...parkedScriptUtxos.map(([input]) => input)]
          .sort(compareInputs)
          .map(keyOf),
      );
      expect(result.resolvedInputs).toEqual(expect.arrayContaining([carrying]));
    });

    it('builds a call whose script measures above its seed', async () => {
      const heavy = { memory: 3_000_000, steps: 1_000_000_000 };
      const { run } = scenario({ chain: { evaluate: evaluateSwapAt(heavy) } });
      const result = expectSuccess(await run(swapRequest()));
      const declared = spendRedeemersOf(result).find(
        ({ data }) =>
          Serialization.PlutusData.fromCore(data).toCbor() ===
          SWAP_REDEEMER_CBOR,
      );
      expect(declared?.executionUnits).toEqual({
        memory: 3_300_000,
        steps: 1_100_000_000,
      });
    });

    it('does not blame the fund inputs for a call whose own script passes the execution limit', async () => {
      const { run } = scenario({
        chain: {
          evaluate: evaluateSwapAt({ memory: 13_000_000, steps: 100_000_000 }),
        },
      });
      expect(expectFailure(await run(swapRequest()))).toMatchObject({
        code: 'transaction-limits',
        exceeded: ['executionMemory'],
      });
    });

    it('refuses a fee above the bound, not the fund inputs, when the call alone passes the execution limit', async () => {
      const { run } = scenario({
        chain: {
          evaluate: evaluateSwapAt({ memory: 13_000_000, steps: 100_000_000 }),
        },
      });
      expect(
        expectFailure(
          await run(
            spendRequest([poolOutput()], {
              contract: swap(),
              feeBound: 700_000n,
            }),
          ),
        ),
      ).toMatchObject({ code: 'grant-spend', reason: 'fee-above-bound' });
    });

    it("counts a call's budgets as fixed when it refuses too many fund inputs", async () => {
      const funds = Array.from({ length: 12 }, (_, index) =>
        fundUtxo(1 + index, 1_000_000n),
      );
      const { run } = scenario({
        grants: [lovelaceGrant({ perCallCap: 30_000_000n })],
        funds,
        chain: {
          evaluate: tx =>
            (tx.witnessSet().redeemers()?.toCore() ?? []).map(
              ({ purpose, index, data }) => ({
                purpose,
                index,
                budget:
                  purpose === Cardano.RedeemerPurpose.mint
                    ? { memory: 2_500_000, steps: 100_000_000 }
                    : Serialization.PlutusData.fromCore(data).toCbor() === FUND
                    ? { memory: 1_050_000, steps: 100_000_000 }
                    : MEASURED,
              }),
            ),
        },
      });
      expect(
        expectFailure(
          await run(
            spendRequest([payment(7_000_000n), orderOutput()], {
              contract: mintCall,
            }),
          ),
        ),
      ).toEqual({
        code: 'grant-spend',
        reason: 'fund-input-cap',
        maxFundInputs: 6,
        requiredFundInputs: 12,
      });
    });

    it.each<[string, CardanoCustodyContractCall, string]>([
      [
        'nothing to call',
        {},
        'A contract call names no input, mint, script or reference',
      ],
      [
        'a reference input of an account fund',
        { ...swap(), referenceInputs: [fundUtxo(1, 20_000_000n)] },
        `UTxO ${keyOf(fundUtxo(1, 20_000_000n)[0])} is the account's own`,
      ],
      [
        'a reference input of the spent grant',
        { ...swap(), referenceInputs: [grantUtxo(lovelaceGrant())] },
        `UTxO ${keyOf(grantUtxo(lovelaceGrant())[0])} is the account's own`,
      ],
      [
        'an input at a key address',
        {
          inputs: [
            {
              utxo: utxo(703, {
                address: recipientAddress,
                value: { coins: 5_000_000n },
              }),
              redeemer: SWAP_REDEEMER,
            },
          ],
        },
        'Input 0 is not locked by a script',
      ],
      [
        'an input of the account',
        {
          inputs: [
            { utxo: fundUtxo(704, 5_000_000n), redeemer: SWAP_REDEEMER },
          ],
        },
        'Input 0 belongs to a custody account',
      ],
      [
        'a datum-hash input without its datum',
        {
          inputs: [
            {
              utxo: utxo(705, {
                address: CONTRACT_ADDRESS,
                value: { coins: 5_000_000n },
                datumHash: Serialization.PlutusData.fromCore(1n).hash(),
              }),
              redeemer: SWAP_REDEEMER,
              datum: POOL_DATUM,
            },
          ],
        },
        'Input 0 needs the datum its hash names',
      ],
      [
        'a datum for an inline datum input',
        {
          inputs: [
            { utxo: poolUtxo, redeemer: SWAP_REDEEMER, datum: POOL_DATUM },
          ],
        },
        'Input 0 carries no datum hash for its datum',
      ],
      [
        'a UTxO it both spends and references',
        { ...swap(), referenceInputs: [poolUtxo] },
        `UTxO ${keyOf(poolUtxo[0])} is named twice`,
      ],
      [
        'a script attached twice',
        { ...swap(), scripts: [CONTRACT_SCRIPT, CONTRACT_SCRIPT] },
        `Script ${CONTRACT_HASH} is attached twice`,
      ],
      [
        'an attached custody account validator',
        { ...swap(), scripts: [version.accountValidator] },
        `Script ${version.accountValidatorHash} is a custody contract script`,
      ],
      [
        'an attached custody logic',
        { ...swap(), scripts: [version.logics[0].script] },
        `Script ${version.logics[0].hash} is a custody contract script`,
      ],
      [
        'a script a reference input also carries',
        {
          ...swap({ referenceInputs: [scriptCarrier] }),
          scripts: [CONTRACT_SCRIPT],
        },
        `Script ${CONTRACT_HASH} is also carried by an input of the transaction`,
      ],
      [
        'a script a call input also carries',
        {
          inputs: [
            {
              utxo: utxo(702, {
                address: CONTRACT_ADDRESS,
                value: { coins: 5_000_000n },
                scriptReference: CONTRACT_SCRIPT,
                datum: POOL_DATUM,
              }),
              redeemer: SWAP_REDEEMER,
            },
          ],
          scripts: [CONTRACT_SCRIPT],
        },
        `Script ${CONTRACT_HASH} is also carried by an input of the transaction`,
      ],
      [
        'an attached script that is not PlutusV3',
        { ...swap(), scripts: [CONTRACT_SCRIPT_V2] },
        `Script ${Serialization.Script.fromCore(
          CONTRACT_SCRIPT_V2,
        ).hash()} is not PlutusV3`,
      ],
      [
        'a reference input that carries a native script',
        { ...swap(), referenceInputs: [nativeCarrier] },
        `UTxO ${keyOf(nativeCarrier[0])} carries a script that is not PlutusV3`,
      ],
      [
        'a call input that carries a script that is not PlutusV3',
        {
          inputs: [{ utxo: v2Carrier, redeemer: SWAP_REDEEMER }],
          scripts: [CONTRACT_SCRIPT],
        },
        `UTxO ${keyOf(v2Carrier[0])} carries a script that is not PlutusV3`,
      ],
      [
        'a script nothing in the call needs',
        { ...swap(), scripts: [CONTRACT_SCRIPT, OTHER_CONTRACT_SCRIPT] },
        `Script ${OTHER_CONTRACT_HASH} is needed by no input or mint of the call`,
      ],
      [
        'an input the spend also references',
        {
          inputs: [{ utxo: parkedScriptUtxos[0], redeemer: SWAP_REDEEMER }],
        },
        `UTxO ${keyOf(parkedScriptUtxos[0][0])} is both spent and referenced`,
      ],
      [
        'a mint of custody account tokens',
        {
          mint: [
            {
              policyId: Cardano.PolicyId(version.accountValidatorHash),
              assets: new Map([[ORDER_NAME, 1n]]),
              redeemer: 1n,
            },
          ],
        },
        'A contract call cannot mint custody account tokens',
      ],
      [
        'a policy named twice',
        { mint: [mintCall.mint![0], mintCall.mint![0]] },
        `Policy ${CONTRACT_HASH} is named twice`,
      ],
      [
        'a mint of no quantity',
        {
          mint: [{ ...mintCall.mint![0], assets: new Map([[ORDER_NAME, 0n]]) }],
        },
        `Policy ${CONTRACT_HASH} names no asset or a zero quantity`,
      ],
    ])(
      'refuses before any evaluation a call with %s',
      async (_what, contract, message) => {
        const { run, provider } = scenario();
        expect(
          expectFailure(
            await run(
              spendRequest([poolOutput()], {
                contract,
              }),
            ),
          ),
        ).toEqual(invalidCall(message));
        expect(provider.evaluateTx).not.toHaveBeenCalled();
      },
    );

    it("refuses before any evaluation a call that names another grantee's grant UTxO", async () => {
      const grants = [
        lovelaceGrant(),
        lovelaceGrant({}, 1n, { grantee: otherGranteeKeyHash }),
      ];
      const { run, provider, grantUtxos } = scenario({ grants });
      expect(
        expectFailure(
          await run(
            swapRequest({ ...swap(), referenceInputs: [grantUtxos[1]] }),
          ),
        ),
      ).toEqual(
        invalidCall(`UTxO ${keyOf(grantUtxos[1][0])} is the account's own`),
      );
      expect(provider.evaluateTx).not.toHaveBeenCalled();
    });

    it('reads a reference input the spend already reads once', async () => {
      const { run, control } = scenario();
      const result = expectSuccess(
        await run(
          swapRequest(swap({ referenceInputs: [control, scriptCarrier] })),
        ),
      );
      expect(bodyOf(result).referenceInputs?.map(keyOf)).toEqual(
        [
          control[0],
          ...parkedScriptUtxos.map(([input]) => input),
          scriptCarrier[0],
        ]
          .sort(compareInputs)
          .map(keyOf),
      );
    });

    it('passes the shared inspection only as an allowed contract call', async () => {
      const { run } = scenario();
      const result = expectSuccess(await run(swapRequest()));
      const inspect = (allowContractCall: boolean) =>
        inspectCustodyTransaction(
          transactionOf(result),
          result.resolvedInputs,
          {
            chainId,
            now: Date.now(),
            slotToPosixMs: slot => slot * 1000,
            accountRecord: result.accountRecord,
            allowGrantSpend: true,
            allowContractCall,
          },
        );
      expect(inspect(true).ok).toBe(true);
      expect(inspect(false).ok).toBe(false);
    });
  });
});
