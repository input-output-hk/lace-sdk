import * as Crypto from '@lace-lib/cardano-crypto';
import { HexBlob } from '@lace-lib/cardano-util';

import * as Cardano from '../../../src/Cardano';
import { Certificate, PoolRegistration } from '../../../src/Serialization';

const cbor = HexBlob(
  '8a03581cd85087c646951407198c27b1b950fd2e99f28586c000ce39f6e6ef9258208dd154228946bd12967c12bedb1cb6038b78f8b84a1760b1a788fa72a4af3db01927101903e8d81e820105581de1cb0ec2692497b458e46812c8a5bfa2931d1a2d965a99893828ec810f81581ccb0ec2692497b458e46812c8a5bfa2931d1a2d965a99893828ec810f8383011913886b6578616d706c652e636f6d8400191770447f000001f682026b6578616d706c652e636f6d827368747470733a2f2f6578616d706c652e636f6d58200f3abbc8fc19c2e61bab6059bf8a466e6e754833a08a62a6c56fe0e78f19d9d5',
);

const cborWithSets = HexBlob(
  '8a03581cd85087c646951407198c27b1b950fd2e99f28586c000ce39f6e6ef9258208dd154228946bd12967c12bedb1cb6038b78f8b84a1760b1a788fa72a4af3db01927101903e8d81e820105581de1cb0ec2692497b458e46812c8a5bfa2931d1a2d965a99893828ec810fd9010281581ccb0ec2692497b458e46812c8a5bfa2931d1a2d965a99893828ec810f8383011913886b6578616d706c652e636f6d8400191770447f000001f682026b6578616d706c652e636f6d827368747470733a2f2f6578616d706c652e636f6d58200f3abbc8fc19c2e61bab6059bf8a466e6e754833a08a62a6c56fe0e78f19d9d5',
);

const poolParameters: Cardano.PoolParameters = {
  cost: 1000n,
  id: Cardano.PoolId(
    'pool1mpgg03jxj52qwxvvy7cmj58a96vl9pvxcqqvuw0kumheygxmn34',
  ),
  margin: { denominator: 5, numerator: 1 },
  metadataJson: {
    hash: Crypto.Hash32ByteBase16(
      '0f3abbc8fc19c2e61bab6059bf8a466e6e754833a08a62a6c56fe0e78f19d9d5',
    ),
    url: 'https://example.com',
  },
  owners: [
    Cardano.RewardAccount(
      'stake1u89sasnfyjtmgk8ydqfv3fdl52f36x3djedfnzfc9rkgzrcss5vgr',
    ),
  ],
  pledge: 10_000n,
  relays: [
    { __typename: 'RelayByName', hostname: 'example.com', port: 5000 },
    {
      __typename: 'RelayByAddress',
      ipv4: '127.0.0.1',
      port: 6000,
    },
    { __typename: 'RelayByNameMultihost', dnsName: 'example.com' },
  ],
  rewardAccount: Cardano.RewardAccount(
    'stake1u89sasnfyjtmgk8ydqfv3fdl52f36x3djedfnzfc9rkgzrcss5vgr',
  ),
  vrf: Cardano.VrfVkHex(
    '8dd154228946bd12967c12bedb1cb6038b78f8b84a1760b1a788fa72a4af3db0',
  ),
};

const core: Cardano.PoolRegistrationCertificate = {
  __typename: Cardano.CertificateType.PoolRegistration,
  poolParameters,
};

// Constructed and validated against cardano-ledger 9b81d9943ce79b8531e9d8e2c5f9adcb158677cb dijkstra.cddl
const cborWithBlsKey = HexBlob(
  '8b03581cd85087c646951407198c27b1b950fd2e99f28586c000ce39f6e6ef9258208dd154228946bd12967c12bedb1cb6038b78f8b84a1760b1a788fa72a4af3db0825860000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f5830606162636465666768696a6b6c6d6e6f707172737475767778797a7b7c7d7e7f808182838485868788898a8b8c8d8e8f1927101903e8d81e820105581de1cb0ec2692497b458e46812c8a5bfa2931d1a2d965a99893828ec810fd9010281581ccb0ec2692497b458e46812c8a5bfa2931d1a2d965a99893828ec810f8383011913886b6578616d706c652e636f6d8400191770447f000001f682026b6578616d706c652e636f6d827368747470733a2f2f6578616d706c652e636f6d58200f3abbc8fc19c2e61bab6059bf8a466e6e754833a08a62a6c56fe0e78f19d9d5',
);

const cborWithNullBlsKey = HexBlob(
  '8b03581cd85087c646951407198c27b1b950fd2e99f28586c000ce39f6e6ef9258208dd154228946bd12967c12bedb1cb6038b78f8b84a1760b1a788fa72a4af3db0f61927101903e8d81e820105581de1cb0ec2692497b458e46812c8a5bfa2931d1a2d965a99893828ec810fd9010281581ccb0ec2692497b458e46812c8a5bfa2931d1a2d965a99893828ec810f8383011913886b6578616d706c652e636f6d8400191770447f000001f682026b6578616d706c652e636f6d827368747470733a2f2f6578616d706c652e636f6d58200f3abbc8fc19c2e61bab6059bf8a466e6e754833a08a62a6c56fe0e78f19d9d5',
);

const blsKey: Cardano.PoolBlsKey = {
  proofOfPossession: HexBlob(
    '606162636465666768696a6b6c6d6e6f707172737475767778797a7b7c7d7e7f808182838485868788898a8b8c8d8e8f',
  ),
  publicKey: HexBlob(
    '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f',
  ),
};

// Vendored from cardano-ledger 9b81d9943ce79b8531e9d8e2c5f9adcb158677cb eras/dijkstra/impl/testlib/Test/Cardano/Ledger/Dijkstra/Binary/Golden.hs
const ledgerGoldenCborWithBlsKey = HexBlob(
  '8b03581c0d6a577e9441ad8ed9663931906e4d43ece8f82c712b1d0235affb065820c5e21ab1c9f6022d81c3b25e3436cb7f1df77f9652ae3e1310c28e621dd87b4c825860a57565542eaa01ef2b910bf0eaba4d98a1e5b8b79cc425db08f8780732d0ea9bc85fc6175f272b2344bb27bc572ebf14022e52689dcedfccf44a00e5bd1aa59db44517217d6b0f21b372169ee761938c28914ddcb9663de54db288e760a8e14f58308114c1b1ef41b6b826f612f6383989ccefc82fb4df4a49dbd828b8fd94db9d0e86a55e22861b585edf411a48374aa42a0105d81e82010a581de00d6a577e9441ad8ed9663931906e4d43ece8f82c712b1d0235affb06d9010281581c0d6a577e9441ad8ed9663931906e4d43ece8f82c712b1d0235affb06838400190bb8447f00000150b80d01200000000000000000010000008301190bb97172656c61792e6578616d706c652e636f6d82027172656c61792e6578616d706c652e636f6d826e636f6e73656e7375732e706f6f6c427b7d',
);

// Test data used in the following tests, apart from the BLS key vectors, was generated with the cardano-serialization-lib
describe('PoolRegistration', () => {
  it('can decode PoolRegistration from CBOR', () => {
    const certificate = PoolRegistration.fromCbor(cbor);
    const params = certificate.poolParameters();

    expect(params.operator()).toEqual(
      Cardano.PoolId.toKeyHash(
        Cardano.PoolId(
          'pool1mpgg03jxj52qwxvvy7cmj58a96vl9pvxcqqvuw0kumheygxmn34',
        ),
      ),
    );
    expect(params.vrfKeyHash()).toEqual(
      Cardano.VrfVkHex(
        '8dd154228946bd12967c12bedb1cb6038b78f8b84a1760b1a788fa72a4af3db0',
      ),
    );
    expect(params.pledge()).toEqual(10_000n);
    expect(params.cost()).toEqual(1000n);
    expect(params.margin().toCore()).toEqual({ denominator: 5, numerator: 1 });
    expect(params.rewardAccount().toAddress().toBech32()).toEqual(
      Cardano.RewardAccount(
        'stake1u89sasnfyjtmgk8ydqfv3fdl52f36x3djedfnzfc9rkgzrcss5vgr',
      ),
    );
    expect(
      params
        .poolOwners()
        .toCore()
        .map(keyHash =>
          Cardano.createRewardAccount(
            keyHash,
            params.rewardAccount().toAddress().getNetworkId(),
          ),
        ),
    ).toEqual([
      Cardano.RewardAccount(
        'stake1u89sasnfyjtmgk8ydqfv3fdl52f36x3djedfnzfc9rkgzrcss5vgr',
      ),
    ]);
    expect(params.relays().map(relay => relay.toCore())).toEqual([
      { __typename: 'RelayByName', hostname: 'example.com', port: 5000 },
      {
        __typename: 'RelayByAddress',
        ipv4: '127.0.0.1',
        port: 6000,
      },
      { __typename: 'RelayByNameMultihost', dnsName: 'example.com' },
    ]);
    expect(params.poolMetadata()?.toCore()).toEqual({
      hash: Crypto.Hash32ByteBase16(
        '0f3abbc8fc19c2e61bab6059bf8a466e6e754833a08a62a6c56fe0e78f19d9d5',
      ),
      url: 'https://example.com',
    });
  });

  it('can decode PoolRegistration from Core', () => {
    const certificate = PoolRegistration.fromCore(core);
    const params = certificate.poolParameters();

    expect(params.operator()).toEqual(
      Cardano.PoolId.toKeyHash(
        Cardano.PoolId(
          'pool1mpgg03jxj52qwxvvy7cmj58a96vl9pvxcqqvuw0kumheygxmn34',
        ),
      ),
    );
    expect(params.vrfKeyHash()).toEqual(
      Cardano.VrfVkHex(
        '8dd154228946bd12967c12bedb1cb6038b78f8b84a1760b1a788fa72a4af3db0',
      ),
    );
    expect(params.pledge()).toEqual(10_000n);
    expect(params.cost()).toEqual(1000n);
    expect(params.margin().toCore()).toEqual({ denominator: 5, numerator: 1 });
    expect(params.rewardAccount().toAddress().toBech32()).toEqual(
      Cardano.RewardAccount(
        'stake1u89sasnfyjtmgk8ydqfv3fdl52f36x3djedfnzfc9rkgzrcss5vgr',
      ),
    );
    expect(
      params
        .poolOwners()
        .toCore()
        .map(keyHash =>
          Cardano.createRewardAccount(
            keyHash,
            params.rewardAccount().toAddress().getNetworkId(),
          ),
        ),
    ).toEqual([
      Cardano.RewardAccount(
        'stake1u89sasnfyjtmgk8ydqfv3fdl52f36x3djedfnzfc9rkgzrcss5vgr',
      ),
    ]);
    expect(params.relays().map(relay => relay.toCore())).toEqual([
      { __typename: 'RelayByName', hostname: 'example.com', port: 5000 },
      {
        __typename: 'RelayByAddress',
        ipv4: '127.0.0.1',
        port: 6000,
      },
      { __typename: 'RelayByNameMultihost', dnsName: 'example.com' },
    ]);
    expect(params.poolMetadata()?.toCore()).toEqual({
      hash: Crypto.Hash32ByteBase16(
        '0f3abbc8fc19c2e61bab6059bf8a466e6e754833a08a62a6c56fe0e78f19d9d5',
      ),
      url: 'https://example.com',
    });
  });

  it('can encode PoolRegistration to CBOR (pool owners emit tag 258 set by default)', () => {
    const certificate = PoolRegistration.fromCore(core);

    expect(certificate.toCbor()).toEqual(cborWithSets);
  });

  it('can encode PoolRegistration to Core', () => {
    const certificate = PoolRegistration.fromCbor(cbor);

    expect(certificate.toCore()).toEqual(core);
  });

  it('can encode PoolRegistration with 6.248 tags to Core', () => {
    const certificate = PoolRegistration.fromCbor(cborWithSets);
    expect(certificate.toCore()).toEqual(core);
  });

  it('decodes a registration with a BLS key and re-encodes it byte for byte', () => {
    const certificate = PoolRegistration.fromCbor(cborWithBlsKey);

    expect(certificate.poolParameters().blsKey()).toEqual(blsKey);
    expect(certificate.toCore()).toEqual({
      ...core,
      poolParameters: { ...poolParameters, blsKey },
    });
    expect(certificate.toCbor()).toEqual(cborWithBlsKey);
  });

  it('keeps a BLS key when the registration is rebuilt from its core form', () => {
    const certificate = PoolRegistration.fromCore(
      PoolRegistration.fromCbor(cborWithBlsKey).toCore(),
    );

    expect(certificate.toCbor()).toEqual(cborWithBlsKey);
  });

  it('reads an empty BLS key field as no BLS key and leaves it out when rebuilt from its core form', () => {
    const certificate = PoolRegistration.fromCbor(cborWithNullBlsKey);

    expect(certificate.poolParameters().blsKey()).toBeUndefined();
    expect(certificate.toCore()).toEqual(core);
    expect(certificate.toCbor()).toEqual(cborWithNullBlsKey);
    expect(PoolRegistration.fromCore(certificate.toCore()).toCbor()).toEqual(
      cborWithSets,
    );
  });

  it('rejects a registration with neither the Conway nor the Dijkstra field count', () => {
    expect(() =>
      PoolRegistration.fromCbor(HexBlob(`8c${cborWithBlsKey.slice(2)}f6`)),
    ).toThrow(
      'Expected an array of 10 or 11 elements, but got an array of 12 elements',
    );
  });

  it('decodes the ledger golden Dijkstra registration with a BLS key as a certificate', () => {
    const certificate = Certificate.fromCbor(ledgerGoldenCborWithBlsKey);
    const core = certificate.toCore() as Cardano.PoolRegistrationCertificate;

    expect(core.poolParameters.blsKey).toEqual({
      proofOfPossession: HexBlob(
        '8114c1b1ef41b6b826f612f6383989ccefc82fb4df4a49dbd828b8fd94db9d0e86a55e22861b585edf411a48374aa42a',
      ),
      publicKey: HexBlob(
        'a57565542eaa01ef2b910bf0eaba4d98a1e5b8b79cc425db08f8780732d0ea9bc85fc6175f272b2344bb27bc572ebf14022e52689dcedfccf44a00e5bd1aa59db44517217d6b0f21b372169ee761938c28914ddcb9663de54db288e760a8e14f',
      ),
    });
    expect(certificate.toCbor()).toEqual(ledgerGoldenCborWithBlsKey);
    expect(Certificate.fromCore(core).toCbor()).toEqual(
      ledgerGoldenCborWithBlsKey,
    );
  });
});
