# @lace-lib/cardano-util

Ported from [cardano-js-sdk](https://github.com/input-output-hk/cardano-js-sdk)'s `@cardano-sdk/util` (version 0.17.2); published as part of `@laceio/cardano`.

The general-purpose utilities the Cardano domain layer is written against: opaque types, errors, transformers, hex
strings and the like. It imports no other platform package, RxJS or `ts-results-es`, so a published package can
inline it on its own, and the ported packages that use it stay independent of the platform's own libraries.
