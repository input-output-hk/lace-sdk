import { Cardano } from '@cardano-sdk/core';

import type {
  HydraHeadMintingScriptTemplate,
  HydraProtocolVersion,
  HydraScriptRegistryEntry,
} from './types';

/**
 * Head minting script template of each release, the same on every network.
 * Derived from the minting scripts of real heads of each release.
 */
const HEAD_MINTING_SCRIPTS: Readonly<
  Record<HydraProtocolVersion, HydraHeadMintingScriptTemplate>
> = {
  '0.13.0': {
    language: Cardano.PlutusLanguageVersion.V2,
    prefixLength: 4109,
    prefixDigest:
      '0622c657cd483376060b25bcf106de26b109a2725affb049da92b4b9318b50be',
    seedEncoding: 'constants',
  },
  '0.14.0': {
    language: Cardano.PlutusLanguageVersion.V2,
    prefixLength: 4020,
    prefixDigest:
      'b7c6fe1f8cae5c1e870c5ac483701d0dd20036bd25921bd480c63177de3ae88a',
    seedEncoding: 'constants',
  },
  '0.15.0': {
    language: Cardano.PlutusLanguageVersion.V2,
    prefixLength: 3809,
    prefixDigest:
      '3df377f2d07fd23a99534322d5136c354770d8f912a1a6d9a1d4b02673e7170c',
    seedEncoding: 'constants',
  },
  '0.16.0': {
    language: Cardano.PlutusLanguageVersion.V2,
    prefixLength: 4171,
    prefixDigest:
      'db6926c9a5f335a8ffc38106af439df9939688eded415f64733e3ee6a4c4e041',
    seedEncoding: 'constants',
  },
  '0.18.0': {
    language: Cardano.PlutusLanguageVersion.V2,
    prefixLength: 4565,
    prefixDigest:
      '60bf870c6e66e0fe80b7bf51c7c40f4b4fb31a00791668a10ae20f17f6214f97',
    seedEncoding: 'constants',
  },
  '0.19.0': {
    language: Cardano.PlutusLanguageVersion.V2,
    prefixLength: 4466,
    prefixDigest:
      'b932d89dd2bc9b06d3272ee62fade7829c31a59a6fdaffe19d76aea173a6b05b',
    seedEncoding: 'constants',
  },
  '0.20.0': {
    language: Cardano.PlutusLanguageVersion.V3,
    prefixLength: 5502,
    prefixDigest:
      'b673136cd9b035cc14130f254accddccb17888c7c0cd72f2a9149493264d52bc',
    seedEncoding: 'constants',
  },
  '0.22.0': {
    language: Cardano.PlutusLanguageVersion.V3,
    prefixLength: 5245,
    prefixDigest:
      'b490374c8929aa937f2b00b407ee4d184728c4743db8d0a5b3d8c31f81d37877',
    seedEncoding: 'constrFields',
  },
  '1.0.0': {
    language: Cardano.PlutusLanguageVersion.V3,
    prefixLength: 5245,
    prefixDigest:
      '6e8b0126bee834d19870f45acb4a9a1ebb6447c0c77c3c9d5533daff36bd51b7',
    seedEncoding: 'constrFields',
  },
  '1.3.0': {
    language: Cardano.PlutusLanguageVersion.V3,
    prefixLength: 5245,
    prefixDigest:
      '7fb3c445f01d84bf4694a2947a25a30f8eee90f02cb7f86443ecf81f43fba453',
    seedEncoding: 'constrFields',
  },
  '2.0.0': {
    language: Cardano.PlutusLanguageVersion.V3,
    prefixLength: 4939,
    prefixDigest:
      '07421b8dbd6206ac84e324b5430dac5f524067b20f5109790b2a1a749d1c1acc',
    seedEncoding: 'constrFields',
  },
  '2.1.0': {
    language: Cardano.PlutusLanguageVersion.V3,
    prefixLength: 4626,
    prefixDigest:
      '57869f59227226c342622630d1459827c7c88d29a105e77347be5d1dda3eca34',
    seedEncoding: 'constrFields',
  },
  '2.2.0': {
    language: Cardano.PlutusLanguageVersion.V3,
    prefixLength: 4817,
    prefixDigest:
      'af3a4793dcce5831cd17a242bf0bc6aa2219c9673e87ec026d9085838390656b',
    seedEncoding: 'constrFields',
  },
  '2.3.0': {
    language: Cardano.PlutusLanguageVersion.V3,
    prefixLength: 4817,
    prefixDigest:
      'c485e0959fbdeb29c76f920e1e5dd397bf5ab9f07efe724f032afe8ab553ae90',
    seedEncoding: 'constrFields',
  },
};

/**
 * Hydra script addresses on Preprod and Preview, which share them, ordered by
 * protocol version. Derived from the script hashes published by the
 * hydra-chain-observer.
 */
export const TESTNET_HYDRA_SCRIPT_REGISTRY: readonly HydraScriptRegistryEntry[] =
  [
    {
      version: '0.13.0',
      headMintingScript: HEAD_MINTING_SCRIPTS['0.13.0'],
      headAddress:
        'addr_test1wr34hheje5uqvktp2rquh2m2k4zkhk2hkdspnmf8g6l5s8g6ds0pk',
    },
    {
      version: '0.14.0',
      headMintingScript: HEAD_MINTING_SCRIPTS['0.14.0'],
      headAddress:
        'addr_test1wr5fkrz2v92m4sjrf509qz75ns24k26kw3xv7kswlfe2stsmattyu',
    },
    {
      version: '0.15.0',
      headMintingScript: HEAD_MINTING_SCRIPTS['0.15.0'],
      headAddress:
        'addr_test1wparveslts27nutc8t42hzggztzeku5xew7xmemz6vgswusswq7ec',
    },
    {
      version: '0.16.0',
      headMintingScript: HEAD_MINTING_SCRIPTS['0.16.0'],
      headAddress:
        'addr_test1wzrtl72m5g8f68gmxjye54kcdwave8ldnxfxpvnaejfdz2q6602qc',
    },
    {
      version: '0.18.0',
      headMintingScript: HEAD_MINTING_SCRIPTS['0.18.0'],
      headAddress:
        'addr_test1wz7eltfrtjr3ldlcxlrkwkfsrz5yhccg8luql8dttuw9t7gqyv9ga',
    },
    {
      version: '0.19.0',
      headMintingScript: HEAD_MINTING_SCRIPTS['0.19.0'],
      headAddress:
        'addr_test1wqhwga7xpquex6lynfgqxp5ssed4hm2dhrxj7pdly4dvdqqyn5nxg',
    },
    {
      version: '0.20.0',
      headMintingScript: HEAD_MINTING_SCRIPTS['0.20.0'],
      headAddress:
        'addr_test1wq8r2y26937p835wekxhfeyc0szdg5u7xdmy803qhve8f0gsqwq93',
      depositAddress:
        'addr_test1wzhqrkk782wrgm2ujwhreceegy4epg9clqlefmrt4gjwxrqckxj2j',
    },
    {
      version: '0.22.0',
      headMintingScript: HEAD_MINTING_SCRIPTS['0.22.0'],
      headAddress:
        'addr_test1wzlxa0r5ggyvvc9lplwpe7a4z4680nfsthjmzam72awtknqz5cf7v',
      depositAddress:
        'addr_test1wzhqrkk782wrgm2ujwhreceegy4epg9clqlefmrt4gjwxrqckxj2j',
    },
    {
      version: '1.0.0',
      headMintingScript: HEAD_MINTING_SCRIPTS['1.0.0'],
      headAddress:
        'addr_test1wzs5gta0ym2wcsy79a32dpwp6jynlrttewhhhj6e6mapxsq390hx3',
      depositAddress:
        'addr_test1wzhqrkk782wrgm2ujwhreceegy4epg9clqlefmrt4gjwxrqckxj2j',
    },
    {
      version: '1.3.0',
      headMintingScript: HEAD_MINTING_SCRIPTS['1.3.0'],
      headAddress:
        'addr_test1wptc3k5fdxcphvwel4ah3vxumxyw72cag5v7ph4wv4kw75c0m8ju2',
      depositAddress:
        'addr_test1wzhqrkk782wrgm2ujwhreceegy4epg9clqlefmrt4gjwxrqckxj2j',
    },
    {
      version: '2.0.0',
      headMintingScript: HEAD_MINTING_SCRIPTS['2.0.0'],
      headAddress:
        'addr_test1wqsl5mhyp654wpp28hhghtnfk9w8akypq2l8ajc9dky3rvsa2vhh8',
      depositAddress:
        'addr_test1wzhqrkk782wrgm2ujwhreceegy4epg9clqlefmrt4gjwxrqckxj2j',
    },
    {
      version: '2.1.0',
      headMintingScript: HEAD_MINTING_SCRIPTS['2.1.0'],
      headAddress:
        'addr_test1wp8y3t7dsl5883sc4cqwuzgd2tsy28eayhcm05lrjlpsk0shksg9n',
      depositAddress:
        'addr_test1wqzrpsd0hdcyppdex67hl4fskhr8gqyupwzl6x884py54kqh56v08',
    },
    {
      version: '2.2.0',
      headMintingScript: HEAD_MINTING_SCRIPTS['2.2.0'],
      headAddress:
        'addr_test1wr7htcjvn653tn5wfrfl78gv2jksnnqprywzgst26ld6fgcn3usg2',
      depositAddress:
        'addr_test1wrrcaryjq4epavl0gsg08kuuv95l5md5jlpyvswjnss998qyu7lhm',
    },
    {
      version: '2.3.0',
      headMintingScript: HEAD_MINTING_SCRIPTS['2.3.0'],
      headAddress:
        'addr_test1wq4erflxvet45fr9hrrldflevr2cwr83x622vlejzhspf3gn6jry8',
      depositAddress:
        'addr_test1wrrcaryjq4epavl0gsg08kuuv95l5md5jlpyvswjnss998qyu7lhm',
    },
  ];

/** Hydra script addresses on Mainnet, ordered by protocol version. */
export const MAINNET_HYDRA_SCRIPT_REGISTRY: readonly HydraScriptRegistryEntry[] =
  [
    {
      version: '0.13.0',
      headMintingScript: HEAD_MINTING_SCRIPTS['0.13.0'],
      headAddress: 'addr1w834hheje5uqvktp2rquh2m2k4zkhk2hkdspnmf8g6l5s8gp9ynwn',
    },
    {
      version: '0.14.0',
      headMintingScript: HEAD_MINTING_SCRIPTS['0.14.0'],
      headAddress: 'addr1w85fkrz2v92m4sjrf509qz75ns24k26kw3xv7kswlfe2stsq4lhte',
    },
    {
      version: '0.15.0',
      headMintingScript: HEAD_MINTING_SCRIPTS['0.15.0'],
      headAddress: 'addr1w9arveslts27nutc8t42hzggztzeku5xew7xmemz6vgswustx5zka',
    },
    {
      version: '0.16.0',
      headMintingScript: HEAD_MINTING_SCRIPTS['0.16.0'],
      headAddress: 'addr1wxrtl72m5g8f68gmxjye54kcdwave8ldnxfxpvnaejfdz2qpjmk0a',
    },
    {
      version: '0.18.0',
      headMintingScript: HEAD_MINTING_SCRIPTS['0.18.0'],
      headAddress: 'addr1wx7eltfrtjr3ldlcxlrkwkfsrz5yhccg8luql8dttuw9t7gmvce8c',
    },
    {
      version: '0.19.0',
      headMintingScript: HEAD_MINTING_SCRIPTS['0.19.0'],
      headAddress: 'addr1wyhwga7xpquex6lynfgqxp5ssed4hm2dhrxj7pdly4dvdqqlmq0fd',
    },
    {
      version: '0.20.0',
      headMintingScript: HEAD_MINTING_SCRIPTS['0.20.0'],
      headAddress: 'addr1wy8r2y26937p835wekxhfeyc0szdg5u7xdmy803qhve8f0gtg6u25',
      depositAddress:
        'addr1wxhqrkk782wrgm2ujwhreceegy4epg9clqlefmrt4gjwxrqr7jw9h',
    },
    {
      version: '0.22.0',
      headMintingScript: HEAD_MINTING_SCRIPTS['0.22.0'],
      headAddress: 'addr1wxlxa0r5ggyvvc9lplwpe7a4z4680nfsthjmzam72awtknqeuv43f',
      depositAddress:
        'addr1wxhqrkk782wrgm2ujwhreceegy4epg9clqlefmrt4gjwxrqr7jw9h',
    },
    {
      version: '1.0.0',
      headMintingScript: HEAD_MINTING_SCRIPTS['1.0.0'],
      headAddress: 'addr1wxs5gta0ym2wcsy79a32dpwp6jynlrttewhhhj6e6mapxsq2dmtf5',
      depositAddress:
        'addr1wxhqrkk782wrgm2ujwhreceegy4epg9clqlefmrt4gjwxrqr7jw9h',
    },
    {
      version: '1.3.0',
      headMintingScript: HEAD_MINTING_SCRIPTS['1.3.0'],
      headAddress: 'addr1w9tc3k5fdxcphvwel4ah3vxumxyw72cag5v7ph4wv4kw75c5nnwn0',
      depositAddress:
        'addr1wxhqrkk782wrgm2ujwhreceegy4epg9clqlefmrt4gjwxrqr7jw9h',
    },
    {
      version: '2.0.0',
      headMintingScript: HEAD_MINTING_SCRIPTS['2.0.0'],
      headAddress: 'addr1wysl5mhyp654wpp28hhghtnfk9w8akypq2l8ajc9dky3rvsxzctcz',
      depositAddress:
        'addr1wxhqrkk782wrgm2ujwhreceegy4epg9clqlefmrt4gjwxrqr7jw9h',
    },
    {
      version: '2.1.0',
      headMintingScript: HEAD_MINTING_SCRIPTS['2.1.0'],
      headAddress: 'addr1w98y3t7dsl5883sc4cqwuzgd2tsy28eayhcm05lrjlpsk0sv7y52k',
      depositAddress:
        'addr1wyzrpsd0hdcyppdex67hl4fskhr8gqyupwzl6x884py54kqvuwsqz',
    },
    {
      version: '2.2.0',
      headMintingScript: HEAD_MINTING_SCRIPTS['2.2.0'],
      headAddress: 'addr1w87htcjvn653tn5wfrfl78gv2jksnnqprywzgst26ld6fgcgegv80',
      depositAddress:
        'addr1w8rcaryjq4epavl0gsg08kuuv95l5md5jlpyvswjnss998ql52rc7',
    },
    {
      version: '2.3.0',
      headMintingScript: HEAD_MINTING_SCRIPTS['2.3.0'],
      headAddress: 'addr1wy4erflxvet45fr9hrrldflevr2cwr83x622vlejzhspf3ggjxltz',
      depositAddress:
        'addr1w8rcaryjq4epavl0gsg08kuuv95l5md5jlpyvswjnss998ql52rc7',
    },
  ];
