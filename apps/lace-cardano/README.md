# @laceio/cardano

The Cardano domain layer Lace builds on: ledger types and
CBOR serialization, cryptography, key management, input selection, the rules a
transaction is built against and the CIP-30 dApp connector, as one package with
a subpath per area. The documentation and the API reference are on the
developer site, <https://sdk.lace.io>.

This package is the Cardano JS SDK's domain layer, owned and maintained by the team that builds Lace, beside the Lace
SDK in one repository, where each change is built, tested and reviewed with the code that uses it. It follows
the Lace SDK's versioning rules: before 1.0, an export changes incompatibly only in a minor release, never in a patch,
and only after the release before it marked it deprecated. The code, API and licence are
the library's own; the history before the move stays in the
[cardano-js-sdk repository](https://github.com/input-output-hk/cardano-js-sdk). Lace intends to deprecate the
`@cardano-sdk` packages, which stay published and unchanged until then, with notice ahead; the Lace SDK carries the
same low-level libraries here and the higher-level ones in `@laceio/sdk`. [Who maintains it](https://sdk.lace.io/docs/learn/cardano-domain-layer/#who-maintains-it) says more.

The BIP32-Ed25519 key derivation in `@laceio/cardano/crypto` was reviewed in November 2023 and the findings
addressed; the [report](https://github.com/input-output-hk/lace-sdk/blob/main/packages/lib/cardano-crypto/audit_202311.pdf) and [a note on what it covered](https://github.com/input-output-hk/lace-sdk/blob/main/packages/lib/cardano-crypto/AUDIT.md) are published in the
[Lace SDK repository](https://github.com/input-output-hk/lace-sdk).

## Installation

```sh
npm install @laceio/cardano
```

Import each area from its subpath; nothing is exported from the package's root.

| Subpath                           | Holds                                                                                                        |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `@laceio/cardano/core`            | Ledger types as plain data, CBOR serialization, transaction inspectors, slot arithmetic, provider interfaces |
| `@laceio/cardano/crypto`          | BIP32-Ed25519 keys and derivation, Ed25519 signatures, Blake2b                                               |
| `@laceio/cardano/util`            | Opaque string types, hex and bech32 helpers, serialization of plain objects                                  |
| `@laceio/cardano/key-management`  | Key agents from recovery words, accounts from a public key, derivation paths, CIP-8 data signing             |
| `@laceio/cardano/input-selection` | Input selectors and selection constraints                                                                    |
| `@laceio/cardano/tx-construction` | Fees, minimum ada, output validation, validity intervals, the script data hash, a body from a selection      |
| `@laceio/cardano/dapp-connector`  | The wallet side of CIP-30, CIP-95 and CIP-142                                                                |

The subpaths resolve under every TypeScript `moduleResolution` setting, and
each ships an ES module and a CommonJS build with its own declarations.

The code reads the `Buffer` global and `process.env.NODE_ENV`. Node provides
both; a browser bundle needs a `Buffer` polyfill (for example
`vite-plugin-node-polyfills` or webpack's `ProvidePlugin`) and a define for
`process.env.NODE_ENV`. The declarations name `Buffer`, so install
`@types/node` to type-check against them.

## Quick Start

```typescript
import { Serialization } from '@laceio/cardano/core';

declare const cborHex: string;

const tx = Serialization.Transaction.fromCbor(Serialization.TxCBOR(cborHex));
console.log(tx.getId(), tx.body().fee(), tx.body().outputs().length);
```

## Documentation

- [Packages](https://sdk.lace.io/docs/packages/): the four packages of the SDK and when to install which.
- [The Cardano domain layer](https://sdk.lace.io/docs/learn/cardano-domain-layer/): what this package is, what each
  subpath holds, and how to move to it from the `@cardano-sdk` packages.
- [Use the Cardano domain layer without a wallet](https://sdk.lace.io/docs/guides/cardano-domain-layer/): decode a
  transaction, derive an address, compute minimum ada, sign on a Ledger device.
- API reference, one page per subpath: [core](https://sdk.lace.io/docs/reference/cardano-core/),
  [crypto](https://sdk.lace.io/docs/reference/cardano-crypto/), [util](https://sdk.lace.io/docs/reference/cardano-util/),
  [key-management](https://sdk.lace.io/docs/reference/cardano-key-management/),
  [input-selection](https://sdk.lace.io/docs/reference/cardano-input-selection/),
  [tx-construction](https://sdk.lace.io/docs/reference/cardano-tx-construction/),
  [dapp-connector](https://sdk.lace.io/docs/reference/cardano-dapp-connector/).
- Hardware wallets: [`@laceio/cardano-ledger`](https://www.npmjs.com/package/@laceio/cardano-ledger) and
  [`@laceio/cardano-trezor`](https://www.npmjs.com/package/@laceio/cardano-trezor), published separately so that a
  library never installs USB or Trezor Connect code to get ledger types.
- For AI agents: [llms.txt](https://sdk.lace.io/llms.txt) and a Markdown twin of every page.

## License

Apache-2.0
