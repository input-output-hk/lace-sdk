import { HexBlob, InvalidArgumentError } from '@lace-lib/cardano-util';

import { EpochNo } from '../../Cardano/types/Block';
import { SerializationError, SerializationFailure } from '../../errors';
import { CborReader, CborReaderState, CborWriter } from '../CBOR';
import { ExUnits, ProtocolVersion, UnitInterval } from '../Common';

import { Costmdls } from './Costmdls';
import { DrepVotingThresholds } from './DrepVotingThresholds';
import { ExUnitPrices } from './ExUnitPrices';
import { PoolVotingThresholds } from './PoolVotingThresholds';

import type * as Cardano from '../../Cardano';
import type { DeserializationOptions } from '../Common';

const MAX_WORD32 = 4_294_967_295;
const MAX_WORD16 = 65_535;

const assertUint32 = (argName: string, value: number): void => {
  if (!Number.isInteger(value) || value < 0 || value > MAX_WORD32)
    throw new InvalidArgumentError(
      argName,
      `Expected an integer between 0 and ${MAX_WORD32}, but got ${value}`,
    );
};

const assertPositiveWord32 = (argName: string, value: number): void => {
  if (!Number.isInteger(value) || value < 1 || value > MAX_WORD32)
    throw new InvalidArgumentError(
      argName,
      `Expected an integer between 1 and ${MAX_WORD32}, but got ${value}`,
    );
};

/**
 * Asserts that a value fits in an unsigned 16 bit integer.
 *
 * @param argName The name of the argument, used in the error.
 * @param value The value to check.
 */
const assertUint16 = (argName: string, value: number): void => {
  if (!Number.isInteger(value) || value < 0 || value > MAX_WORD16)
    throw new InvalidArgumentError(
      argName,
      `Expected an integer between 0 and ${MAX_WORD16}, but got ${value}`,
    );
};

const assertPositiveInterval = (argName: string, value: UnitInterval): void => {
  if (value.numerator() < 1n || value.denominator() < 1n)
    throw new InvalidArgumentError(
      argName,
      `Expected a positive interval, but got ${value.numerator()}/${value.denominator()}`,
    );
};

/**
 * Reads a rational that must be greater than zero.
 *
 * @param reader The CBOR reader positioned at the value.
 * @param argName The name of the parameter, used in the error.
 * @returns The value read.
 */
const readPositiveInterval = (
  reader: CborReader,
  argName: string,
): UnitInterval => {
  const value = UnitInterval.fromCbor(
    HexBlob.fromBytes(reader.readEncodedValue()),
  );
  assertPositiveInterval(argName, value);
  return value;
};

/**
 * Reads an integer that must fit in an unsigned 32 bit integer.
 *
 * @param reader The CBOR reader positioned at the value.
 * @param argName The name of the parameter, used in the error.
 * @returns The value read.
 */
const readUint32 = (reader: CborReader, argName: string): number => {
  const value = Number(reader.readInt());
  assertUint32(argName, value);
  return value;
};

/**
 * Reads an integer that must fit in an unsigned 32 bit integer and be greater than zero.
 *
 * @param reader The CBOR reader positioned at the value.
 * @param argName The name of the parameter, used in the error.
 * @returns The value read.
 */
const readPositiveWord32 = (reader: CborReader, argName: string): number => {
  const value = Number(reader.readInt());
  assertPositiveWord32(argName, value);
  return value;
};

/**
 * Reads an integer that must fit in an unsigned 16 bit integer.
 *
 * @param reader The CBOR reader positioned at the value.
 * @param argName The name of the parameter, used in the error.
 * @returns The value read.
 */
const readUint16 = (reader: CborReader, argName: string): number => {
  const value = Number(reader.readInt());
  assertUint16(argName, value);
  return value;
};

/**
 * The ProtocolParamUpdate structure in Cardano is used to propose changes to
 * the protocol parameters of the blockchain. Protocol parameters govern various
 * aspects of the Cardano network.
 */
export class ProtocolParamUpdate {
  #minFeeA: Cardano.Lovelace | undefined;
  #minFeeB: Cardano.Lovelace | undefined;
  #maxBlockBodySize: number | undefined;
  #maxTxSize: number | undefined;
  #maxBlockHeaderSize: number | undefined;
  #keyDeposit: Cardano.Lovelace | undefined;
  #poolDeposit: Cardano.Lovelace | undefined;
  #maxEpoch: number | undefined;
  #nOpt: number | undefined;
  #poolPledgeInfluence: UnitInterval | undefined;
  #expansionRate: UnitInterval | undefined;
  #treasuryGrowthRate: UnitInterval | undefined;
  #d: UnitInterval | undefined;
  #extraEntropy: HexBlob | undefined;
  #protocolVersion: ProtocolVersion | undefined;
  #minPoolCost: Cardano.Lovelace | undefined;
  #adaPerUtxoByte: Cardano.Lovelace | undefined;
  #costModels: Costmdls | undefined;
  #executionCosts: ExUnitPrices | undefined;
  #maxTxExUnits: ExUnits | undefined;
  #maxBlockExUnits: ExUnits | undefined;
  #maxValueSize: number | undefined;
  #collateralPercentage: number | undefined;
  #maxCollateralInputs: number | undefined;
  #poolVotingThresholds: PoolVotingThresholds | undefined;
  #drepVotingThresholds: DrepVotingThresholds | undefined;
  #minCommitteeSize: number | undefined;
  #committeeTermLimit: number | undefined;
  #governanceActionValidityPeriod: number | undefined;
  #governanceActionDeposit: number | undefined;
  #drepDeposit: number | undefined;
  #drepInactivityPeriod: number | undefined;
  #minFeeRefScriptCostPerByte: UnitInterval | undefined;
  #maxRefScriptSizePerBlock: number | undefined;
  #maxRefScriptSizePerTx: number | undefined;
  #refScriptCostStride: number | undefined;
  #refScriptCostMultiplier: UnitInterval | undefined;
  #maxPledgeLeverage: UnitInterval | null | undefined;
  #minPoolMargin: UnitInterval | undefined;
  #leiosAnnouncementPeriodLength: number | undefined;
  #leiosVotePeriodLength: number | undefined;
  #leiosDiffusionPeriodLength: number | undefined;
  #leiosCommitteeSize: number | undefined;
  #leiosQuorumStakeThreshold: UnitInterval | undefined;
  #maxEndorserBlockReferencesSize: number | undefined;
  #maxEndorserBlockTxsSize: number | undefined;
  #maxEndorserBlockExUnits: ExUnits | undefined;
  #maxRefScriptSizePerEndorserBlock: number | undefined;
  #perasMinCandidateBlockAge: number | undefined;
  #perasHealingFactor: UnitInterval | undefined;
  #perasCertBoost: number | undefined;
  #perasTargetCommitteeSize: number | undefined;
  #perasBootstrapRound: number | null | undefined;
  #perasQuorumThresholdSafetyMargin: UnitInterval | undefined;
  #refInputsCostPerMultiAssetPolicy: Cardano.Lovelace | undefined;
  #refInputsCostPerDatumByte: Cardano.Lovelace | undefined;
  #originalBytes: HexBlob | undefined = undefined;

  /**
   * Serializes a ProtocolParamUpdate into CBOR format.
   *
   * @returns The ProtocolParamUpdate in CBOR format.
   */

  toCbor(): HexBlob {
    const writer = new CborWriter();

    if (this.#originalBytes) return this.#originalBytes;

    // CDDL
    // protocol_param_update =
    //   { ? 0:  uint                   ; minfee A
    //   , ? 1:  uint                   ; minfee B
    //   , ? 2:  uint                   ; max block body size
    //   , ? 3:  uint                   ; max transaction size
    //   , ? 4:  uint                   ; max block header size
    //   , ? 5:  coin                   ; key deposit
    //   , ? 6:  coin                   ; pool deposit
    //   , ? 7: epoch                   ; maximum epoch
    //   , ? 8: uint                    ; n_opt: desired number of stake pools
    //   , ? 9: rational                ; pool pledge influence
    //   , ? 10: unit_interval          ; expansion rate
    //   , ? 11: unit_interval          ; treasury growth rate
    //   , ? 16: coin                   ; min pool cost
    //   , ? 17: coin                   ; ada per utxo byte
    //   , ? 18: costmdls               ; cost models for script languages
    //   , ? 19: ex_unit_prices         ; execution costs
    //   , ? 20: ex_units               ; max tx ex units
    //   , ? 21: ex_units               ; max block ex units
    //   , ? 22: uint                   ; max value size
    //   , ? 23: uint                   ; collateral percentage
    //   , ? 24: uint                   ; max collateral inputs
    //   , ? 25: pool_voting_thresholds ; pool voting thresholds
    //   , ? 26: drep_voting_thresholds ; DRep voting thresholds
    //   , ? 27: uint                   ; min committee size
    //   , ? 28: uint                   ; committee term limit
    //   , ? 29: epoch                  ; governance action validity period
    //   , ? 30: coin                   ; governance action deposit
    //   , ? 31: coin                   ; DRep deposit
    //   , ? 32: epoch                  ; DRep inactivity period
    //   , ? 33: nonnegative_interval   ; MinFee RefScriptCostPerByte
    //   , ? 34: uint .size 4           ; max refScript size per block
    //   , ? 35: uint .size 4           ; max refScript size per tx
    //   , ? 36: positive_word32        ; refScript cost stride
    //   , ? 37: positive_interval      ; refScript cost multiplier
    //   , ? 38: max_pledge_leverage    ; max pledge leverage
    //   , ? 39: unit_interval          ; min pool margin
    //   , ? 40: uint .size 4           ; leios announcement period length in ms
    //   , ? 41: uint .size 4           ; leios vote period length in ms
    //   , ? 42: uint .size 4           ; leios diffusion period length in ms
    //   , ? 43: uint .size 2           ; leios committee size
    //   , ? 44: unit_interval          ; leios quorum stake threshold
    //   , ? 45: uint .size 4           ; max endorser block references size
    //   , ? 46: uint .size 4           ; max endorser block txs size
    //   , ? 47: ex_units               ; max endorser block ex units
    //   , ? 48: uint .size 4           ; max ref script size per endorser block
    //   , ? 49: uint .size 4           ; peras minimum candidate block age in slots
    //   , ? 50: positive_interval      ; peras healing factor
    //   , ? 51: uint .size 2           ; peras certificate boost
    //   , ? 52: uint .size 2           ; peras target committee size
    //   , ? 53: nil / uint .size 4     ; peras bootstrap round
    //   , ? 54: unit_interval          ; peras quorum threshold safety margin
    //   , ? 55: coin                   ; minfee per multi-asset policy id in reference inputs
    //   , ? 56: coin                   ; minfee per datum byte in reference inputs
    //   }
    writer.writeStartMap(this.#getMapSize());

    if (this.#minFeeA !== undefined) {
      writer.writeInt(0n);
      writer.writeInt(this.#minFeeA);
    }

    if (this.#minFeeB !== undefined) {
      writer.writeInt(1n);
      writer.writeInt(this.#minFeeB);
    }

    if (this.#maxBlockBodySize !== undefined) {
      writer.writeInt(2n);
      writer.writeInt(this.#maxBlockBodySize);
    }

    if (this.#maxTxSize !== undefined) {
      writer.writeInt(3n);
      writer.writeInt(this.#maxTxSize);
    }

    if (this.#maxBlockHeaderSize !== undefined) {
      writer.writeInt(4n);
      writer.writeInt(this.#maxBlockHeaderSize);
    }

    if (this.#keyDeposit !== undefined) {
      writer.writeInt(5n);
      writer.writeInt(this.#keyDeposit);
    }

    if (this.#poolDeposit !== undefined) {
      writer.writeInt(6n);
      writer.writeInt(this.#poolDeposit);
    }

    if (this.#maxEpoch !== undefined) {
      writer.writeInt(7n);
      writer.writeInt(this.#maxEpoch);
    }

    if (this.#nOpt !== undefined) {
      writer.writeInt(8n);
      writer.writeInt(this.#nOpt);
    }

    if (this.#poolPledgeInfluence !== undefined) {
      writer.writeInt(9n);
      writer.writeEncodedValue(
        Buffer.from(this.#poolPledgeInfluence.toCbor(), 'hex'),
      );
    }

    if (this.#expansionRate !== undefined) {
      writer.writeInt(10n);
      writer.writeEncodedValue(
        Buffer.from(this.#expansionRate.toCbor(), 'hex'),
      );
    }

    if (this.#treasuryGrowthRate !== undefined) {
      writer.writeInt(11n);
      writer.writeEncodedValue(
        Buffer.from(this.#treasuryGrowthRate.toCbor(), 'hex'),
      );
    }

    if (this.#d !== undefined) {
      writer.writeInt(12n);
      writer.writeEncodedValue(Buffer.from(this.#d.toCbor(), 'hex'));
    }

    if (this.#extraEntropy !== undefined) {
      if (this.#extraEntropy.length === 0) {
        writer.writeInt(13n);
        writer.writeStartArray(1);
        writer.writeInt(0);
      } else {
        writer.writeInt(13n);
        writer.writeStartArray(2);
        writer.writeInt(1);
        writer.writeByteString(Buffer.from(this.#extraEntropy, 'hex'));
      }
    }

    if (this.#protocolVersion !== undefined) {
      writer.writeInt(14n);
      writer.writeEncodedValue(
        Buffer.from(this.#protocolVersion.toCbor(), 'hex'),
      );
    }

    if (this.#minPoolCost !== undefined) {
      writer.writeInt(16n);
      writer.writeInt(this.#minPoolCost);
    }

    if (this.#adaPerUtxoByte !== undefined) {
      writer.writeInt(17n);
      writer.writeInt(this.#adaPerUtxoByte);
    }

    if (this.#costModels !== undefined) {
      writer.writeInt(18n);
      writer.writeEncodedValue(Buffer.from(this.#costModels.toCbor(), 'hex'));
    }

    if (this.#executionCosts !== undefined) {
      writer.writeInt(19n);
      writer.writeEncodedValue(
        Buffer.from(this.#executionCosts.toCbor(), 'hex'),
      );
    }

    if (this.#maxTxExUnits !== undefined) {
      writer.writeInt(20n);
      writer.writeEncodedValue(Buffer.from(this.#maxTxExUnits.toCbor(), 'hex'));
    }

    if (this.#maxBlockExUnits !== undefined) {
      writer.writeInt(21n);
      writer.writeEncodedValue(
        Buffer.from(this.#maxBlockExUnits.toCbor(), 'hex'),
      );
    }

    if (this.#maxValueSize !== undefined) {
      writer.writeInt(22n);
      writer.writeInt(this.#maxValueSize);
    }

    if (this.#collateralPercentage !== undefined) {
      writer.writeInt(23n);
      writer.writeInt(this.#collateralPercentage);
    }

    if (this.#maxCollateralInputs !== undefined) {
      writer.writeInt(24n);
      writer.writeInt(this.#maxCollateralInputs);
    }

    if (this.#poolVotingThresholds !== undefined) {
      writer.writeInt(25n);
      writer.writeEncodedValue(
        Buffer.from(this.#poolVotingThresholds.toCbor(), 'hex'),
      );
    }

    if (this.#drepVotingThresholds !== undefined) {
      writer.writeInt(26n);
      writer.writeEncodedValue(
        Buffer.from(this.#drepVotingThresholds.toCbor(), 'hex'),
      );
    }

    if (this.#minCommitteeSize !== undefined) {
      writer.writeInt(27n);
      writer.writeInt(this.#minCommitteeSize);
    }

    if (this.#committeeTermLimit !== undefined) {
      writer.writeInt(28n);
      writer.writeInt(this.#committeeTermLimit);
    }

    if (this.#governanceActionValidityPeriod !== undefined) {
      writer.writeInt(29n);
      writer.writeInt(this.#governanceActionValidityPeriod);
    }

    if (this.#governanceActionDeposit !== undefined) {
      writer.writeInt(30n);
      writer.writeInt(this.#governanceActionDeposit);
    }

    if (this.#drepDeposit !== undefined) {
      writer.writeInt(31n);
      writer.writeInt(this.#drepDeposit);
    }

    if (this.#drepInactivityPeriod !== undefined) {
      writer.writeInt(32n);
      writer.writeInt(this.#drepInactivityPeriod);
    }

    if (this.#minFeeRefScriptCostPerByte !== undefined) {
      writer.writeInt(33n);
      writer.writeEncodedValue(
        Buffer.from(this.#minFeeRefScriptCostPerByte.toCbor(), 'hex'),
      );
    }

    if (this.#maxRefScriptSizePerBlock !== undefined) {
      assertUint32('maxRefScriptSizePerBlock', this.#maxRefScriptSizePerBlock);
      writer.writeInt(34n);
      writer.writeInt(this.#maxRefScriptSizePerBlock);
    }

    if (this.#maxRefScriptSizePerTx !== undefined) {
      assertUint32('maxRefScriptSizePerTx', this.#maxRefScriptSizePerTx);
      writer.writeInt(35n);
      writer.writeInt(this.#maxRefScriptSizePerTx);
    }

    if (this.#refScriptCostStride !== undefined) {
      assertPositiveWord32('refScriptCostStride', this.#refScriptCostStride);
      writer.writeInt(36n);
      writer.writeInt(this.#refScriptCostStride);
    }

    if (this.#refScriptCostMultiplier !== undefined) {
      assertPositiveInterval(
        'refScriptCostMultiplier',
        this.#refScriptCostMultiplier,
      );
      writer.writeInt(37n);
      writer.writeEncodedValue(
        Buffer.from(this.#refScriptCostMultiplier.toCbor(), 'hex'),
      );
    }

    if (this.#maxPledgeLeverage !== undefined) {
      writer.writeInt(38n);
      if (this.#maxPledgeLeverage === null) {
        writer.writeNull();
      } else {
        writer.writeEncodedValue(
          Buffer.from(this.#maxPledgeLeverage.toCbor(), 'hex'),
        );
      }
    }

    if (this.#minPoolMargin !== undefined) {
      writer.writeInt(39n);
      writer.writeEncodedValue(
        Buffer.from(this.#minPoolMargin.toCbor(), 'hex'),
      );
    }

    if (this.#leiosAnnouncementPeriodLength !== undefined) {
      assertUint32(
        'leiosAnnouncementPeriodLength',
        this.#leiosAnnouncementPeriodLength,
      );
      writer.writeInt(40n);
      writer.writeInt(this.#leiosAnnouncementPeriodLength);
    }

    if (this.#leiosVotePeriodLength !== undefined) {
      assertUint32('leiosVotePeriodLength', this.#leiosVotePeriodLength);
      writer.writeInt(41n);
      writer.writeInt(this.#leiosVotePeriodLength);
    }

    if (this.#leiosDiffusionPeriodLength !== undefined) {
      assertUint32(
        'leiosDiffusionPeriodLength',
        this.#leiosDiffusionPeriodLength,
      );
      writer.writeInt(42n);
      writer.writeInt(this.#leiosDiffusionPeriodLength);
    }

    if (this.#leiosCommitteeSize !== undefined) {
      assertUint16('leiosCommitteeSize', this.#leiosCommitteeSize);
      writer.writeInt(43n);
      writer.writeInt(this.#leiosCommitteeSize);
    }

    if (this.#leiosQuorumStakeThreshold !== undefined) {
      writer.writeInt(44n);
      writer.writeEncodedValue(
        Buffer.from(this.#leiosQuorumStakeThreshold.toCbor(), 'hex'),
      );
    }

    if (this.#maxEndorserBlockReferencesSize !== undefined) {
      assertUint32(
        'maxEndorserBlockReferencesSize',
        this.#maxEndorserBlockReferencesSize,
      );
      writer.writeInt(45n);
      writer.writeInt(this.#maxEndorserBlockReferencesSize);
    }

    if (this.#maxEndorserBlockTxsSize !== undefined) {
      assertUint32('maxEndorserBlockTxsSize', this.#maxEndorserBlockTxsSize);
      writer.writeInt(46n);
      writer.writeInt(this.#maxEndorserBlockTxsSize);
    }

    if (this.#maxEndorserBlockExUnits !== undefined) {
      writer.writeInt(47n);
      writer.writeEncodedValue(
        Buffer.from(this.#maxEndorserBlockExUnits.toCbor(), 'hex'),
      );
    }

    if (this.#maxRefScriptSizePerEndorserBlock !== undefined) {
      assertUint32(
        'maxRefScriptSizePerEndorserBlock',
        this.#maxRefScriptSizePerEndorserBlock,
      );
      writer.writeInt(48n);
      writer.writeInt(this.#maxRefScriptSizePerEndorserBlock);
    }

    if (this.#perasMinCandidateBlockAge !== undefined) {
      assertUint32(
        'perasMinCandidateBlockAge',
        this.#perasMinCandidateBlockAge,
      );
      writer.writeInt(49n);
      writer.writeInt(this.#perasMinCandidateBlockAge);
    }

    if (this.#perasHealingFactor !== undefined) {
      assertPositiveInterval('perasHealingFactor', this.#perasHealingFactor);
      writer.writeInt(50n);
      writer.writeEncodedValue(
        Buffer.from(this.#perasHealingFactor.toCbor(), 'hex'),
      );
    }

    if (this.#perasCertBoost !== undefined) {
      assertUint16('perasCertBoost', this.#perasCertBoost);
      writer.writeInt(51n);
      writer.writeInt(this.#perasCertBoost);
    }

    if (this.#perasTargetCommitteeSize !== undefined) {
      assertUint16('perasTargetCommitteeSize', this.#perasTargetCommitteeSize);
      writer.writeInt(52n);
      writer.writeInt(this.#perasTargetCommitteeSize);
    }

    if (this.#perasBootstrapRound === null) {
      writer.writeInt(53n);
      writer.writeNull();
    } else if (this.#perasBootstrapRound !== undefined) {
      assertUint32('perasBootstrapRound', this.#perasBootstrapRound);
      writer.writeInt(53n);
      writer.writeInt(this.#perasBootstrapRound);
    }

    if (this.#perasQuorumThresholdSafetyMargin !== undefined) {
      writer.writeInt(54n);
      writer.writeEncodedValue(
        Buffer.from(this.#perasQuorumThresholdSafetyMargin.toCbor(), 'hex'),
      );
    }

    if (this.#refInputsCostPerMultiAssetPolicy !== undefined) {
      writer.writeInt(55n);
      writer.writeInt(this.#refInputsCostPerMultiAssetPolicy);
    }

    if (this.#refInputsCostPerDatumByte !== undefined) {
      writer.writeInt(56n);
      writer.writeInt(this.#refInputsCostPerDatumByte);
    }

    return writer.encodeAsHex();
  }

  /**
   * Deserializes the ProtocolParamUpdate from a CBOR byte array.
   *
   * The integer parameters introduced in the Dijkstra era must fit in their 16 or 32 bit size,
   * and the reference script cost stride must also be greater than zero, as must the reference
   * script cost multiplier and the Peras healing factor. A key may appear only once, and unknown
   * keys are skipped unless `strict` is set.
   *
   * @param cbor The CBOR encoded ProtocolParamUpdate object.
   * @param options Deserialization options. When `strict` is true, throws on unknown map keys
   * and forwards the options to the protocol version decoding.
   * @returns The new ProtocolParamUpdate instance.
   */
  static fromCbor(
    cbor: HexBlob,
    options?: DeserializationOptions,
  ): ProtocolParamUpdate {
    const reader = new CborReader(cbor);
    const params = new ProtocolParamUpdate();
    const seenKeys = new Set<bigint>();

    reader.readStartMap();

    while (reader.peekState() !== CborReaderState.EndMap) {
      const key = reader.readInt();

      if (seenKeys.has(key))
        throw new SerializationError(
          SerializationFailure.InvalidType,
          `Duplicate protocol parameter update map key: ${key}`,
        );

      seenKeys.add(key);

      switch (key) {
        case 0n:
          params.#minFeeA = reader.readInt();
          break;
        case 1n:
          params.#minFeeB = reader.readInt();
          break;
        case 2n:
          params.#maxBlockBodySize = Number(reader.readInt());
          break;
        case 3n:
          params.#maxTxSize = Number(reader.readInt());
          break;
        case 4n:
          params.#maxBlockHeaderSize = Number(reader.readInt());
          break;
        case 5n:
          params.#keyDeposit = reader.readInt();
          break;
        case 6n:
          params.#poolDeposit = reader.readInt();
          break;
        case 7n:
          params.#maxEpoch = Number(reader.readInt());
          break;
        case 8n:
          params.#nOpt = Number(reader.readInt());
          break;
        case 9n:
          params.#poolPledgeInfluence = UnitInterval.fromCbor(
            HexBlob.fromBytes(reader.readEncodedValue()),
          );
          break;
        case 10n:
          params.#expansionRate = UnitInterval.fromCbor(
            HexBlob.fromBytes(reader.readEncodedValue()),
          );
          break;
        case 11n:
          params.#treasuryGrowthRate = UnitInterval.fromCbor(
            HexBlob.fromBytes(reader.readEncodedValue()),
          );
          break;
        case 12n:
          params.#d = UnitInterval.fromCbor(
            HexBlob.fromBytes(reader.readEncodedValue()),
          );
          break;
        case 13n:
          if (reader.readStartArray() === 1) {
            reader.readEncodedValue();
            // Entropy was set as empty
            params.#extraEntropy = '' as HexBlob;
            reader.readEndArray();
          } else {
            reader.readEncodedValue();
            params.#extraEntropy = HexBlob.fromBytes(reader.readByteString());
            reader.readEndArray();
          }
          break;
        case 14n:
          params.#protocolVersion = ProtocolVersion.fromCbor(
            HexBlob.fromBytes(reader.readEncodedValue()),
            options,
          );
          break;
        case 16n:
          params.#minPoolCost = reader.readInt();
          break;
        case 17n:
          params.#adaPerUtxoByte = reader.readInt();
          break;
        case 18n:
          params.#costModels = Costmdls.fromCbor(
            HexBlob.fromBytes(reader.readEncodedValue()),
          );
          break;
        case 19n:
          params.#executionCosts = ExUnitPrices.fromCbor(
            HexBlob.fromBytes(reader.readEncodedValue()),
          );
          break;
        case 20n:
          params.#maxTxExUnits = ExUnits.fromCbor(
            HexBlob.fromBytes(reader.readEncodedValue()),
          );
          break;
        case 21n:
          params.#maxBlockExUnits = ExUnits.fromCbor(
            HexBlob.fromBytes(reader.readEncodedValue()),
          );
          break;
        case 22n:
          params.#maxValueSize = Number(reader.readInt());
          break;
        case 23n:
          params.#collateralPercentage = Number(reader.readInt());
          break;
        case 24n:
          params.#maxCollateralInputs = Number(reader.readInt());
          break;
        case 25n:
          params.#poolVotingThresholds = PoolVotingThresholds.fromCbor(
            HexBlob.fromBytes(reader.readEncodedValue()),
          );
          break;
        case 26n:
          params.#drepVotingThresholds = DrepVotingThresholds.fromCbor(
            HexBlob.fromBytes(reader.readEncodedValue()),
          );
          break;
        case 27n:
          params.#minCommitteeSize = Number(reader.readInt());
          break;
        case 28n:
          params.#committeeTermLimit = Number(reader.readInt());
          break;
        case 29n:
          params.#governanceActionValidityPeriod = Number(reader.readInt());
          break;
        case 30n:
          params.#governanceActionDeposit = Number(reader.readInt());
          break;
        case 31n:
          params.#drepDeposit = Number(reader.readInt());
          break;
        case 32n:
          params.#drepInactivityPeriod = Number(reader.readInt());
          break;
        case 33n:
          params.#minFeeRefScriptCostPerByte = UnitInterval.fromCbor(
            HexBlob.fromBytes(reader.readEncodedValue()),
          );
          break;
        case 34n:
          params.#maxRefScriptSizePerBlock = readUint32(
            reader,
            'maxRefScriptSizePerBlock',
          );
          break;
        case 35n:
          params.#maxRefScriptSizePerTx = readUint32(
            reader,
            'maxRefScriptSizePerTx',
          );
          break;
        case 36n:
          params.#refScriptCostStride = readPositiveWord32(
            reader,
            'refScriptCostStride',
          );
          break;
        case 37n:
          params.#refScriptCostMultiplier = readPositiveInterval(
            reader,
            'refScriptCostMultiplier',
          );
          break;
        case 38n:
          if (reader.peekState() === CborReaderState.Null) {
            reader.readNull();
            params.#maxPledgeLeverage = null;
          } else {
            params.#maxPledgeLeverage = UnitInterval.fromCbor(
              HexBlob.fromBytes(reader.readEncodedValue()),
            );
          }
          break;
        case 39n:
          params.#minPoolMargin = UnitInterval.fromCbor(
            HexBlob.fromBytes(reader.readEncodedValue()),
          );
          break;
        case 40n:
          params.#leiosAnnouncementPeriodLength = readUint32(
            reader,
            'leiosAnnouncementPeriodLength',
          );
          break;
        case 41n:
          params.#leiosVotePeriodLength = readUint32(
            reader,
            'leiosVotePeriodLength',
          );
          break;
        case 42n:
          params.#leiosDiffusionPeriodLength = readUint32(
            reader,
            'leiosDiffusionPeriodLength',
          );
          break;
        case 43n:
          params.#leiosCommitteeSize = readUint16(reader, 'leiosCommitteeSize');
          break;
        case 44n:
          params.#leiosQuorumStakeThreshold = UnitInterval.fromCbor(
            HexBlob.fromBytes(reader.readEncodedValue()),
          );
          break;
        case 45n:
          params.#maxEndorserBlockReferencesSize = readUint32(
            reader,
            'maxEndorserBlockReferencesSize',
          );
          break;
        case 46n:
          params.#maxEndorserBlockTxsSize = readUint32(
            reader,
            'maxEndorserBlockTxsSize',
          );
          break;
        case 47n:
          params.#maxEndorserBlockExUnits = ExUnits.fromCbor(
            HexBlob.fromBytes(reader.readEncodedValue()),
          );
          break;
        case 48n:
          params.#maxRefScriptSizePerEndorserBlock = readUint32(
            reader,
            'maxRefScriptSizePerEndorserBlock',
          );
          break;
        case 49n:
          params.#perasMinCandidateBlockAge = readUint32(
            reader,
            'perasMinCandidateBlockAge',
          );
          break;
        case 50n:
          params.#perasHealingFactor = readPositiveInterval(
            reader,
            'perasHealingFactor',
          );
          break;
        case 51n:
          params.#perasCertBoost = readUint16(reader, 'perasCertBoost');
          break;
        case 52n:
          params.#perasTargetCommitteeSize = readUint16(
            reader,
            'perasTargetCommitteeSize',
          );
          break;
        case 53n:
          if (reader.peekState() === CborReaderState.Null) {
            reader.readNull();
            params.#perasBootstrapRound = null;
          } else {
            params.#perasBootstrapRound = readUint32(
              reader,
              'perasBootstrapRound',
            );
          }
          break;
        case 54n:
          params.#perasQuorumThresholdSafetyMargin = UnitInterval.fromCbor(
            HexBlob.fromBytes(reader.readEncodedValue()),
          );
          break;
        case 55n:
          params.#refInputsCostPerMultiAssetPolicy = reader.readInt();
          break;
        case 56n:
          params.#refInputsCostPerDatumByte = reader.readInt();
          break;
        default:
          if (options?.strict)
            throw new SerializationError(
              SerializationFailure.UnknownField,
              `Unknown protocol parameter update map key: ${key}`,
            );

          reader.skipValue();
      }
    }

    reader.readEndMap();

    params.#originalBytes = cbor;

    return params;
  }

  /**
   * Creates a Core ProtocolParamUpdate object from the current ProtocolParamUpdate object.
   *
   * The extra entropy (key 13) is set to an empty string for the neutral nonce (encoded as [0])
   * and to the hex of the hash for a seed (encoded as [1, hash]). fromCore rebuilds both forms,
   * and toCbor returns the decoded bytes until a setter is called.
   *
   * Rational parameters become decimal text. fromCore converts real parameters and simple fractions
   * back to the same value in lowest terms, approximates a rational with a large numerator or
   * denominator, and throws a RangeError when the approximation does not fit 64 bits.
   *
   * @returns The Core ProtocolParamUpdate object.
   */
  toCore(): Cardano.ProtocolParametersUpdate {
    const protocolParametersUpdate: Cardano.ProtocolParametersUpdate = {
      coinsPerUtxoByte:
        this.#adaPerUtxoByte !== undefined
          ? Number(this.#adaPerUtxoByte)
          : undefined,
      collateralPercentage: this.#collateralPercentage,
      committeeTermLimit:
        this.#committeeTermLimit !== undefined
          ? EpochNo(this.#committeeTermLimit)
          : undefined,
      costModels: this.#costModels?.toCore(),
      dRepDeposit: this.#drepDeposit,
      dRepInactivityPeriod:
        this.#drepInactivityPeriod !== undefined
          ? EpochNo(this.#drepInactivityPeriod)
          : undefined,
      dRepVotingThresholds: this.#drepVotingThresholds?.toCore(),
      desiredNumberOfPools: this.#nOpt,
      governanceActionDeposit: this.#governanceActionDeposit,
      governanceActionValidityPeriod:
        this.#governanceActionValidityPeriod !== undefined
          ? EpochNo(this.#governanceActionValidityPeriod)
          : undefined,
      leiosAnnouncementPeriodLength: this.#leiosAnnouncementPeriodLength,
      leiosCommitteeSize: this.#leiosCommitteeSize,
      leiosDiffusionPeriodLength: this.#leiosDiffusionPeriodLength,
      leiosQuorumStakeThreshold: this.#leiosQuorumStakeThreshold
        ?.toFloat()
        .toString(),
      leiosVotePeriodLength: this.#leiosVotePeriodLength,
      maxBlockBodySize: this.#maxBlockBodySize,
      maxBlockHeaderSize: this.#maxBlockHeaderSize,
      maxCollateralInputs: this.#maxCollateralInputs,
      maxEndorserBlockExecutionUnits: this.#maxEndorserBlockExUnits?.toCore(),
      maxEndorserBlockReferencesSize: this.#maxEndorserBlockReferencesSize,
      maxEndorserBlockTxsSize: this.#maxEndorserBlockTxsSize,
      maxExecutionUnitsPerBlock: this.#maxBlockExUnits?.toCore(),
      maxExecutionUnitsPerTransaction: this.#maxTxExUnits?.toCore(),
      maxPledgeLeverage:
        this.#maxPledgeLeverage === null
          ? null
          : this.#maxPledgeLeverage?.toFloat().toString(),
      maxRefScriptSizePerBlock: this.#maxRefScriptSizePerBlock,
      maxRefScriptSizePerEndorserBlock: this.#maxRefScriptSizePerEndorserBlock,
      maxRefScriptSizePerTx: this.#maxRefScriptSizePerTx,
      maxTxSize:
        this.#maxTxSize !== undefined ? Number(this.#maxTxSize) : undefined,
      maxValueSize: this.#maxValueSize,
      minCommitteeSize: this.#minCommitteeSize,
      minFeeCoefficient:
        this.#minFeeA !== undefined ? Number(this.#minFeeA) : undefined,
      minFeeConstant:
        this.#minFeeB !== undefined ? Number(this.#minFeeB) : undefined,
      minFeeRefScriptCostPerByte: this.#minFeeRefScriptCostPerByte
        ? this.#minFeeRefScriptCostPerByte.toFloat().toString()
        : undefined,
      minPoolCost:
        this.#minPoolCost !== undefined ? Number(this.#minPoolCost) : undefined,
      minPoolMargin: this.#minPoolMargin?.toFloat().toString(),
      monetaryExpansion: this.#expansionRate
        ? this.#expansionRate.toFloat().toString()
        : undefined,
      perasBootstrapRound: this.#perasBootstrapRound,
      perasCertBoost: this.#perasCertBoost,
      perasHealingFactor: this.#perasHealingFactor?.toFloat().toString(),
      perasMinCandidateBlockAge: this.#perasMinCandidateBlockAge,
      perasQuorumThresholdSafetyMargin: this.#perasQuorumThresholdSafetyMargin
        ?.toFloat()
        .toString(),
      perasTargetCommitteeSize: this.#perasTargetCommitteeSize,
      poolDeposit:
        this.#poolDeposit !== undefined ? Number(this.#poolDeposit) : undefined,
      poolInfluence: this.#poolPledgeInfluence
        ? this.#poolPledgeInfluence.toFloat().toString()
        : undefined,
      poolRetirementEpochBound: this.#maxEpoch,
      poolVotingThresholds: this.#poolVotingThresholds?.toCore(),
      prices: this.#executionCosts?.toCore(),
      refScriptCostMultiplier: this.#refScriptCostMultiplier
        ? this.#refScriptCostMultiplier.toFloat().toString()
        : undefined,
      refInputsCostPerDatumByte:
        this.#refInputsCostPerDatumByte !== undefined
          ? Number(this.#refInputsCostPerDatumByte)
          : undefined,
      refInputsCostPerMultiAssetPolicy:
        this.#refInputsCostPerMultiAssetPolicy !== undefined
          ? Number(this.#refInputsCostPerMultiAssetPolicy)
          : undefined,
      refScriptCostStride: this.#refScriptCostStride,
      stakeKeyDeposit:
        this.#keyDeposit !== undefined ? Number(this.#keyDeposit) : undefined,
      treasuryExpansion: this.#treasuryGrowthRate
        ? this.#treasuryGrowthRate.toFloat().toString()
        : undefined,
    };

    if (this.#d)
      protocolParametersUpdate.decentralizationParameter = this.#d
        .toFloat()
        .toString();
    if (this.#extraEntropy !== undefined)
      protocolParametersUpdate.extraEntropy = this.#extraEntropy;
    if (this.#protocolVersion)
      protocolParametersUpdate.protocolVersion = this.#protocolVersion.toCore();

    return protocolParametersUpdate;
  }

  /**
   * Creates a ProtocolParamUpdate object from the given Core ProtocolParamUpdate object.
   *
   * @param parametersUpdate core parametersUpdate object.
   */
  static fromCore<
    T extends Cardano.ProtocolParametersUpdateConway = Cardano.ProtocolParametersUpdate,
  >(parametersUpdate: T) {
    const params = new ProtocolParamUpdate();

    params.#minFeeA =
      parametersUpdate.minFeeCoefficient !== undefined
        ? BigInt(parametersUpdate.minFeeCoefficient)
        : undefined;
    params.#maxBlockBodySize = parametersUpdate.maxBlockBodySize;
    params.#minFeeB =
      parametersUpdate.minFeeConstant !== undefined
        ? BigInt(parametersUpdate.minFeeConstant)
        : undefined;
    params.#maxBlockHeaderSize = parametersUpdate.maxBlockHeaderSize;
    params.#keyDeposit =
      parametersUpdate.stakeKeyDeposit !== undefined
        ? BigInt(parametersUpdate.stakeKeyDeposit)
        : undefined;
    params.#poolDeposit =
      parametersUpdate.poolDeposit !== undefined &&
      parametersUpdate.poolDeposit !== null
        ? BigInt(parametersUpdate.poolDeposit)
        : undefined;
    params.#maxEpoch = parametersUpdate.poolRetirementEpochBound;
    params.#nOpt = parametersUpdate.desiredNumberOfPools;
    params.#poolPledgeInfluence = parametersUpdate.poolInfluence
      ? UnitInterval.fromFloat(Number(parametersUpdate.poolInfluence))
      : undefined;
    params.#expansionRate = parametersUpdate.monetaryExpansion
      ? UnitInterval.fromFloat(Number(parametersUpdate.monetaryExpansion))
      : undefined;
    params.#treasuryGrowthRate = parametersUpdate.treasuryExpansion
      ? UnitInterval.fromFloat(Number(parametersUpdate.treasuryExpansion))
      : undefined;
    params.#minPoolCost =
      parametersUpdate.minPoolCost !== undefined
        ? BigInt(parametersUpdate.minPoolCost)
        : undefined;
    params.#maxValueSize = parametersUpdate.maxValueSize;
    params.#maxTxSize = parametersUpdate.maxTxSize;
    params.#collateralPercentage = parametersUpdate.collateralPercentage;
    params.#maxCollateralInputs = parametersUpdate.maxCollateralInputs;
    params.#costModels = parametersUpdate.costModels
      ? Costmdls.fromCore(parametersUpdate.costModels)
      : undefined;
    params.#executionCosts = parametersUpdate.prices
      ? ExUnitPrices.fromCore(parametersUpdate.prices)
      : undefined;
    params.#maxTxExUnits = parametersUpdate.maxExecutionUnitsPerTransaction
      ? ExUnits.fromCore(parametersUpdate.maxExecutionUnitsPerTransaction)
      : undefined;
    params.#maxBlockExUnits = parametersUpdate.maxExecutionUnitsPerBlock
      ? ExUnits.fromCore(parametersUpdate.maxExecutionUnitsPerBlock)
      : undefined;
    params.#adaPerUtxoByte =
      parametersUpdate.coinsPerUtxoByte !== undefined
        ? BigInt(parametersUpdate.coinsPerUtxoByte)
        : undefined;
    params.#poolVotingThresholds = parametersUpdate.poolVotingThresholds
      ? PoolVotingThresholds.fromCore(parametersUpdate.poolVotingThresholds)
      : undefined;
    params.#drepVotingThresholds = parametersUpdate.dRepVotingThresholds
      ? DrepVotingThresholds.fromCore(parametersUpdate.dRepVotingThresholds)
      : undefined;
    params.#minCommitteeSize = parametersUpdate.minCommitteeSize;
    params.#committeeTermLimit = parametersUpdate.committeeTermLimit;
    params.#governanceActionValidityPeriod =
      parametersUpdate.governanceActionValidityPeriod;
    params.#governanceActionDeposit = parametersUpdate.governanceActionDeposit;
    params.#drepDeposit = parametersUpdate.dRepDeposit;
    params.#drepInactivityPeriod = parametersUpdate.dRepInactivityPeriod;
    params.#minFeeRefScriptCostPerByte =
      parametersUpdate.minFeeRefScriptCostPerByte
        ? UnitInterval.fromFloat(
            Number(parametersUpdate.minFeeRefScriptCostPerByte),
          )
        : undefined;
    params.#maxRefScriptSizePerBlock =
      parametersUpdate.maxRefScriptSizePerBlock;
    params.#maxRefScriptSizePerTx = parametersUpdate.maxRefScriptSizePerTx;
    params.#refScriptCostStride = parametersUpdate.refScriptCostStride;
    params.#refScriptCostMultiplier = parametersUpdate.refScriptCostMultiplier
      ? UnitInterval.fromFloat(Number(parametersUpdate.refScriptCostMultiplier))
      : undefined;
    params.#maxPledgeLeverage =
      parametersUpdate.maxPledgeLeverage === null
        ? null
        : parametersUpdate.maxPledgeLeverage
        ? UnitInterval.fromFloat(Number(parametersUpdate.maxPledgeLeverage))
        : undefined;
    params.#minPoolMargin = parametersUpdate.minPoolMargin
      ? UnitInterval.fromFloat(Number(parametersUpdate.minPoolMargin))
      : undefined;
    params.#leiosAnnouncementPeriodLength =
      parametersUpdate.leiosAnnouncementPeriodLength;
    params.#leiosVotePeriodLength = parametersUpdate.leiosVotePeriodLength;
    params.#leiosDiffusionPeriodLength =
      parametersUpdate.leiosDiffusionPeriodLength;
    params.#leiosCommitteeSize = parametersUpdate.leiosCommitteeSize;
    params.#leiosQuorumStakeThreshold =
      parametersUpdate.leiosQuorumStakeThreshold
        ? UnitInterval.fromFloat(
            Number(parametersUpdate.leiosQuorumStakeThreshold),
          )
        : undefined;
    params.#maxEndorserBlockReferencesSize =
      parametersUpdate.maxEndorserBlockReferencesSize;
    params.#maxEndorserBlockTxsSize = parametersUpdate.maxEndorserBlockTxsSize;
    params.#maxEndorserBlockExUnits =
      parametersUpdate.maxEndorserBlockExecutionUnits
        ? ExUnits.fromCore(parametersUpdate.maxEndorserBlockExecutionUnits)
        : undefined;
    params.#maxRefScriptSizePerEndorserBlock =
      parametersUpdate.maxRefScriptSizePerEndorserBlock;
    params.#perasMinCandidateBlockAge =
      parametersUpdate.perasMinCandidateBlockAge;
    params.#perasHealingFactor = parametersUpdate.perasHealingFactor
      ? UnitInterval.fromFloat(Number(parametersUpdate.perasHealingFactor))
      : undefined;
    params.#perasCertBoost = parametersUpdate.perasCertBoost;
    params.#perasTargetCommitteeSize =
      parametersUpdate.perasTargetCommitteeSize;
    params.#perasBootstrapRound = parametersUpdate.perasBootstrapRound;
    params.#perasQuorumThresholdSafetyMargin =
      parametersUpdate.perasQuorumThresholdSafetyMargin
        ? UnitInterval.fromFloat(
            Number(parametersUpdate.perasQuorumThresholdSafetyMargin),
          )
        : undefined;
    params.#refInputsCostPerMultiAssetPolicy =
      parametersUpdate.refInputsCostPerMultiAssetPolicy !== undefined
        ? BigInt(parametersUpdate.refInputsCostPerMultiAssetPolicy)
        : undefined;
    params.#refInputsCostPerDatumByte =
      parametersUpdate.refInputsCostPerDatumByte !== undefined
        ? BigInt(parametersUpdate.refInputsCostPerDatumByte)
        : undefined;

    const { protocolVersion, extraEntropy, decentralizationParameter } =
      parametersUpdate as unknown as Cardano.ProtocolParametersUpdate;
    if (
      protocolVersion !== undefined ||
      extraEntropy !== undefined ||
      decentralizationParameter
    ) {
      params.#d = decentralizationParameter
        ? UnitInterval.fromFloat(Number(decentralizationParameter))
        : undefined;
      params.#protocolVersion = protocolVersion
        ? ProtocolVersion.fromCore(protocolVersion)
        : undefined;
      if (extraEntropy === undefined) {
        params.#extraEntropy = undefined;
      } else if (extraEntropy === '' || extraEntropy === 'neutral') {
        params.#extraEntropy = '' as HexBlob;
      } else {
        params.#extraEntropy = HexBlob(extraEntropy);
      }
    }

    return params;
  }

  /**
   * minfeeA and minfeeB are two separate parameters in Cardano's fee calculation
   * to ensure flexibility and fine-grained control over how transaction fees are
   * determined. Both of these parameters come into play when deciding the cost of
   * a transaction, and they serve different purposes.
   *
   * The transaction fee in Cardano is computed as: fee = minfeeA * size + minfeeB.
   *
   * minfeeA it's multiplied by the size of the transaction. This means it's primarily responsible
   * for how the fee scales with the transaction's size. If minfeeA is high, then the cost per byte
   * of transaction data is high. This encourages users to minimize the size of their transactions.
   *
   * Conversely, if minfeeA is low, the cost per byte is low, but other factors (like minfeeB) can still
   * influence the overall fee.
   *
   * @param minFeeA fee to be multiplied by the transaction size.
   */
  setMinFeeA(minFeeA: Cardano.Lovelace): void {
    this.#minFeeA = minFeeA;
  }

  /**
   * Gets the minFeeA component of the transaction fee computation.
   *
   * @returns The transaction fee to be multiplied by the transaction size, or undefined
   * if not set.
   */
  minFeeA(): Cardano.Lovelace | undefined {
    return this.#minFeeA;
  }

  /**
   * minfeeB it's a constant added to the transaction fee irrespective of the transaction's size.
   * Think of it as a "base fee" for processing the transaction. A higher minfeeB means every
   * transaction will have a higher minimum cost, regardless of its size.
   *
   * This discourages spamming the network with a large number of tiny transactions.
   *
   * @param minFeeB fee to be added to every transaction regardless of its size, or undefined
   * if not set.
   */
  setMinFeeB(minFeeB: Cardano.Lovelace): void {
    this.#minFeeB = minFeeB;
    this.#originalBytes = undefined;
  }

  /**
   * Gets the minFeeB component of the transaction fee computation.
   *
   * @returns The transaction fee to be added to every transaction regardless of its size, or undefined
   * if not set.
   */
  minFeeB(): Cardano.Lovelace | undefined {
    return this.#minFeeB;
  }

  /**
   * Sets the maximum block body size. It sets an upper limit on the size of the block's body.
   *
   * @param maxBlockBodySize The block body size in bytes.
   */
  setMaxBlockBodySize(maxBlockBodySize: number): void {
    this.#maxBlockBodySize = maxBlockBodySize;
    this.#originalBytes = undefined;
  }

  /**
   * Gets the maximum block body size.
   *
   * @returns The maximum block body size in bytes, or undefined
   * if not set.
   */
  maxBlockBodySize(): number | undefined {
    return this.#maxBlockBodySize;
  }

  /**
   * Sets the maximum transaction size. This limits the size of individual transactions.
   *
   * @param maxTxSize The transaction size in bytes.
   */
  setMaxTxSize(maxTxSize: number): void {
    this.#maxTxSize = maxTxSize;
    this.#originalBytes = undefined;
  }

  /**
   * Gets the maximum transaction size. This limits the size of individual transactions.
   *
   * @returns The transaction size in bytes, or undefined
   * if not set.
   */
  maxTxSize(): number | undefined {
    return this.#maxTxSize;
  }

  /**
   * Sets the maximum block header size.
   *
   * @param maxBlockHeaderSize The block header size in bytes.
   */
  setMaxBlockHeaderSize(maxBlockHeaderSize: number): void {
    this.#maxBlockHeaderSize = maxBlockHeaderSize;
    this.#originalBytes = undefined;
  }

  /**
   * Gets the maximum block header size.
   *
   * @returns The block header size in bytes, or undefined
   * if not set.
   */
  maxBlockHeaderSize(): number | undefined {
    return this.#maxBlockHeaderSize;
  }

  /**
   * Sets the amount of ADA required as a deposit for staking key registration.
   *
   * @param keyDeposit The amount of ADA required in lovelace.
   */
  setKeyDeposit(keyDeposit: Cardano.Lovelace): void {
    this.#keyDeposit = keyDeposit;
    this.#originalBytes = undefined;
  }

  /**
   * Gets the amount of ADA required as a deposit for staking key registration.
   *
   * @returns The amount of ADA required in lovelace, or undefined
   * if not set.
   */
  keyDeposit(): Cardano.Lovelace | undefined {
    return this.#keyDeposit;
  }

  /**
   * Sets the amount of ADA required as a deposit for stake pool registration.
   *
   * @param poolDeposit The amount of ADA required in lovelace, or undefined
   * if not set.
   */
  setPoolDeposit(poolDeposit: Cardano.Lovelace): void {
    this.#poolDeposit = poolDeposit;
    this.#originalBytes = undefined;
  }

  /**
   * Gets the amount of ADA required as a deposit for stake pool registration.
   *
   * @returns The amount of ADA required in lovelace, or undefined
   * if not set.
   */
  poolDeposit(): Cardano.Lovelace | undefined {
    return this.#poolDeposit;
  }

  /**
   * Sets the maximum epoch (number of epochs) for which a pool can be ranked in
   * the non-myopic member rewards.
   *
   * @param maxEpoch The maximum number of epochs.
   */
  setMaxEpoch(maxEpoch: number): void {
    this.#maxEpoch = maxEpoch;
    this.#originalBytes = undefined;
  }

  /**
   * Gets the maximum epoch (number of epochs) for which a pool can be ranked in
   * the non-myopic member rewards.
   *
   * @returns The maximum epoch number of epochs, or undefined
   * if not set.
   */
  maxEpoch(): number | undefined {
    return this.#maxEpoch;
  }

  /**
   * Sets the desired number of stake pools. It's used in the rewards calculation
   * to encourage a certain number of active stake pools.
   *
   * @param nOpt The desired number of stake pools.
   */
  setNOpt(nOpt: number): void {
    this.#nOpt = nOpt;
    this.#originalBytes = undefined;
  }

  /**
   * Gets the desired number of stake pools. It's used in the rewards calculation
   * to encourage a certain number of active stake pools.
   *
   * @returns The desired number of stake pools, or undefined
   * if not set.
   */
  nOpt(): number | undefined {
    return this.#nOpt;
  }

  /**
   * Sets the pool pledge power of influencing rewards for stake pools, determining how
   * much stake pool owners versus delegators get.
   *
   * @param poolPledgeInfluence The pool pledge power of influence over rewards (a0).
   */
  setPoolPledgeInfluence(poolPledgeInfluence: UnitInterval): void {
    this.#poolPledgeInfluence = poolPledgeInfluence;
    this.#originalBytes = undefined;
  }

  /**
   * Gets the pool pledge power of influencing rewards for stake pools, determining how
   * much stake pool owners versus delegators get.
   *
   * @returns The pool pledge power of influence over rewards (a0), or undefined
   * if not set.
   */
  poolPledgeInfluence(): UnitInterval | undefined {
    return this.#poolPledgeInfluence;
  }

  /**
   * Sets the rate at which ADA is taken from the reserves and used for epoch rewards and treasury.
   *
   * @param expansionRate  The rate at which ADA is taken from the reserves.
   */
  setExpansionRate(expansionRate: UnitInterval): void {
    this.#expansionRate = expansionRate;
    this.#originalBytes = undefined;
  }

  /**
   * Gets the rate at which ADA is taken from the reserves and used for epoch rewards and treasury.
   *
   * @returns The rate at which ADA is taken from the reserves, or undefined
   * if not set.
   */
  expansionRate(): UnitInterval | undefined {
    return this.#expansionRate;
  }

  /**
   * Sets the percentage of rewards taken from the total to populate the treasury.
   *
   * @param treasuryGrowthRate The percentage of rewards.
   */
  setTreasuryGrowthRate(treasuryGrowthRate: UnitInterval): void {
    this.#treasuryGrowthRate = treasuryGrowthRate;
    this.#originalBytes = undefined;
  }

  /**
   * Gets the percentage of rewards taken from the total to populate the treasury.
   *
   * @returns The percentage of rewards, or undefined
   * if not set.
   */
  treasuryGrowthRate(): UnitInterval | undefined {
    return this.#treasuryGrowthRate;
  }

  // Alonzo

  /**
   * Sets the degree of decentralization; ranges from 0 to 1. A value of 1 indicates
   * complete decentralization, i.e., all blocks are produced by community stake pools,
   * while 0 would indicate a fully centralized scenario.
   *
   * REMARK: This parameter is only used in the Alonzo era. Do not set it for other eras.
   *
   * @param d The degree of decentralization.
   */
  setD(d: UnitInterval): void {
    this.#d = d;
    this.#originalBytes = undefined;
  }

  /**
   * Gets the degree of decentralization; ranges from 0 to 1. A value of 1 indicates
   * complete decentralization, i.e., all blocks are produced by community stake pools,
   * while 0 would indicate a fully centralized scenario.
   *
   * @returns The degree of decentralization, or undefined
   * if not set.
   */
  d(): UnitInterval | undefined {
    return this.#d;
  }

  /**
   * Sets additional randomness used to seed the pseudo-random number generator for leader election.
   *
   * REMARK: This parameter is only used in the Alonzo era. Do not set it for other eras.
   *
   * @param extraEntropy The additional randomness.
   */
  setExtraEntropy(extraEntropy: HexBlob): void {
    this.#extraEntropy = extraEntropy;
    this.#originalBytes = undefined;
  }

  /**
   * Gets additional randomness used to seed the pseudo-random number generator for leader election.
   *
   * @returns The additional randomness, or undefined
   * if not set.
   */
  extraEntropy(): HexBlob | undefined {
    return this.#extraEntropy;
  }

  /**
   * Sets the proposed protocol version. It's a tuple two numbers: major and minor.
   *
   * @param protocolVersion the protocol version.
   */
  setProtocolVersion(protocolVersion: ProtocolVersion): void {
    this.#protocolVersion = protocolVersion;
    this.#originalBytes = undefined;
  }

  /**
   * Gets the proposed protocol version. It's a tuple two numbers: major and minor.
   *
   * @returns The protocol version, or undefined
   * if not set.
   */
  protocolVersion(): ProtocolVersion | undefined {
    return this.#protocolVersion;
  }

  /**
   * Sets the minimum operational cost for a stake pool per epoch, ensuring that
   * stake pools cannot advertise a cost that is too low.
   *
   * @param minPoolCost The minimum operational cost.
   */
  setMinPoolCost(minPoolCost: Cardano.Lovelace): void {
    this.#minPoolCost = minPoolCost;
    this.#originalBytes = undefined;
  }

  /**
   * Gets the minimum operational cost for a stake pool per epoch, ensuring that
   * stake pools cannot advertise a cost that is too low.
   *
   * @returns The minimum operational cost, or undefined
   * if not set.
   */
  minPoolCost(): Cardano.Lovelace | undefined {
    return this.#minPoolCost;
  }

  /**
   * Sets the cost in Lovelaces for storing one byte of data.
   *
   * @param adaPerUtxoByte The cost in Lovelaces for storing one byte of data.
   */
  setAdaPerUtxoByte(adaPerUtxoByte: Cardano.Lovelace): void {
    this.#adaPerUtxoByte = adaPerUtxoByte;
    this.#originalBytes = undefined;
  }

  /**
   * Gets the cost for storing one byte of data.
   *
   * @returns The cost  for storing one byte of data, or undefined
   * if not set.
   */
  adaPerUtxoByte(): Cardano.Lovelace | undefined {
    return this.#adaPerUtxoByte;
  }

  /**
   * Sets the cost models for Plutus scripts, defining the resources each
   * operation in a Plutus script consumes.
   *
   * @param costModels The cost models for Plutus scripts.
   */
  setCostModels(costModels: Costmdls): void {
    this.#costModels = costModels;
    this.#originalBytes = undefined;
  }

  /**
   * Gets the cost models for Plutus scripts, defining the resources each
   * operation in a Plutus script consumes.
   *
   * @returns The cost models for Plutus scripts, or undefined
   * if not set.
   */
  costModels(): Costmdls | undefined {
    return this.#costModels;
  }

  /**
   * Sets the prices for the ExUnits consumed by Plutus scripts.
   *
   * @param executionCosts The prices for the ExUnits.
   */
  setExecutionCosts(executionCosts: ExUnitPrices): void {
    this.#executionCosts = executionCosts;
    this.#originalBytes = undefined;
  }

  /**
   * Gets the prices for the ExUnits consumed by Plutus scripts.
   *
   * @returns The prices for the ExUnits, or undefined
   * if not set.
   */
  executionCosts(): ExUnitPrices | undefined {
    return this.#executionCosts;
  }

  /**
   * Sets the maximum ExUnits that a transaction can consume.
   *
   * @param maxTxExUnits The maximum ExUnits.
   */
  setMaxTxExUnits(maxTxExUnits: ExUnits): void {
    this.#maxTxExUnits = maxTxExUnits;
    this.#originalBytes = undefined;
  }

  /**
   * Gets the maximum ExUnits that a transaction can consume.
   *
   * @returns The maximum ExUnits, or undefined
   * if not set.
   */
  maxTxExUnits(): ExUnits | undefined {
    return this.#maxTxExUnits;
  }

  /**
   * Sets the maximum ExUnits that a block can consume.
   *
   * @param maxBlockExUnits The maximum ExUnits.
   */
  setMaxBlockExUnits(maxBlockExUnits: ExUnits): void {
    this.#maxBlockExUnits = maxBlockExUnits;
    this.#originalBytes = undefined;
  }

  /**
   * Gets the maximum ExUnits that a block can consume.
   *
   * @returns The maximum ExUnits, or undefined
   * if not set.
   */
  maxBlockExUnits(): ExUnits | undefined {
    return this.#maxBlockExUnits;
  }

  /**
   * Sets the maximum serialized length (in bytes) of a multi-asset value (token bundle)
   * in a transaction output.
   *
   * @param maxValueSize The maximum serialized length (in bytes).
   */
  setMaxValueSize(maxValueSize: number): void {
    this.#maxValueSize = maxValueSize;
    this.#originalBytes = undefined;
  }

  /**
   * Gets the maximum serialized length (in bytes) of a multi-asset value (token bundle)
   * in a transaction output.
   *
   * @returns The maximum serialized length (in bytes), or undefined
   * if not set.
   */
  maxValueSize(): number | undefined {
    return this.#maxValueSize;
  }

  /**
   * Sets the percentage of the total transaction fee its collateral must (at minimum) cover.
   *
   * @param collateralPercentage The percentage of the total transaction fee.
   */
  setCollateralPercentage(collateralPercentage: number): void {
    this.#collateralPercentage = collateralPercentage;
    this.#originalBytes = undefined;
  }

  /**
   * Gets the percentage of the total transaction fee its collateral must (at minimum) cover.
   *
   * @returns The percentage of the total transaction fee, or undefined
   * if not set.
   */
  collateralPercentage(): number | undefined {
    return this.#collateralPercentage;
  }

  /**
   * Sets the limit the total number of collateral inputs, and thus the total number of additional
   * signatures that must be checked during validation.
   *
   * @param maxCollateralInputs The max number of total collateral inputs allowed in a transaction.
   */
  setMaxCollateralInputs(maxCollateralInputs: number): void {
    this.#maxCollateralInputs = maxCollateralInputs;
    this.#originalBytes = undefined;
  }

  /**
   * Gets the limit the total number of collateral inputs, and thus the total number of additional
   * signatures that must be checked during validation.
   *
   * @returns The max number of total collateral inputs allowed in a transaction, or undefined
   * if not set.
   */
  maxCollateralInputs(): number | undefined {
    return this.#maxCollateralInputs;
  }

  // Conway

  /**
   * Sets the SPO vote thresholds which must be met as a percentage of the stake held by all stake pools to enact
   * the different governance actions that must be ratified by them.
   *
   * @param pooVotingThresholds The vote thresholds.
   */
  setPoolVotingThresholds(pooVotingThresholds: PoolVotingThresholds) {
    this.#poolVotingThresholds = pooVotingThresholds;
    this.#originalBytes = undefined;
  }

  /**
   * Gets the SPO vote thresholds which must be met as a percentage of the stake held by all stake pools to enact
   * the different governance actions that must be ratified by them.
   *
   * @returns The vote thresholds.
   */
  poolVotingThresholds(): PoolVotingThresholds | undefined {
    return this.#poolVotingThresholds;
  }

  /**
   * Sets the DRep vote thresholds that must be met as a percentage of active voting stake to enact
   * the different governance actions that must be ratified by them.
   *
   * @param drepVotingThresholds The vote thresholds.
   */
  setDrepVotingThresholds(drepVotingThresholds: DrepVotingThresholds) {
    this.#drepVotingThresholds = drepVotingThresholds;
    this.#originalBytes = undefined;
  }

  /**
   * Gets the DRep vote thresholds that must be met as a percentage of active voting stake to enact
   * the different governance actions that must be ratified by them.
   *
   * @returns The vote thresholds.
   */
  drepVotingThresholds(): DrepVotingThresholds | undefined {
    return this.#drepVotingThresholds;
  }

  /**
   * Unlike the Shelley governance design, the size of the constitutional committee is not fixed and can
   * be any non-negative number. It may be changed whenever a new committee is elected ("New constitutional committee and/or threshold").
   *
   * @param minCommitteeSize The minimal size of the committee.
   */
  setMinCommitteeSize(minCommitteeSize: number) {
    this.#minCommitteeSize = minCommitteeSize;
    this.#originalBytes = undefined;
  }

  /**
   * Gets the minimal size of the constitutional committee.
   *
   * @returns The minimal size of the committee.
   */
  minCommitteeSize(): number | undefined {
    return this.#minCommitteeSize;
  }

  /**
   * Sets the constitutional committee term limit. Per-member terms allow for a rotation scheme,
   * such as a third of the committee expiring every year. Expired members can no longer vote.
   * Member can also willingly resign early, which will be marked on-chain as an expired member.
   *
   * @param committeeTermLimit The maximum term limit.
   */
  setCommitteeTermLimit(committeeTermLimit: number) {
    this.#committeeTermLimit = committeeTermLimit;
    this.#originalBytes = undefined;
  }

  /**
   * Gets the constitutional committee term limit.
   *
   * @returns The constitutional committee term limit.
   */
  committeeTermLimit(): number | undefined {
    return this.#committeeTermLimit;
  }

  /**
   * Sets the governance action validity period. Governance actions must be ratified before a
   * specific epoch boundary or ir will expire.
   *
   * @param governanceActionValidityPeriod The governance action validity period.
   */
  setGovernanceActionValidityPeriod(governanceActionValidityPeriod: number) {
    this.#governanceActionValidityPeriod = governanceActionValidityPeriod;
    this.#originalBytes = undefined;
  }

  /**
   * Gets the governance action validity period. Governance actions must be ratified before a
   * specific epoch boundary or ir will expire.
   *
   * @returns The governance action validity period.
   */
  governanceActionValidityPeriod(): number | undefined {
    return this.#governanceActionValidityPeriod;
  }

  /**
   * Sets the governance action deposit amount.
   *
   * @param governanceActionDeposit The deposit amount.
   */
  setGovernanceActionDeposit(governanceActionDeposit: number) {
    this.#governanceActionDeposit = governanceActionDeposit;
    this.#originalBytes = undefined;
  }

  /**
   * Gets the governance action deposit amount.
   *
   * @returns The deposit amount.
   */
  governanceActionDeposit(): number | undefined {
    return this.#governanceActionDeposit;
  }

  /**
   * Sets the DRep deposit amount.
   *
   * @param drepDeposit The deposit amount.
   */
  setDrepDeposit(drepDeposit: number) {
    this.#drepDeposit = drepDeposit;
    this.#originalBytes = undefined;
  }

  /**
   * Gets the DRep deposit amount.
   *
   * @returns The deposit amount.
   */
  drepDeposit(): number | undefined {
    return this.#drepDeposit;
  }

  /**
   * Sets the DRep inactivity period. DReps need to vote regularly to still be considered active.
   * Specifically, if a DRep does not submit any votes for drepInactivityPeriod-many epochs, the DRep
   * is considered inactive. Inactive DReps do not count towards the active voting stake anymore. The reason
   * for marking DReps as inactive is so that DReps who stop participating but still have stake delegated
   * to them do not eventually leave the system in a state where no governance action can pass.
   *
   * @param drepInactivityPeriod the DRep inactivity period.
   */
  setDrepInactivityPeriod(drepInactivityPeriod: number) {
    this.#drepInactivityPeriod = drepInactivityPeriod;
    this.#originalBytes = undefined;
  }

  /**
   * Gets the DRep inactivity period.
   *
   * @returns the DRep inactivity period.
   */
  drepInactivityPeriod(): number | undefined {
    return this.#drepInactivityPeriod;
  }

  minFeeRefScriptCostPerByte(): UnitInterval | undefined {
    return this.#minFeeRefScriptCostPerByte;
  }

  // Dijkstra

  /**
   * Sets the maximum total size (in bytes) of reference scripts a block can use.
   *
   * @param maxRefScriptSizePerBlock The maximum reference script size per block, an unsigned 32 bit integer.
   */
  setMaxRefScriptSizePerBlock(maxRefScriptSizePerBlock: number): void {
    assertUint32('maxRefScriptSizePerBlock', maxRefScriptSizePerBlock);
    this.#maxRefScriptSizePerBlock = maxRefScriptSizePerBlock;
    this.#originalBytes = undefined;
  }

  /**
   * Gets the maximum total size (in bytes) of reference scripts a block can use.
   *
   * @returns The maximum reference script size per block, or undefined if not set.
   */
  maxRefScriptSizePerBlock(): number | undefined {
    return this.#maxRefScriptSizePerBlock;
  }

  /**
   * Sets the maximum total size (in bytes) of reference scripts a transaction can use,
   * enforced across a whole nested transaction batch.
   *
   * @param maxRefScriptSizePerTx The maximum reference script size per transaction, an unsigned 32 bit integer.
   */
  setMaxRefScriptSizePerTx(maxRefScriptSizePerTx: number): void {
    assertUint32('maxRefScriptSizePerTx', maxRefScriptSizePerTx);
    this.#maxRefScriptSizePerTx = maxRefScriptSizePerTx;
    this.#originalBytes = undefined;
  }

  /**
   * Gets the maximum total size (in bytes) of reference scripts a transaction can use.
   *
   * @returns The maximum reference script size per transaction, or undefined if not set.
   */
  maxRefScriptSizePerTx(): number | undefined {
    return this.#maxRefScriptSizePerTx;
  }

  /**
   * Sets the reference script cost stride, the byte increment at which the reference
   * script price steps up.
   *
   * @param refScriptCostStride The stride in bytes, an integer between 1 and 4294967295.
   */
  setRefScriptCostStride(refScriptCostStride: number): void {
    assertPositiveWord32('refScriptCostStride', refScriptCostStride);
    this.#refScriptCostStride = refScriptCostStride;
    this.#originalBytes = undefined;
  }

  /**
   * Gets the reference script cost stride.
   *
   * @returns The stride in bytes, or undefined if not set.
   */
  refScriptCostStride(): number | undefined {
    return this.#refScriptCostStride;
  }

  /**
   * Sets the reference script cost multiplier, the growth factor of the reference
   * script price per stride.
   *
   * @param refScriptCostMultiplier The multiplier as a positive interval (numerator and denominator >= 1).
   */
  setRefScriptCostMultiplier(refScriptCostMultiplier: UnitInterval): void {
    assertPositiveInterval('refScriptCostMultiplier', refScriptCostMultiplier);
    this.#refScriptCostMultiplier = refScriptCostMultiplier;
    this.#originalBytes = undefined;
  }

  /**
   * Gets the reference script cost multiplier.
   *
   * @returns The multiplier, or undefined if not set.
   */
  refScriptCostMultiplier(): UnitInterval | undefined {
    return this.#refScriptCostMultiplier;
  }

  /**
   * Sets the maximum pledge leverage, which limits the stake a pool is rewarded for relative to its pledge.
   *
   * @param maxPledgeLeverage The maximum pledge leverage as a non negative interval, or null for no leverage cap.
   */
  setMaxPledgeLeverage(maxPledgeLeverage: UnitInterval | null): void {
    this.#maxPledgeLeverage = maxPledgeLeverage;
    this.#originalBytes = undefined;
  }

  /**
   * Gets the maximum pledge leverage.
   *
   * @returns The maximum pledge leverage, null for no leverage cap, or undefined if not set.
   */
  maxPledgeLeverage(): UnitInterval | null | undefined {
    return this.#maxPledgeLeverage;
  }

  /**
   * Sets the minimum margin a stake pool can declare.
   *
   * @param minPoolMargin The minimum pool margin.
   */
  setMinPoolMargin(minPoolMargin: UnitInterval): void {
    this.#minPoolMargin = minPoolMargin;
    this.#originalBytes = undefined;
  }

  /**
   * Gets the minimum margin a stake pool can declare.
   *
   * @returns The minimum pool margin, or undefined if not set.
   */
  minPoolMargin(): UnitInterval | undefined {
    return this.#minPoolMargin;
  }

  /**
   * Sets the time announcement headers have to propagate through the network before Leios voting starts.
   *
   * @param leiosAnnouncementPeriodLength The period length in milliseconds, an unsigned 32 bit integer.
   */
  setLeiosAnnouncementPeriodLength(
    leiosAnnouncementPeriodLength: number,
  ): void {
    assertUint32(
      'leiosAnnouncementPeriodLength',
      leiosAnnouncementPeriodLength,
    );
    this.#leiosAnnouncementPeriodLength = leiosAnnouncementPeriodLength;
    this.#originalBytes = undefined;
  }

  /**
   * Gets the Leios announcement period length.
   *
   * @returns The period length in milliseconds, or undefined if not set.
   */
  leiosAnnouncementPeriodLength(): number | undefined {
    return this.#leiosAnnouncementPeriodLength;
  }

  /**
   * Sets the time committee members have to vote on a Leios endorser block.
   *
   * @param leiosVotePeriodLength The period length in milliseconds, an unsigned 32 bit integer.
   */
  setLeiosVotePeriodLength(leiosVotePeriodLength: number): void {
    assertUint32('leiosVotePeriodLength', leiosVotePeriodLength);
    this.#leiosVotePeriodLength = leiosVotePeriodLength;
    this.#originalBytes = undefined;
  }

  /**
   * Gets the Leios vote period length.
   *
   * @returns The period length in milliseconds, or undefined if not set.
   */
  leiosVotePeriodLength(): number | undefined {
    return this.#leiosVotePeriodLength;
  }

  /**
   * Sets the time a certified Leios endorser block has to reach the whole network after voting.
   *
   * @param leiosDiffusionPeriodLength The period length in milliseconds, an unsigned 32 bit integer.
   */
  setLeiosDiffusionPeriodLength(leiosDiffusionPeriodLength: number): void {
    assertUint32('leiosDiffusionPeriodLength', leiosDiffusionPeriodLength);
    this.#leiosDiffusionPeriodLength = leiosDiffusionPeriodLength;
    this.#originalBytes = undefined;
  }

  /**
   * Gets the Leios diffusion period length.
   *
   * @returns The period length in milliseconds, or undefined if not set.
   */
  leiosDiffusionPeriodLength(): number | undefined {
    return this.#leiosDiffusionPeriodLength;
  }

  /**
   * Sets the number of top stake pools seated on the Leios voting committee of an epoch.
   *
   * @param leiosCommitteeSize The committee size, an unsigned 16 bit integer.
   */
  setLeiosCommitteeSize(leiosCommitteeSize: number): void {
    assertUint16('leiosCommitteeSize', leiosCommitteeSize);
    this.#leiosCommitteeSize = leiosCommitteeSize;
    this.#originalBytes = undefined;
  }

  /**
   * Gets the Leios committee size.
   *
   * @returns The committee size, or undefined if not set.
   */
  leiosCommitteeSize(): number | undefined {
    return this.#leiosCommitteeSize;
  }

  /**
   * Sets the minimum fraction of active stake the votes of a Leios certificate must represent.
   *
   * @param leiosQuorumStakeThreshold The quorum stake threshold.
   */
  setLeiosQuorumStakeThreshold(leiosQuorumStakeThreshold: UnitInterval): void {
    this.#leiosQuorumStakeThreshold = leiosQuorumStakeThreshold;
    this.#originalBytes = undefined;
  }

  /**
   * Gets the Leios quorum stake threshold.
   *
   * @returns The quorum stake threshold, or undefined if not set.
   */
  leiosQuorumStakeThreshold(): UnitInterval | undefined {
    return this.#leiosQuorumStakeThreshold;
  }

  /**
   * Sets the maximum size (in bytes) of the transaction references of a Leios endorser block.
   *
   * @param maxEndorserBlockReferencesSize The maximum size in bytes, an unsigned 32 bit integer.
   */
  setMaxEndorserBlockReferencesSize(
    maxEndorserBlockReferencesSize: number,
  ): void {
    assertUint32(
      'maxEndorserBlockReferencesSize',
      maxEndorserBlockReferencesSize,
    );
    this.#maxEndorserBlockReferencesSize = maxEndorserBlockReferencesSize;
    this.#originalBytes = undefined;
  }

  /**
   * Gets the maximum size of the transaction references of a Leios endorser block.
   *
   * @returns The maximum size in bytes, or undefined if not set.
   */
  maxEndorserBlockReferencesSize(): number | undefined {
    return this.#maxEndorserBlockReferencesSize;
  }

  /**
   * Sets the maximum total size (in bytes) of the transactions endorsed by a Leios endorser block.
   *
   * @param maxEndorserBlockTxsSize The maximum size in bytes, an unsigned 32 bit integer.
   */
  setMaxEndorserBlockTxsSize(maxEndorserBlockTxsSize: number): void {
    assertUint32('maxEndorserBlockTxsSize', maxEndorserBlockTxsSize);
    this.#maxEndorserBlockTxsSize = maxEndorserBlockTxsSize;
    this.#originalBytes = undefined;
  }

  /**
   * Gets the maximum total size of the transactions endorsed by a Leios endorser block.
   *
   * @returns The maximum size in bytes, or undefined if not set.
   */
  maxEndorserBlockTxsSize(): number | undefined {
    return this.#maxEndorserBlockTxsSize;
  }

  /**
   * Sets the maximum ExUnits the scripts of a Leios endorser block can consume.
   *
   * @param maxEndorserBlockExUnits The maximum ExUnits.
   */
  setMaxEndorserBlockExUnits(maxEndorserBlockExUnits: ExUnits): void {
    this.#maxEndorserBlockExUnits = maxEndorserBlockExUnits;
    this.#originalBytes = undefined;
  }

  /**
   * Gets the maximum ExUnits the scripts of a Leios endorser block can consume.
   *
   * @returns The maximum ExUnits, or undefined if not set.
   */
  maxEndorserBlockExUnits(): ExUnits | undefined {
    return this.#maxEndorserBlockExUnits;
  }

  /**
   * Sets the maximum total size (in bytes) of reference scripts a Leios endorser block can use.
   *
   * @param maxRefScriptSizePerEndorserBlock The maximum size in bytes, an unsigned 32 bit integer.
   */
  setMaxRefScriptSizePerEndorserBlock(
    maxRefScriptSizePerEndorserBlock: number,
  ): void {
    assertUint32(
      'maxRefScriptSizePerEndorserBlock',
      maxRefScriptSizePerEndorserBlock,
    );
    this.#maxRefScriptSizePerEndorserBlock = maxRefScriptSizePerEndorserBlock;
    this.#originalBytes = undefined;
  }

  /**
   * Gets the maximum total size of reference scripts a Leios endorser block can use.
   *
   * @returns The maximum size in bytes, or undefined if not set.
   */
  maxRefScriptSizePerEndorserBlock(): number | undefined {
    return this.#maxRefScriptSizePerEndorserBlock;
  }

  /**
   * Sets the minimum age of a block to be eligible for voting in a Peras round.
   *
   * @param perasMinCandidateBlockAge The minimum age in slots, an unsigned 32 bit integer.
   */
  setPerasMinCandidateBlockAge(perasMinCandidateBlockAge: number): void {
    assertUint32('perasMinCandidateBlockAge', perasMinCandidateBlockAge);
    this.#perasMinCandidateBlockAge = perasMinCandidateBlockAge;
    this.#originalBytes = undefined;
  }

  /**
   * Gets the minimum age of a block to be eligible for voting in a Peras round.
   *
   * @returns The minimum age in slots, or undefined if not set.
   */
  perasMinCandidateBlockAge(): number | undefined {
    return this.#perasMinCandidateBlockAge;
  }

  /**
   * Sets the coefficient used to derive the length of a Peras cooldown period.
   *
   * @param perasHealingFactor The healing factor as a positive interval (numerator and denominator >= 1).
   */
  setPerasHealingFactor(perasHealingFactor: UnitInterval): void {
    assertPositiveInterval('perasHealingFactor', perasHealingFactor);
    this.#perasHealingFactor = perasHealingFactor;
    this.#originalBytes = undefined;
  }

  /**
   * Gets the Peras healing factor.
   *
   * @returns The healing factor, or undefined if not set.
   */
  perasHealingFactor(): UnitInterval | undefined {
    return this.#perasHealingFactor;
  }

  /**
   * Sets the extra chain weight a Peras certificate gives to the block it boosts.
   *
   * @param perasCertBoost The certificate boost, an unsigned 16 bit integer.
   */
  setPerasCertBoost(perasCertBoost: number): void {
    assertUint16('perasCertBoost', perasCertBoost);
    this.#perasCertBoost = perasCertBoost;
    this.#originalBytes = undefined;
  }

  /**
   * Gets the Peras certificate boost.
   *
   * @returns The certificate boost, or undefined if not set.
   */
  perasCertBoost(): number | undefined {
    return this.#perasCertBoost;
  }

  /**
   * Sets the target size of the Peras voting committee.
   *
   * @param perasTargetCommitteeSize The target committee size, an unsigned 16 bit integer.
   */
  setPerasTargetCommitteeSize(perasTargetCommitteeSize: number): void {
    assertUint16('perasTargetCommitteeSize', perasTargetCommitteeSize);
    this.#perasTargetCommitteeSize = perasTargetCommitteeSize;
    this.#originalBytes = undefined;
  }

  /**
   * Gets the target size of the Peras voting committee.
   *
   * @returns The target committee size, or undefined if not set.
   */
  perasTargetCommitteeSize(): number | undefined {
    return this.#perasTargetCommitteeSize;
  }

  /**
   * Sets the Peras round used to bootstrap voting.
   *
   * @param perasBootstrapRound The bootstrap round, an unsigned 32 bit integer, or null for no bootstrap round.
   */
  setPerasBootstrapRound(perasBootstrapRound: number | null): void {
    if (perasBootstrapRound !== null)
      assertUint32('perasBootstrapRound', perasBootstrapRound);
    this.#perasBootstrapRound = perasBootstrapRound;
    this.#originalBytes = undefined;
  }

  /**
   * Gets the Peras round used to bootstrap voting.
   *
   * @returns The bootstrap round, null for no bootstrap round, or undefined if not set.
   */
  perasBootstrapRound(): number | null | undefined {
    return this.#perasBootstrapRound;
  }

  /**
   * Sets the safety margin added on top of the 75% Peras quorum threshold.
   *
   * @param perasQuorumThresholdSafetyMargin The safety margin, between 0 and 0.25.
   */
  setPerasQuorumThresholdSafetyMargin(
    perasQuorumThresholdSafetyMargin: UnitInterval,
  ): void {
    this.#perasQuorumThresholdSafetyMargin = perasQuorumThresholdSafetyMargin;
    this.#originalBytes = undefined;
  }

  /**
   * Gets the safety margin added on top of the Peras quorum threshold.
   *
   * @returns The safety margin, or undefined if not set.
   */
  perasQuorumThresholdSafetyMargin(): UnitInterval | undefined {
    return this.#perasQuorumThresholdSafetyMargin;
  }

  /**
   * Sets the fee charged for every multi-asset policy in the values of the reference inputs of a transaction.
   *
   * @param refInputsCostPerMultiAssetPolicy The fee per policy in lovelace.
   */
  setRefInputsCostPerMultiAssetPolicy(
    refInputsCostPerMultiAssetPolicy: Cardano.Lovelace,
  ): void {
    this.#refInputsCostPerMultiAssetPolicy = refInputsCostPerMultiAssetPolicy;
    this.#originalBytes = undefined;
  }

  /**
   * Gets the fee charged for every multi-asset policy in the reference inputs of a transaction.
   *
   * @returns The fee per policy in lovelace, or undefined if not set.
   */
  refInputsCostPerMultiAssetPolicy(): Cardano.Lovelace | undefined {
    return this.#refInputsCostPerMultiAssetPolicy;
  }

  /**
   * Sets the fee charged per datum byte in the reference inputs of a transaction.
   *
   * @param refInputsCostPerDatumByte The fee per byte in lovelace.
   */
  setRefInputsCostPerDatumByte(
    refInputsCostPerDatumByte: Cardano.Lovelace,
  ): void {
    this.#refInputsCostPerDatumByte = refInputsCostPerDatumByte;
    this.#originalBytes = undefined;
  }

  /**
   * Gets the fee charged per datum byte in the reference inputs of a transaction.
   *
   * @returns The fee per byte in lovelace, or undefined if not set.
   */
  refInputsCostPerDatumByte(): Cardano.Lovelace | undefined {
    return this.#refInputsCostPerDatumByte;
  }

  /**
   * Gets the size of the serialized map.
   *
   * @private
   */
  #getMapSize(): number {
    let mapSize = 0;

    if (this.#minFeeA !== undefined) ++mapSize;
    if (this.#minFeeB !== undefined) ++mapSize;
    if (this.#maxBlockBodySize !== undefined) ++mapSize;
    if (this.#maxTxSize !== undefined) ++mapSize;
    if (this.#maxBlockHeaderSize !== undefined) ++mapSize;
    if (this.#keyDeposit !== undefined) ++mapSize;
    if (this.#poolDeposit !== undefined) ++mapSize;
    if (this.#maxEpoch !== undefined) ++mapSize;
    if (this.#nOpt !== undefined) ++mapSize;
    if (this.#poolPledgeInfluence !== undefined) ++mapSize;
    if (this.#expansionRate !== undefined) ++mapSize;
    if (this.#treasuryGrowthRate !== undefined) ++mapSize;
    if (this.#d !== undefined) ++mapSize;
    if (this.#extraEntropy !== undefined) ++mapSize;
    if (this.#protocolVersion !== undefined) ++mapSize;
    if (this.#minPoolCost !== undefined) ++mapSize;
    if (this.#adaPerUtxoByte !== undefined) ++mapSize;
    if (this.#costModels !== undefined) ++mapSize;
    if (this.#executionCosts !== undefined) ++mapSize;
    if (this.#maxTxExUnits !== undefined) ++mapSize;
    if (this.#maxBlockExUnits !== undefined) ++mapSize;
    if (this.#maxValueSize !== undefined) ++mapSize;
    if (this.#collateralPercentage !== undefined) ++mapSize;
    if (this.#maxCollateralInputs !== undefined) ++mapSize;
    if (this.#poolVotingThresholds !== undefined) ++mapSize;
    if (this.#drepVotingThresholds !== undefined) ++mapSize;
    if (this.#minCommitteeSize !== undefined) ++mapSize;
    if (this.#committeeTermLimit !== undefined) ++mapSize;
    if (this.#governanceActionValidityPeriod !== undefined) ++mapSize;
    if (this.#governanceActionDeposit !== undefined) ++mapSize;
    if (this.#drepDeposit !== undefined) ++mapSize;
    if (this.#drepInactivityPeriod !== undefined) ++mapSize;
    if (this.#minFeeRefScriptCostPerByte !== undefined) ++mapSize;
    if (this.#maxRefScriptSizePerBlock !== undefined) ++mapSize;
    if (this.#maxRefScriptSizePerTx !== undefined) ++mapSize;
    if (this.#refScriptCostStride !== undefined) ++mapSize;
    if (this.#refScriptCostMultiplier !== undefined) ++mapSize;
    if (this.#maxPledgeLeverage !== undefined) ++mapSize;
    if (this.#minPoolMargin !== undefined) ++mapSize;
    if (this.#leiosAnnouncementPeriodLength !== undefined) ++mapSize;
    if (this.#leiosVotePeriodLength !== undefined) ++mapSize;
    if (this.#leiosDiffusionPeriodLength !== undefined) ++mapSize;
    if (this.#leiosCommitteeSize !== undefined) ++mapSize;
    if (this.#leiosQuorumStakeThreshold !== undefined) ++mapSize;
    if (this.#maxEndorserBlockReferencesSize !== undefined) ++mapSize;
    if (this.#maxEndorserBlockTxsSize !== undefined) ++mapSize;
    if (this.#maxEndorserBlockExUnits !== undefined) ++mapSize;
    if (this.#maxRefScriptSizePerEndorserBlock !== undefined) ++mapSize;
    if (this.#perasMinCandidateBlockAge !== undefined) ++mapSize;
    if (this.#perasHealingFactor !== undefined) ++mapSize;
    if (this.#perasCertBoost !== undefined) ++mapSize;
    if (this.#perasTargetCommitteeSize !== undefined) ++mapSize;
    if (this.#perasBootstrapRound !== undefined) ++mapSize;
    if (this.#perasQuorumThresholdSafetyMargin !== undefined) ++mapSize;
    if (this.#refInputsCostPerMultiAssetPolicy !== undefined) ++mapSize;
    if (this.#refInputsCostPerDatumByte !== undefined) ++mapSize;

    return mapSize;
  }
}
