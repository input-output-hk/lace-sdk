import { HexBlob, InvalidArgumentError } from '@lace-lib/cardano-util';

import { ExUnits, UnitInterval } from '../../../src/Serialization/Common';
import { ProtocolParamUpdate } from '../../../src/Serialization/Update/ProtocolParamUpdate';

import type { Cardano } from '../../../src';

const MAX_WORD32 = 4_294_967_295;
const MAX_WORD16 = 65_535;

const dijkstraCbor = HexBlob(
  'a60018641821d81e8218590218221a004c4b4018231a000f424018241964001825d81e820302',
);

const subsetCbor = HexBlob('a218221a004c4b401825d81e820302');

const maxWord32Cbor = HexBlob('a318221affffffff18231affffffff18241affffffff');

const dijkstraCore: Cardano.ProtocolParametersUpdate = {
  maxRefScriptSizePerBlock: 5_000_000,
  maxRefScriptSizePerTx: 1_000_000,
  minFeeCoefficient: 100,
  minFeeRefScriptCostPerByte: '44.5',
  refScriptCostMultiplier: '1.5',
  refScriptCostStride: 25_600,
};

const subsetCore: Cardano.ProtocolParametersUpdate = {
  maxRefScriptSizePerBlock: 5_000_000,
  refScriptCostMultiplier: '1.5',
};

describe('ProtocolParamUpdate Dijkstra params', () => {
  it('can decode keys 34-37 from CBOR', () => {
    const params = ProtocolParamUpdate.fromCbor(dijkstraCbor);

    expect(params.minFeeA()).toEqual(100n);
    expect(params.minFeeRefScriptCostPerByte()?.toFloat()).toEqual(44.5);
    expect(params.maxRefScriptSizePerBlock()).toEqual(5_000_000);
    expect(params.maxRefScriptSizePerTx()).toEqual(1_000_000);
    expect(params.refScriptCostStride()).toEqual(25_600);
    expect(params.refScriptCostMultiplier()?.toFloat()).toEqual(1.5);
  });

  it('round trips CBOR with all four new keys byte-exact', () => {
    expect(ProtocolParamUpdate.fromCbor(dijkstraCbor).toCbor()).toEqual(
      dijkstraCbor,
    );
    expect(ProtocolParamUpdate.fromCore(dijkstraCore).toCbor()).toEqual(
      dijkstraCbor,
    );
  });

  it('round trips CBOR with only a subset of the new keys byte-exact', () => {
    const params = ProtocolParamUpdate.fromCbor(subsetCbor);

    expect(params.maxRefScriptSizePerBlock()).toEqual(5_000_000);
    expect(params.maxRefScriptSizePerTx()).toBeUndefined();
    expect(params.refScriptCostStride()).toBeUndefined();
    expect(params.refScriptCostMultiplier()?.toFloat()).toEqual(1.5);
    expect(params.toCbor()).toEqual(subsetCbor);
    expect(ProtocolParamUpdate.fromCore(subsetCore).toCbor()).toEqual(
      subsetCbor,
    );
  });

  it('omits keys 34-37 when the fields are not set', () => {
    expect(
      ProtocolParamUpdate.fromCore({ minFeeCoefficient: 100 }).toCbor(),
    ).toEqual(HexBlob('a1001864'));
  });

  it('converts to core with the new fields', () => {
    expect(ProtocolParamUpdate.fromCbor(dijkstraCbor).toCore()).toEqual(
      dijkstraCore,
    );
  });

  it('is symmetric between toCore and fromCore', () => {
    expect(ProtocolParamUpdate.fromCore(dijkstraCore).toCore()).toEqual(
      dijkstraCore,
    );
    expect(ProtocolParamUpdate.fromCore(subsetCore).toCore()).toEqual(
      subsetCore,
    );
  });

  it('can set and encode the new fields at the uint32 upper bound', () => {
    const params = new ProtocolParamUpdate();

    params.setMaxRefScriptSizePerBlock(MAX_WORD32);
    params.setMaxRefScriptSizePerTx(MAX_WORD32);
    params.setRefScriptCostStride(MAX_WORD32);

    expect(params.maxRefScriptSizePerBlock()).toEqual(MAX_WORD32);
    expect(params.maxRefScriptSizePerTx()).toEqual(MAX_WORD32);
    expect(params.refScriptCostStride()).toEqual(MAX_WORD32);
    expect(params.toCbor()).toEqual(maxWord32Cbor);
  });

  it('can set the multiplier through the setter', () => {
    const params = new ProtocolParamUpdate();

    params.setRefScriptCostMultiplier(new UnitInterval(3n, 2n));

    expect(params.refScriptCostMultiplier()?.toFloat()).toEqual(1.5);
    expect(params.toCbor()).toEqual(HexBlob('a11825d81e820302'));
  });

  it('rejects values greater than the uint32 upper bound', () => {
    const params = new ProtocolParamUpdate();

    expect(() => params.setMaxRefScriptSizePerBlock(MAX_WORD32 + 1)).toThrow(
      InvalidArgumentError,
    );
    expect(() => params.setMaxRefScriptSizePerTx(MAX_WORD32 + 1)).toThrow(
      InvalidArgumentError,
    );
    expect(() => params.setRefScriptCostStride(MAX_WORD32 + 1)).toThrow(
      InvalidArgumentError,
    );
  });

  it('rejects a zero cost stride', () => {
    const params = new ProtocolParamUpdate();

    expect(() => params.setRefScriptCostStride(0)).toThrow(
      InvalidArgumentError,
    );
  });

  it('rejects a non positive cost multiplier', () => {
    const params = new ProtocolParamUpdate();

    expect(() =>
      params.setRefScriptCostMultiplier(new UnitInterval(0n, 2n)),
    ).toThrow(InvalidArgumentError);
  });

  it('rejects out of range values when encoding fields set through fromCore', () => {
    expect(() =>
      ProtocolParamUpdate.fromCore({ refScriptCostStride: 0 }).toCbor(),
    ).toThrow(InvalidArgumentError);
    expect(() =>
      ProtocolParamUpdate.fromCore({
        maxRefScriptSizePerBlock: MAX_WORD32 + 1,
      }).toCbor(),
    ).toThrow(InvalidArgumentError);
    expect(() =>
      ProtocolParamUpdate.fromCore({
        maxRefScriptSizePerTx: MAX_WORD32 + 1,
      }).toCbor(),
    ).toThrow(InvalidArgumentError);
    expect(() =>
      ProtocolParamUpdate.fromCore({
        refScriptCostStride: MAX_WORD32 + 1,
      }).toCbor(),
    ).toThrow(InvalidArgumentError);
  });
});

/**
 * Leios, Peras and reference input parameter update vectors, constructed and validated against
 * cardano-ledger 9b81d9943ce79b8531e9d8e2c5f9adcb158677cb dijkstra.cddl.
 */
const leiosCbor = HexBlob(
  'ab1826d81e8203021827d81e82011418281903e818291907d0182a190bb8182b1901f4182cd81e820305182d1a00010000182e1a000186a0182f821a00d59f801b00000002540be40018301a00032000',
);

const leiosNoLeverageCapCbor = HexBlob(
  'ab1826f61827d81e82011418281903e818291907d0182a190bb8182b1901f4182cd81e820305182d1a00010000182e1a000186a0182f821a00d59f801b00000002540be40018301a00032000',
);

const perasCbor = HexBlob(
  'a81831181e1832d81e82050218330f18341902581835071836d81e82010a18371903e81838182c',
);

const perasNoBootstrapRoundCbor = HexBlob(
  'a81831181e1832d81e82050218330f18341902581835f61836d81e82010a18371903e81838182c',
);

const leiosCore: Cardano.ProtocolParametersUpdate = {
  leiosAnnouncementPeriodLength: 1000,
  leiosCommitteeSize: 500,
  leiosDiffusionPeriodLength: 3000,
  leiosQuorumStakeThreshold: '0.6',
  leiosVotePeriodLength: 2000,
  maxEndorserBlockExecutionUnits: { memory: 14_000_000, steps: 10_000_000_000 },
  maxEndorserBlockReferencesSize: 65_536,
  maxEndorserBlockTxsSize: 100_000,
  maxPledgeLeverage: '1.5',
  maxRefScriptSizePerEndorserBlock: 204_800,
  minPoolMargin: '0.05',
};

const perasCore: Cardano.ProtocolParametersUpdate = {
  perasBootstrapRound: 7,
  perasCertBoost: 15,
  perasHealingFactor: '2.5',
  perasMinCandidateBlockAge: 30,
  perasQuorumThresholdSafetyMargin: '0.1',
  perasTargetCommitteeSize: 600,
  refInputsCostPerDatumByte: 44,
  refInputsCostPerMultiAssetPolicy: 1000,
};

describe('ProtocolParamUpdate Leios, Peras and reference input params', () => {
  it.each([
    ['Leios parameters', leiosCbor],
    ['Leios parameters with no leverage cap', leiosNoLeverageCapCbor],
    ['Peras and reference input parameters', perasCbor],
    ['Peras parameters with no bootstrap round', perasNoBootstrapRoundCbor],
    ['a Leios announcement period length', HexBlob('a118281903e8')],
    ['a Peras minimum candidate block age', HexBlob('a11831181e')],
    ['a Peras bootstrap round', HexBlob('a1183507')],
  ])('re-encodes an update with %s byte for byte', (_, cbor) => {
    const params = ProtocolParamUpdate.fromCbor(cbor);

    expect(params.toCbor()).toEqual(cbor);
    expect(ProtocolParamUpdate.fromCore(params.toCore()).toCbor()).toEqual(
      cbor,
    );
  });

  it('decodes the Leios parameters', () => {
    const params = ProtocolParamUpdate.fromCbor(leiosCbor);

    expect(params.maxPledgeLeverage()?.toCbor()).toEqual('d81e820302');
    expect(params.minPoolMargin()?.toCbor()).toEqual('d81e820114');
    expect(params.leiosAnnouncementPeriodLength()).toEqual(1000);
    expect(params.leiosVotePeriodLength()).toEqual(2000);
    expect(params.leiosDiffusionPeriodLength()).toEqual(3000);
    expect(params.leiosCommitteeSize()).toEqual(500);
    expect(params.leiosQuorumStakeThreshold()?.toCbor()).toEqual('d81e820305');
    expect(params.maxEndorserBlockReferencesSize()).toEqual(65_536);
    expect(params.maxEndorserBlockTxsSize()).toEqual(100_000);
    expect(params.maxEndorserBlockExUnits()?.toCore()).toEqual({
      memory: 14_000_000,
      steps: 10_000_000_000,
    });
    expect(params.maxRefScriptSizePerEndorserBlock()).toEqual(204_800);
    expect(params.toCore()).toEqual(leiosCore);
  });

  it('decodes the Peras and reference input parameters', () => {
    const params = ProtocolParamUpdate.fromCbor(perasCbor);

    expect(params.perasMinCandidateBlockAge()).toEqual(30);
    expect(params.perasHealingFactor()?.toCbor()).toEqual('d81e820502');
    expect(params.perasCertBoost()).toEqual(15);
    expect(params.perasTargetCommitteeSize()).toEqual(600);
    expect(params.perasBootstrapRound()).toEqual(7);
    expect(params.perasQuorumThresholdSafetyMargin()?.toCbor()).toEqual(
      'd81e82010a',
    );
    expect(params.refInputsCostPerMultiAssetPolicy()).toEqual(1000n);
    expect(params.refInputsCostPerDatumByte()).toEqual(44n);
    expect(params.toCore()).toEqual(perasCore);
  });

  it('encodes the new parameters from their core form', () => {
    expect(ProtocolParamUpdate.fromCore(leiosCore).toCbor()).toEqual(leiosCbor);
    expect(ProtocolParamUpdate.fromCore(perasCore).toCbor()).toEqual(perasCbor);
  });

  it('round trips every new parameter built in code', () => {
    const params = new ProtocolParamUpdate();

    params.setMaxPledgeLeverage(new UnitInterval(3n, 2n));
    params.setMinPoolMargin(new UnitInterval(1n, 20n));
    params.setLeiosAnnouncementPeriodLength(1000);
    params.setLeiosVotePeriodLength(2000);
    params.setLeiosDiffusionPeriodLength(3000);
    params.setLeiosCommitteeSize(500);
    params.setLeiosQuorumStakeThreshold(new UnitInterval(3n, 5n));
    params.setMaxEndorserBlockReferencesSize(65_536);
    params.setMaxEndorserBlockTxsSize(100_000);
    params.setMaxEndorserBlockExUnits(
      new ExUnits(14_000_000n, 10_000_000_000n),
    );
    params.setMaxRefScriptSizePerEndorserBlock(204_800);
    params.setPerasMinCandidateBlockAge(30);
    params.setPerasHealingFactor(new UnitInterval(5n, 2n));
    params.setPerasCertBoost(15);
    params.setPerasTargetCommitteeSize(600);
    params.setPerasBootstrapRound(7);
    params.setPerasQuorumThresholdSafetyMargin(new UnitInterval(1n, 10n));
    params.setRefInputsCostPerMultiAssetPolicy(1000n);
    params.setRefInputsCostPerDatumByte(44n);

    const decoded = ProtocolParamUpdate.fromCbor(params.toCbor());

    expect(decoded.toCbor()).toEqual(params.toCbor());
    expect(decoded.toCore()).toEqual({ ...leiosCore, ...perasCore });
  });

  it('writes no leverage cap as nil and keeps it apart from a missing one', () => {
    const params = new ProtocolParamUpdate();

    params.setMaxPledgeLeverage(null);

    expect(params.maxPledgeLeverage()).toBeNull();
    expect(params.toCbor()).toEqual(HexBlob('a11826f6'));
    expect(ProtocolParamUpdate.fromCbor(HexBlob('a11826f6')).toCore()).toEqual({
      maxPledgeLeverage: null,
    });
    expect(
      ProtocolParamUpdate.fromCore({ maxPledgeLeverage: null }).toCbor(),
    ).toEqual(HexBlob('a11826f6'));
    expect(
      ProtocolParamUpdate.fromCbor(HexBlob('a0')).maxPledgeLeverage(),
    ).toBeUndefined();
    expect(ProtocolParamUpdate.fromCore({}).toCbor()).toEqual(HexBlob('a0'));
  });

  it('writes no Peras bootstrap round as nil and keeps it apart from a missing one', () => {
    const params = new ProtocolParamUpdate();

    params.setPerasBootstrapRound(null);

    expect(params.perasBootstrapRound()).toBeNull();
    expect(params.toCbor()).toEqual(HexBlob('a11835f6'));
    expect(ProtocolParamUpdate.fromCbor(HexBlob('a11835f6')).toCore()).toEqual({
      perasBootstrapRound: null,
    });
    expect(
      ProtocolParamUpdate.fromCore({ perasBootstrapRound: null }).toCbor(),
    ).toEqual(HexBlob('a11835f6'));
    expect(
      ProtocolParamUpdate.fromCbor(HexBlob('a0')).perasBootstrapRound(),
    ).toBeUndefined();
  });

  it('skips the value of an unknown key and keeps decoding the next keys', () => {
    const cbor = HexBlob('a318638201a102030018641839d81e820102');
    const params = ProtocolParamUpdate.fromCbor(cbor);

    expect(params.minFeeA()).toEqual(100n);
    expect(params.toCbor()).toEqual(cbor);
    expect(params.toCore()).toEqual({ minFeeCoefficient: 100 });
  });

  it('rejects values outside the range of the new integer parameters', () => {
    const params = new ProtocolParamUpdate();

    expect(() =>
      params.setLeiosAnnouncementPeriodLength(MAX_WORD32 + 1),
    ).toThrow(InvalidArgumentError);
    expect(() => params.setLeiosVotePeriodLength(MAX_WORD32 + 1)).toThrow(
      InvalidArgumentError,
    );
    expect(() => params.setLeiosDiffusionPeriodLength(MAX_WORD32 + 1)).toThrow(
      InvalidArgumentError,
    );
    expect(() => params.setLeiosCommitteeSize(MAX_WORD16 + 1)).toThrow(
      InvalidArgumentError,
    );
    expect(() =>
      params.setMaxEndorserBlockReferencesSize(MAX_WORD32 + 1),
    ).toThrow(InvalidArgumentError);
    expect(() => params.setMaxEndorserBlockTxsSize(MAX_WORD32 + 1)).toThrow(
      InvalidArgumentError,
    );
    expect(() =>
      params.setMaxRefScriptSizePerEndorserBlock(MAX_WORD32 + 1),
    ).toThrow(InvalidArgumentError);
    expect(() => params.setPerasMinCandidateBlockAge(MAX_WORD32 + 1)).toThrow(
      InvalidArgumentError,
    );
    expect(() => params.setPerasCertBoost(MAX_WORD16 + 1)).toThrow(
      InvalidArgumentError,
    );
    expect(() => params.setPerasTargetCommitteeSize(MAX_WORD16 + 1)).toThrow(
      InvalidArgumentError,
    );
    expect(() => params.setPerasBootstrapRound(MAX_WORD32 + 1)).toThrow(
      InvalidArgumentError,
    );
  });

  it.each([
    ['a max reference script size per block', 'a118221b0000000100000000'],
    ['a max reference script size per transaction', 'a118231b0000000100000000'],
    ['a reference script cost stride', 'a118241b0000000100000000'],
    ['a zero reference script cost stride', 'a1182400'],
    ['a zero reference script cost multiplier', 'a11825d81e820001'],
    ['a Leios announcement period length', 'a118281b0000000100000000'],
    ['a Leios vote period length', 'a118291b0000000100000000'],
    ['a Leios diffusion period length', 'a1182a1b0000000100000000'],
    ['a Leios committee size', 'a1182b1a00010000'],
    ['a max endorser block references size', 'a1182d1b0000000100000000'],
    ['a max endorser block transactions size', 'a1182e1b0000000100000000'],
    [
      'a max reference script size per endorser block',
      'a118301b0000000100000000',
    ],
    ['a Peras minimum candidate block age', 'a118311b0000000100000000'],
    ['a zero Peras healing factor', 'a11832d81e820001'],
    ['a Peras certificate boost', 'a118331a00010000'],
    ['a Peras target committee size', 'a118341a00010000'],
    ['a Peras bootstrap round', 'a118351b0000000100000000'],
  ])('rejects %s out of its range when decoding', (_, cbor) => {
    expect(() => ProtocolParamUpdate.fromCbor(HexBlob(cbor))).toThrow(
      InvalidArgumentError,
    );
  });

  it('decodes every new integer parameter at its upper bound byte for byte', () => {
    const cbor = HexBlob(
      'ae18221affffffff18231affffffff18241affffffff18281affffffff18291affffffff182a1affffffff182b19ffff182d1affffffff182e1affffffff18301affffffff18311affffffff183319ffff183419ffff18351affffffff',
    );
    const params = ProtocolParamUpdate.fromCbor(cbor);

    expect(params.leiosCommitteeSize()).toEqual(MAX_WORD16);
    expect(params.perasBootstrapRound()).toEqual(MAX_WORD32);
    expect(params.toCbor()).toEqual(cbor);
    expect(ProtocolParamUpdate.fromCore(params.toCore()).toCbor()).toEqual(
      cbor,
    );
  });

  it('rejects a non positive Peras healing factor', () => {
    const params = new ProtocolParamUpdate();

    expect(() =>
      params.setPerasHealingFactor(new UnitInterval(0n, 2n)),
    ).toThrow(InvalidArgumentError);
    expect(() =>
      ProtocolParamUpdate.fromCore({ perasHealingFactor: '0' }).toCbor(),
    ).toThrow(InvalidArgumentError);
  });

  it('rejects out of range values when encoding new fields set through fromCore', () => {
    expect(() =>
      ProtocolParamUpdate.fromCore({
        leiosCommitteeSize: MAX_WORD16 + 1,
      }).toCbor(),
    ).toThrow(InvalidArgumentError);
    expect(() =>
      ProtocolParamUpdate.fromCore({
        perasBootstrapRound: MAX_WORD32 + 1,
      }).toCbor(),
    ).toThrow(InvalidArgumentError);
  });
});
