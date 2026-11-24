import { eval_phase_two_raw } from '@blaze-cardano/uplc/wasm';
import { Cardano, Serialization } from '@lace-lib/cardano-core';
import { SLOT_CONFIG_NETWORK } from '@lace-lib/cardano-tx-builder';
import { HexBlob } from '@lace-lib/cardano-util';

import type { RequiredProtocolParameters } from '@lace-contract/cardano-context';
import type { TxEvaluator } from '@lace-lib/cardano-tx-builder';

/** Plutus V3 cost model of Preprod at protocol version 11, as Blockfrost lists it. */
export const PLUTUS_V3_COST_MODEL = [
  100788, 420, 1, 1, 1000, 173, 0, 1, 1000, 59957, 4, 1, 11183, 32, 201305,
  8356, 4, 16000, 100, 16000, 100, 16000, 100, 16000, 100, 16000, 100, 16000,
  100, 100, 100, 16000, 100, 94375, 32, 132994, 32, 61462, 4, 72010, 178, 0, 1,
  22151, 32, 91189, 769, 4, 2, 85848, 123203, 7305, -900, 1716, 960, 57, 85848,
  0, 1, 1, 1000, 42921, 4, 2, 30623, 28755, 75, 1, 898148, 27279, 1, 51775, 558,
  1, 39184, 1000, 60594, 1, 141895, 32, 83150, 32, 15299, 32, 76049, 1, 13169,
  4, 22100, 10, 28999, 74, 1, 28999, 74, 1, 43285, 552, 1, 44749, 541, 1, 33852,
  32, 68246, 32, 72362, 32, 7243, 32, 7391, 32, 11546, 32, 85848, 123203, 7305,
  -900, 1716, 960, 57, 85848, 0, 1, 90434, 519, 0, 1, 74433, 32, 85848, 123203,
  7305, -900, 1716, 960, 57, 85848, 0, 1, 1, 85848, 123203, 7305, -900, 1716,
  960, 57, 85848, 0, 1, 955506, 213312, 0, 2, 270652, 22588, 4, 1457325, 64566,
  4, 20467, 1, 4, 0, 141992, 32, 100788, 420, 1, 1, 81663, 32, 59498, 32, 20142,
  32, 24588, 32, 20744, 32, 25933, 32, 24623, 32, 43053543, 10, 53384111, 14333,
  10, 43574283, 26308, 10, 16000, 100, 16000, 100, 962335, 18, 2780678, 6,
  442008, 1, 52538055, 3756, 18, 267929, 18, 76433006, 8868, 18, 52948122, 18,
  1995836, 36, 3227919, 12, 901022, 1, 166917843, 4307, 36, 284546, 36,
  158221314, 26549, 36, 74698472, 36, 333849714, 1, 254006273, 72, 2174038, 72,
  2261318, 64571, 4, 207616, 8310, 4, 1293828, 28716, 63, 0, 1, 1006041, 43623,
  251, 0, 1, 100181, 726, 719, 0, 1, 100181, 726, 719, 0, 1, 100181, 726, 719,
  0, 1, 107878, 680, 0, 1, 95336, 1, 281145, 18848, 0, 1, 180194, 159, 1, 1,
  158519, 8942, 0, 1, 159378, 8813, 0, 1, 107490, 3298, 1, 106057, 655, 1,
  1964219, 24520, 3, 607153, 231697, 53144, 0, 1, 116711, 1957, 4, 231883, 10,
  1000, 24838, 7, 1, 232010, 32, 321837444, 25087669, 18, 617887431, 67302824,
  36, 356924, 18413, 45, 21, 219951, 9444, 1, 1000, 172116, 183150, 6, 24, 21,
  213283, 618401, 1998, 28258, 1, 1000, 38159, 2, 22, 1000, 95933, 1, 1, 11,
  1000, 277577, 12, 21,
];

export const PREPROD = Cardano.NetworkMagics.Preprod;
export const SLOT_CONFIG = SLOT_CONFIG_NETWORK[PREPROD]!;
const MAX_STEPS = 10_000_000_000n;
const MAX_MEMORY = 16_500_000n;

export const protocolParameters = {
  minFeeCoefficient: 44,
  minFeeConstant: 155_381,
  prices: { memory: 0.0577, steps: 0.000_072_1 },
  coinsPerUtxoByte: 4310,
  poolDeposit: 500_000_000,
  stakeKeyDeposit: 2_000_000,
  maxTxSize: 16_384,
  maxValueSize: 5000,
  collateralPercentage: 150,
  maxCollateralInputs: 3,
  minFeeRefScriptCostPerByte: 15,
} as unknown as RequiredProtocolParameters;

export const costModels: Cardano.CostModels = new Map([
  [Cardano.PlutusLanguageVersion.V3, PLUTUS_V3_COST_MODEL],
]);

const toBytes = (hex: string): Uint8Array =>
  Uint8Array.from(Buffer.from(hex, 'hex'));

/**
 * Runs the transaction's scripts with Aiken's UPLC machine, which builds the
 * script context from the transaction as the ledger does.
 *
 * @throws When a script fails, with its traces.
 */
export const runScripts = (
  serializedTx: string,
  resolvedInputs: readonly Cardano.Utxo[],
) =>
  eval_phase_two_raw(
    toBytes(serializedTx),
    resolvedInputs.map(([txIn]) =>
      toBytes(Serialization.TransactionInput.fromCore(txIn).toCbor()),
    ),
    resolvedInputs.map(([, txOut]) =>
      toBytes(Serialization.TransactionOutput.fromCore(txOut).toCbor()),
    ),
    toBytes(Serialization.Costmdls.fromCore(costModels).toCbor()),
    MAX_STEPS,
    MAX_MEMORY,
    BigInt(SLOT_CONFIG.zeroTime),
    BigInt(SLOT_CONFIG.zeroSlot),
    SLOT_CONFIG.slotLength,
  ).map(({ redeemer }) =>
    Serialization.Redeemer.fromCbor(
      HexBlob(Buffer.from(redeemer).toString('hex')),
    ).toCore(),
  );

/** Measures each redeemer with the real validator, failing as the node would. */
export const uplcEvaluator: TxEvaluator = {
  evaluate: async (_tx, resolvedInputs, serializedTx) =>
    runScripts(serializedTx!.toCbor(), resolvedInputs).map(
      ({ purpose, index, executionUnits }) => ({
        purpose,
        index,
        budget: executionUnits,
      }),
    ),
};

const constr = (
  alternative: bigint,
  ...fields: Serialization.PlutusData[]
): Serialization.PlutusData => {
  const list = new Serialization.PlutusList();
  for (const field of fields) list.add(field);
  return Serialization.PlutusData.newConstrPlutusData(
    new Serialization.ConstrPlutusData(alternative, list),
  );
};

const bytes = (hex: string) => Serialization.PlutusData.newBytes(toBytes(hex));

const integer = (value: bigint) => Serialization.PlutusData.newInteger(value);

const map = (entries: [string, Serialization.PlutusData][]) => {
  const plutusMap = new Serialization.PlutusMap();
  for (const [key, value] of entries) plutusMap.insert(bytes(key), value);
  return Serialization.PlutusData.newMap(plutusMap);
};

const credential = ({ type, hash }: Cardano.Credential) =>
  constr(type === Cardano.CredentialType.KeyHash ? 0n : 1n, bytes(hash));

const byKey = <T>([a]: [string, T], [b]: [string, T]) =>
  a < b ? -1 : a > b ? 1 : 0;

/**
 * The ledger API `TxOut` a Plutus V3 script sees for an output to a base or
 * enterprise address, with tokens and a datum hash or an inline datum.
 */
export const plutusTxOutOf = ({
  address,
  value,
  datumHash,
  datum,
}: Cardano.TxOut): Serialization.PlutusData => {
  const { paymentPart, delegationPart } =
    Cardano.Address.fromBech32(address).getProps();
  const staking = delegationPart
    ? constr(0n, constr(0n, credential(delegationPart)))
    : constr(1n);
  const policies = new Map<string, [string, Serialization.PlutusData][]>();
  for (const [assetId, quantity] of value.assets ?? []) {
    const policyId = Cardano.AssetId.getPolicyId(assetId);
    policies.set(policyId, [
      ...(policies.get(policyId) ?? []),
      [Cardano.AssetId.getAssetName(assetId), integer(quantity)],
    ]);
  }
  const outputDatum = datum
    ? constr(2n, Serialization.PlutusData.fromCore(datum))
    : datumHash
    ? constr(1n, bytes(datumHash))
    : constr(0n);
  return constr(
    0n,
    constr(0n, credential(paymentPart!), staking),
    map([
      ['', map([['', integer(value.coins)]])],
      ...[...policies]
        .sort(byKey)
        .map(([policyId, tokens]): [string, Serialization.PlutusData] => [
          policyId,
          map(tokens.sort(byKey)),
        ]),
    ]),
    outputDatum,
    constr(1n),
  );
};

/** Deposit validator address of Hydra 2.2.0 and 2.3.0 on Preprod. */
export const DEPOSIT_ADDRESS = Cardano.PaymentAddress(
  'addr_test1wrrcaryjq4epavl0gsg08kuuv95l5md5jlpyvswjnss998qyu7lhm',
);

/**
 * A deposit UTxO committing `outputs`, its datum written as a Hydra node
 * writes it, each commit spending an output of one funding transaction.
 */
export const depositCommitting = ({
  txId,
  deadline,
  outputs,
}: {
  txId: string;
  deadline: number;
  outputs: readonly Cardano.TxOut[];
}): Cardano.Utxo => {
  const datum = constr(
    0n,
    bytes('324c8b8198c4c9db7526d6dccb79e992c4863b24b56453bb16995bdc'),
    integer(BigInt(deadline)),
    Serialization.PlutusData.newList(
      outputs.reduce((list, output, index) => {
        list.add(
          constr(
            0n,
            constr(0n, bytes('cc'.repeat(32)), integer(BigInt(index))),
            bytes(plutusTxOutOf(output).toCbor()),
          ),
        );
        return list;
      }, new Serialization.PlutusList()),
    ),
  );
  const assets = new Map<Cardano.AssetId, bigint>();
  for (const output of outputs) {
    for (const [assetId, quantity] of output.value.assets ?? []) {
      assets.set(assetId, (assets.get(assetId) ?? 0n) + quantity);
    }
  }
  const coins = outputs.reduce((sum, output) => sum + output.value.coins, 0n);
  return [
    { txId: Cardano.TransactionId(txId), index: 0, address: DEPOSIT_ADDRESS },
    {
      address: DEPOSIT_ADDRESS,
      value: { coins, ...(assets.size > 0 && { assets }) },
      datum: datum.toCore(),
    },
  ];
};
