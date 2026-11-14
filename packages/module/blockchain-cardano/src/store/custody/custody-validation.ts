import { Cardano, Serialization } from '@lace-lib/cardano-core';
import {
  addValueDeltas,
  encodeCustodyAccountState,
  encodeCustodyGrant,
  findCustodySponsorRuleViolations,
  inspectCustodyTransaction,
  negateValueDelta,
  valueDeltaOf,
} from '@lace-lib/cardano-custody';
import {
  TransactionLimitsExceededError,
  assertWithinTransactionLimits,
  minAdaRequired,
} from '@lace-lib/cardano-tx-builder';

import { failCustodyBuild } from './build-failure';

import type { CustodyChain } from './custody-chain';
import type {
  CardanoCustodyBuildResult,
  CardanoCustodyFundingContext,
} from '@lace-contract/cardano-context';
import type * as Crypto from '@lace-lib/cardano-crypto';
import type {
  CustodyAccountInspection,
  CustodyAccountRecord,
  CustodyAccountState,
  CustodyContractVersion,
  CustodyGrant,
  CustodySponsorRuleContext,
  CustodyValueDelta,
} from '@lace-lib/cardano-custody';

/** What a custody build meant to produce, checked against the final bytes. */
interface CustodyBuildExpectation {
  readonly record: CustodyAccountRecord;
  /**
   * The control output a creation or an owner operation writes. Absent for
   * a grant spend, which leaves the control UTxO unspent.
   */
  readonly control?: {
    readonly state: CustodyAccountState;
    readonly lovelace: bigint;
  };
  /**
   * The grant UTxOs the transaction issues, in slot order, by the grant
   * each datum carries and the lovelace each holds; none when absent.
   */
  readonly issuedGrants?: readonly {
    readonly grant: CustodyGrant;
    readonly lovelace: bigint;
  }[];
  /** The slots of the dead grants the transaction sweeps; none when absent. */
  readonly sweptSlots?: readonly bigint[];
  /** The key the transaction names as its only required signer. */
  readonly signer: Crypto.Ed25519KeyHashHex;
  /** Absent for a grant spend, which the grantee signs. */
  readonly deviceKeyHash?: Crypto.Ed25519KeyHashHex;
  /**
   * The grant a grant spend spends, by slot, and the grant its recreated
   * grant UTxO carries. Absent for every other build, whose transaction may
   * then spend no grant.
   */
  readonly grantSpend?: {
    readonly slot: bigint;
    readonly after: CustodyGrant;
  };
  /**
   * Present when a grant spend or an owner spend calls other contracts,
   * which inspection then allows. `supplied` is the value the call brings
   * into the transaction: what its inputs hold and what it mints, less what
   * it burns.
   */
  readonly contractCall?: {
    readonly supplied: CustodyValueDelta;
  };
  /**
   * The value the account pays away: the requested outputs and the fee,
   * less what the transaction withdraws into the account and what a
   * contract call supplies. Tokens of the account itself, which a
   * transaction mints or burns, are not paid away. Absent at creation, the
   * only build the sponsor pays for, when the account spends nothing.
   */
  readonly outflow?: {
    readonly requested: Cardano.Value;
    /** The account's rewards withdrawn and the logic run's draw. */
    readonly withdrawal: bigint;
  };
  readonly funding: CardanoCustodyFundingContext;
}

const cborOf = (data: Cardano.PlutusData): string =>
  Serialization.PlutusData.fromCore(data).toCbor();

/**
 * What the sponsor service checks the transaction against, from the funding
 * it leased, the contract version of the account the transaction operates
 * and the chain.
 */
const sponsorRuleContextOf = (
  funding: CardanoCustodyFundingContext,
  contractVersion: CustodyContractVersion,
  { chainId, clock, now, protocolParameters }: CustodyChain,
): CustodySponsorRuleContext => ({
  mode:
    funding.mode === 'fee'
      ? {
          kind: 'fee',
          feeUtxo: funding.feeUtxo,
          maxSponsoredLovelace: funding.maxSponsoredLovelace,
        }
      : { kind: 'collateral' },
  sponsorAddress: funding.sponsorAddress,
  collateralUtxo: funding.collateralUtxo,
  contractVersion,
  networkMagic: chainId.networkMagic,
  latestValiditySlot: clock.slotAt(funding.validUntil),
  currentSlot: clock.slotAt(now),
  collateralPercentage: protocolParameters.collateralPercentage,
  costModels: protocolParameters.costModels,
});

/**
 * The largest fee the sponsor's shared collateral UTxO covers, or undefined
 * without a collateral percentage. The ledger needs collateral of the fee
 * times the percentage, and the sponsor needs the rest of the UTxO back in
 * a return output that holds its minimum ADA. For the service's 5 ADA UTxO,
 * a percentage of 150 and a base return address on Preprod, that is
 * 2,686,833 lovelace, below the 3,333,333 the UTxO covers without a return.
 */
const collateralFeeCeilingOf = (
  {
    collateralUtxo: [, collateral],
    sponsorAddress,
  }: CardanoCustodyFundingContext,
  { collateralPercentage, coinsPerUtxoByte }: Cardano.ProtocolParameters,
): bigint | undefined => {
  if (collateralPercentage <= 0) return undefined;
  const returned = minAdaRequired(
    { address: sponsorAddress, value: { coins: collateral.value.coins } },
    BigInt(coinsPerUtxoByte),
  );
  const available = collateral.value.coins - returned;
  return available > 0n
    ? (available * 100n) / BigInt(collateralPercentage)
    : 0n;
};

const unexpected = (what: string): never =>
  failCustodyBuild({
    code: 'build-failed',
    message: `The built transaction ${what}`,
  });

const isSameGrant = (a: CustodyGrant, b: CustodyGrant): boolean =>
  cborOf(encodeCustodyGrant(a)) === cborOf(encodeCustodyGrant(b));

/** Checks the control output and the grant UTxOs the transaction writes. */
const checkAccountOutputs = (
  {
    controlOutput,
    issuedGrants,
    sweptGrants,
    grantSpend,
  }: CustodyAccountInspection,
  expectation: CustodyBuildExpectation,
): void => {
  const { control } = expectation;
  if (!control) {
    if (controlOutput) unexpected('rewrites the control state');
  } else if (
    !controlOutput ||
    cborOf(encodeCustodyAccountState(controlOutput.state)) !==
      cborOf(encodeCustodyAccountState(control.state))
  ) {
    unexpected('does not carry the intended account state');
  } else if (controlOutput.lovelace !== control.lovelace) {
    unexpected('does not lock the intended control lovelace');
  }
  const planned = expectation.issuedGrants ?? [];
  const isIssuedAsPlanned =
    issuedGrants.length === planned.length &&
    issuedGrants.every(
      ({ grant, lovelace }, index) =>
        isSameGrant(grant, planned[index].grant) &&
        lovelace === planned[index].lovelace,
    );
  if (!isIssuedAsPlanned) unexpected('does not issue the intended grants');
  const plannedSwept = new Set(expectation.sweptSlots ?? []);
  const isSweptAsPlanned =
    sweptGrants.length === plannedSwept.size &&
    sweptGrants.every(({ grant }) => plannedSwept.has(grant.slot));
  if (!isSweptAsPlanned) unexpected('does not sweep the intended grants');
  const plannedSpend = expectation.grantSpend;
  const isSpentAsPlanned =
    !plannedSpend ||
    (grantSpend?.grant.slot === plannedSpend.slot &&
      isSameGrant(grantSpend.after, plannedSpend.after));
  if (!isSpentAsPlanned) unexpected('does not spend the intended grant');
};

/**
 * The value expected to leave the account, by lower-case asset id and
 * without empty entries: the requested outputs and the fee, less the
 * withdrawal and what a contract call supplies. The account inputs, the
 * call's inputs and its mint balance the outputs, the fee and the
 * account's change, so whatever the call supplies leaves the account less.
 */
const expectedOutflowOf = (
  { requested, withdrawal }: NonNullable<CustodyBuildExpectation['outflow']>,
  fee: bigint,
  supplied: CustodyValueDelta | undefined,
): CustodyValueDelta =>
  addValueDeltas([
    valueDeltaOf(requested),
    { lovelace: fee - withdrawal, assets: new Map() },
    ...(supplied ? [negateValueDelta(supplied)] : []),
  ]);

/** Checks the value leaving the account, its own tokens aside. */
const checkOutflow = (
  { netOutflow }: CustodyAccountInspection,
  fee: bigint,
  expectation: CustodyBuildExpectation,
): void => {
  if (!expectation.outflow) return;
  const expected = expectedOutflowOf(
    expectation.outflow,
    fee,
    expectation.contractCall?.supplied,
  );
  const accountPolicy: string = expectation.record.accountValidatorHash;
  const leaving = [...netOutflow.assets].filter(
    ([assetId]) => Cardano.AssetId.getPolicyId(assetId) !== accountPolicy,
  );
  const isExpectedOutflow =
    netOutflow.lovelace === expected.lovelace &&
    leaving.length === expected.assets.size &&
    leaving.every(
      ([assetId, quantity]) =>
        expected.assets.get(assetId.toLowerCase() as Cardano.AssetId) ===
        quantity,
    );
  if (!isExpectedOutflow) unexpected('pays out more than requested');
};

/**
 * Checks the final, balanced transaction before anyone is asked to sign it:
 * the shared custody inspection (the hosted signer's consent rules), the
 * intended control output, issued grants, sweeps and grant spend, the
 * account's net
 * outflow, the signer, the fee the sponsor's collateral covers, the fee
 * sponsor service's policy and the protocol limits. Any failure refuses
 * the build.
 *
 * `resolvedInputs` resolves every input, reference input and collateral
 * input.
 */
export const finalizeCustodyBuild = (
  {
    transaction,
    resolvedInputs,
  }: {
    transaction: Serialization.Transaction;
    resolvedInputs: Cardano.Utxo[];
  },
  chain: CustodyChain,
  expectation: CustodyBuildExpectation,
): CardanoCustodyBuildResult => {
  const inspection = inspectCustodyTransaction(transaction, resolvedInputs, {
    chainId: chain.chainId,
    now: chain.now,
    slotToPosixMs: chain.clock.slotStart,
    accountRecord: expectation.record,
    allowGrantSpend: expectation.grantSpend !== undefined,
    allowContractCall: expectation.contractCall !== undefined,
    ...(expectation.deviceKeyHash && {
      deviceKeyHash: expectation.deviceKeyHash,
    }),
  });
  if (!inspection.ok) {
    return failCustodyBuild({
      code: 'inspection-refused',
      refusals: [...inspection.error.refusals],
    });
  }
  const { accounts, requiredSigners, fee, validity } = inspection.value;
  const [account] = accounts;
  checkAccountOutputs(account, expectation);
  checkOutflow(account, fee, expectation);
  if (
    requiredSigners.length !== 1 ||
    requiredSigners[0] !== expectation.signer
  ) {
    return unexpected('does not name exactly the intended signer');
  }

  const { funding } = expectation;
  const maxFee =
    funding.mode === 'collateral'
      ? collateralFeeCeilingOf(funding, chain.protocolParameters)
      : undefined;
  if (maxFee !== undefined && fee > maxFee) {
    return failCustodyBuild({ code: 'collateral-fee-ceiling', fee, maxFee });
  }
  const sponsorViolations = findCustodySponsorRuleViolations(
    transaction,
    resolvedInputs,
    sponsorRuleContextOf(funding, account.contractVersion, chain),
  );
  if (sponsorViolations.length > 0) {
    return failCustodyBuild({
      code: 'sponsor-rules',
      violations: sponsorViolations,
    });
  }
  try {
    assertWithinTransactionLimits(
      transaction,
      resolvedInputs,
      chain.protocolParameters,
    );
  } catch (error) {
    if (!(error instanceof TransactionLimitsExceededError)) throw error;
    return failCustodyBuild({
      code: 'transaction-limits',
      usage: error.usage,
      exceeded: error.exceeded,
    });
  }

  return {
    transaction: transaction.toCbor(),
    bodyHash: transaction.getId(),
    resolvedInputs,
    accountRecord: expectation.record,
    fee,
    invalidHereafter: validity.invalidHereafter!.slot,
    costModels: chain.protocolParameters.costModels,
  };
};
