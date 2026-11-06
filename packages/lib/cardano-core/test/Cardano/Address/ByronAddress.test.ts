import * as Crypto from '@lace-lib/cardano-crypto';
import { HexBlob } from '@lace-lib/cardano-util';

import { Cardano } from '../../../src';
import { ByronAddressType } from '../../../src/Cardano';
import * as cip19TestVectors from '../../Cip19TestVectors';

describe('Cardano/Address/ByronAddress', () => {
  it('fromCredentials can build the correct ByronAddress instance', () => {
    const address = Cardano.ByronAddress.fromCredentials(
      Crypto.Hash28ByteBase16(
        '9c708538a763ff27169987a489e35057ef3cd3778c05e96f7ba9450e',
      ),
      {
        derivationPath: HexBlob(
          '9c1722f7e446689256e1a30260f3510d558d99d0c391f2ba89cb6977',
        ),
        magic: 1_097_911_063,
      },
      ByronAddressType.PubKey,
    );
    expect(address.toAddress().toBase58()).toEqual(
      cip19TestVectors.byronTestnetDaedalus,
    );
  });

  it('keeps a network magic attribute of 0 when re-encoded', () => {
    const bytes = HexBlob(
      '82d818583d83581c239e480f0260bfe927d69166886a0315eee294eec1098977656f8e10a20157566120636f6d70726573736564206c656e6e612e706e67024100001a359e595f',
    );
    const address = Cardano.Address.fromBytes(bytes);

    expect(address.asByron()!.getAttributes().magic).toBe(0);
    expect(address.toBytes()).toEqual(bytes);
    expect(Cardano.Address.fromBase58(address.toBase58()).toBytes()).toEqual(
      bytes,
    );
  });

  it('keeps an empty derivation path attribute when re-encoded', () => {
    const address = Cardano.ByronAddress.fromCredentials(
      Crypto.Hash28ByteBase16(
        '9c708538a763ff27169987a489e35057ef3cd3778c05e96f7ba9450e',
      ),
      { derivationPath: HexBlob('') },
      ByronAddressType.PubKey,
    ).toAddress();
    const decoded = Cardano.Address.fromBytes(address.toBytes());

    expect(decoded.asByron()!.getAttributes().derivationPath).toEqual('');
    expect(decoded.toBytes()).toEqual(address.toBytes());
  });
});
