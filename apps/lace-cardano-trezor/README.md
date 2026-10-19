# @laceio/cardano-trezor

Cardano signing with Trezor devices, over `@trezor/connect` and `@trezor/connect-web`: the `TrezorKeyAgent` of the
Cardano domain layer Lace builds on. The domain layer itself is
[`@laceio/cardano`](https://www.npmjs.com/package/@laceio/cardano), which this package depends on; it is published
separately so that a library never installs hardware wallet code to get ledger types. The documentation and the API
reference are on the developer site, <https://sdk.lace.io>.

## Installation

```sh
npm install @laceio/cardano-trezor
```

## Quick Start

```typescript
import { Cardano } from '@laceio/cardano/core';
import { SodiumBip32Ed25519 } from '@laceio/cardano/crypto';
import { CommunicationType } from '@laceio/cardano/key-management';
import { TrezorKeyAgent } from '@laceio/cardano-trezor';

const keyAgent = await TrezorKeyAgent.createWithDevice(
  {
    chainId: Cardano.ChainIds.Preprod,
    trezorConfig: {
      communicationType: CommunicationType.Web,
      manifest: { email: 'you@example.com', appUrl: 'https://example.com' },
    },
  },
  { bip32Ed25519: await SodiumBip32Ed25519.create(), logger: console },
);
console.log(keyAgent.extendedAccountPublicKey);
```

## Documentation

- [Cardano Trezor devices](https://sdk.lace.io/docs/reference/cardano-trezor/): every export, from the package's
  declarations.
- [Packages](https://sdk.lace.io/docs/packages/): the four packages of the SDK and when to install which.

## License

Apache-2.0
