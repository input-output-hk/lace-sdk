import { Cardano, Serialization } from '@lace-lib/cardano-core';
import * as Crypto from '@lace-lib/cardano-crypto';
import {
  AddressType,
  InMemoryKeyAgent,
  util,
} from '@lace-lib/cardano-key-management';
import { HexBlob } from '@lace-lib/cardano-util';
import { beforeAll, describe, expect, it } from 'vitest';

import { getUniqueSubTransactionSignerKeyHashes } from '../src/getUniqueSigners';
import { LargeFirstCoinSelector } from '../src/input-selection/LargeFirstCoinSelector';
import { SubTransactionBuilder } from '../src/SubTransactionBuilder';
import { TransactionBuilder } from '../src/TransactionBuilder';

import type { GroupedAddress } from '@lace-lib/cardano-key-management';

const mnemonicWords = [...Array.from({ length: 11 }, () => 'abandon'), 'about'];

const batcherAddress = Cardano.PaymentAddress(
  'addr_test1qra788mu4sg8kwd93ns9nfdh3k4ufxwg4xhz2r3n064tzfgxu2hyfhlkwuxupa9d5085eunq2qywy7hvmvej456flkns6cy45x',
);

const protocolParameters = {
  coinsPerUtxoByte: 4310,
  collateralPercentage: 150,
  maxCollateralInputs: 3,
  maxTxSize: 16_384,
  maxValueSize: 5000,
  minFeeCoefficient: 44,
  minFeeConstant: 155_381,
  minFeeRefScriptCostPerByte: '15',
  poolDeposit: 500_000_000,
  prices: { memory: 0.0577, steps: 0.0000721 },
  stakeKeyDeposit: 2_000_000,
};

const utxoAt = (
  byte: string,
  address: Cardano.PaymentAddress,
  coins: bigint,
): Cardano.Utxo => [
  { address, index: 0, txId: Cardano.TransactionId(byte.repeat(32)) },
  { address, value: { coins } },
];

const verifies = (
  [publicKey, signature]: readonly [
    Crypto.Ed25519PublicKeyHex,
    Crypto.Ed25519SignatureHex,
  ],
  id: Cardano.TransactionId,
) =>
  Crypto.Ed25519PublicKey.fromHex(publicKey).verify(
    Crypto.Ed25519Signature.fromHex(signature),
    HexBlob(id),
  );

describe('signing a sub transaction the wallet is party to', () => {
  let keyAgent: InMemoryKeyAgent;
  let ownAddress: GroupedAddress;

  beforeAll(async () => {
    keyAgent = await InMemoryKeyAgent.fromBip39MnemonicWords(
      {
        chainId: Cardano.ChainIds.Preprod,
        getPassphrase: async () => Buffer.from('password'),
        mnemonicWords,
      },
      {
        bip32Ed25519: await Crypto.SodiumBip32Ed25519.create(),
        logger: console,
      },
    );
    ownAddress = await keyAgent.deriveAddress(
      { index: 0, type: AddressType.External },
      0,
    );
  });

  it('signs the sub transaction id with the keys it needs, and the batch carries it byte for byte', async () => {
    const spent = utxoAt('a1', ownAddress.address, 4_000_000n);
    const subTransaction = await new SubTransactionBuilder()
      .addInput(spent)
      .addOutput({ address: ownAddress.address, value: { coins: 3_000_000n } })
      .build();

    const signers = getUniqueSubTransactionSignerKeyHashes(
      subTransaction.toCore(),
      [spent],
    );
    const ownPaymentKeyHash = Cardano.Address.fromBech32(ownAddress.address)
      .asBase()!
      .getPaymentCredential().hash;
    expect([...signers]).toEqual([ownPaymentKeyHash]);

    const knownAddresses = [ownAddress];
    const txInKeyPathMap = await util.createTxInKeyPathMap(
      subTransaction.body().toCore(),
      knownAddresses,
      {
        resolveInput: async input =>
          input.txId === spent[0].txId && input.index === spent[0].index
            ? spent[1]
            : null,
      },
    );
    const witnessed = await util
      .createBip32Ed25519Witnesser(util.createAsyncKeyAgent(keyAgent))
      .witnessSubTransaction(subTransaction, {
        knownAddresses,
        txInKeyPathMap,
      });
    const signed = Serialization.SubTransaction.fromCbor(witnessed.cbor);

    expect(witnessed.id).toBe(subTransaction.getId());
    expect(signed.body().toCbor()).toBe(subTransaction.body().toCbor());
    const vkeys = signed.witnessSet().vkeys()!.toCore();
    expect(vkeys).toHaveLength(1);
    const [vkey] = vkeys;
    expect(Crypto.Ed25519PublicKey.fromHex(vkey[0]).hash().hex()).toBe(
      ownPaymentKeyHash,
    );
    expect(verifies(vkey, witnessed.id)).toBe(true);
    expect(
      verifies(
        vkey,
        Crypto.blake2b.hash<Cardano.TransactionId>(signed.body().toCbor(), 32),
      ),
    ).toBe(true);

    const tx = await new TransactionBuilder(
      Cardano.NetworkMagics.Preprod,
      protocolParameters,
    )
      .useCoinSelector(new LargeFirstCoinSelector())
      .setChangeAddress(batcherAddress)
      .setUnspentOutputs([utxoAt('b2', batcherAddress, 10_000_000n)])
      .addSubTransaction(signed, [spent])
      .build();

    const [carried] = tx.body().subTransactions()!.values();
    expect(carried.toCbor()).toBe(witnessed.cbor);
    expect(carried.getId()).toBe(witnessed.id);
    expect(carried.witnessSet().vkeys()!.toCore()).toEqual([vkey]);
    expect(
      verifies(
        vkey,
        Crypto.blake2b.hash<Cardano.TransactionId>(carried.body().toCbor(), 32),
      ),
    ).toBe(true);
  });
});
