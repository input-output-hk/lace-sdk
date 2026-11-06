import { Cardano, Serialization } from '@lace-lib/cardano-core';
import * as Crypto from '@lace-lib/cardano-crypto';
import { HexBlob } from '@lace-lib/cardano-util';

import { AddressType, util } from '../../src';
import { testKeyAgent } from '../mocks';

import type {
  AsyncKeyAgent,
  GroupedAddress,
  SignTransactionContext,
  Witnesser,
} from '../../src';
import type { Cip30DataSignature } from '@lace-lib/cardano-dapp-connector';
import type { Mocked } from 'vitest';

describe('createBip32Ed25519Witnesser', () => {
  let asyncKeyAgent: Mocked<AsyncKeyAgent>;
  let witnesser: Witnesser;

  beforeEach(async () => {
    asyncKeyAgent = {
      signBlob: vi.fn(),
      signCip8Data: vi.fn(),
      signSubTransaction: vi.fn(),
      signTransaction: vi.fn(),
    } as unknown as Mocked<AsyncKeyAgent>;
    witnesser = util.createBip32Ed25519Witnesser(asyncKeyAgent);
  });

  it('signData is unchanged', async () => {
    const blob = HexBlob('abc123');
    const result = {} as Cip30DataSignature;
    const props = {
      knownAddresses: [],
      payload: blob,
      sender: { url: 'some test' },
      signWith: 'stub' as Cardano.PaymentAddress,
    };
    asyncKeyAgent.signCip8Data.mockResolvedValueOnce(result);
    await expect(witnesser.signData(props)).resolves.toBe(result);
    expect(asyncKeyAgent.signCip8Data).toBeCalledWith(props);
  });

  it('signTransaction is unchanged', async () => {
    const transaction = new Serialization.Transaction(
      Serialization.TransactionBody.fromCore({
        fee: 20_000n,
        inputs: [],
        outputs: [],
        validityInterval: {},
      }),
      new Serialization.TransactionWitnessSet(),
    );

    const options = { knownAddresses: [], txInKeyPathMap: {} };
    const result = new Map();
    asyncKeyAgent.signTransaction.mockResolvedValueOnce(result);

    const witnessTx = await witnesser.witness(transaction, options);
    await expect(witnessTx.tx.witness).toEqual({ signatures: result });
    expect(asyncKeyAgent.signTransaction).toBeCalledWith(
      transaction.body(),
      options,
      void 0,
    );
  });

  it('keeps the bytes of the body and auxiliary data it signs', async () => {
    const outputAddress = `61${'11'.repeat(28)}`;
    const body = `a4008182582000${'00'.repeat(
      31,
    )}000181a200581d${outputAddress}011a000f424002194e20075820${'22'.repeat(
      32,
    )}`;
    const auxiliaryData = 'd90103a100a10163616263';
    const transaction = Serialization.Transaction.fromCbor(
      Serialization.TxCBOR(`84${body}a0f5${auxiliaryData}`),
    );
    const publicKey = 'aa'.repeat(32);
    const signature = 'bb'.repeat(64);
    asyncKeyAgent.signTransaction.mockResolvedValueOnce(
      new Map([[publicKey, signature]]) as Cardano.Signatures,
    );

    const witnessTx = await witnesser.witness(transaction, {
      knownAddresses: [],
      txInKeyPathMap: {},
    });
    const signed = Serialization.Transaction.fromCbor(witnessTx.cbor);

    expect(signed.body().toCbor()).toBe(body);
    expect(signed.auxiliaryData()?.toCbor()).toBe(auxiliaryData);
    expect(signed.getId()).toBe(transaction.getId());
    expect(witnessTx.tx.id).toBe(transaction.getId());
    expect(signed.witnessSet().vkeys()?.toCore()).toEqual([
      [publicKey, signature],
    ]);
  });

  describe('witnessSubTransaction', () => {
    const body = `a20081825820${'33'.repeat(32)}000180`;
    const otherParty = ['cc'.repeat(32), 'dd'.repeat(64)] as const;
    const publicKey = 'aa'.repeat(32);
    const signature = 'bb'.repeat(64);
    const context = { knownAddresses: [], txInKeyPathMap: {} };

    const witnessedBy = async (
      subTransaction: Serialization.SubTransaction,
      signatures: Cardano.Signatures,
    ) => {
      asyncKeyAgent.signSubTransaction.mockResolvedValueOnce(signatures);
      const witnessed = await witnesser.witnessSubTransaction(
        subTransaction,
        context,
      );
      return {
        signed: Serialization.SubTransaction.fromCbor(witnessed.cbor),
        witnessed,
      };
    };

    it('signs with the key agent and keeps the body bytes and id', async () => {
      const subTransaction = Serialization.SubTransaction.fromCbor(
        HexBlob(`83${body}a0f6`),
      );
      const options = { additionalKeyPaths: [{ index: 0, role: 0 }] };
      asyncKeyAgent.signSubTransaction.mockResolvedValueOnce(
        new Map([[publicKey, signature]]) as Cardano.Signatures,
      );

      const witnessed = await witnesser.witnessSubTransaction(
        subTransaction,
        context,
        options,
      );
      const signed = Serialization.SubTransaction.fromCbor(witnessed.cbor);

      expect(asyncKeyAgent.signSubTransaction).toBeCalledWith(
        subTransaction,
        context,
        options,
      );
      expect(signed.body().toCbor()).toBe(body);
      expect(signed.getId()).toBe(subTransaction.getId());
      expect(witnessed.id).toBe(subTransaction.getId());
      expect(signed.witnessSet().vkeys()?.toCore()).toEqual([
        [publicKey, signature],
      ]);
    });

    it('keeps the vkey witnesses of other parties and adds its own', async () => {
      const subTransaction = Serialization.SubTransaction.fromCbor(
        HexBlob(`83${body}a10081825820${otherParty[0]}5840${otherParty[1]}f6`),
      );

      const { signed } = await witnessedBy(
        subTransaction,
        new Map([[publicKey, signature]]) as Cardano.Signatures,
      );

      expect(signed.body().toCbor()).toBe(body);
      expect(signed.witnessSet().vkeys()?.toCore()).toEqual([
        otherParty,
        [publicKey, signature],
      ]);
    });

    it('leaves the sub transaction bytes as they were when it already carries every signature', async () => {
      const cbor = HexBlob(
        `83${body}a10081825820${otherParty[0]}5840${otherParty[1]}f6`,
      );

      const { witnessed } = await witnessedBy(
        Serialization.SubTransaction.fromCbor(cbor),
        new Map([otherParty]) as Cardano.Signatures,
      );

      expect(witnessed.cbor).toBe(cbor);
    });
  });

  describe('a transaction carrying a native script in its witness set', () => {
    let ownAddress: GroupedAddress;
    let script: Cardano.RequireSignatureScript;
    let transaction: Serialization.Transaction;
    let context: SignTransactionContext;

    beforeEach(async () => {
      const keyAgent = await testKeyAgent();
      witnesser = util.createBip32Ed25519Witnesser(
        util.createAsyncKeyAgent(keyAgent),
      );
      ownAddress = await keyAgent.deriveAddress(
        { index: 0, type: AddressType.External },
        0,
      );
      script = {
        __type: Cardano.ScriptType.Native,
        keyHash: Crypto.Ed25519KeyHashHex(
          Cardano.Address.fromBech32(ownAddress.address)
            .asBase()!
            .getPaymentCredential().hash,
        ),
        kind: Cardano.NativeScriptKind.RequireSignature,
      };
      transaction = new Serialization.Transaction(
        Serialization.TransactionBody.fromCore({
          fee: 20_000n,
          inputs: [],
          mint: new Map([[mintedBy(script), 1n]]),
          outputs: [],
          validityInterval: {},
        }),
        Serialization.TransactionWitnessSet.fromCore({
          scripts: [script],
          signatures: new Map(),
        }),
      );
      context = { knownAddresses: [ownAddress], txInKeyPathMap: {} };
    });

    const mintedBy = (policy: Cardano.Script) =>
      Cardano.AssetId.fromParts(
        Cardano.PolicyId(Serialization.Script.fromCore(policy).hash()),
        Cardano.AssetName(''),
      );

    const vkeysOf = (cbor: Serialization.TxCBOR) =>
      Serialization.Transaction.fromCbor(cbor).witnessSet().vkeys()?.toCore() ??
      [];

    it('signs with the key the script requires without the script in the context', async () => {
      const witnessed = await witnesser.witness(transaction, context);

      const vkeys = vkeysOf(witnessed.cbor);
      expect(vkeys).toHaveLength(1);
      const [[publicKey, signature]] = vkeys;
      expect(Crypto.Ed25519PublicKey.fromHex(publicKey).hash().hex()).toBe(
        script.keyHash,
      );
      expect(
        Crypto.Ed25519PublicKey.fromHex(publicKey).verify(
          Crypto.Ed25519Signature.fromHex(signature),
          HexBlob(transaction.getId()),
        ),
      ).toBe(true);
    });

    it('signs once when the context also passes the script', async () => {
      const witnessed = await witnesser.witness(transaction, {
        ...context,
        scripts: [script],
      });

      expect(vkeysOf(witnessed.cbor)).toHaveLength(1);
    });

    it('counts the key the script requires when stub signing', async () => {
      const withoutContextScripts = await witnesser.witness(
        transaction,
        context,
        { stubSign: true },
      );
      const withContextScripts = await witnesser.witness(
        transaction,
        { ...context, scripts: [script] },
        { stubSign: true },
      );

      expect(vkeysOf(withoutContextScripts.cbor)).toHaveLength(1);
      expect(vkeysOf(withContextScripts.cbor)).toHaveLength(1);
    });

    it('does not sign for a carried script the body does not need', async () => {
      const unreferenced = new Serialization.Transaction(
        Serialization.TransactionBody.fromCore({
          fee: 20_000n,
          inputs: [],
          outputs: [],
          validityInterval: {},
        }),
        transaction.witnessSet(),
      );

      const witnessed = await witnesser.witness(unreferenced, context);
      const stubbed = await witnesser.witness(unreferenced, context, {
        stubSign: true,
      });

      expect(vkeysOf(witnessed.cbor)).toHaveLength(0);
      expect(vkeysOf(stubbed.cbor)).toHaveLength(0);
    });

    describe('in a sub transaction', () => {
      const scriptInput = {
        index: 0,
        txId: Cardano.TransactionId('44'.repeat(32)),
      };

      const batchSpending = (inputs: Cardano.TxIn[]) =>
        new Serialization.Transaction(
          Serialization.TransactionBody.fromCore({
            fee: 20_000n,
            inputs,
            outputs: [],
            subTransactions: [
              {
                body: {
                  inputs: [{ index: 1, txId: scriptInput.txId }],
                  outputs: [],
                },
                witness: { scripts: [script], signatures: new Map() },
              },
            ],
          }),
          new Serialization.TransactionWitnessSet(),
        );

      it('signs and prices a top level input the script may lock', async () => {
        const batch = batchSpending([scriptInput]);

        const witnessed = await witnesser.witness(batch, context);
        const stubbed = await witnesser.witness(batch, context, {
          stubSign: true,
        });

        const vkeys = vkeysOf(witnessed.cbor);
        expect(vkeys).toHaveLength(1);
        expect(Crypto.Ed25519PublicKey.fromHex(vkeys[0][0]).hash().hex()).toBe(
          script.keyHash,
        );
        expect(vkeysOf(stubbed.cbor)).toHaveLength(1);
      });

      it('does not sign for it when the top level spends no input the script may lock', async () => {
        const batch = batchSpending([]);

        const witnessed = await witnesser.witness(batch, context);

        expect(vkeysOf(witnessed.cbor)).toHaveLength(0);
      });
    });
  });
});
