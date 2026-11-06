import * as Crypto from '@lace-lib/cardano-crypto';
import { HexBlob } from '@lace-lib/cardano-util';

import { Cardano, Serialization, SerializationFailure } from '../../src';

// Shelley era
const shelleyCbor = HexBlob(
  '82a11902d5a4187b1904d2636b65796576616c7565646b65793246000102030405a1190237656569676874a119029a6463616b65828202818200581c3542acb3a64d80c29302260d62c3b87a742ad14abf855ebc6733081e830300818200581cb5ae663aaea8e500157bdf4baafd6f5ba0ce5759f7cd4101fc132f54',
);

const alonzoCbor = HexBlob(
  'd90103a400a11902d5a4187b1904d2636b65796576616c7565646b65793246000102030405a1190237656569676874a119029a6463616b6501848204038205098202818200581c3542acb3a64d80c29302260d62c3b87a742ad14abf855ebc6733081e830300818200581cb5ae663aaea8e500157bdf4baafd6f5ba0ce5759f7cd4101fc132f540284474601000022001047460100002200114746010000220012474601000022001303844746010000220010474601000022001147460100002200124746010000220013',
);

const metadataCborHex =
  'a11902d5a4187b1904d2636b65796576616c7565646b65793246000102030405a1190237656569676874a119029a6463616b65';

const dijkstraV4Cbor = HexBlob(
  `d90103a200${metadataCborHex}058247460100002200104746010000220011`,
);

const dijkstraV3V4Cbor = HexBlob(
  `d90103a300${metadataCborHex}048247460100002200104746010000220011058247460100002200124746010000220013`,
);

const metadatum = new Map<Cardano.Metadatum, Cardano.Metadatum>([
  [123n, 1234n],
  ['key', 'value'],
  ['key2', new Uint8Array([0, 1, 2, 3, 4, 5])],
  [
    new Map<Cardano.Metadatum, Cardano.Metadatum>([[567n, 'eight']]),
    new Map<Cardano.Metadatum, Cardano.Metadatum>([[666n, 'cake']]),
  ],
]) as Cardano.Metadatum;

const shelleyScripts: Array<Cardano.Script> = [
  {
    __type: Cardano.ScriptType.Native,
    kind: Cardano.NativeScriptKind.RequireAnyOf,
    scripts: [
      {
        __type: Cardano.ScriptType.Native,
        keyHash: Crypto.Ed25519KeyHashHex(
          '3542acb3a64d80c29302260d62c3b87a742ad14abf855ebc6733081e',
        ),
        kind: Cardano.NativeScriptKind.RequireSignature,
      },
    ],
  },
  {
    __type: Cardano.ScriptType.Native,
    kind: Cardano.NativeScriptKind.RequireNOf,
    required: 0,
    scripts: [
      {
        __type: Cardano.ScriptType.Native,
        keyHash: Crypto.Ed25519KeyHashHex(
          'b5ae663aaea8e500157bdf4baafd6f5ba0ce5759f7cd4101fc132f54',
        ),
        kind: Cardano.NativeScriptKind.RequireSignature,
      },
    ],
  },
];

const alonzoScripts: Array<Cardano.Script> = [
  {
    __type: Cardano.ScriptType.Plutus,
    bytes: HexBlob('46010000220010'),
    version: Cardano.PlutusLanguageVersion.V1,
  },
  {
    __type: Cardano.ScriptType.Plutus,
    bytes: HexBlob('46010000220011'),
    version: Cardano.PlutusLanguageVersion.V1,
  },
  {
    __type: Cardano.ScriptType.Plutus,
    bytes: HexBlob('46010000220012'),
    version: Cardano.PlutusLanguageVersion.V1,
  },
  {
    __type: Cardano.ScriptType.Plutus,
    bytes: HexBlob('46010000220013'),
    version: Cardano.PlutusLanguageVersion.V1,
  },
  {
    __type: Cardano.ScriptType.Plutus,
    bytes: HexBlob('46010000220010'),
    version: Cardano.PlutusLanguageVersion.V2,
  },
  {
    __type: Cardano.ScriptType.Plutus,
    bytes: HexBlob('46010000220011'),
    version: Cardano.PlutusLanguageVersion.V2,
  },
  {
    __type: Cardano.ScriptType.Plutus,
    bytes: HexBlob('46010000220012'),
    version: Cardano.PlutusLanguageVersion.V2,
  },
  {
    __type: Cardano.ScriptType.Plutus,
    bytes: HexBlob('46010000220013'),
    version: Cardano.PlutusLanguageVersion.V2,
  },
  { __type: Cardano.ScriptType.Native, kind: 4, slot: Cardano.Slot(3) },
  { __type: Cardano.ScriptType.Native, kind: 5, slot: Cardano.Slot(9) },
  {
    __type: Cardano.ScriptType.Native,
    kind: Cardano.NativeScriptKind.RequireAnyOf,
    scripts: [
      {
        __type: Cardano.ScriptType.Native,
        keyHash: Crypto.Ed25519KeyHashHex(
          '3542acb3a64d80c29302260d62c3b87a742ad14abf855ebc6733081e',
        ),
        kind: Cardano.NativeScriptKind.RequireSignature,
      },
    ],
  },
  {
    __type: Cardano.ScriptType.Native,
    kind: Cardano.NativeScriptKind.RequireNOf,
    required: 0,
    scripts: [
      {
        __type: Cardano.ScriptType.Native,
        keyHash: Crypto.Ed25519KeyHashHex(
          'b5ae663aaea8e500157bdf4baafd6f5ba0ce5759f7cd4101fc132f54',
        ),
        kind: Cardano.NativeScriptKind.RequireSignature,
      },
    ],
  },
];

const dijkstraV4Scripts: Array<Cardano.Script> = [
  {
    __type: Cardano.ScriptType.Plutus,
    bytes: HexBlob('46010000220010'),
    version: Cardano.PlutusLanguageVersion.V4,
  },
  {
    __type: Cardano.ScriptType.Plutus,
    bytes: HexBlob('46010000220011'),
    version: Cardano.PlutusLanguageVersion.V4,
  },
];

const dijkstraV3V4Scripts: Array<Cardano.Script> = [
  {
    __type: Cardano.ScriptType.Plutus,
    bytes: HexBlob('46010000220010'),
    version: Cardano.PlutusLanguageVersion.V3,
  },
  {
    __type: Cardano.ScriptType.Plutus,
    bytes: HexBlob('46010000220011'),
    version: Cardano.PlutusLanguageVersion.V3,
  },
  {
    __type: Cardano.ScriptType.Plutus,
    bytes: HexBlob('46010000220012'),
    version: Cardano.PlutusLanguageVersion.V4,
  },
  {
    __type: Cardano.ScriptType.Plutus,
    bytes: HexBlob('46010000220013'),
    version: Cardano.PlutusLanguageVersion.V4,
  },
];

const shelleyCore: Cardano.AuxiliaryData = {
  blob: new Map([[725n, metadatum]]),
  scripts: shelleyScripts,
};

const alonzoCore: Cardano.AuxiliaryData = {
  blob: new Map([[725n, metadatum]]),
  scripts: alonzoScripts,
};

const dijkstraV4Core: Cardano.AuxiliaryData = {
  blob: new Map([[725n, metadatum]]),
  scripts: dijkstraV4Scripts,
};

const dijkstraV3V4Core: Cardano.AuxiliaryData = {
  blob: new Map([[725n, metadatum]]),
  scripts: dijkstraV3V4Scripts,
};

describe('AuxiliaryData', () => {
  describe('Shelley auxiliary data', () => {
    it('can encode TransactionWitnessSet to CBOR', () => {
      const data = Serialization.AuxiliaryData.fromCore(shelleyCore);
      expect(data.toCbor()).toEqual(shelleyCbor);
    });

    it('can encode TransactionWitnessSet to Core', () => {
      const data = Serialization.AuxiliaryData.fromCbor(shelleyCbor);
      expect(data.toCore()).toEqual(shelleyCore);
    });
  });

  describe('Alonzo auxiliary data', () => {
    it('can encode TransactionWitnessSet to CBOR', () => {
      const data = Serialization.AuxiliaryData.fromCore(alonzoCore);
      expect(data.toCbor()).toEqual(alonzoCbor);
    });

    it('can encode TransactionWitnessSet to Core', () => {
      const data = Serialization.AuxiliaryData.fromCbor(alonzoCbor);
      expect(data.toCore()).toEqual(alonzoCore);
    });
  });

  describe('Dijkstra auxiliary data with plutus v4 scripts', () => {
    it('can encode AuxiliaryData with plutus v4 scripts at map key 5 to CBOR', () => {
      const data = Serialization.AuxiliaryData.fromCore(dijkstraV4Core);
      expect(data.toCbor()).toEqual(dijkstraV4Cbor);
    });

    it('can decode AuxiliaryData with plutus v4 scripts at map key 5 to Core', () => {
      const data = Serialization.AuxiliaryData.fromCbor(dijkstraV4Cbor);
      expect(data.toCore()).toEqual(dijkstraV4Core);
    });

    it('round trips plutus v4 auxiliary data byte-exact through decode and re-encode', () => {
      const data = Serialization.AuxiliaryData.fromCbor(dijkstraV4Cbor);
      data.setPlutusV4Scripts(data.plutusV4Scripts()!);
      expect(data.toCbor()).toEqual(dijkstraV4Cbor);
    });

    it('can encode AuxiliaryData with both plutus v3 and v4 script lists to CBOR', () => {
      const data = Serialization.AuxiliaryData.fromCore(dijkstraV3V4Core);
      expect(data.toCbor()).toEqual(dijkstraV3V4Cbor);
    });

    it('can decode AuxiliaryData with both plutus v3 and v4 script lists to Core', () => {
      const data = Serialization.AuxiliaryData.fromCbor(dijkstraV3V4Cbor);
      expect(data.toCore()).toEqual(dijkstraV3V4Core);
    });

    it('round trips v3 plus v4 auxiliary data byte-exact through decode and re-encode', () => {
      const data = Serialization.AuxiliaryData.fromCbor(dijkstraV3V4Cbor);
      data.setPlutusV4Scripts(data.plutusV4Scripts()!);
      expect(data.toCbor()).toEqual(dijkstraV3V4Cbor);
    });

    it('preserves toCore/fromCore symmetry for plutus v4 scripts', () => {
      expect(
        Serialization.AuxiliaryData.fromCore(dijkstraV4Core).toCore(),
      ).toEqual(dijkstraV4Core);
      expect(
        Serialization.AuxiliaryData.fromCore(dijkstraV3V4Core).toCore(),
      ).toEqual(dijkstraV3V4Core);
    });

    it('exposes decoded plutus v4 scripts via the plutusV4Scripts getter', () => {
      const data = Serialization.AuxiliaryData.fromCbor(dijkstraV4Cbor);
      const scripts = data.plutusV4Scripts();
      expect(scripts).toHaveLength(2);
      expect(scripts![0].rawBytes()).toEqual(HexBlob('46010000220010'));
      expect(scripts![1].rawBytes()).toEqual(HexBlob('46010000220011'));
    });
  });

  describe('metadatum', () => {
    const convertMetadatum = (data: any) => {
      const label = 123n;
      const auxiliaryData = Serialization.AuxiliaryData.fromCore({
        blob: new Map([[label, data]]),
      });
      return auxiliaryData.metadata()!.metadata()!.get(label);
    };

    const str64Len =
      'looooooooooooooooooooooooooooooooooooooooooooooooooooooooooogstr';
    const str65Len =
      'loooooooooooooooooooooooooooooooooooooooooooooooooooooooooooogstr';

    it('converts number', () => {
      const number = 1234n;
      expect(convertMetadatum(number)!.asInteger()).toBe(number);
    });

    it('decodes a negative bignum as minus one minus the unsigned value in its byte string', () => {
      const data = Serialization.TransactionMetadatum.fromCbor(
        HexBlob('c349000100000000000000'),
      );
      expect(data.asInteger()).toEqual(-72_057_594_037_927_937n);
    });

    it('rebuilds a decoded negative bignum from its core form with the same value', () => {
      const data = Serialization.TransactionMetadatum.fromCbor(
        HexBlob('c349000100000000000000'),
      );
      expect(
        Serialization.TransactionMetadatum.fromCore(data.toCore()).toCbor(),
      ).toEqual('3b0100000000000000');
    });

    it('round trips a negative integer below the 64-bit range as a negative bignum', () => {
      const value = -(2n ** 64n) - 5n;
      const cbor =
        Serialization.TransactionMetadatum.newInteger(value).toCbor();
      expect(cbor).toEqual('c349010000000000000004');
      expect(
        Serialization.TransactionMetadatum.fromCbor(cbor).asInteger(),
      ).toEqual(value);
    });

    it('converts text', () => {
      expect(convertMetadatum(str64Len)!.asText()).toBe(str64Len);
    });

    it('converts list', () => {
      const list = [str64Len, 'str2'];
      const medataumList = convertMetadatum(list)!.asList();

      expect(medataumList!.getLength()).toBe(list.length);
      expect(medataumList!.get(0).asText()).toBe(list[0]);
      expect(medataumList!.get(1).asText()).toBe(list[1]);
    });

    test('converts bytes', () => {
      const bytes = Buffer.from(str64Len).valueOf();
      const metadatumBytes = convertMetadatum(bytes);
      expect(metadatumBytes!.asBytes()).toEqual(bytes);
    });

    it('converts map', () => {
      const key = new Map<Cardano.Metadatum, Cardano.Metadatum>([
        [567n, 'eight'],
      ]);
      const map = new Map<Cardano.Metadatum, Cardano.Metadatum>([
        [123n, 1234n],
        ['key', 'value'],
        [key, new Map<Cardano.Metadatum, Cardano.Metadatum>([[666n, 'cake']])],
      ]);
      const metadatumMap = convertMetadatum(map)!.asMap();
      const metadatum1 = metadatumMap!.get(convertMetadatum(123n)!);
      const metadatum2 = metadatumMap!.get(convertMetadatum('key')!);
      const metadatum3 = metadatumMap!.get(convertMetadatum(key)!);
      const metadatum1AsInt = metadatum1!.asInteger();
      const metadatum3AsMap = metadatum3!.asMap();

      expect(metadatumMap!.getLength()).toBe(map.size);
      expect(metadatum1AsInt).toBe(1234n);
      expect(metadatum2!.asText()).toBe('value');
      expect(
        metadatum3AsMap!
          .get(Serialization.TransactionMetadatum.newInteger(666n))!
          .asText(),
      ).toBe('cake');
    });

    test('bytes too long throws error', () => {
      const bytes = Buffer.from(str65Len, 'utf8');
      expect(() => convertMetadatum(bytes)).toThrow(
        SerializationFailure.MaxLengthLimit,
      );
    });

    it('text too long throws error', () => {
      expect(() => convertMetadatum(str65Len)).toThrow(
        SerializationFailure.MaxLengthLimit,
      );
    });

    it('bool throws error', () => {
      expect(() => convertMetadatum(true)).toThrowError(
        SerializationFailure.InvalidType,
      );
    });

    it('undefined throws error', () => {
      expect(() => convertMetadatum(undefined)).toThrowError(
        SerializationFailure.InvalidType,
      );
    });

    it('null throws error', () => {
      expect(() => convertMetadatum(null)).toThrowError(
        SerializationFailure.InvalidType,
      );
    });

    it('can find an element in a metadatum map with key - Integer', () => {
      const data = new Serialization.MetadatumMap();

      data.insert(
        Serialization.TransactionMetadatum.newInteger(1n),
        Serialization.TransactionMetadatum.newInteger(2n),
      );

      expect(
        data.get(Serialization.TransactionMetadatum.newInteger(1n)),
      ).toEqual(Serialization.TransactionMetadatum.newInteger(2n));
      expect(
        data.get(Serialization.TransactionMetadatum.newInteger(2n)),
      ).toBeUndefined();
    });

    it('can find an element in a metadatum map with key - Text', () => {
      const data = new Serialization.MetadatumMap();

      data.insert(
        Serialization.TransactionMetadatum.newText('someKey'),
        Serialization.TransactionMetadatum.newInteger(2n),
      );

      expect(
        data.get(Serialization.TransactionMetadatum.newText('someKey')),
      ).toEqual(Serialization.TransactionMetadatum.newInteger(2n));
      expect(
        data.get(Serialization.TransactionMetadatum.newText('someOtherKey')),
      ).toBeUndefined();
    });

    it('can find an element in a metadatum map with key - Bytes', () => {
      const data = new Serialization.MetadatumMap();

      data.insert(
        Serialization.TransactionMetadatum.newBytes(new Uint8Array([0, 1, 2])),
        Serialization.TransactionMetadatum.newInteger(2n),
      );

      expect(
        data.get(
          Serialization.TransactionMetadatum.newBytes(
            new Uint8Array([0, 1, 2]),
          ),
        ),
      ).toEqual(Serialization.TransactionMetadatum.newInteger(2n));

      expect(
        data.get(
          Serialization.TransactionMetadatum.newBytes(
            new Uint8Array([0, 1, 2, 3]),
          ),
        ),
      ).toBeUndefined();
    });

    it('can find an element in a metadatum map with key - MetadatumList', () => {
      const data = new Serialization.MetadatumMap();

      const list1 = new Serialization.MetadatumList();
      list1.add(Serialization.TransactionMetadatum.newInteger(1n));
      list1.add(Serialization.TransactionMetadatum.newInteger(2n));
      list1.add(Serialization.TransactionMetadatum.newInteger(5n));

      const list2 = new Serialization.MetadatumList();
      list2.add(Serialization.TransactionMetadatum.newInteger(1n));
      list2.add(Serialization.TransactionMetadatum.newInteger(2n));
      list2.add(Serialization.TransactionMetadatum.newInteger(5n));

      const list3 = new Serialization.MetadatumList();
      list3.add(Serialization.TransactionMetadatum.newInteger(1n));
      list3.add(Serialization.TransactionMetadatum.newInteger(2n));

      data.insert(
        Serialization.TransactionMetadatum.newList(list1),
        Serialization.TransactionMetadatum.newInteger(2n),
      );

      expect(
        data.get(Serialization.TransactionMetadatum.newList(list2)),
      ).toEqual(Serialization.TransactionMetadatum.newInteger(2n));

      expect(
        data.get(Serialization.TransactionMetadatum.newList(list3)),
      ).toBeUndefined();
    });

    it('can find an element in a metadatum map with key - MetadatumMap', () => {
      const data = new Serialization.MetadatumMap();

      const map1 = new Serialization.MetadatumMap();
      const list1 = new Serialization.MetadatumList();
      list1.add(Serialization.TransactionMetadatum.newInteger(1n));
      list1.add(Serialization.TransactionMetadatum.newInteger(2n));
      list1.add(Serialization.TransactionMetadatum.newInteger(5n));
      map1.insert(
        Serialization.TransactionMetadatum.newList(list1),
        Serialization.TransactionMetadatum.newInteger(1n),
      );

      const map2 = new Serialization.MetadatumMap();
      const list2 = new Serialization.MetadatumList();
      list2.add(Serialization.TransactionMetadatum.newInteger(1n));
      list2.add(Serialization.TransactionMetadatum.newInteger(2n));
      list2.add(Serialization.TransactionMetadatum.newInteger(5n));
      map2.insert(
        Serialization.TransactionMetadatum.newList(list2),
        Serialization.TransactionMetadatum.newInteger(1n),
      );

      const map3 = new Serialization.MetadatumMap();
      const list3 = new Serialization.MetadatumList();
      list3.add(Serialization.TransactionMetadatum.newInteger(1n));
      list3.add(Serialization.TransactionMetadatum.newInteger(2n));
      map3.insert(
        Serialization.TransactionMetadatum.newList(list3),
        Serialization.TransactionMetadatum.newInteger(1n),
      );

      data.insert(
        Serialization.TransactionMetadatum.newMap(map1),
        Serialization.TransactionMetadatum.newInteger(1n),
      );

      expect(data.get(Serialization.TransactionMetadatum.newMap(map2))).toEqual(
        Serialization.TransactionMetadatum.newInteger(2n),
      );
      expect(
        data.get(Serialization.TransactionMetadatum.newMap(map3)),
      ).toBeUndefined();
    });
  });

  describe('metadatum map with a repeated key', () => {
    const cbor = HexBlob('a201020103');

    it('keeps both entries and re-encodes byte for byte', () => {
      const metadatum = Serialization.TransactionMetadatum.fromCbor(cbor);
      expect(metadatum.asMap()!.getLength()).toBe(2);
      expect(metadatum.toCbor()).toEqual(cbor);
    });

    it('holds one entry with the first value in the core form', () => {
      const core = Serialization.TransactionMetadatum.fromCbor(
        cbor,
      ).toCore() as Cardano.MetadatumMap;
      expect([...core.entries()]).toEqual([[1n, 2n]]);
    });

    it('gives every entry of a repeated byte string key the first value in the core form', () => {
      const bytesKeyCbor = HexBlob('a2410102410103');
      const metadatum =
        Serialization.TransactionMetadatum.fromCbor(bytesKeyCbor);
      const core = metadatum.toCore() as Cardano.MetadatumMap;
      expect(metadatum.toCbor()).toEqual(bytesKeyCbor);
      expect([...core.values()]).toEqual([2n, 2n]);
    });
  });

  describe('general transaction metadata', () => {
    const metadataEntries =
      '1a0005950764eea8a5041a000b3ead6c0be480bff391bdb2d0b324471a00213eb8a1a0850563ef99b0418262df80021a002249d638191a0026074382a0401a00381ac0485a6a109b2816e1421a0041d95b44146845cd1a0047e0185819cb5c346430138e7e27b4b82b99969cfcafec428ab0ca7093731a0055a55ea01a0069cffa66c6a259efb3961a006ebb35a01a0073f4d770eeaca5c2bff1a098b7f2b9a0acefb1b31a007517c02b1a007acbcc801a007e3614820141641a0086198882621a3961151a009116638142a7cf1a00991b4a4cd6a803166435cd4bfe5c7af81a00aad34157c292b0fa78045783288c58d5c880a36dab00aee8f86ff61a00bafb8f832343643f9e221a00bb61c1a2456768aa29553660141a00c4a980544d83d639e7a2727cb30e3203a3ab041f4c7db7411a00c68c2f47679463cbaa0c371a00c8067174f39dac9407d2a516e1aea9cbb1ef9996f48599931a00d6434a2c1a00dad42161281a00eab53356ab5be4d2b80e3eefec8f8e09b347d1c4c0fffffed5a71a00f05752381d1a00f9ea8b26';
    const indefiniteMetadataCbor = HexBlob(`bf${metadataEntries}ff`);
    const nestedIndefiniteMetadataCbor = HexBlob(
      'bf1a0003c170842185410864d5b6d0a9022062c78c81018204001a0015dfca311a002a5738425ef81a0030c9886cf0b6a598522fca8a11e9ab921a004024ffa164ccad7641a56008042d44a5ff254a54fb623fdf89189be1797b93b4c129f6759520bc02405258b602b6be36fa5f8a68cfb2f2433517794d00201a0054afbc7705f395828cf395bd9ddf93eeb6a0f0a69cba7969c5bd481a005722b6828465d891db9e7c2164de85465460601a006076a1a54579088eede54fcb45bef14b89a143d200ea79532dad820003a164d2a4c396181a65dcbe19c2963043bbb8727819e291a6c4aa13efab99ee93abf2a686aed0a2f0afaeb7e38a9042fc56231a00670c318520a2457774a9f5312464f482b6ae42ef66438cae4ca3652fc78bd7b0453a3c4c9f1e43a9082443372ae365cc90cf93050281437351fc1a006db151512f45be1f9c8c532f55d6daab86261c19511a006db3f97818d08bf3ac92bac585cfbaf182b39bf09f878c6ad4b0ef91be1a00719b50a4604a50f39de08b17423c2161a06bf2a2bd8b72ef83bf5cd78c214001a01a00726ea7141a007c71d04930f5c05fd55aef56041a0099151ea3246d18d4a6eeb6afd386f28190b771a06dc8abeaa5bfcaa4f2b99ab2d5bda44314119e6355c5876023042400004b69307d3d062168f523ce8a1a009997ba6ce7adba1dee9ca042e5b489301a00a6a19f84406231206355332b820261601a00b5de708405a042bfb4401a00bc292f58186ba8f719dbb09e64eb6b3214d99a893dc4d33e9b519e92c41a00c3cb22a3a12203181d038342173c03613e602c1a00cdcc1d8362dbb5631bc5a6401a00f08b9e657d2bdfae761a00f3430f801a00fa533969c4aeeea2b0ef819010ff',
    );

    it('keeps the last value of a repeated label and re-encodes its original bytes', () => {
      const cbor = HexBlob('a201020103');
      const metadata = Serialization.GeneralTransactionMetadata.fromCbor(cbor);
      expect(metadata.toCbor()).toEqual(cbor);
      expect([...metadata.toCore().entries()]).toEqual([[1n, 3n]]);
    });

    it('re-encodes decoded metadata written as an indefinite length map with its original bytes', () => {
      expect(
        Serialization.GeneralTransactionMetadata.fromCbor(
          indefiniteMetadataCbor,
        ).toCbor(),
      ).toEqual(indefiniteMetadataCbor);
    });

    it('re-encodes decoded metadata with nested maps and lists written as an indefinite length map with its original bytes', () => {
      expect(
        Serialization.GeneralTransactionMetadata.fromCbor(
          nestedIndefiniteMetadataCbor,
        ).toCbor(),
      ).toEqual(nestedIndefiniteMetadataCbor);
    });

    it('re-encodes decoded metadata from its entries once they are replaced', () => {
      const metadata = Serialization.GeneralTransactionMetadata.fromCbor(
        indefiniteMetadataCbor,
      );

      metadata.setMetadata(metadata.metadata()!);

      expect(metadata.toCbor()).toEqual(`b81d${metadataEntries}`);
    });

    describe('equality', () => {
      const build = (text: string) =>
        Serialization.GeneralTransactionMetadata.fromCore(
          new Map([[674n, text]]),
        );

      it('is not equal when built in code with different entries', () => {
        expect(build('first').equals(build('second'))).toBe(false);
      });

      it('is equal when built in code with the same entries', () => {
        expect(build('first').equals(build('first'))).toBe(true);
      });

      it('is equal when decoded from the same bytes', () => {
        expect(
          Serialization.GeneralTransactionMetadata.fromCbor(
            indefiniteMetadataCbor,
          ).equals(
            Serialization.GeneralTransactionMetadata.fromCbor(
              indefiniteMetadataCbor,
            ),
          ),
        ).toBe(true);
      });

      it('is equal when decoded and rebuilt from the same entries', () => {
        const decoded = Serialization.GeneralTransactionMetadata.fromCbor(
          indefiniteMetadataCbor,
        );

        expect(
          decoded.equals(
            Serialization.GeneralTransactionMetadata.fromCore(decoded.toCore()),
          ),
        ).toBe(true);
      });
    });
  });

  describe('edits after decoding', () => {
    const integer = (value: bigint) =>
      Serialization.TransactionMetadatum.newInteger(value);

    it('re-encodes a decoded metadatum after adding to its list', () => {
      const metadatum = Serialization.TransactionMetadatum.fromCbor(
        HexBlob('80'),
      );

      metadatum.asList()!.add(integer(1n));

      expect(metadatum.toCbor()).toEqual('8101');
    });

    it('re-encodes a decoded metadatum after inserting into its map', () => {
      const metadatum = Serialization.TransactionMetadatum.fromCbor(
        HexBlob('a0'),
      );

      metadatum.asMap()!.insert(integer(1n), integer(2n));

      expect(metadatum.toCbor()).toEqual('a10102');
    });

    it('re-encodes a decoded metadatum after adding to a list held as a map value', () => {
      const metadatum = Serialization.TransactionMetadatum.fromCbor(
        HexBlob('a10180'),
      );

      metadatum.asMap()!.get(integer(1n))!.asList()!.add(integer(2n));

      expect(metadatum.toCbor()).toEqual('a1018102');
    });

    it('re-encodes a decoded metadatum after inserting into a map held in its list', () => {
      const metadatum = Serialization.TransactionMetadatum.fromCbor(
        HexBlob('9fa0ff'),
      );

      metadatum.asList()!.get(0).asMap()!.insert(integer(1n), integer(2n));

      expect(metadatum.toCbor()).toEqual('9fa10102ff');
    });

    it('re-encodes decoded metadata after adding a label to its entries', () => {
      const metadata = Serialization.GeneralTransactionMetadata.fromCbor(
        HexBlob('bf0180ff'),
      );

      metadata.metadata()!.set(2n, integer(3n));

      expect(metadata.toCbor()).toEqual('a201800203');
    });

    it('re-encodes decoded metadata after replacing the value of a label', () => {
      const metadata = Serialization.GeneralTransactionMetadata.fromCbor(
        HexBlob('bf0180ff'),
      );

      metadata.metadata()!.set(1n, integer(3n));

      expect(metadata.toCbor()).toEqual('a10103');
    });

    it('re-encodes decoded metadata after adding to a list held as a label value', () => {
      const metadata = Serialization.GeneralTransactionMetadata.fromCbor(
        HexBlob('bf0180ff'),
      );

      metadata.metadata()!.get(1n)!.asList()!.add(integer(2n));

      expect(metadata.toCbor()).toEqual('a1018102');
    });

    it('keeps the decoded bytes of metadata with nested containers that were not changed', () => {
      const cbor = HexBlob('bf019fa0ff02bf0180ffff');
      const metadata = Serialization.GeneralTransactionMetadata.fromCbor(cbor);

      expect(metadata.toCbor()).toEqual(cbor);
      expect(metadata.toCbor()).toEqual(cbor);
    });

    it('is not equal to metadata decoded from the same bytes once edited', () => {
      const edited = Serialization.GeneralTransactionMetadata.fromCbor(
        HexBlob('bf0180ff'),
      );
      const untouched = Serialization.GeneralTransactionMetadata.fromCbor(
        HexBlob('bf0180ff'),
      );

      edited.metadata()!.get(1n)!.asList()!.add(integer(2n));

      expect(edited.equals(untouched)).toBe(false);
    });

    it('re-encodes decoded auxiliary data after editing a metadatum in it', () => {
      const auxiliaryData = Serialization.AuxiliaryData.fromCbor(
        HexBlob('d90103a100a10180'),
      );

      auxiliaryData.metadata()!.metadata()!.get(1n)!.asList()!.add(integer(2n));

      expect(auxiliaryData.toCbor()).toEqual('a1018102');
    });

    it('re-encodes a decoded metadatum list after inserting into a map in it', () => {
      const metadatum = Serialization.TransactionMetadatum.fromCbor(
        HexBlob('81a0'),
      );

      metadatum.asList()!.get(0).asMap()!.insert(integer(1n), integer(2n));

      expect(metadatum.toCbor()).toEqual('81a10102');
    });

    it('keeps the decoded bytes of an untouched metadatum map when a sibling is added', () => {
      const metadatum = Serialization.TransactionMetadatum.fromCbor(
        HexBlob('81a1180101'),
      );

      metadatum.asList()!.add(integer(2n));

      expect(metadatum.toCbor()).toEqual('82a118010102');
    });

    it('decodes deeply nested metadatum maps without encoding them again', () => {
      const cbor = HexBlob('a100'.repeat(1000) + '00');
      const mapToCbor = vi.spyOn(
        Serialization.MetadatumMap.prototype,
        'toCbor',
      );

      try {
        const metadatum = Serialization.TransactionMetadatum.fromCbor(cbor);

        expect(mapToCbor).not.toHaveBeenCalled();
        expect(metadatum.toCbor()).toEqual(cbor);
        expect(mapToCbor).toHaveBeenCalledTimes(1);
      } finally {
        mapToCbor.mockRestore();
      }
    });

    it('rejects a metadatum with a tag other than a bignum', () => {
      expect(() =>
        Serialization.TransactionMetadatum.fromCbor(HexBlob('d81840')),
      ).toThrow('Unsupported metadatum tag 24');
    });
  });

  describe('Deep equality', () => {
    it('Integer', () => {
      expect(
        Serialization.TransactionMetadatum.newInteger(1n).equals(
          Serialization.TransactionMetadatum.newInteger(1n),
        ),
      ).toBeTruthy();
      expect(
        Serialization.TransactionMetadatum.newInteger(1n).equals(
          Serialization.TransactionMetadatum.newInteger(2n),
        ),
      ).toBeFalsy();
    });

    it('Text', () => {
      expect(
        Serialization.TransactionMetadatum.newText('some').equals(
          Serialization.TransactionMetadatum.newText('some'),
        ),
      ).toBeTruthy();
      expect(
        Serialization.TransactionMetadatum.newText('some').equals(
          Serialization.TransactionMetadatum.newText('more'),
        ),
      ).toBeFalsy();
    });

    it('Bytes', () => {
      expect(
        Serialization.TransactionMetadatum.newBytes(
          new Uint8Array([0, 1, 2]),
        ).equals(
          Serialization.TransactionMetadatum.newBytes(
            new Uint8Array([0, 1, 2]),
          ),
        ),
      ).toBeTruthy();
      expect(
        Serialization.TransactionMetadatum.newBytes(
          new Uint8Array([0, 1, 2]),
        ).equals(
          Serialization.TransactionMetadatum.newBytes(new Uint8Array([0, 1])),
        ),
      ).toBeFalsy();
    });

    it('MetadatumList', () => {
      const list1 = new Serialization.MetadatumList();
      list1.add(Serialization.TransactionMetadatum.newInteger(1n));
      list1.add(Serialization.TransactionMetadatum.newInteger(2n));
      list1.add(Serialization.TransactionMetadatum.newInteger(5n));

      const list2 = new Serialization.MetadatumList();
      list2.add(Serialization.TransactionMetadatum.newInteger(1n));
      list2.add(Serialization.TransactionMetadatum.newInteger(2n));
      list2.add(Serialization.TransactionMetadatum.newInteger(5n));

      const list3 = new Serialization.MetadatumList();
      list3.add(Serialization.TransactionMetadatum.newInteger(1n));
      list3.add(Serialization.TransactionMetadatum.newInteger(2n));

      expect(list1.equals(list2)).toBeTruthy();
      expect(list1.equals(list3)).toBeFalsy();
    });

    it('MetadatumMap', () => {
      const map1 = new Serialization.MetadatumMap();
      const list1 = new Serialization.MetadatumList();
      list1.add(Serialization.TransactionMetadatum.newInteger(1n));
      list1.add(Serialization.TransactionMetadatum.newInteger(2n));
      list1.add(Serialization.TransactionMetadatum.newInteger(5n));
      map1.insert(
        Serialization.TransactionMetadatum.newList(list1),
        Serialization.TransactionMetadatum.newInteger(1n),
      );

      const map2 = new Serialization.MetadatumMap();
      const list2 = new Serialization.MetadatumList();
      list2.add(Serialization.TransactionMetadatum.newInteger(1n));
      list2.add(Serialization.TransactionMetadatum.newInteger(2n));
      list2.add(Serialization.TransactionMetadatum.newInteger(5n));
      map2.insert(
        Serialization.TransactionMetadatum.newList(list2),
        Serialization.TransactionMetadatum.newInteger(1n),
      );

      const map3 = new Serialization.MetadatumMap();
      const list3 = new Serialization.MetadatumList();
      list3.add(Serialization.TransactionMetadatum.newInteger(1n));
      list3.add(Serialization.TransactionMetadatum.newInteger(2n));
      map3.insert(
        Serialization.TransactionMetadatum.newList(list3),
        Serialization.TransactionMetadatum.newInteger(1n),
      );

      expect(map1.equals(map2)).toBeTruthy();
      expect(map1.equals(map3)).toBeFalsy();
    });
  });
});
