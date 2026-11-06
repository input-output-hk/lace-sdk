import { Ed25519SignatureHex } from '@lace-lib/cardano-crypto';
import { HexBlob, InvalidStringError } from '@lace-lib/cardano-util';

import { Cardano } from '../../../';

describe('Cardano/types/Transaction', () => {
  describe('TransactionId', () => {
    describe('when used as a constructor', () => {
      it('accepts a valid transaction hash hex string', () => {
        expect(() =>
          Cardano.TransactionId(
            '3e33018e8293d319ef5b3ac72366dd28006bd315b715f7e7cfcbd3004129b80d',
          ),
        ).not.toThrow();
      });
    });

    describe('fromHexBlob', () => {
      it('accepts a valid length hex string', () => {
        expect(() =>
          Cardano.TransactionId.fromHexBlob(
            HexBlob(
              '3e33018e8293d319ef5b3ac72366dd28006bd315b715f7e7cfcbd3004129b80d',
            ),
          ),
        ).not.toThrow();
      });

      it('throws when given an invalid length hex string', () => {
        expect(() =>
          Cardano.TransactionId.fromHexBlob(HexBlob('33018e8293d319e')),
        ).toThrowError(InvalidStringError);
      });
    });
  });

  describe('HydratedSubTransaction', () => {
    it('carries its id and inputs that hold the address of the output they spend', () => {
      expectTypeOf<
        Cardano.HydratedSubTransaction['id']
      >().toEqualTypeOf<Cardano.TransactionId>();
      expectTypeOf<
        Cardano.HydratedSubTransaction['body']['inputs']
      >().toEqualTypeOf<Cardano.HydratedTxIn[]>();
      expectTypeOf<
        Cardano.HydratedSubTransaction['body']['referenceInputs']
      >().toEqualTypeOf<Cardano.HydratedTxIn[] | undefined>();
    });

    it('is the sub transaction type of a hydrated body but not of a core body', () => {
      expectTypeOf<Cardano.HydratedTxBody['subTransactions']>().toEqualTypeOf<
        Cardano.HydratedSubTransaction[] | undefined
      >();
      expectTypeOf<Cardano.TxBody['subTransactions']>().toEqualTypeOf<
        Cardano.SubTransaction[] | undefined
      >();
    });

    it('is readable wherever a core sub transaction is expected', () => {
      expectTypeOf<Cardano.HydratedSubTransaction>().toExtend<Cardano.SubTransaction>();
      expectTypeOf<Cardano.HydratedTxBody>().toExtend<Cardano.TxBody>();
    });
  });

  it('Ed25519Signature() accepts a valid signature hex string', () => {
    expect(() =>
      Ed25519SignatureHex(
        '709f937c4ce152c81f8406c03279ff5a8556a12a8657e40a578eaaa6223d2e6a2fece39733429e3ec73a6c798561b5c2d47d82224d656b1d964cfe8b5fdffe09',
      ),
    ).not.toThrow();
  });
});
