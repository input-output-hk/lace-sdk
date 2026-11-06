import { Cardano, Serialization } from '@lace-lib/cardano-core';
import { HexBlob } from '@lace-lib/cardano-util';

/** A UTxO as recorded from the Preprod Blockfrost API. */
type RecordedUtxo = {
  tx_hash: string;
  output_index: number;
  address: string;
  amount: { unit: string; quantity: string }[];
  inline_datum?: string;
};

/**
 * UTxOs at the Hydra 2.3.0 validators, recorded from the Preprod Blockfrost
 * API and reduced to the fields the index reads.
 */
export const preprodHydraUtxos = {
  /** Deposit of 4.626931 ada into head 324c8b81 by a key credential, Hydra 2.3.0. */
  depositV2: {
    tx_hash: 'c1a8300f3d89c7feca5a91561329d205574170d5886e7bfb384558b5b89759a7',
    output_index: 0,
    address: 'addr_test1wrrcaryjq4epavl0gsg08kuuv95l5md5jlpyvswjnss998qyu7lhm',
    amount: [{ unit: 'lovelace', quantity: '4626931' }],
    inline_datum:
      'd8799f581c324c8b8198c4c9db7526d6dccb79e992c4863b24b56453bb16995bdc1b000001a05d17b3df9fd8799fd8799f5820e2f094efbbf8e363b9d02c7b5c61f89abdd6b839161d3a01638a882356ef96b101ff5f5840d8799fd8799fd8799f581cba1e067abfb07ecd833cec7005a8aa89cbdf09e10d6c87bb73da9e35ffd8799fd8799fd8799f581cac246d63642cf5fba32b6b605158236b8abf4d4e926fa42750db18341406ffffffffa140a1401a004699f3d87980d87a80ffffffffff',
  },
  /** Open single-party head 324c8b81, created by its init transaction, Hydra 2.3.0. */
  headV2Open: {
    tx_hash: '52142a19d274fb321e289f0c5209778b2c3c14df4bc83618334d1f5634706080',
    output_index: 0,
    address: 'addr_test1wq4erflxvet45fr9hrrldflevr2cwr83x622vlejzhspf3gn6jry8',
    amount: [
      { unit: 'lovelace', quantity: '2094660' },
      {
        unit: '324c8b8198c4c9db7526d6dccb79e992c4863b24b56453bb16995bdc4879647261486561645632',
        quantity: '1',
      },
      {
        unit: '324c8b8198c4c9db7526d6dccb79e992c4863b24b56453bb16995bdcba1e067abfb07ecd833cec7005a8aa89cbdf09e10d6c87bb73da9e35',
        quantity: '1',
      },
    ],
    inline_datum:
      'd8799fd8799fd8799f5820e2f094efbbf8e363b9d02c7b5c61f89abdd6b839161d3a01638a882356ef96b100ff581c324c8b8198c4c9db7526d6dccb79e992c4863b24b56453bb16995bdc9f582078c948f98b55d4c0b66e4247aac1378f1dad25c37786458c4c0f56b22d88c028ffd8799f19ea60ff00582034758143d508cf8e757b5298b216d453759175423c5987685c8c043713bebc311a001ff644ffff',
  },
  /** Open head with three participation tokens, Hydra 2.3.0. */
  headV2OpenThreeParties: {
    tx_hash: '0777008da4a043399941367d190582666e59ea59925a977503276f28b1b745e5',
    output_index: 0,
    address: 'addr_test1wq4erflxvet45fr9hrrldflevr2cwr83x622vlejzhspf3gn6jry8',
    amount: [
      { unit: 'lovelace', quantity: '2926490' },
      {
        unit: '976b3e073a7c7eae48ca8b2cf84bf9d16b7e4f993eefbf67093f51a40bd9aa016f9a0f4ec200da003581b503d441ce8fd74abc20b58fcd1e',
        quantity: '1',
      },
      {
        unit: '976b3e073a7c7eae48ca8b2cf84bf9d16b7e4f993eefbf67093f51a44879647261486561645632',
        quantity: '1',
      },
      {
        unit: '976b3e073a7c7eae48ca8b2cf84bf9d16b7e4f993eefbf67093f51a4aca3f7a29699c17f8fc7029d1f3c7956e262be059b2d55774939bb08',
        quantity: '1',
      },
      {
        unit: '976b3e073a7c7eae48ca8b2cf84bf9d16b7e4f993eefbf67093f51a4cd24fc5fb96b807f219b31143c8c0247a9c12eb688b39270f6299661',
        quantity: '1',
      },
    ],
    inline_datum:
      'd8799fd8799fd8799f5820413c81e0ddd975771047fba3cc4844d97ee21945ee492961e592138d32c1754a00ff581c976b3e073a7c7eae48ca8b2cf84bf9d16b7e4f993eefbf67093f51a49f5820fe050c7a612985d6f8e9fc596fa43af2c583fdee30568c45a7ddfa78951359f15820917f29d55f080512616a45b9b99d36f427de3dffd650151ab4980c2b187b99b3582020fa4e59f339ec0690b33ce8c3a6d4800c6e98c22983fe37c3be2adf36ff2431ffd8799f1a0001d4c0ff00582034758143d508cf8e757b5298b216d453759175423c5987685c8c043713bebc311a002ca79affff',
  },
} satisfies Record<string, RecordedUtxo>;

/** Builds the `@cardano-sdk/core` UTxO a Cardano provider returns. */
export const toCardanoUtxo = (utxo: RecordedUtxo): Cardano.Utxo => {
  const address = Cardano.PaymentAddress(utxo.address);
  const assets = new Map<Cardano.AssetId, bigint>();
  let coins = 0n;
  for (const { unit, quantity } of utxo.amount) {
    if (unit === 'lovelace') coins = BigInt(quantity);
    else assets.set(Cardano.AssetId(unit), BigInt(quantity));
  }
  return [
    {
      txId: Cardano.TransactionId(utxo.tx_hash),
      index: utxo.output_index,
      address,
    },
    {
      address,
      value: { coins, assets },
      ...(utxo.inline_datum
        ? {
            datum: Serialization.PlutusData.fromCbor(
              HexBlob(utxo.inline_datum),
            ).toCore(),
          }
        : {}),
    },
  ];
};
