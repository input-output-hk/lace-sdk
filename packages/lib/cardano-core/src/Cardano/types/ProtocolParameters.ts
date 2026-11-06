import type { Fraction } from '.';
import type { EpochNo, Slot } from './Block';
import type { PlutusLanguageVersion } from './Script';
import type * as Crypto from '@lace-lib/cardano-crypto';

export interface ProtocolVersion {
  major: number;
  minor: number;
  patch?: number;
}

/**
 * Cost models are a way to provide predictable pricing for script execution by specifying
 * how much each OP costs in terms of memory and CPU steps.
 */
export type CostModel = Array<number>;

/**
 * Each language version can have a different set of OP costs. CostModels is a map of
 * plutus language version to its defined cost.
 */
export type CostModels = Map<PlutusLanguageVersion, CostModel>;

export interface Prices {
  memory: number;
  steps: number;
}
/**
 * Memory and steps are numbers. The ledger caps the execution units of a transaction with the
 * maxTxExecutionUnits protocol parameter, far below 2^53, so the units of a valid transaction are
 * exact. Decoded values above 2^53 are rounded; use ExUnits.toCbor for exact data.
 */
export interface ExUnits {
  memory: number;
  steps: number;
}

export interface ValidityInterval {
  invalidBefore?: Slot;
  invalidHereafter?: Slot;
}

export interface TxFeePolicy {
  coefficient: string;
  constant: number;
}

export interface SoftforkRule {
  initThreshold: string;
  minThreshold: string;
  decrementThreshold: string;
}

type ProtocolParametersByron = {
  heavyDlgThreshold: string;
  maxBlockSize: number;
  maxHeaderSize: number;
  maxProposalSize: number;
  maxTxSize: number;
  mpcThreshold: string;
  scriptVersion: number;
  slotDuration: number;
  unlockStakeEpoch: number;
  updateProposalThreshold: string;
  updateProposalTimeToLive: number;
  updateVoteThreshold: string;
  txFeePolicy: TxFeePolicy;
  softforkRule: SoftforkRule;
};

type NewProtocolParamsInShelley = {
  minFeeCoefficient: number;
  minFeeConstant: number;
  maxBlockBodySize: number;
  maxBlockHeaderSize: number;
  stakeKeyDeposit: number;
  poolDeposit: number | null;
  poolRetirementEpochBound: number;
  desiredNumberOfPools: number;
  poolInfluence: string;
  monetaryExpansion: string;
  treasuryExpansion: string;
  decentralizationParameter: string;
  minUtxoValue: number;
  minPoolCost: number;
  /**
   * Only legal before the Babbage era. An empty string or 'neutral' is the neutral nonce,
   * and any other value is the hex of the seed hash.
   */
  extraEntropy: string | 'neutral';
  protocolVersion: ProtocolVersion;
};

type ShelleyProtocolParams = NewProtocolParamsInShelley &
  Pick<ProtocolParametersByron, 'maxTxSize'>;

type NewProtocolParamsInAlonzo = {
  coinsPerUtxoWord: number;
  maxValueSize: number;
  collateralPercentage: number;
  maxCollateralInputs: number;
  costModels: CostModels;
  prices: Prices;
  maxExecutionUnitsPerTransaction: ExUnits;
  maxExecutionUnitsPerBlock: ExUnits;
};

type AlonzoProtocolParams = NewProtocolParamsInAlonzo &
  Omit<ShelleyProtocolParams, 'minUtxoValue'>;

type NewProtocolParamsInBabbage = {
  coinsPerUtxoByte: number;
};

// coinsPerUtxoWord was replaced by coinsPerUtxoByte and extraEntropy was deprecated.
type BabbageProtocolParameters = NewProtocolParamsInBabbage &
  Omit<
    AlonzoProtocolParams,
    'coinsPerUtxoWord' | 'decentralizationParameter' | 'extraEntropy'
  >;

// Voting thresholds
export interface PoolVotingThresholds {
  motionNoConfidence: Fraction;
  committeeNormal: Fraction;
  committeeNoConfidence: Fraction;
  hardForkInitiation: Fraction;
  securityRelevantParamVotingThreshold: Fraction;
}

export interface DelegateRepresentativeThresholds
  extends Omit<PoolVotingThresholds, 'securityRelevantParamVotingThreshold'> {
  updateConstitution: Fraction;
  ppNetworkGroup: Fraction;
  ppEconomicGroup: Fraction;
  ppTechnicalGroup: Fraction;
  ppGovernanceGroup: Fraction;
  treasuryWithdrawal: Fraction;
}

type NewProtocolParamsInConway = {
  poolVotingThresholds: PoolVotingThresholds;
  dRepVotingThresholds: DelegateRepresentativeThresholds;
  minCommitteeSize: number;
  committeeTermLimit: EpochNo;
  governanceActionValidityPeriod: EpochNo;
  governanceActionDeposit: number;
  dRepDeposit: number;
  dRepInactivityPeriod: EpochNo;
  minFeeRefScriptCostPerByte: string;
};

type NewProtocolParamsInDijkstra = {
  maxRefScriptSizePerBlock: number;
  maxRefScriptSizePerTx: number;
  refScriptCostStride: number;
  refScriptCostMultiplier: string;
  /** Maximum pledge leverage of a stake pool, or null for no leverage cap. */
  maxPledgeLeverage: string | null;
  /** Minimum margin a stake pool can declare. */
  minPoolMargin: string;
  /** Length of the Leios announcement period in milliseconds. */
  leiosAnnouncementPeriodLength: number;
  /** Length of the Leios vote period in milliseconds. */
  leiosVotePeriodLength: number;
  /** Length of the Leios diffusion period in milliseconds. */
  leiosDiffusionPeriodLength: number;
  /** Size of the Leios voting committee. */
  leiosCommitteeSize: number;
  /** Minimum fraction of active stake the votes of a Leios certificate must represent. */
  leiosQuorumStakeThreshold: string;
  /** Maximum size in bytes of the transaction references of a Leios endorser block. */
  maxEndorserBlockReferencesSize: number;
  /** Maximum total size in bytes of the transactions endorsed by a Leios endorser block. */
  maxEndorserBlockTxsSize: number;
  /** Maximum execution units the scripts of a Leios endorser block can consume. */
  maxEndorserBlockExecutionUnits: ExUnits;
  /** Maximum total size in bytes of the reference scripts a Leios endorser block can use. */
  maxRefScriptSizePerEndorserBlock: number;
  /** Minimum age in slots of a block to be eligible for voting in a Peras round. */
  perasMinCandidateBlockAge: number;
  /** Coefficient used to derive the length of a Peras cooldown period. */
  perasHealingFactor: string;
  /** Extra chain weight a Peras certificate gives to the block it boosts. */
  perasCertBoost: number;
  /** Target size of the Peras voting committee. */
  perasTargetCommitteeSize: number;
  /** Peras round used to bootstrap voting, or null for no bootstrap round. */
  perasBootstrapRound: number | null;
  /** Safety margin added to the 75% Peras quorum threshold, between 0 and 0.25. */
  perasQuorumThresholdSafetyMargin: string;
  /** Fee in lovelace per multi-asset policy in the values of the reference inputs of a transaction. */
  refInputsCostPerMultiAssetPolicy: number;
  /** Fee in lovelace per datum byte in the reference inputs of a transaction. */
  refInputsCostPerDatumByte: number;
};

export type ProtocolParameters = BabbageProtocolParameters &
  Partial<NewProtocolParamsInConway> &
  Partial<NewProtocolParamsInDijkstra>;
export type ConwayProtocolParameters = Omit<
  ProtocolParameters,
  'protocolVersion'
>;

// Even tho extraEntropy was deprecated on babbage era, and protocolVersion was deprecated in conway era,
// they are still present in the ProtocolParametersUpdate structure since this structure is backward compatible with all eras.
/**
 * Rational parameters, such as poolInfluence or monetaryExpansion, are decimal text. Real
 * parameters and simple fractions convert back to the same value in lowest terms (15/10 becomes
 * 3/2). A rational with a large numerator or denominator is approximated, and fromCore throws a
 * RangeError when the approximation does not fit 64 bits. Use ProtocolParamUpdate.toCbor for exact
 * data.
 */
export type ProtocolParametersUpdate = Partial<
  Pick<AlonzoProtocolParams, 'decentralizationParameter' | 'extraEntropy'> &
    ProtocolParameters
>;
export type ProtocolParametersUpdateConway = Partial<ConwayProtocolParameters>;

export type GenesisDelegateKeyHash = Crypto.Hash28ByteBase16;
export type ProposedProtocolParameterUpdates = Map<
  GenesisDelegateKeyHash,
  ProtocolParametersUpdate
>;

export type Update = {
  epoch: EpochNo;
  proposedProtocolParameterUpdates: ProposedProtocolParameterUpdates;
};
