import * as Crypto from '@lace-lib/cardano-crypto';

import { Cardano, Serialization } from '../../src';

/** The parties taking part in the batch, seen from a wallet under test. */
export interface DijkstraBatchActors {
  /** Funds sub transaction 1 and receives the sub transaction 2 output. */
  counterparty1Address: Cardano.PaymentAddress;
  /** Funds sub transaction 2 and owns the intermediate output it also spends. */
  counterparty2Address: Cardano.PaymentAddress;
  /** Funds the top level and receives the outputs of sub transaction 1 and the top level. */
  walletAddress: Cardano.PaymentAddress;
  /** Receives the direct deposit and is the subject of the account balance interval. */
  walletRewardAccount: Cardano.RewardAccount;
}

/** A Dijkstra batch transaction with coherent economics, plus the data needed to resolve and inspect it. */
export interface DijkstraBatchFixture {
  actors: DijkstraBatchActors;
  /** CBOR of the transaction, unchanged by a round trip. */
  cbor: Serialization.TxCBOR;
  /**
   * Every input of the batch produced outside of it, top level and sub transactions, with the
   * output it spends. It leaves out the intra-batch utxo, which a resolver must find in the batch
   * itself.
   */
  externalUtxos: Cardano.Utxo[];
  /**
   * The chain history view of the transaction: every input carries the address of the output it
   * spends and every sub transaction carries its id, under a synthetic block header.
   */
  hydratedTx: Cardano.HydratedTx;
  /** The output of sub transaction 1 at index 1, spent by sub transaction 2. */
  intraBatchUtxo: Cardano.Utxo;
  /** Asset minted by sub transaction 1 into the output it pays to the wallet. */
  mintedAssetId: Cardano.AssetId;
  /** Sub transaction ids in batch order, each the hash of its sub transaction body. */
  subTxIds: [Cardano.TransactionId, Cardano.TransactionId];
  tx: Cardano.Tx;
}

const COUNTERPARTY_1_UTXO_TX_ID = Cardano.TransactionId(
  '1000000000000000000000000000000000000000000000000000000000000001',
);
const COUNTERPARTY_2_UTXO_TX_ID = Cardano.TransactionId(
  '2000000000000000000000000000000000000000000000000000000000000002',
);
const WALLET_UTXO_TX_ID = Cardano.TransactionId(
  '3000000000000000000000000000000000000000000000000000000000000003',
);

const COUNTERPARTY_1_INPUT_COINS = 10_000_000n;
const COUNTERPARTY_2_INPUT_COINS = 6_000_000n;
const WALLET_INPUT_COINS = 5_000_000n;

const SUB_TX_1_WALLET_OUTPUT_COINS = 12_000_000n;
const INTERMEDIATE_OUTPUT_COINS = 3_000_000n;
const SUB_TX_2_OUTPUT_COINS = 1_000_000n;
const TOP_LEVEL_WALLET_OUTPUT_COINS = 5_700_000n;

const BATCH_FEE = 300_000n;
const DIRECT_DEPOSIT_COINS = 2_000_000n;
const ACCOUNT_BALANCE_LOWER_BOUND = 2_000_000n;
const ACCOUNT_BALANCE_UPPER_BOUND = 100_000_000n;

const MINTED_TOKEN_QUANTITY = 100n;

const GUARD_KEY_HASH = Crypto.Hash28ByteBase16(
  '00112233445566778899aabbccddeeff00112233445566778899aabb',
);
const GUARD_SCRIPT_HASH = Crypto.Hash28ByteBase16(
  'aabbccddeeff00112233445566778899aabbccddeeff001122334455',
);

const actors: DijkstraBatchActors = {
  counterparty1Address: Cardano.PaymentAddress(
    'addr_test1qzs0umu0s2ammmpw0hea0w2crtcymdjvvlqngpgqy76gpfnuzcjqw982pcftgx53fu5527z2cj2tkx2h8ux2vxsg475qp3y3vz',
  ),
  counterparty2Address: Cardano.PaymentAddress(
    'addr_test1qq585l3hyxgj3nas2v3xymd23vvartfhceme6gv98aaeg9muzcjqw982pcftgx53fu5527z2cj2tkx2h8ux2vxsg475q2g7k3g',
  ),
  walletAddress: Cardano.PaymentAddress(
    'addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3jcu5d8ps7zex2k2xt3uqxgjqnnj83ws8lhrn648jjxtwq2ytjqp',
  ),
  walletRewardAccount: Cardano.RewardAccount(
    'stake_test1uqfu74w3wh4gfzu8m6e7j987h4lq9r3t7ef5gaw497uu85qsqfy27',
  ),
};

const mintedAssetId = Cardano.AssetId(
  '2a286ad895d091f2b3d168a6091ad2627d30a72761a5bc36eef00740',
);

/**
 * Creates a witness set with no signatures.
 *
 * @returns The empty witness set.
 */
const emptyWitness = (): Cardano.Witness => ({ signatures: new Map() });

/**
 * Builds a deterministic Dijkstra batch transaction (CIP-0118) whose economics are coherent: the
 * batch as a whole balances while no level balances on its own, so code that treats a sub
 * transaction as a self-contained transaction produces wrong numbers.
 *
 * Value flow, in ada:
 *
 * - Sub transaction 1 spends the 10.0 utxo of counterparty 1 and produces 12.0 plus 100 minted
 *   tokens to the wallet and a 3.0 intermediate output to counterparty 2. Deficit: 5.0.
 * - Sub transaction 2 spends the 6.0 utxo of counterparty 2 and the 3.0 intermediate output of
 *   its sibling, the intra-batch input, producing 1.0 to counterparty 1. Surplus: 8.0.
 * - The top level spends the 5.0 utxo of the wallet, produces 5.7 back to the wallet, pays the
 *   0.3 batch fee and deposits 2.0 directly into the wallet reward account. Deficit: 3.0.
 *
 * Across the batch, external inputs (21.0) equal new outputs (18.7) plus fee (0.3) plus direct
 * deposits (2.0).
 *
 * The top level also carries a key hash guard, a script hash guard and an account balance
 * interval on the wallet reward account. Sub transaction 2 requires the script guard at the top
 * level without a datum, and sub transaction 1 mints the fixture asset.
 *
 * This is a copy of the `@lace-lib/cardano-util-dev` batch fixture: that package depends on this
 * one, so its test helpers cannot be imported here.
 *
 * @returns The batch transaction with its CBOR, utxos, hydrated view and sub transaction ids.
 */
export const createDijkstraBatchFixture = (): DijkstraBatchFixture => {
  const subTx1: Cardano.SubTransaction = {
    body: {
      inputs: [{ index: 0, txId: COUNTERPARTY_1_UTXO_TX_ID }],
      mint: new Map([[mintedAssetId, MINTED_TOKEN_QUANTITY]]),
      outputs: [
        {
          address: actors.walletAddress,
          value: {
            assets: new Map([[mintedAssetId, MINTED_TOKEN_QUANTITY]]),
            coins: SUB_TX_1_WALLET_OUTPUT_COINS,
          },
        },
        {
          address: actors.counterparty2Address,
          value: { coins: INTERMEDIATE_OUTPUT_COINS },
        },
      ],
    },
    witness: emptyWitness(),
  };
  const subTx1Id = Serialization.SubTransaction.fromCore(subTx1).getId();

  const subTx2: Cardano.SubTransaction = {
    body: {
      inputs: [
        { index: 0, txId: COUNTERPARTY_2_UTXO_TX_ID },
        { index: 1, txId: subTx1Id },
      ],
      outputs: [
        {
          address: actors.counterparty1Address,
          value: { coins: SUB_TX_2_OUTPUT_COINS },
        },
      ],
      requiredTopLevelGuards: [
        {
          credential: {
            hash: GUARD_SCRIPT_HASH,
            type: Cardano.CredentialType.ScriptHash,
          },
          datum: null,
        },
      ],
    },
    witness: emptyWitness(),
  };
  const subTx2Id = Serialization.SubTransaction.fromCore(subTx2).getId();

  const body: Cardano.TxBody = {
    accountBalanceIntervals: [
      {
        interval: {
          exclusiveUpperBound: ACCOUNT_BALANCE_UPPER_BOUND,
          inclusiveLowerBound: ACCOUNT_BALANCE_LOWER_BOUND,
        },
        rewardAccount: actors.walletRewardAccount,
      },
    ],
    directDeposits: [
      {
        quantity: DIRECT_DEPOSIT_COINS,
        stakeAddress: actors.walletRewardAccount,
      },
    ],
    fee: BATCH_FEE,
    guards: [
      { hash: GUARD_KEY_HASH, type: Cardano.CredentialType.KeyHash },
      { hash: GUARD_SCRIPT_HASH, type: Cardano.CredentialType.ScriptHash },
    ],
    inputs: [{ index: 0, txId: WALLET_UTXO_TX_ID }],
    outputs: [
      {
        address: actors.walletAddress,
        value: { coins: TOP_LEVEL_WALLET_OUTPUT_COINS },
      },
    ],
    subTransactions: [subTx1, subTx2],
  };

  const cbor = new Serialization.Transaction(
    Serialization.TransactionBody.fromCore(body),
    Serialization.TransactionWitnessSet.fromCore(emptyWitness()),
  ).toCbor();
  const tx = Serialization.Transaction.fromCbor(cbor).toCore();

  const externalUtxos: Cardano.Utxo[] = [
    [
      {
        address: actors.counterparty1Address,
        index: 0,
        txId: COUNTERPARTY_1_UTXO_TX_ID,
      },
      {
        address: actors.counterparty1Address,
        value: { coins: COUNTERPARTY_1_INPUT_COINS },
      },
    ],
    [
      {
        address: actors.counterparty2Address,
        index: 0,
        txId: COUNTERPARTY_2_UTXO_TX_ID,
      },
      {
        address: actors.counterparty2Address,
        value: { coins: COUNTERPARTY_2_INPUT_COINS },
      },
    ],
    [
      { address: actors.walletAddress, index: 0, txId: WALLET_UTXO_TX_ID },
      { address: actors.walletAddress, value: { coins: WALLET_INPUT_COINS } },
    ],
  ];

  const intraBatchUtxo: Cardano.Utxo = [
    { address: actors.counterparty2Address, index: 1, txId: subTx1Id },
    {
      address: actors.counterparty2Address,
      value: { coins: INTERMEDIATE_OUTPUT_COINS },
    },
  ];

  const allUtxos = [...externalUtxos, intraBatchUtxo];
  const hydrateInput = (txIn: Cardano.TxIn): Cardano.HydratedTxIn => {
    const utxo = allUtxos.find(
      ([produced]) =>
        produced.txId === txIn.txId && produced.index === txIn.index,
    );
    if (!utxo) throw new Error(`No utxo for input: ${txIn.txId}#${txIn.index}`);
    return { address: utxo[0].address, index: txIn.index, txId: txIn.txId };
  };

  const subTxIds: [Cardano.TransactionId, Cardano.TransactionId] = [
    subTx1Id,
    subTx2Id,
  ];
  const hydratedTx: Cardano.HydratedTx = {
    blockHeader: {
      blockNo: Cardano.BlockNo(1_000_000),
      hash: Cardano.BlockId(
        '9999999999999999999999999999999999999999999999999999999999999999',
      ),
      slot: Cardano.Slot(50_000_000),
    },
    body: {
      ...tx.body,
      collaterals: tx.body.collaterals?.map(hydrateInput),
      inputs: tx.body.inputs.map(hydrateInput),
      referenceInputs: tx.body.referenceInputs?.map(hydrateInput),
      subTransactions: (tx.body.subTransactions ?? []).map(
        (subTx, subTxIndex) => ({
          ...subTx,
          body: {
            ...subTx.body,
            inputs: subTx.body.inputs.map(hydrateInput),
            referenceInputs: subTx.body.referenceInputs?.map(hydrateInput),
          },
          id: subTxIds[subTxIndex],
        }),
      ),
    },
    id: tx.id,
    index: 0,
    inputSource: Cardano.InputSource.inputs,
    txSize: cbor.length / 2,
    witness: tx.witness,
  };

  return {
    actors,
    cbor,
    externalUtxos,
    hydratedTx,
    intraBatchUtxo,
    mintedAssetId,
    subTxIds,
    tx,
  };
};
