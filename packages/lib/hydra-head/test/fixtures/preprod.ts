import type { HydraBlockfrostUtxo, HydraTxEndpoint } from '../../src';

/**
 * UTxOs recorded from the Preprod Blockfrost API, reduced to the fields the
 * converters read. Spent outputs keep the inline datum they carried.
 */
export const preprodUtxos = {
  /** Deposit of 4.626931 ada into head 324c8b81 by a key credential, Hydra 2.3.0. */
  depositV2: {
    tx_hash: 'c1a8300f3d89c7feca5a91561329d205574170d5886e7bfb384558b5b89759a7',
    output_index: 0,
    address: 'addr_test1wrrcaryjq4epavl0gsg08kuuv95l5md5jlpyvswjnss998qyu7lhm',
    amount: [{ unit: 'lovelace', quantity: '4626931' }],
    inline_datum:
      'd8799f581c324c8b8198c4c9db7526d6dccb79e992c4863b24b56453bb16995bdc1b000001a05d17b3df9fd8799fd8799f5820e2f094efbbf8e363b9d02c7b5c61f89abdd6b839161d3a01638a882356ef96b101ff5f5840d8799fd8799fd8799f581cba1e067abfb07ecd833cec7005a8aa89cbdf09e10d6c87bb73da9e35ffd8799fd8799fd8799f581cac246d63642cf5fba32b6b605158236b8abf4d4e926fa42750db18341406ffffffffa140a1401a004699f3d87980d87a80ffffffffff',
  },
  /** Second deposit of the same output into head 324c8b81 after recovering the first. */
  redepositV2: {
    tx_hash: 'a2918d2edb88ebaa4d1edab80303e4f6b68736d2179fb5e11a62a67fdcaac00a',
    output_index: 0,
    address: 'addr_test1wrrcaryjq4epavl0gsg08kuuv95l5md5jlpyvswjnss998qyu7lhm',
    amount: [{ unit: 'lovelace', quantity: '4626931' }],
    inline_datum:
      'd8799f581c324c8b8198c4c9db7526d6dccb79e992c4863b24b56453bb16995bdc1b000001a05d4e00459fd8799fd8799f5820ec46e4746c1fa79697ebae7d3c19bef0c59f544cb48649c71bdef3348c943b4d00ff5f5840d8799fd8799fd8799f581cba1e067abfb07ecd833cec7005a8aa89cbdf09e10d6c87bb73da9e35ffd8799fd8799fd8799f581cac246d63642cf5fba32b6b605158236b8abf4d4e926fa42750db18341406ffffffffa140a1401a004699f3d87980d87a80ffffffffff',
  },
  /** Deposit of two outputs locked by script credentials, one carrying native assets and an inline datum. */
  depositV2ScriptCommits: {
    tx_hash: '237b4918bd36034a407d72710c9404debb9870003a93237f8b2ca380fada77f4',
    output_index: 0,
    address: 'addr_test1wrrcaryjq4epavl0gsg08kuuv95l5md5jlpyvswjnss998qyu7lhm',
    amount: [
      { unit: 'lovelace', quantity: '1090309030' },
      {
        unit: '5d09adde9fdf0bb0cbf14180fa490a32b4031c67e83f766806b540fe1b9cff79ccffe244ad9aca17d397b2bf9f33c2ec1e7e0d39c8cc8f8af4fb2da2',
        quantity: '1',
      },
      {
        unit: 'd2a8592ec9673ac18fea1044885f94518e954ab0cb2b6bb0a328d2af425443',
        quantity: '100000',
      },
    ],
    inline_datum:
      'd8799f581ccf253d219b93f709ba62bcccd942cfcb353c2feafada1c8d9ab84e9e1b0000019ec21ba4259fd8799fd8799f5820070993f1b3e051bb52a129c120c6c29d0e772a85a541bf31ce1904dfce75d30a03ff5f5840d8799fd8799fd87a9f581c5d09adde9fdf0bb0cbf14180fa490a32b4031c67e83f766806b540feffd87a80ffa340a1401a3ceb1266581c5d09adde9fdf0bb0cb5840f14180fa490a32b4031c67e83f766806b540fea158201b9cff79ccffe244ad9aca17d397b2bf9f33c2ec1e7e0d39c8cc8f8af4fb2da201581cd2a8592ec9673a5840c18fea1044885f94518e954ab0cb2b6bb0a328d2afa1434254431a000186a0d87b9fd8799fd8799fd8799f581cb67e2b4f83bcfe7563727cf9da1a779b5784f35840f6f8dbc6b7766f997bffd8799fd8799fd8799f581cf4e27974423042e028de7fb4785810eb8e025c1df57b6e95891c12daffffffff1a001e8480d8799f58406c5840d787d1db8661561423a8d91992049405f377e15f0f606c1549d42651c71bed55af53cbfbf428cc4c85f7344712c7461d98ac64910240c28a501382d142e1cbff46ffffd87a80ffffffd8799fd8799f5820ccd04439b0ddb431a85cdc6370d0feabf116f63b4ccebd0b3358e5dd480ca57800ff5f5840d8799fd8799fd87a9f581cb4e57d911b37050e1eebc91d2ef137c5677edfc91923a95118f28a1cffd87a80ffa140a1401a0411b940d87b9fd87980ffd8799f58581f1c5d09adde9fdf0bb0cbf14180fa490a32b4031c67e83f766806b540feffffffffffff',
  },
  /** Deposit of 299 ada into head 915c743c by a key credential, Hydra 2.1.0. */
  depositV21: {
    tx_hash: '780405c8c68927d16867698635c4841a39886fad87c8b51d1ad382f6b3b7847f',
    output_index: 0,
    address: 'addr_test1wqzrpsd0hdcyppdex67hl4fskhr8gqyupwzl6x884py54kqh56v08',
    amount: [{ unit: 'lovelace', quantity: '299000000' }],
    inline_datum:
      'd8799f581c915c743c079446c4ef1099e29ac4b0a98d236620663dcc939ab0693f1b0000019f460dca7b9fd8799fd8799f58201df91d1f2c6aab9a004510bf1c4adeb95712b04ac6868d273d2b40df5eb1a2c900ff5f5840d8799fd8799fd8799f581c6bc787c1d7909620c60275d10da846cd448d710ce1acc1bd8b8cd435ffd8799fd8799fd8799f581cf6b304fe081314c1df5fd0f96f58238ecf914ed4e647ec4e9ec251335cc2ffffffffa140a1401a11d260c0d87980d87a80ffffffffff',
  },
  /** Deposit at the validator shared by Hydra 0.20.0 to 2.0.0, committing one key credential output. */
  depositV1: {
    tx_hash: 'c9bcfbb141f52def5feb7795fad6c88eb00b074a6a4511bb080dc757a1405f5a',
    output_index: 0,
    address: 'addr_test1wzhqrkk782wrgm2ujwhreceegy4epg9clqlefmrt4gjwxrqckxj2j',
    amount: [{ unit: 'lovelace', quantity: '25000000' }],
    inline_datum:
      'd8799f581c0bb9800f5ca9ff850cc0d4328978f4d0d67c16c7b49c56b7dd5770921b000001966571c3d59fd8799fd8799f5820bc0576bc057c864839a592d6a5f4330f980d9d3e269eaf352095b480105ab36001ff5f5840d8799fd8799fd8799f581cdcdc1c3ebd69660cfab24fcb905192740e32b406d9b1846309215320ffd8799fd8799fd8799f581ce7a15bc02c97204ea140a4499f5823a3c1e9cd75e1f7f55f1cb332ec8a8dffffffffa140a1401a017d7840d87980d87a80ffffffffff',
  },
  /** Deposit at the shared validator whose datum commits no outputs. */
  depositV1Empty: {
    tx_hash: 'a04f47f45ee658d99d5b19bed83e3929cab006dbf234cfe983dee01413e842a5',
    output_index: 0,
    address: 'addr_test1wzhqrkk782wrgm2ujwhreceegy4epg9clqlefmrt4gjwxrqckxj2j',
    amount: [{ unit: 'lovelace', quantity: '1077500' }],
    inline_datum:
      'd8799f581cbbbb8ba20aa6ec8671ad65fcc3b73693db43a64ddb3bc3cc1d888dcd1b0000019654ba6b8a80ff',
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
  /** The same head after its close transaction. */
  headV2Closed: {
    tx_hash: '991ca66dbb49250b06fa8819a78310842701554a8f6a642e5ccdfa674cb61409',
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
      'd87a9fd8799f581c324c8b8198c4c9db7526d6dccb79e992c4863b24b56453bb16995bdc9f582078c948f98b55d4c0b66e4247aac1378f1dad25c37786458c4c0f56b22d88c028ffd8799f19ea60ff0001801b000001a05d62c8305830987609283f9f463bb65637453c93070105344430c60d382508af2925058bc01c5bbc2b4a6039be55f90b7e4270f9eac51a001ff644ffff',
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
  /** Closed single-party head of payment key 4d688562, Hydra 2.3.0. */
  headV2ClosedLive: {
    tx_hash: 'e5b07d117c390f9b87694ed21ebedb50dbe3170d49c0a7bfeeaeb1b3f4e11933',
    output_index: 0,
    address: 'addr_test1wq4erflxvet45fr9hrrldflevr2cwr83x622vlejzhspf3gn6jry8',
    amount: [
      { unit: 'lovelace', quantity: '10103280' },
      {
        unit: '87e5931f96faa62899239102381dd637acd7d7b20752f070651f88904879647261486561645632',
        quantity: '1',
      },
      {
        unit: '87e5931f96faa62899239102381dd637acd7d7b20752f070651f88904d6885624e031c24dcf87fa672150660d81a706174b8470abacd0c28',
        quantity: '1',
      },
    ],
    inline_datum:
      'd87a9fd8799f581c87e5931f96faa62899239102381dd637acd7d7b20752f070651f88909f58205b7be834bc7eb7eeb1245d7dcce90c4046d4987e2b4be5fc2211df7340b839fbffd8799f1a02932e00ff0208801b0000019f780963485830b68533d31590f2b55e6d4f7706572e3508eca71dbd38a06c5749b45878b84dfbb057f1527e6fa8972159ff01495179d01a002017f0ffff',
  },
  /** Head part way through a partial fanout, Hydra 2.3.0. */
  headV2FanningOut: {
    tx_hash: 'f96e9b1375c44ac6865c19682df5043911f15682db436ba27948421d75ccc2f5',
    output_index: 0,
    address: 'addr_test1wq4erflxvet45fr9hrrldflevr2cwr83x622vlejzhspf3gn6jry8',
    amount: [
      { unit: 'lovelace', quantity: '232498020' },
      {
        unit: 'd7f3a349772cb36206c2005f108b77bdad46da96b1a6378702feed004879647261486561645632',
        quantity: '1',
      },
      {
        unit: 'd7f3a349772cb36206c2005f108b77bdad46da96b1a6378702feed007099552de5127f5ca4f671d47f6ab785a2a676fb415d4329e9459bf6',
        quantity: '1',
      },
      {
        unit: 'd7f3a349772cb36206c2005f108b77bdad46da96b1a6378702feed00cde0c82d83345bbdde6d8c560702799b5fb196ec1f5a046a022915bd',
        quantity: '1',
      },
    ],
    inline_datum:
      'd87c9fd8799f581cd7f3a349772cb36206c2005f108b77bdad46da96b1a6378702feed009f582081814b2bab84dbde831b5a7fcc59fe5e3933815149a066af3af8f5e474618678582043da01357a570626abb64152d19bd9e16505b870faf0239172dcec7027e790c7ff1b0000019fdc6a07205830ae2e3e7582500cd16429e32f2054b4f6881914116e8004bdeb324604eb6b9aca163c2a5dc95ee061d886083e5aeee0981a00266830ffff',
  },
  /** Initial head before collect, Hydra 1.3.0. Participation tokens sit at the initial validator, not here. */
  headV1Initial: {
    tx_hash: '5d439be4e71ff2271d693096b6221c6ba8a14aacecfc481ce78e4630adcc4991',
    output_index: 0,
    address: 'addr_test1wptc3k5fdxcphvwel4ah3vxumxyw72cag5v7ph4wv4kw75c0m8ju2',
    amount: [
      { unit: 'lovelace', quantity: '1741240' },
      {
        unit: '5e6a9dff5a09e1bbb4629828c4b35b7283d20471d89d3aa6752e3aad4879647261486561645631',
        quantity: '1',
      },
    ],
    inline_datum:
      'd8799fd8799f1a02932e00ff9f5820cea20bee39936e1f1cf05de5ded5616da5b222c16ec7bba5dd6b0206017195df5820481439f01d219dad1572e5ba6aeda25530e2f639a35e10a42e7603cb603463e4ff581c5e6a9dff5a09e1bbb4629828c4b35b7283d20471d89d3aa6752e3aadd8799f58207f062174a17606e577c507badd81fdf914133c149f0dd7841995be21ebcb857501ffff',
  },
  /** Open two-party head, Hydra 1.3.0. */
  headV1Open: {
    tx_hash: '8c9be8f7b3367b9ffdcf7e9ecbf102dda029f4f2da82d255f2b07f1e15c0b99e',
    output_index: 0,
    address: 'addr_test1wptc3k5fdxcphvwel4ah3vxumxyw72cag5v7ph4wv4kw75c0m8ju2',
    amount: [
      { unit: 'lovelace', quantity: '433503669' },
      {
        unit: '33564663e57d82a7eea85f75e1207d806b14aeec53bf8df58686d3e561647364',
        quantity: '998916667',
      },
      {
        unit: 'e4a912c2d066420b341112415cc2c3bce75a6976f5b91fe6f26651f4061c1bb1394bcdd7180b7b3885e9dcc3a69849be473a771272837986',
        quantity: '1',
      },
      {
        unit: 'e4a912c2d066420b341112415cc2c3bce75a6976f5b91fe6f26651f44879647261486561645631',
        quantity: '1',
      },
      {
        unit: 'e4a912c2d066420b341112415cc2c3bce75a6976f5b91fe6f26651f4b887bd9223e6daff0e70c3faba0c7f5b7f54ae6b475f098c690684d3',
        quantity: '1',
      },
    ],
    inline_datum:
      'd87a9fd8799f581ce4a912c2d066420b341112415cc2c3bce75a6976f5b91fe6f26651f49f58204b98b0470e86d6953514f134fe6b7e80d8b59ddf360870541572d1fd48add7bb5820245f67326d144a16cd07783c607cbae0d79e437d3bd8814be006e6198ae169d8ffd8799f1a02932e00ff0758203945488b5b05df7dd27ea5fd58f75d9d099b11b02bb353312ab055a8e801cbc3ffff',
  },
  /** Closed head, Hydra 1.3.0. */
  headV1Closed: {
    tx_hash: '0f6d68175d064602e5aae14e469627824c1a5c32f29278328d3c0315efbd5231',
    output_index: 0,
    address: 'addr_test1wptc3k5fdxcphvwel4ah3vxumxyw72cag5v7ph4wv4kw75c0m8ju2',
    amount: [
      { unit: 'lovelace', quantity: '57887700' },
      {
        unit: '0e3d5ba6551e9703241aad239e4a27efa80243bc935b5abc0b10719400259a20ad15b90133525a924897e0914959d68fffb6597e807bf8599989292d',
        quantity: '1',
      },
      {
        unit: '22b42bad850ac6515471da16548fc23c798b18c33cda8c06df48a39f4879647261486561645631',
        quantity: '1',
      },
      {
        unit: '22b42bad850ac6515471da16548fc23c798b18c33cda8c06df48a39f4ab95844bfa4a45a9a414dfd00bd7b94a7cf1937525b565a9fc211a3',
        quantity: '1',
      },
    ],
    inline_datum:
      'd87b9fd8799f581c22b42bad850ac6515471da16548fc23c798b18c33cda8c06df48a39f9f582097bc3248065602407abaf8b34608f5bee7ffc30baff75c5e22add8a5a8ca73c2ffd8799f1a0001d4c0ff000458200ef8dae1dd040e71eca02f83687e725521c43e5718f097ff480915f63770b8135820e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b8555820e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855801b0000019d5b532588ffff',
  },
  /** Closed head with four participation tokens, Hydra 1.0.0. */
  headV1ClosedFourParties: {
    tx_hash: '129610180d9a6f293b57755e65ccf1125dfec4e25e07f3832467028847c2e161',
    output_index: 0,
    address: 'addr_test1wzs5gta0ym2wcsy79a32dpwp6jynlrttewhhhj6e6mapxsq390hx3',
    amount: [
      { unit: 'lovelace', quantity: '26197700' },
      {
        unit: '64bf7ade7b4d82ae1e953d4aa80413e67cf693ba7c0804726803c998',
        quantity: '2',
      },
      {
        unit: 'ca55c4b1468c7dfb27a0cdb5a0d5e970a613d8e774cee33f39c219f0376ca49fdbff2ebc082141951e55038468b51230e90cfc0000004204',
        quantity: '1',
      },
      {
        unit: 'ca55c4b1468c7dfb27a0cdb5a0d5e970a613d8e774cee33f39c219f04879647261486561645631',
        quantity: '1',
      },
      {
        unit: 'ca55c4b1468c7dfb27a0cdb5a0d5e970a613d8e774cee33f39c219f08ae582467f58e7b4e1c2a76c36bc9fe9a40407ef34b0dacfb52eec61',
        quantity: '1',
      },
      {
        unit: 'ca55c4b1468c7dfb27a0cdb5a0d5e970a613d8e774cee33f39c219f09720b632701aabb325d5928b66811d624d650287c2e0e099e1eeb510',
        quantity: '1',
      },
      {
        unit: 'ca55c4b1468c7dfb27a0cdb5a0d5e970a613d8e774cee33f39c219f0cb1da3f22432d3bb64b85d2cca0c0658282db2348fe651a44208efeb',
        quantity: '1',
      },
      {
        unit: 'faa864cea71bfa9973d91f650af89e4f72cbba273468ab4593dbf5fe',
        quantity: '1',
      },
    ],
    inline_datum:
      'd87b9fd8799f581cca55c4b1468c7dfb27a0cdb5a0d5e970a613d8e774cee33f39c219f09f582049ae529500d8fd845a5acb36a36665c01fcd27c894c9ff06c6251497841685e458206c8b4e01b9997b517177b6d0b06faa290d4fdf235d8678546ddd9ca5b2852aed58208896163f0bedb7cdfdeb89da89b3736543452b8c7234d35065a86678a301f8385820b7fc1074d903c5b252e5509cb864c0c84acd3df3576dad12d7c3733408d7206affd8799f19ea60ff000a5820292bbd9429d9eed669f14475d87e68f962eaf1108fc92476ec70f54d5cc5825b5820e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b8555820e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855801b00000199b89a50a8ffff',
  },
  /** Open head with its record inline on the constructor, Hydra 0.15.0. */
  head015Open: {
    tx_hash: '55c3205bd417c3efac4f17626f17779dd6d05d824468ac13b661be2a6aeadbd2',
    output_index: 0,
    address: 'addr_test1wparveslts27nutc8t42hzggztzeku5xew7xmemz6vgswusswq7ec',
    amount: [
      { unit: 'lovelace', quantity: '102896320' },
      {
        unit: '92bf63e07127532df310ee5e28cc9c2e6dfebb198319553167ca6eb10fbb3b449ec56a325429b64938188ac3de523a7c1ade025638c1e125',
        quantity: '1',
      },
      {
        unit: '92bf63e07127532df310ee5e28cc9c2e6dfebb198319553167ca6eb14879647261486561645631',
        quantity: '1',
      },
    ],
    inline_datum:
      'd87a9fd8799f19ea60ff9f5820ad9bdc6b45f418dba8ca2103081a96c2df0c0c923e5a13df0e9100289d9cb087ff582020692a7ef26573713ababf378e3abad61fdee1cfe9d79cf5afb12e609a777a07581c92bf63e07127532df310ee5e28cc9c2e6dfebb198319553167ca6eb1ff',
  },
  /** Closed head with its record inline on the constructor, Hydra 0.15.0. */
  head015Closed: {
    tx_hash: 'cd5917b70ae0607733439dbcaca8906e0eafccd63c3ecb4e0397cace28877e6c',
    output_index: 0,
    address: 'addr_test1wparveslts27nutc8t42hzggztzeku5xew7xmemz6vgswusswq7ec',
    amount: [
      { unit: 'lovelace', quantity: '102896320' },
      {
        unit: '33a01500135d5b8cf9798726722a0813ceca4edef2bd15538942b5020fbb3b449ec56a325429b64938188ac3de523a7c1ade025638c1e125',
        quantity: '1',
      },
      {
        unit: '33a01500135d5b8cf9798726722a0813ceca4edef2bd15538942b5024879647261486561645631',
        quantity: '1',
      },
    ],
    inline_datum:
      'd87b9f9f5820ad9bdc6b45f418dba8ca2103081a96c2df0c0c923e5a13df0e9100289d9cb087ff0358206f6f2c3630b654437d0c3ce7045b1de1368bdb10acf166c3de3e49a6a272ffda1b0000018d60569700d8799f19ea60ff581c33a01500135d5b8cf9798726722a0813ceca4edef2bd15538942b50280ff',
  },
  /** Closed two-party head with an optional delta UTxO hash, Hydra 0.18.0. */
  head018Closed: {
    tx_hash: '781b153e3a3d579e6829bca6e7c340016274faead5ba59201b2bc8f9b70fdfcb',
    output_index: 0,
    address: 'addr_test1wz7eltfrtjr3ldlcxlrkwkfsrz5yhccg8luql8dttuw9t7gqyv9ga',
    amount: [
      { unit: 'lovelace', quantity: '1272335860' },
      {
        unit: '32ea2301d2d2c973b5874eefd3f6be0b65d087b4f54d3a659a8483e01a88a7ba69af29090b82ef5896cc8e1fd6480345357172b9776fcc64',
        quantity: '1',
      },
      {
        unit: '32ea2301d2d2c973b5874eefd3f6be0b65d087b4f54d3a659a8483e04879647261486561645631',
        quantity: '1',
      },
      {
        unit: '32ea2301d2d2c973b5874eefd3f6be0b65d087b4f54d3a659a8483e0998635d31e13c650f446ad4764f89e162d4ab0a1f54df1702253248d',
        quantity: '1',
      },
      {
        unit: '77211b30313564b8b11db9c9de94addc5fa305f5d47fd278140eef63534f44495441',
        quantity: '50000',
      },
    ],
    inline_datum:
      'd87b9fd8799f581c32ea2301d2d2c973b5874eefd3f6be0b65d087b4f54d3a659a8483e09f5820baf8ad0d117f123e56ff9b42c09d102aab133ca270eb68a6ff334f5ea18052b358206722986bcab2655094c6e3e5099fe35529c65b7a472eeb7e12a9ce1982205874ffd8799f19ea60ff000158201d086fd6789989b992ed08b426f8bb2eaefd6e0fd95d2b1395e657fa4a1d82dbd8799f5820e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855ff801b00000191770e0060ffff',
  },
  /** Closed single-party head with a nine-field closed record, Hydra 0.19.0. */
  head019Closed: {
    tx_hash: '1aa03d1eec77877ef6acd3ca8df63582a4b03f60a8916f16dba08b3fd3a8ccf1',
    output_index: 0,
    address: 'addr_test1wqhwga7xpquex6lynfgqxp5ssed4hm2dhrxj7pdly4dvdqqyn5nxg',
    amount: [
      { unit: 'lovelace', quantity: '7727959' },
      {
        unit: '403e7aa80ce8576d692d5507ccbfed6feec90fc0bae3361b726c52944879647261486561645631',
        quantity: '1',
      },
      {
        unit: '403e7aa80ce8576d692d5507ccbfed6feec90fc0bae3361b726c529484d011433cc392e2ffca0725c747f5fa9dfb958808d718640cc92da6',
        quantity: '1',
      },
    ],
    inline_datum:
      'd87b9fd8799f581c403e7aa80ce8576d692d5507ccbfed6feec90fc0bae3361b726c52949f5820147797b709663fec73316be9240c0e3d78dc448d2f42ba485f3255f045c8c1bbffd8799f19ea60ff00015820db984c609828fd021efc8ff6d255d4448dda31bd5c7fe1abc3dd8229f18e51185820e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855801b0000019392afb528ffff',
  },
  /** Open head whose record starts with the head seed, Hydra 2.0.0. */
  head200Open: {
    tx_hash: 'f5bf2e50a1d0e738d6444ef2319bc612585e93bf75bef5dc6f7c0e2e569748dc',
    output_index: 0,
    address: 'addr_test1wqsl5mhyp654wpp28hhghtnfk9w8akypq2l8ajc9dky3rvsa2vhh8',
    amount: [
      { unit: 'lovelace', quantity: '1896400' },
      {
        unit: '95e30221a4aedb141f4b0573cd4597c4886273efd84f1b53e34aa8c6305fc77760a60bdefd5397c44dd8395e92e527ff40f0a39a61b17115',
        quantity: '1',
      },
      {
        unit: '95e30221a4aedb141f4b0573cd4597c4886273efd84f1b53e34aa8c64879647261486561645632',
        quantity: '1',
      },
    ],
    inline_datum:
      'd8799fd8799fd8799f58206280a68af74f46b167d8ae7d038a163a55a9c89a28d2f127ef8afa37e974e09101ff581c95e30221a4aedb141f4b0573cd4597c4886273efd84f1b53e34aa8c69f5820afc16d9041f4693d73107145f09864bf913e6957ff444e665a21858ea0670ea4ffd8799f1a02932e00ff005820e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855ffff',
  },
  /** Closed head of the same participant, Hydra 2.0.0. */
  head200Closed: {
    tx_hash: '6280a68af74f46b167d8ae7d038a163a55a9c89a28d2f127ef8afa37e974e091',
    output_index: 0,
    address: 'addr_test1wqsl5mhyp654wpp28hhghtnfk9w8akypq2l8ajc9dky3rvsa2vhh8',
    amount: [
      { unit: 'lovelace', quantity: '2068800' },
      {
        unit: 'ca23701fa1cead9c450016c009f981a9328b775e454307d63e650fcc305fc77760a60bdefd5397c44dd8395e92e527ff40f0a39a61b17115',
        quantity: '1',
      },
      {
        unit: 'ca23701fa1cead9c450016c009f981a9328b775e454307d63e650fcc4879647261486561645632',
        quantity: '1',
      },
    ],
    inline_datum:
      'd87a9fd8799f581cca23701fa1cead9c450016c009f981a9328b775e454307d63e650fcc9f5820afc16d9041f4693d73107145f09864bf913e6957ff444e665a21858ea0670ea4ffd8799f1a02932e00ff00005820e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b8555820e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b8555820e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855801b0000019d583b3ef8ffff',
  },
  /** Open single-party head, Hydra 2.1.0. */
  head210Open: {
    tx_hash: '4ba24194b5f1b33c97ba49c45288621324c38cb5b69bfeef1d01c67c218a00bb',
    output_index: 0,
    address: 'addr_test1wp8y3t7dsl5883sc4cqwuzgd2tsy28eayhcm05lrjlpsk0shksg9n',
    amount: [
      { unit: 'lovelace', quantity: '1887780' },
      {
        unit: 'f6a10f4d035dd2e37e38c06ebba428a964923674f86431d75543f36d4879647261486561645632',
        quantity: '1',
      },
      {
        unit: 'f6a10f4d035dd2e37e38c06ebba428a964923674f86431d75543f36dccdbd4465da79f9dff67e9da89b000129dde95815bbc7948aed36772',
        quantity: '1',
      },
    ],
    inline_datum:
      'd8799fd8799fd8799f5820efc01d22feaffbf6893aa0165ad753cf30fe1fd95d9a700befb1318b5c78d7b200ff581cf6a10f4d035dd2e37e38c06ebba428a964923674f86431d75543f36d9f582043e12c1d1ef4cbc5ccf45b7334698d6972766d3b06a7ef1d3318fdb5ceb1e521ffd8799f19ea60ff005820e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855ffff',
  },
  /** Closed head with three participation tokens, Hydra 2.1.0. */
  head210ClosedThreeParties: {
    tx_hash: 'a0f8fdcfabdd67b174d386111b6f0893e7c3252b4948c73665add55d6adbc13b',
    output_index: 0,
    address: 'addr_test1wp8y3t7dsl5883sc4cqwuzgd2tsy28eayhcm05lrjlpsk0shksg9n',
    amount: [
      { unit: 'lovelace', quantity: '10041523255' },
      {
        unit: '31ce99eebf17fd16e25625f413ddefbb0f07f9d6a764280ddbed10ac4879647261486561645632',
        quantity: '1',
      },
      {
        unit: '31ce99eebf17fd16e25625f413ddefbb0f07f9d6a764280ddbed10ac4fb53f7aa3e07e3f3ba8516ed345119e9841822385c0307311209b41',
        quantity: '1',
      },
      {
        unit: '31ce99eebf17fd16e25625f413ddefbb0f07f9d6a764280ddbed10ac5ecf89bf0e00eaf8667d9ff9bb92c6faac2fbcc6ff71ce9a8d6c5033',
        quantity: '1',
      },
      {
        unit: '31ce99eebf17fd16e25625f413ddefbb0f07f9d6a764280ddbed10ac96c6d56eb5b0b80595fa11df3cccbdf8523a0f6d869ea162be0fde23',
        quantity: '1',
      },
    ],
    inline_datum:
      'd87a9fd8799f581c31ce99eebf17fd16e25625f413ddefbb0f07f9d6a764280ddbed10ac9f58208c69cf05a794ae72151dbd7522d9398daf30b14d0a8f9972e31f76fb14b0b4f15820a65dd1af5d938e394b05198b97870a33343d3dd2ec8feb8906a2cbbd2cc0ac96582032bce7668b68bcc66750963217e50244fb7a9495053fb787fd5480aa1e509366ffd8799f1a000493e0ff0a18195820f55e90bf8b712d12e4f73474504ca945094f101024dd6d6f34e263b7de6fc0b55820c11e7402179f0156fb35c94be8d4331673b7674ba03e476123a3dfd29b76c5825820e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855801b0000019e9388c290ffff',
  },
  /** Open single-party head, Hydra 2.2.0. */
  head220Open: {
    tx_hash: 'eb5720128cfa017c0c1c8e03fad1d8a651b23167cd0bf5e783eb3019a9ae3695',
    output_index: 0,
    address: 'addr_test1wr7htcjvn653tn5wfrfl78gv2jksnnqprywzgst26ld6fgcn3usg2',
    amount: [
      { unit: 'lovelace', quantity: '2094660' },
      {
        unit: '4e2d26c1b1041b61501deef72ff004fb34c5fba41fe79ec4ca204e4d33f5db6245ae537883b3f9cf35b2a8592b45935d814e66007a6eb46e',
        quantity: '1',
      },
      {
        unit: '4e2d26c1b1041b61501deef72ff004fb34c5fba41fe79ec4ca204e4d4879647261486561645632',
        quantity: '1',
      },
    ],
    inline_datum:
      'd8799fd8799fd8799f5820070993f1b3e051bb52a129c120c6c29d0e772a85a541bf31ce1904dfce75d30a06ff581c4e2d26c1b1041b61501deef72ff004fb34c5fba41fe79ec4ca204e4d9f5820d17787dc73a50a994149d3bca818ca4accd1c626d76a407fcf44f069cb379583ffd8799f192710ff00582034758143d508cf8e757b5298b216d453759175423c5987685c8c043713bebc311a001ff644ffff',
  },
} satisfies Record<string, HydraBlockfrostUtxo>;

/**
 * Spent inputs and outputs of Preprod Hydra transactions, without collateral
 * and reference inputs.
 */
export const preprodTxs = {
  /** Transaction c1a8300f3d89c7feca5a91561329d205574170d5886e7bfb384558b5b89759a7. */
  depositTx: {
    inputs: [
      {
        address:
          'addr_test1vzapupn6h7c8anvr8nk8qpdg42yuhhcfuyxkepamw0dfudgk46y8x',
      },
      {
        address:
          'addr_test1qzapupn6h7c8anvr8nk8qpdg42yuhhcfuyxkepamw0dfuddvy3kkxepv7ha6x2mtvpgkhz4lf48fymayyagdkxp5zsrqu57a0v',
      },
    ],
    outputs: [
      {
        address:
          'addr_test1wrrcaryjq4epavl0gsg08kuuv95l5md5jlpyvswjnss998qyu7lhm',
        inlineDatum:
          'd8799f581c324c8b8198c4c9db7526d6dccb79e992c4863b24b56453bb16995bdc1b000001a05d17b3df9fd8799fd8799f5820e2f094efbbf8e363b9d02c7b5c61f89abdd6b839161d3a01638a882356ef96b101ff5f5840d8799fd8799fd8799f581cba1e067abfb07ecd833cec7005a8aa89cbdf09e10d6c87bb73da9e35ffd8799fd8799fd8799f581cac246d63642cf5fba32b6b605158236b8abf4d4e926fa42750db18341406ffffffffa140a1401a004699f3d87980d87a80ffffffffff',
      },
      {
        address:
          'addr_test1vzapupn6h7c8anvr8nk8qpdg42yuhhcfuyxkepamw0dfudgk46y8x',
      },
    ],
  },
  /** Transaction ec46e4746c1fa79697ebae7d3c19bef0c59f544cb48649c71bdef3348c943b4d. */
  recoverTx: {
    inputs: [
      {
        address:
          'addr_test1wrrcaryjq4epavl0gsg08kuuv95l5md5jlpyvswjnss998qyu7lhm',
        inlineDatum:
          'd8799f581c324c8b8198c4c9db7526d6dccb79e992c4863b24b56453bb16995bdc1b000001a05d17b3df9fd8799fd8799f5820e2f094efbbf8e363b9d02c7b5c61f89abdd6b839161d3a01638a882356ef96b101ff5f5840d8799fd8799fd8799f581cba1e067abfb07ecd833cec7005a8aa89cbdf09e10d6c87bb73da9e35ffd8799fd8799fd8799f581cac246d63642cf5fba32b6b605158236b8abf4d4e926fa42750db18341406ffffffffa140a1401a004699f3d87980d87a80ffffffffff',
      },
      {
        address:
          'addr_test1vzapupn6h7c8anvr8nk8qpdg42yuhhcfuyxkepamw0dfudgk46y8x',
      },
    ],
    outputs: [
      {
        address:
          'addr_test1qzapupn6h7c8anvr8nk8qpdg42yuhhcfuyxkepamw0dfuddvy3kkxepv7ha6x2mtvpgkhz4lf48fymayyagdkxp5zsrqu57a0v',
      },
      {
        address:
          'addr_test1vzapupn6h7c8anvr8nk8qpdg42yuhhcfuyxkepamw0dfudgk46y8x',
      },
    ],
  },
  /** Transaction 52142a19d274fb321e289f0c5209778b2c3c14df4bc83618334d1f5634706080. */
  initTx: {
    inputs: [
      {
        address:
          'addr_test1vzapupn6h7c8anvr8nk8qpdg42yuhhcfuyxkepamw0dfudgk46y8x',
      },
    ],
    outputs: [
      {
        address:
          'addr_test1wq4erflxvet45fr9hrrldflevr2cwr83x622vlejzhspf3gn6jry8',
        inlineDatum:
          'd8799fd8799fd8799f5820e2f094efbbf8e363b9d02c7b5c61f89abdd6b839161d3a01638a882356ef96b100ff581c324c8b8198c4c9db7526d6dccb79e992c4863b24b56453bb16995bdc9f582078c948f98b55d4c0b66e4247aac1378f1dad25c37786458c4c0f56b22d88c028ffd8799f19ea60ff00582034758143d508cf8e757b5298b216d453759175423c5987685c8c043713bebc311a001ff644ffff',
      },
      {
        address:
          'addr_test1vzapupn6h7c8anvr8nk8qpdg42yuhhcfuyxkepamw0dfudgk46y8x',
      },
    ],
  },
  /** Transaction 6886062e8fead16af440ca5e83c989e15f16973b7f9e8b529191ecab595a39e3. */
  incrementTx: {
    inputs: [
      {
        address:
          'addr_test1wq4erflxvet45fr9hrrldflevr2cwr83x622vlejzhspf3gn6jry8',
        inlineDatum:
          'd8799fd8799fd8799f5820f26fdd2181e1259d547a3e15da3e8bf5967407a90a11018202c5fcba562f094f00ff581c3ad15325e8efc631345be31a9ed3d4d1cc156aaf2a805dda4fa334149f58203cded55fce992ee232fcd02620c2298f7b0fc2691c1de2e28b6aeff659f4fe6458206f41581ab667249e4a63ca4bb6292a9f6db30eb96bd2402cdbc6834180ee8b45ffd8799f1a0036ee80ff015820fbeb28f218f9e1469ee711fc6e3bfd3e9cd00041ff6b4edd3db8f4245358c7e71a00266830ffff',
      },
      {
        address:
          'addr_test1vqcszc7kyks8n5chay2glcvz8dszdxel8yf3zvcdqjm3luqgnktcu',
      },
      {
        address:
          'addr_test1wrrcaryjq4epavl0gsg08kuuv95l5md5jlpyvswjnss998qyu7lhm',
        inlineDatum:
          'd8799f581c3ad15325e8efc631345be31a9ed3d4d1cc156aaf2a805dda4fa334141b000001a0ab33f55f9fd8799fd8799f5820d640b92b0f0504e14519baa13235524d9add56f4b7b0c3f75bf0925916594a0200ff5f5840d8799fd8799fd8799f581cab49237a09aa8d9a2ddf7e4db28a5d3dd0bed8b79422263a71e142fcffd8799fd8799fd8799f581ceb1d59b5a03507b2af7c266be95827f2d01e4844ad17cd709e05d2ee8ff3ffffffffa140a1401b000000011e1a3000d87980d87a80ffffffffff',
      },
    ],
    outputs: [
      {
        address:
          'addr_test1wq4erflxvet45fr9hrrldflevr2cwr83x622vlejzhspf3gn6jry8',
        inlineDatum:
          'd8799fd8799fd8799f5820f26fdd2181e1259d547a3e15da3e8bf5967407a90a11018202c5fcba562f094f00ff581c3ad15325e8efc631345be31a9ed3d4d1cc156aaf2a805dda4fa334149f58203cded55fce992ee232fcd02620c2298f7b0fc2691c1de2e28b6aeff659f4fe6458206f41581ab667249e4a63ca4bb6292a9f6db30eb96bd2402cdbc6834180ee8b45ffd8799f1a0036ee80ff025820d0b447c853e29ab38076a47ddfa21ec399f884668503865835dc6e2ffa5cda4b1a00266830ffff',
      },
      {
        address:
          'addr_test1vqcszc7kyks8n5chay2glcvz8dszdxel8yf3zvcdqjm3luqgnktcu',
      },
    ],
  },
  /** Transaction 991ca66dbb49250b06fa8819a78310842701554a8f6a642e5ccdfa674cb61409. */
  closeTx: {
    inputs: [
      {
        address:
          'addr_test1vzapupn6h7c8anvr8nk8qpdg42yuhhcfuyxkepamw0dfudgk46y8x',
      },
      {
        address:
          'addr_test1wq4erflxvet45fr9hrrldflevr2cwr83x622vlejzhspf3gn6jry8',
        inlineDatum:
          'd8799fd8799fd8799f5820e2f094efbbf8e363b9d02c7b5c61f89abdd6b839161d3a01638a882356ef96b100ff581c324c8b8198c4c9db7526d6dccb79e992c4863b24b56453bb16995bdc9f582078c948f98b55d4c0b66e4247aac1378f1dad25c37786458c4c0f56b22d88c028ffd8799f19ea60ff00582034758143d508cf8e757b5298b216d453759175423c5987685c8c043713bebc311a001ff644ffff',
      },
    ],
    outputs: [
      {
        address:
          'addr_test1wq4erflxvet45fr9hrrldflevr2cwr83x622vlejzhspf3gn6jry8',
        inlineDatum:
          'd87a9fd8799f581c324c8b8198c4c9db7526d6dccb79e992c4863b24b56453bb16995bdc9f582078c948f98b55d4c0b66e4247aac1378f1dad25c37786458c4c0f56b22d88c028ffd8799f19ea60ff0001801b000001a05d62c8305830987609283f9f463bb65637453c93070105344430c60d382508af2925058bc01c5bbc2b4a6039be55f90b7e4270f9eac51a001ff644ffff',
      },
      {
        address:
          'addr_test1vzapupn6h7c8anvr8nk8qpdg42yuhhcfuyxkepamw0dfudgk46y8x',
      },
    ],
  },
  /** Transaction d887151d1a85c7d1d04157b0e207888b671d2a35d420490a7843aca42f60bec9. */
  partialFanoutTx: {
    inputs: [
      {
        address:
          'addr_test1wq4erflxvet45fr9hrrldflevr2cwr83x622vlejzhspf3gn6jry8',
        inlineDatum:
          'd87c9fd8799f581c519cad63f33930a82a0d38cb2e7ab7b990f701e85de11d6dac92d7929f582012be25b31829d51c53105a95b7a7261813f2821d835f3be65945f47762bed5ad5820453c2f259f64f66eb535cd4969e480eaa6339bfc9b81175392a990b2be36224dff1b000001a0aa9c50305830a484571ce291df4d34f8fd0eb544cac414b624dc81a442a46aad6ed8759c2ee333bfdc6a69fb983a70bffe56c31eecfa1a00266830ffff',
      },
      {
        address:
          'addr_test1vrk9h3u5rj42gy6qh0uvnka45fgzcsf74zjaqztgeg3ry5sk2rrgn',
      },
    ],
    outputs: [
      {
        address:
          'addr_test1wq4erflxvet45fr9hrrldflevr2cwr83x622vlejzhspf3gn6jry8',
        inlineDatum:
          'd87c9fd8799f581c519cad63f33930a82a0d38cb2e7ab7b990f701e85de11d6dac92d7929f582012be25b31829d51c53105a95b7a7261813f2821d835f3be65945f47762bed5ad5820453c2f259f64f66eb535cd4969e480eaa6339bfc9b81175392a990b2be36224dff1b000001a0aa9c5030583087984c58febd103cf306af8918a7d5513ff524c50305806c84370b94874d5f47ee7b51b9b79332d9402e336a078197741a00266830ffff',
      },
      {
        address:
          'addr_test1wzs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgn37w4g',
        inlineDatum:
          'd8799fd8799fd8799f581c61d147d9987a8f11f3689b17f4f64629d24dd9c7284aa4b8cc2778beffd8799fd8799fd8799f581ce9bf8fd1eac246706f7cf4bf996e196b5254806be1f3e17832a61ab1ffffffffd8799fd8799fd8799f581c61d147d9987a8f11f3689b17f4f64629d24dd9c7284aa4b8cc2778beffd8799fd8799fd8799f581ce9bf8fd1eac246706f7cf4bf996e196b5254806be1f3e17832a61ab1ffffffffffd8799fd8799f581cbfbeb41470c50a117e555921175e828c91dfb3195abf0f597b58a650ffd8799fd8799fd8799f581c89239da3347ffd747c864eebb6a726f390b608f2ca83829905e39500ffffffffd87a80582aa401010327200621582089c89162eb58f1e999f218160793565d1f13f5b46c8941244c1ae4e47149152f5f5840845869a3012704582089c89162eb58f1e999f218160793565d1f13f5b46c8941244c1ae4e47149152f6761646472657373583900bfbeb41470c50a117e5559215840175e828c91dfb3195abf0f597b58a65089239da3347ffd747c864eebb6a726f390b608f2ca83829905e39500a166686173686564f4582083c5ac1f3bcf293d2d584000bf3bb5ada58165b2ce7a21641517a904b7430b4588475840e824e97c14d29aed8c361959cc3b820109620ea5f1da3770fa4c544ea7b6366361009f2c6ab8a6581915069b948c3bc52170cac8245184848351fe8e93dad926db00ff5820eb2685e9273c10e96735c4d6777aa99ebdd991b427a8f1255d1c4b40ab607232487b79ee59fce1af58583c67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b1092afba73a452f0293811d884ca6ea2992a8529273caf4a480ee6192f0000001a0036d8dc58204d73f358cc99fd5aa3eb755d6245bd98beeb05ad16e7ad95f6e2ef3eace06c32401b000001a0aa710ccf1b000001a0aa835c4f1b000001a0aa95abcf1b000001a0aaa7fb4f0000d87980ff',
      },
      {
        address:
          'addr_test1qpsaz37enpag7y0ndzd30a8kgc5aynwecu5y4f9cesnh30hfh78ar6kzgecx7l85h7vkuxtt2f2gq6lp70shsv4xr2csmd0pmv',
      },
      {
        address:
          'addr_test1wzs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgn37w4g',
        inlineDatum:
          'd8799fd8799fd8799f581c61d147d9987a8f11f3689b17f4f64629d24dd9c7284aa4b8cc2778beffd8799fd8799fd8799f581ce9bf8fd1eac246706f7cf4bf996e196b5254806be1f3e17832a61ab1ffffffffd8799fd8799fd8799f581c61d147d9987a8f11f3689b17f4f64629d24dd9c7284aa4b8cc2778beffd8799fd8799fd8799f581ce9bf8fd1eac246706f7cf4bf996e196b5254806be1f3e17832a61ab1ffffffffffd8799fd8799f581cbfbeb41470c50a117e555921175e828c91dfb3195abf0f597b58a650ffd8799fd8799fd8799f581c89239da3347ffd747c864eebb6a726f390b608f2ca83829905e39500ffffffffd87a80582aa401010327200621582089c89162eb58f1e999f218160793565d1f13f5b46c8941244c1ae4e47149152f5f5840845869a3012704582089c89162eb58f1e999f218160793565d1f13f5b46c8941244c1ae4e47149152f6761646472657373583900bfbeb41470c50a117e5559215840175e828c91dfb3195abf0f597b58a65089239da3347ffd747c864eebb6a726f390b608f2ca83829905e39500a166686173686564f458206c4026539677d98a3b584056a7c2caad2f205f8b618517aaeffdab87804b79c0b7b6584018242c10bc68b034737c6e72f3e4dd00a54a34c46abe6d12575b81fd1ee00418e8c34e0398129f58196dd21764c1ed270873cea3b4454cfbb5f5757d404fe2c7d00fff5820239811f007d440b4659bd5849369c39a7cf7ec9d9fe647c74645c2fca4d8769a483189595468abbdd0583c67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b1092afba73a452f0293811d884ca6ea2992a8529273caf4a480ee6192f0000001a0036d8dc5820cf75d00d610159df988a6032e0fd30c1ce2f2fa59735740fb92db65629a3a139401b000001a0aa75cdcc1b000001a0aa881d4c1b000001a0aa9a6ccc1b000001a0aaacbc4c0000d87980ff',
      },
      {
        address:
          'addr_test1qpsaz37enpag7y0ndzd30a8kgc5aynwecu5y4f9cesnh30hfh78ar6kzgecx7l85h7vkuxtt2f2gq6lp70shsv4xr2csmd0pmv',
      },
      {
        address:
          'addr_test1wzs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgn37w4g',
        inlineDatum:
          'd8799fd8799fd8799f581c61d147d9987a8f11f3689b17f4f64629d24dd9c7284aa4b8cc2778beffd8799fd8799fd8799f581ce9bf8fd1eac246706f7cf4bf996e196b5254806be1f3e17832a61ab1ffffffffd8799fd8799fd8799f581c61d147d9987a8f11f3689b17f4f64629d24dd9c7284aa4b8cc2778beffd8799fd8799fd8799f581ce9bf8fd1eac246706f7cf4bf996e196b5254806be1f3e17832a61ab1ffffffffffd8799fd8799f581cbfbeb41470c50a117e555921175e828c91dfb3195abf0f597b58a650ffd8799fd8799fd8799f581c89239da3347ffd747c864eebb6a726f390b608f2ca83829905e39500ffffffffd87a80582aa401010327200621582089c89162eb58f1e999f218160793565d1f13f5b46c8941244c1ae4e47149152f5f5840845869a3012704582089c89162eb58f1e999f218160793565d1f13f5b46c8941244c1ae4e47149152f6761646472657373583900bfbeb41470c50a117e5559215840175e828c91dfb3195abf0f597b58a65089239da3347ffd747c864eebb6a726f390b608f2ca83829905e39500a166686173686564f45820320ee3f54829c48dd85840555cbdefc235f1c33e83479f40a447bc28d8278cdd96dc584090d45e52a6dbc2c5261429e7dd69d993d66b27f99fe3c69f48a31abc872b686d4178bf3f2399525819a245226a68c842ce2a65b5ca97bc576d126ecacf549c939f00ff5820643b76ee0f7202c8bdbcf24a77681383af03cbbec75bb7dfa523da7a9f8fc3dd483f6d4bea94c3553e583c67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b1092afba73a452f0293811d884ca6ea2992a8529273caf4a480ee6192f0000001a0036d8dc58208972a8d900c85f3e743ff26f46c0164bf1fd59d62f3f760b0dca34be19633c47401b000001a0aa75b3271b000001a0aa8802a71b000001a0aa9a52271b000001a0aaaca1a70000d87980ff',
      },
      {
        address:
          'addr_test1qpsaz37enpag7y0ndzd30a8kgc5aynwecu5y4f9cesnh30hfh78ar6kzgecx7l85h7vkuxtt2f2gq6lp70shsv4xr2csmd0pmv',
      },
      {
        address:
          'addr_test1wzs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgn37w4g',
        inlineDatum:
          'd8799fd8799fd8799f581c61d147d9987a8f11f3689b17f4f64629d24dd9c7284aa4b8cc2778beffd8799fd8799fd8799f581ce9bf8fd1eac246706f7cf4bf996e196b5254806be1f3e17832a61ab1ffffffffd8799fd8799fd8799f581c61d147d9987a8f11f3689b17f4f64629d24dd9c7284aa4b8cc2778beffd8799fd8799fd8799f581ce9bf8fd1eac246706f7cf4bf996e196b5254806be1f3e17832a61ab1ffffffffffd8799fd8799f581cbfbeb41470c50a117e555921175e828c91dfb3195abf0f597b58a650ffd8799fd8799fd8799f581c89239da3347ffd747c864eebb6a726f390b608f2ca83829905e39500ffffffffd87a80582aa401010327200621582089c89162eb58f1e999f218160793565d1f13f5b46c8941244c1ae4e47149152f5f5840845869a3012704582089c89162eb58f1e999f218160793565d1f13f5b46c8941244c1ae4e47149152f6761646472657373583900bfbeb41470c50a117e5559215840175e828c91dfb3195abf0f597b58a65089239da3347ffd747c864eebb6a726f390b608f2ca83829905e39500a166686173686564f458200454e79956293a0e96584067661d1914321ab4ed6a9b4967c5fc4c5ec492285844125840032912ac40b6b5feebffdf4366c9d99f94b0ba1a71d09f8ffbfbca649a24176f5e693c02784b045819b374c603261208befea3caa70e466c11c5cd6dbeb690ad8403ff5820e2d07478b89490e0aec0a371cde73d97f1615cfa80fbcf3100c090a811f7a11f48e4d75b9e401c316e583c67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b1092afba73a452f0293811d884ca6ea2992a8529273caf4a480ee6192f0000001a0036d8dc58201215e0daf84d6e8eab910c2760b886ddc408925270eb79203f55bfb686b0c244401b000001a0aa73c3c81b000001a0aa8613481b000001a0aa9862c81b000001a0aaaab2480000d87980ff',
      },
      {
        address:
          'addr_test1qpsaz37enpag7y0ndzd30a8kgc5aynwecu5y4f9cesnh30hfh78ar6kzgecx7l85h7vkuxtt2f2gq6lp70shsv4xr2csmd0pmv',
      },
      {
        address:
          'addr_test1wzs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgn37w4g',
        inlineDatum:
          'd8799fd8799fd8799f581c61d147d9987a8f11f3689b17f4f64629d24dd9c7284aa4b8cc2778beffd8799fd8799fd8799f581ce9bf8fd1eac246706f7cf4bf996e196b5254806be1f3e17832a61ab1ffffffffd8799fd8799fd8799f581c61d147d9987a8f11f3689b17f4f64629d24dd9c7284aa4b8cc2778beffd8799fd8799fd8799f581ce9bf8fd1eac246706f7cf4bf996e196b5254806be1f3e17832a61ab1ffffffffffd8799fd8799f581cbfbeb41470c50a117e555921175e828c91dfb3195abf0f597b58a650ffd8799fd8799fd8799f581c89239da3347ffd747c864eebb6a726f390b608f2ca83829905e39500ffffffffd87a80582aa401010327200621582089c89162eb58f1e999f218160793565d1f13f5b46c8941244c1ae4e47149152f5f5840845869a3012704582089c89162eb58f1e999f218160793565d1f13f5b46c8941244c1ae4e47149152f6761646472657373583900bfbeb41470c50a117e5559215840175e828c91dfb3195abf0f597b58a65089239da3347ffd747c864eebb6a726f390b608f2ca83829905e39500a166686173686564f45820b3b557dbbf74e8738b5840a62a9c3836e03163e781677517a3d3d6584be839f88274584026c6d2a785d55ac07f694945e01ae4c171d75f98a33e3b68ead05c3f78339e70da2c9edaad69ae5819e7d8c1ce79dd345ba4770de95dbab9200b0bac3938585c4f09ff582009082515d088e75912088ee69810b272079ab396fcd272e50f03134e7e1a0f38485bdb907bcb77d535583c67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b1092afba73a452f0293811d884ca6ea2992a8529273caf4a480ee6192f0000001a0036d8dc582081e2a2621e9bbfe7a98821c2637b48355750c40be7bc331306a368e46d0cd07f401b000001a0aa73cbc91b000001a0aa861b491b000001a0aa986ac91b000001a0aaaaba490000d87980ff',
      },
      {
        address:
          'addr_test1qpsaz37enpag7y0ndzd30a8kgc5aynwecu5y4f9cesnh30hfh78ar6kzgecx7l85h7vkuxtt2f2gq6lp70shsv4xr2csmd0pmv',
      },
      {
        address:
          'addr_test1wzs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgn37w4g',
        inlineDatum:
          'd8799fd8799fd8799f581c61d147d9987a8f11f3689b17f4f64629d24dd9c7284aa4b8cc2778beffd8799fd8799fd8799f581ce9bf8fd1eac246706f7cf4bf996e196b5254806be1f3e17832a61ab1ffffffffd8799fd8799fd8799f581c61d147d9987a8f11f3689b17f4f64629d24dd9c7284aa4b8cc2778beffd8799fd8799fd8799f581ce9bf8fd1eac246706f7cf4bf996e196b5254806be1f3e17832a61ab1ffffffffffd8799fd8799f581cbfbeb41470c50a117e555921175e828c91dfb3195abf0f597b58a650ffd8799fd8799fd8799f581c89239da3347ffd747c864eebb6a726f390b608f2ca83829905e39500ffffffffd87a80582aa401010327200621582089c89162eb58f1e999f218160793565d1f13f5b46c8941244c1ae4e47149152f5f5840845869a3012704582089c89162eb58f1e999f218160793565d1f13f5b46c8941244c1ae4e47149152f6761646472657373583900bfbeb41470c50a117e5559215840175e828c91dfb3195abf0f597b58a65089239da3347ffd747c864eebb6a726f390b608f2ca83829905e39500a166686173686564f45820114c38348bdf4697bd584066bedc70bb95d1b46925ee319040a8dc5846de1c1f40cb5840cb10819ea5789ecbc69fb6c8cff7122e294faee568bc500b7f970ce5fc03e1be6bc72f8f18758f5819bb111460efacdb19ccb45a52bf1059ca01a553f36a37c55001ff5820f400abeed2d3278395b74700754f6eb6acd1e15c424ccfbaee692f1f77d0937448c547a13b10dce9d1583c67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b1092afba73a452f0293811d884ca6ea2992a8529273caf4a480ee6192f0000001a0036d8dc5820dadaeebfe3d7dbfbb2caf6ec5d8d0d5b187f7b38a9e230019d28cec1a34dad69401b000001a0aa75268a1b000001a0aa87760a1b000001a0aa99c58a1b000001a0aaac150a0000d87980ff',
      },
      {
        address:
          'addr_test1qpsaz37enpag7y0ndzd30a8kgc5aynwecu5y4f9cesnh30hfh78ar6kzgecx7l85h7vkuxtt2f2gq6lp70shsv4xr2csmd0pmv',
      },
      {
        address:
          'addr_test1wzs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgn37w4g',
        inlineDatum:
          'd8799fd8799fd8799f581c61d147d9987a8f11f3689b17f4f64629d24dd9c7284aa4b8cc2778beffd8799fd8799fd8799f581ce9bf8fd1eac246706f7cf4bf996e196b5254806be1f3e17832a61ab1ffffffffd8799fd8799fd8799f581c61d147d9987a8f11f3689b17f4f64629d24dd9c7284aa4b8cc2778beffd8799fd8799fd8799f581ce9bf8fd1eac246706f7cf4bf996e196b5254806be1f3e17832a61ab1ffffffffffd8799fd8799f581cbfbeb41470c50a117e555921175e828c91dfb3195abf0f597b58a650ffd8799fd8799fd8799f581c89239da3347ffd747c864eebb6a726f390b608f2ca83829905e39500ffffffffd87a80582aa401010327200621582089c89162eb58f1e999f218160793565d1f13f5b46c8941244c1ae4e47149152f5f5840845869a3012704582089c89162eb58f1e999f218160793565d1f13f5b46c8941244c1ae4e47149152f6761646472657373583900bfbeb41470c50a117e5559215840175e828c91dfb3195abf0f597b58a65089239da3347ffd747c864eebb6a726f390b608f2ca83829905e39500a166686173686564f4582095d628ed9496eb104e584025e4248c9c7a04514fef69a8c86b9d4a8fb65486369c3d58407021f658d618e91b71f5753d9c8a0032edcd919109111d7117c8973715217bdefef267b2686f0e58191d67a381f5f8903e4159461d6c026b818812a220c53cbd0303ff582019ece38da31d6a9010445f945dd616214c20169dcb3db289875e37565d9b870348714089f78a5bac87583c67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b1092afba73a452f0293811d884ca6ea2992a8529273caf4a480ee6192f0000001a0036d8dc58208d637b47ee0f2f2892fb90191df81ea0d258b819973bd4ba5542b6dcf3c20cb2401b000001a0aa75e6fb1b000001a0aa88367b1b000001a0aa9a85fb1b000001a0aaacd57b0000d87980ff',
      },
      {
        address:
          'addr_test1qpsaz37enpag7y0ndzd30a8kgc5aynwecu5y4f9cesnh30hfh78ar6kzgecx7l85h7vkuxtt2f2gq6lp70shsv4xr2csmd0pmv',
      },
      {
        address:
          'addr_test1wzs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgn37w4g',
        inlineDatum:
          'd8799fd8799fd8799f581c61d147d9987a8f11f3689b17f4f64629d24dd9c7284aa4b8cc2778beffd8799fd8799fd8799f581ce9bf8fd1eac246706f7cf4bf996e196b5254806be1f3e17832a61ab1ffffffffd8799fd8799fd8799f581c61d147d9987a8f11f3689b17f4f64629d24dd9c7284aa4b8cc2778beffd8799fd8799fd8799f581ce9bf8fd1eac246706f7cf4bf996e196b5254806be1f3e17832a61ab1ffffffffffd8799fd8799f581cbfbeb41470c50a117e555921175e828c91dfb3195abf0f597b58a650ffd8799fd8799fd8799f581c89239da3347ffd747c864eebb6a726f390b608f2ca83829905e39500ffffffffd87a80582aa401010327200621582089c89162eb58f1e999f218160793565d1f13f5b46c8941244c1ae4e47149152f5f5840845869a3012704582089c89162eb58f1e999f218160793565d1f13f5b46c8941244c1ae4e47149152f6761646472657373583900bfbeb41470c50a117e5559215840175e828c91dfb3195abf0f597b58a65089239da3347ffd747c864eebb6a726f390b608f2ca83829905e39500a166686173686564f458208ee0f21c268f09930a58404f7e6731ad77f3f8d32278dcd637153cc2b2139de3490d58402b0f2351c394db8dcf53a53353f79ab05d6d07c86c8478743ab645a507087fea8e64cba5ce1471581961da48f3ea0d6f49bc2b17ae3b503f2f0c051b09fb4e6f4700ff5820350b6b5de49b8fa2c684452f358abc5a422e85dcbfc9c192d003756b52ff1115488efcdd65f831e67c583c67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b1092afba73a452f0293811d884ca6ea2992a8529273caf4a480ee6192f0000001a0036d8dc5820b2f1851a731caa8ebc0e3a3a2ad67d285c12528ee47e0cdf92299246e724730f401b000001a0aa73b6af1b000001a0aa86062f1b000001a0aa9855af1b000001a0aaaaa52f0000d87980ff',
      },
      {
        address:
          'addr_test1qpsaz37enpag7y0ndzd30a8kgc5aynwecu5y4f9cesnh30hfh78ar6kzgecx7l85h7vkuxtt2f2gq6lp70shsv4xr2csmd0pmv',
      },
      {
        address:
          'addr_test1wzs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgn37w4g',
        inlineDatum:
          'd8799fd8799fd8799f581c61d147d9987a8f11f3689b17f4f64629d24dd9c7284aa4b8cc2778beffd8799fd8799fd8799f581ce9bf8fd1eac246706f7cf4bf996e196b5254806be1f3e17832a61ab1ffffffffd8799fd8799fd8799f581c61d147d9987a8f11f3689b17f4f64629d24dd9c7284aa4b8cc2778beffd8799fd8799fd8799f581ce9bf8fd1eac246706f7cf4bf996e196b5254806be1f3e17832a61ab1ffffffffffd8799fd8799f581cbfbeb41470c50a117e555921175e828c91dfb3195abf0f597b58a650ffd8799fd8799fd8799f581c89239da3347ffd747c864eebb6a726f390b608f2ca83829905e39500ffffffffd87a80582aa401010327200621582089c89162eb58f1e999f218160793565d1f13f5b46c8941244c1ae4e47149152f5f5840845869a3012704582089c89162eb58f1e999f218160793565d1f13f5b46c8941244c1ae4e47149152f6761646472657373583900bfbeb41470c50a117e5559215840175e828c91dfb3195abf0f597b58a65089239da3347ffd747c864eebb6a726f390b608f2ca83829905e39500a166686173686564f4582040e293aca687c468805840c59c90717094b6c254f73d291e0cf1034dce78ba024d7958408929bb9d441a7d82641abc0568c96d06aa038d6f862cddee61a5336b0737818b13f42a7b9215725819161b2999705a586f4197def2237908c4bebbf8199ccbd46209ff582061b502304a6b6100f01237263626db8fc817131ce1464f418890cf7a8cefc5f04866646099d421f4d0583c67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b1092afba73a452f0293811d884ca6ea2992a8529273caf4a480ee6192f0000001a0036d8dc582091dbcdeb46ffd5e902962e837ff5933eb44443e9d76ee42af5988a4a90a86cd5401b000001a0aa710d4b1b000001a0aa835ccb1b000001a0aa95ac4b1b000001a0aaa7fbcb0000d87980ff',
      },
      {
        address:
          'addr_test1qpsaz37enpag7y0ndzd30a8kgc5aynwecu5y4f9cesnh30hfh78ar6kzgecx7l85h7vkuxtt2f2gq6lp70shsv4xr2csmd0pmv',
      },
      {
        address:
          'addr_test1wzs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgn37w4g',
        inlineDatum:
          'd8799fd8799fd8799f581c61d147d9987a8f11f3689b17f4f64629d24dd9c7284aa4b8cc2778beffd8799fd8799fd8799f581ce9bf8fd1eac246706f7cf4bf996e196b5254806be1f3e17832a61ab1ffffffffd8799fd8799fd8799f581c61d147d9987a8f11f3689b17f4f64629d24dd9c7284aa4b8cc2778beffd8799fd8799fd8799f581ce9bf8fd1eac246706f7cf4bf996e196b5254806be1f3e17832a61ab1ffffffffffd8799fd8799f581cbfbeb41470c50a117e555921175e828c91dfb3195abf0f597b58a650ffd8799fd8799fd8799f581c89239da3347ffd747c864eebb6a726f390b608f2ca83829905e39500ffffffffd87a80582aa401010327200621582089c89162eb58f1e999f218160793565d1f13f5b46c8941244c1ae4e47149152f5f5840845869a3012704582089c89162eb58f1e999f218160793565d1f13f5b46c8941244c1ae4e47149152f6761646472657373583900bfbeb41470c50a117e5559215840175e828c91dfb3195abf0f597b58a65089239da3347ffd747c864eebb6a726f390b608f2ca83829905e39500a166686173686564f4582096f4d2dfa787744fe1584040ea15c8dba1963b22ccd0b07ee9aa0985647fb5a5caa558402617f2c5f98ce9f56b58f8bf7f844a529dee22cccf65e22dbae0b97b02087ccfd792ff6e7ddcca581965cfcd27ef17865b3ccf5dbefd669ceb2c63bd1894c7337d02ff582095d8a236e4ad1d3d5aef198f66fc2d1042774b76cde057d79944d612f499358e4831fe82680f194b53583c67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b1092afba73a452f0293811d884ca6ea2992a8529273caf4a480ee6192f0000001a0036d8dc5820498c7a1a58209afb8da134617345683181a3525d69090ebcf9d96432b6d7458e401b000001a0aa75cbbf1b000001a0aa881b3f1b000001a0aa9a6abf1b000001a0aaacba3f0000d87980ff',
      },
      {
        address:
          'addr_test1qpsaz37enpag7y0ndzd30a8kgc5aynwecu5y4f9cesnh30hfh78ar6kzgecx7l85h7vkuxtt2f2gq6lp70shsv4xr2csmd0pmv',
      },
      {
        address:
          'addr_test1vrk9h3u5rj42gy6qh0uvnka45fgzcsf74zjaqztgeg3ry5sk2rrgn',
      },
    ],
  },
  /** Transaction 94984202a155755aedfcecd1cbf2ab1492e13b94dc46e72910be3b70671a2748. */
  fanoutTx: {
    inputs: [
      {
        address:
          'addr_test1wq4erflxvet45fr9hrrldflevr2cwr83x622vlejzhspf3gn6jry8',
        inlineDatum:
          'd87a9fd8799f581c324c8b8198c4c9db7526d6dccb79e992c4863b24b56453bb16995bdc9f582078c948f98b55d4c0b66e4247aac1378f1dad25c37786458c4c0f56b22d88c028ffd8799f19ea60ff0001801b000001a05d62c8305830987609283f9f463bb65637453c93070105344430c60d382508af2925058bc01c5bbc2b4a6039be55f90b7e4270f9eac51a001ff644ffff',
      },
      {
        address:
          'addr_test1vzapupn6h7c8anvr8nk8qpdg42yuhhcfuyxkepamw0dfudgk46y8x',
      },
    ],
    outputs: [
      {
        address:
          'addr_test1vzapupn6h7c8anvr8nk8qpdg42yuhhcfuyxkepamw0dfudgk46y8x',
      },
    ],
  },
} satisfies Record<
  string,
  { inputs: HydraTxEndpoint[]; outputs: HydraTxEndpoint[] }
>;

/**
 * Head datums of releases that store a datum hash on the head UTxO instead of
 * an inline datum, resolved from the hash through the Preprod Blockfrost API.
 */
export const preprodHashedHeadDatums = {
  /** Closed head, Hydra 0.13.0, datum hash 9abc95d289392f465624aa77e8584b669baa867b4cd6673d76fb4ef05d442776. */
  head013Closed:
    'd87b9f9f5820b37aabd81024c043f53a069c91e51a5b52e4ea399ae17ee1fe3cb9c44db707eb5820f68e5624f885d521d2f43c3959a0de70496d5464bd3171aba8248f50d5d72b41ff0a5820a97751510cefbb4447f91e6a0dbed8c0c20d8f33885b705ce5f09b66f761de5d1b0000018c34b6a7f8d8799f19ea60ff581c43b8cdf3edefc752ef9ac900d4c7dd5e512655703b9fafb21229844c80ff',
};
