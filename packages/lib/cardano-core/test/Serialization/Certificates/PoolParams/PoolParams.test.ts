import * as Crypto from '@lace-lib/cardano-crypto';
import { HexBlob } from '@lace-lib/cardano-util';

import * as Cardano from '../../../../src/Cardano';
import { PoolParams } from '../../../../src/Serialization';

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

// Test data used in the following tests was generated with the cardano-serialization-lib
const cbor = HexBlob(
  '89581cd85087c646951407198c27b1b950fd2e99f28586c000ce39f6e6ef9258208dd154228946bd12967c12bedb1cb6038b78f8b84a1760b1a788fa72a4af3db01927101903e8d81e820105581de1cb0ec2692497b458e46812c8a5bfa2931d1a2d965a99893828ec810f81581ccb0ec2692497b458e46812c8a5bfa2931d1a2d965a99893828ec810f8383011913886b6578616d706c652e636f6d8400191770447f000001f682026b6578616d706c652e636f6d827368747470733a2f2f6578616d706c652e636f6d58200f3abbc8fc19c2e61bab6059bf8a466e6e754833a08a62a6c56fe0e78f19d9d5',
);

const cborWithSets = HexBlob(
  '89581cd85087c646951407198c27b1b950fd2e99f28586c000ce39f6e6ef9258208dd154228946bd12967c12bedb1cb6038b78f8b84a1760b1a788fa72a4af3db01927101903e8d81e820105581de1cb0ec2692497b458e46812c8a5bfa2931d1a2d965a99893828ec810fd9010281581ccb0ec2692497b458e46812c8a5bfa2931d1a2d965a99893828ec810f8383011913886b6578616d706c652e636f6d8400191770447f000001f682026b6578616d706c652e636f6d827368747470733a2f2f6578616d706c652e636f6d58200f3abbc8fc19c2e61bab6059bf8a466e6e754833a08a62a6c56fe0e78f19d9d5',
);

const blsKey: Cardano.PoolBlsKey = {
  proofOfPossession: HexBlob(
    '606162636465666768696a6b6c6d6e6f707172737475767778797a7b7c7d7e7f808182838485868788898a8b8c8d8e8f',
  ),
  publicKey: HexBlob(
    '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f',
  ),
};

// Constructed and validated against cardano-ledger 9b81d9943ce79b8531e9d8e2c5f9adcb158677cb dijkstra.cddl
const cborWithBlsKey = HexBlob(
  '8a581cd85087c646951407198c27b1b950fd2e99f28586c000ce39f6e6ef9258208dd154228946bd12967c12bedb1cb6038b78f8b84a1760b1a788fa72a4af3db0825860000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f5830606162636465666768696a6b6c6d6e6f707172737475767778797a7b7c7d7e7f808182838485868788898a8b8c8d8e8f1927101903e8d81e820105581de1cb0ec2692497b458e46812c8a5bfa2931d1a2d965a99893828ec810fd9010281581ccb0ec2692497b458e46812c8a5bfa2931d1a2d965a99893828ec810f8383011913886b6578616d706c652e636f6d8400191770447f000001f682026b6578616d706c652e636f6d827368747470733a2f2f6578616d706c652e636f6d58200f3abbc8fc19c2e61bab6059bf8a466e6e754833a08a62a6c56fe0e78f19d9d5',
);

const cborWithNullBlsKey = HexBlob(
  '8a581cd85087c646951407198c27b1b950fd2e99f28586c000ce39f6e6ef9258208dd154228946bd12967c12bedb1cb6038b78f8b84a1760b1a788fa72a4af3db0f61927101903e8d81e820105581de1cb0ec2692497b458e46812c8a5bfa2931d1a2d965a99893828ec810fd9010281581ccb0ec2692497b458e46812c8a5bfa2931d1a2d965a99893828ec810f8383011913886b6578616d706c652e636f6d8400191770447f000001f682026b6578616d706c652e636f6d827368747470733a2f2f6578616d706c652e636f6d58200f3abbc8fc19c2e61bab6059bf8a466e6e754833a08a62a6c56fe0e78f19d9d5',
);

// Test data used in the following tests, apart from the BLS key vectors, was generated with the cardano-serialization-lib
describe('PoolParams', () => {
  it('can decode PoolParams from CBOR', () => {
    const params = PoolParams.fromCbor(cbor);

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

  it('can decode PoolParams from Core', () => {
    const params = PoolParams.fromCore(poolParameters);

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

  it('can encode PoolParams to CBOR (pool owners emit tag 258 set by default)', () => {
    const params = PoolParams.fromCore(poolParameters);

    expect(params.toCbor()).toEqual(cborWithSets);
  });

  it('can encode PoolParams to Core', () => {
    const params = PoolParams.fromCbor(cbor);

    expect(params.toCore()).toEqual(poolParameters);
  });

  describe('BLS key', () => {
    it('decodes a BLS key and re-encodes it byte for byte', () => {
      const params = PoolParams.fromCbor(cborWithBlsKey);

      expect(params.blsKey()).toEqual(blsKey);
      expect(params.toCore()).toEqual({ ...poolParameters, blsKey });
      expect(params.toCbor()).toEqual(cborWithBlsKey);
    });

    it('keeps a BLS key when rebuilt from its core form', () => {
      const params = PoolParams.fromCore(
        PoolParams.fromCbor(cborWithBlsKey).toCore(),
      );

      expect(params.toCbor()).toEqual(cborWithBlsKey);
    });

    it('reads an empty BLS key field as no BLS key and keeps its original bytes', () => {
      const params = PoolParams.fromCbor(cborWithNullBlsKey);

      expect(params.blsKey()).toBeUndefined();
      expect(params.toCore()).toEqual(poolParameters);
      expect(params.toCbor()).toEqual(cborWithNullBlsKey);
    });

    it('leaves out an empty BLS key field when rebuilt from its core form', () => {
      const params = PoolParams.fromCore(
        PoolParams.fromCbor(cborWithNullBlsKey).toCore(),
      );

      expect(params.toCbor()).toEqual(cborWithSets);
    });

    it('leaves the BLS key field out of parameters that never had one', () => {
      const params = PoolParams.fromCbor(cborWithSets);

      expect(params.blsKey()).toBeUndefined();
      expect(params.toCore()).not.toHaveProperty('blsKey');
      expect(PoolParams.fromCore(params.toCore()).toCbor()).toEqual(
        cborWithSets,
      );
    });

    it('writes and removes the BLS key field when it is set', () => {
      const params = PoolParams.fromCbor(cborWithSets);

      params.setBlsKey(blsKey);
      expect(params.toCbor()).toEqual(cborWithBlsKey);

      params.setBlsKey(undefined);
      expect(params.toCbor()).toEqual(cborWithSets);
    });

    it('rejects a BLS public key that is not 96 bytes', () => {
      const wrongKey = {
        ...blsKey,
        publicKey: HexBlob(blsKey.publicKey.slice(2)),
      };

      expect(() =>
        PoolParams.fromCore({ ...poolParameters, blsKey: wrongKey }),
      ).toThrow('Expected a BLS public key of 96 bytes, but got 95 bytes');
      expect(() =>
        PoolParams.fromCbor(
          HexBlob(
            cborWithBlsKey.replace(
              `825860${blsKey.publicKey}`,
              `82585f${blsKey.publicKey.slice(2)}`,
            ),
          ),
        ),
      ).toThrow('Expected a BLS public key of 96 bytes, but got 95 bytes');
    });

    it('rejects a BLS proof of possession that is not 48 bytes', () => {
      const wrongKey = {
        ...blsKey,
        proofOfPossession: HexBlob(`${blsKey.proofOfPossession}00`),
      };

      expect(() =>
        PoolParams.fromCore({ ...poolParameters, blsKey: wrongKey }),
      ).toThrow(
        'Expected a BLS proof of possession of 48 bytes, but got 49 bytes',
      );
      expect(() =>
        PoolParams.fromCbor(
          HexBlob(
            cborWithBlsKey.replace(
              `5830${blsKey.proofOfPossession}`,
              `5831${blsKey.proofOfPossession}00`,
            ),
          ),
        ),
      ).toThrow(
        'Expected a BLS proof of possession of 48 bytes, but got 49 bytes',
      );
    });

    it('rejects a BLS key array that does not hold two elements', () => {
      expect(() =>
        PoolParams.fromCbor(
          HexBlob(cborWithBlsKey.replace('825860', '835860')),
        ),
      ).toThrow(
        'Expected a BLS key array of 2 elements, but got an array of 3 elements',
      );
    });
  });
});
