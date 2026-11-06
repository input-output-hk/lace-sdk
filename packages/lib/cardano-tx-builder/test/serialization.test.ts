import { Cardano, Serialization, setInConwayEra } from '@lace-lib/cardano-core';
import { blake2b } from '@lace-lib/cardano-crypto';
import { HexBlob } from '@lace-lib/cardano-util';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  auxiliaryDataHash,
  compareTxIns,
  serializeAuxiliaryData,
  serializeTransaction,
  serializeTransactionOutput,
} from '../src/serialization';

import { signedSubTransaction } from './sub-transaction-test-data';

import type * as Crypto from '@lace-lib/cardano-crypto';

const address = Cardano.PaymentAddress(
  'addr_test1qpfhhfy2qgls50r9u4yh0l7z67xpg0a5rrhkmvzcuqrd0znuzcjqw982pcftgx53fu5527z2cj2tkx2h8ux2vxsg475q9gw0lz',
);
const addressBytes = Cardano.Address.fromBech32(address).toBytes();
const datumHash = 'ab'.repeat(32) as Crypto.Hash32ByteBase16;
const keyHash = 'cd'.repeat(28) as Crypto.Ed25519KeyHashHex;
const metadata: Cardano.AuxiliaryData = {
  blob: new Map([[674n, new Map([['msg', ['hello']]])]]),
};
const metadataCbor = Serialization.AuxiliaryData.fromCore(metadata).toCbor();

const txIn = (byte: string, index: number): Cardano.TxIn => ({
  txId: Cardano.TransactionId(byte.repeat(32)),
  index,
});

describe('serialization', () => {
  beforeEach(() => {
    setInConwayEra(true);
  });

  describe('compareTxIns', () => {
    it('orders by transaction id, then by index as a number', () => {
      const inputs = [txIn('02', 0), txIn('01', 10), txIn('01', 2)];

      expect(inputs.sort(compareTxIns)).toEqual([
        txIn('01', 2),
        txIn('01', 10),
        txIn('02', 0),
      ]);
    });

    it('orders transaction ids by their bytes whatever their case', () => {
      const upper = {
        index: 0,
        txId: Cardano.TransactionId('AB'.repeat(32)),
      };
      const lower = {
        index: 0,
        txId: Cardano.TransactionId('a0'.repeat(32)),
      };

      expect([upper, lower].sort(compareTxIns)).toEqual([lower, upper]);
      expect(
        compareTxIns(upper, {
          index: 0,
          txId: Cardano.TransactionId('ab'.repeat(32)),
        }),
      ).toBe(0);
    });
  });

  describe('serializeTransactionOutput', () => {
    it('writes an output without datum or script as a map', () => {
      const output = serializeTransactionOutput({
        address,
        value: { coins: 5_000_000n },
      });

      expect(output.toCbor()).toBe(`a2005839${addressBytes}011a004c4b40`);
    });

    it('writes an output with a datum hash as a map with the datum option', () => {
      const output = serializeTransactionOutput({
        address,
        value: { coins: 5_000_000n },
        datumHash,
      });

      expect(output.toCbor()).toBe(
        `a3005839${addressBytes}011a004c4b400282005820${datumHash}`,
      );
    });

    it('keeps the map an output with an inline datum is already written as', () => {
      const core: Cardano.TxOut = {
        address,
        value: { coins: 5_000_000n },
        datum: 42n,
      };

      expect(serializeTransactionOutput(core).toCbor()).toBe(
        Serialization.TransactionOutput.fromCore(core).toCbor(),
      );
    });
  });

  describe('serializeAuxiliaryData', () => {
    it('writes metadata alone under tag 259', () => {
      expect(serializeAuxiliaryData(metadata).toCbor()).toBe(
        `d90103a100${metadataCbor}`,
      );
    });

    it('writes metadata with native scripts under tag 259', () => {
      const script: Cardano.NativeScript = {
        __type: Cardano.ScriptType.Native,
        kind: Cardano.NativeScriptKind.RequireSignature,
        keyHash,
      };
      const scriptCbor = Serialization.NativeScript.fromCore(script).toCbor();

      expect(
        serializeAuxiliaryData({ ...metadata, scripts: [script] }).toCbor(),
      ).toBe(`d90103a200${metadataCbor}0181${scriptCbor}`);
    });

    it('keeps auxiliary data already written under tag 259', () => {
      const auxiliaryData: Cardano.AuxiliaryData = {
        ...metadata,
        scripts: [
          {
            __type: Cardano.ScriptType.Plutus,
            version: Cardano.PlutusLanguageVersion.V3,
            bytes: HexBlob('deadbeef'),
          },
        ],
      };

      expect(serializeAuxiliaryData(auxiliaryData).toCbor()).toBe(
        Serialization.AuxiliaryData.fromCore(auxiliaryData).toCbor(),
      );
    });
  });

  describe('auxiliaryDataHash', () => {
    it('hashes the tagged form', () => {
      expect(auxiliaryDataHash(metadata)).toBe(
        blake2b.hash(HexBlob(`d90103a100${metadataCbor}`), 32),
      );
    });

    it('gives no hash without auxiliary data', () => {
      expect(auxiliaryDataHash(undefined)).toBeUndefined();
    });
  });

  describe('serializeTransaction', () => {
    const tx: Cardano.Tx = {
      id: Cardano.TransactionId('00'.repeat(32)),
      body: {
        inputs: [txIn('03', 0), txIn('01', 1), txIn('01', 0)],
        collaterals: [txIn('05', 0), txIn('04', 0)],
        referenceInputs: [txIn('07', 0), txIn('06', 0)],
        outputs: [{ address, value: { coins: 5_000_000n } }],
        collateralReturn: { address, value: { coins: 2_000_000n } },
        fee: 200_000n,
      },
      witness: { signatures: new Map() },
      auxiliaryData: metadata,
    };

    it('writes inputs, collateral inputs and reference inputs in set order', () => {
      const body = serializeTransaction(tx).toCore().body;

      expect(body.inputs).toEqual([
        txIn('01', 0),
        txIn('01', 1),
        txIn('03', 0),
      ]);
      expect(body.collaterals).toEqual([txIn('04', 0), txIn('05', 0)]);
      expect(body.referenceInputs).toEqual([txIn('06', 0), txIn('07', 0)]);
    });

    it('writes the outputs and the collateral return as maps and the auxiliary data under tag 259', () => {
      const transaction = serializeTransaction(tx);
      const body = transaction.body();

      expect(body.outputs().map(output => output.isBabbageOutput())).toEqual([
        true,
      ]);
      expect(body.collateralReturn()?.isBabbageOutput()).toBe(true);
      expect(transaction.auxiliaryData()?.toCbor()).toBe(
        `d90103a100${metadataCbor}`,
      );
    });

    it('decodes and re-encodes to the same bytes', () => {
      const cbor = serializeTransaction(tx).toCbor();

      expect(Serialization.Transaction.fromCbor(cbor).toCbor()).toBe(cbor);
    });

    it('writes sub transactions with the bytes they carry, keeping their ids', async () => {
      const first = await signedSubTransaction(txIn('08', 0), {
        address,
        value: { coins: 3_000_000n },
      });
      const second = await signedSubTransaction(txIn('09', 1), {
        address,
        value: { coins: 4_000_000n },
      });
      const subTransactions = [first, second].map(({ cbor }) =>
        Serialization.SubTransaction.fromCbor(cbor),
      );
      expect(
        Serialization.SubTransaction.fromCore(
          subTransactions[0].toCore(),
        ).toCbor(),
      ).not.toBe(first.cbor);

      const cbor = serializeTransaction(tx, subTransactions).toCbor();

      expect(cbor).toContain(`17d9010282${first.cbor}${second.cbor}`);
      const written = Serialization.Transaction.fromCbor(cbor)
        .body()
        .subTransactions()!
        .values();
      expect(written.map(subTx => subTx.toCbor())).toEqual([
        first.cbor,
        second.cbor,
      ]);
      expect(written.map(subTx => subTx.getId())).toEqual([
        first.id,
        second.id,
      ]);
    });

    it('writes the given sub transactions in place of the ones the body holds', async () => {
      const held = await signedSubTransaction(txIn('08', 0), {
        address,
        value: { coins: 3_000_000n },
      });
      const given = await signedSubTransaction(txIn('09', 0), {
        address,
        value: { coins: 3_000_000n },
      });
      const withHeld: Cardano.Tx = {
        ...tx,
        body: {
          ...tx.body,
          subTransactions: [
            Serialization.SubTransaction.fromCbor(held.cbor).toCore(),
          ],
        },
      };

      const written = serializeTransaction(withHeld, [
        Serialization.SubTransaction.fromCbor(given.cbor),
      ])
        .body()
        .subTransactions()!
        .values();

      expect(written.map(subTx => subTx.toCbor())).toEqual([given.cbor]);
    });

    it('writes no sub transactions when none are given or held', () => {
      expect(serializeTransaction(tx, []).toCbor()).toBe(
        serializeTransaction(tx).toCbor(),
      );
      expect(serializeTransaction(tx).body().subTransactions()).toBeUndefined();
    });
  });
});
