# @laceio/cardano-ledger

Cardano signing with Ledger devices, over `@cardano-foundation/ledgerjs-hw-app-cardano` and the WebUSB and node-hid
transports: the `LedgerKeyAgent` of the Cardano domain layer Lace builds on. The domain layer
itself is [`@laceio/cardano`](https://www.npmjs.com/package/@laceio/cardano), which this package depends on; it is
published separately so that a library never installs hardware wallet code to get ledger types. The documentation
and the API reference are on the developer site, <https://sdk.lace.io>.

## Installation

```sh
npm install @laceio/cardano-ledger
```

The package imports `@laceio/cardano` rather than bundling it, under `import` and `require()` alike, so the key
agent's errors and base classes are the ones `@laceio/cardano` exports. The declarations name `node-hid`, which
ships no declarations, and the `USBDevice` global of `@types/w3c-web-usb`, which a `types` list leaves out, so
compile with `skipLibCheck: true`.

## Quick Start

```typescript
import { Cardano } from '@laceio/cardano/core';
import { SodiumBip32Ed25519 } from '@laceio/cardano/crypto';
import { CommunicationType } from '@laceio/cardano/key-management';
import { LedgerKeyAgent } from '@laceio/cardano-ledger';

const keyAgent = await LedgerKeyAgent.createWithDevice(
  {
    chainId: Cardano.ChainIds.Preprod,
    communicationType: CommunicationType.Web,
  },
  { bip32Ed25519: await SodiumBip32Ed25519.create(), logger: console },
);
console.log(keyAgent.extendedAccountPublicKey);
```

## Documentation

- [Cardano Ledger devices](https://sdk.lace.io/docs/reference/cardano-ledger/): every export, from the package's
  declarations.
- [Use the Cardano domain layer without a wallet](https://sdk.lace.io/docs/guides/cardano-domain-layer/): signing on a
  Ledger device, with the key agent's context.
- [Packages](https://sdk.lace.io/docs/packages/): the four packages of the SDK and when to install which.

## License

Apache-2.0
