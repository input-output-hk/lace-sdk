// Midnight Wallet SDK 2 nests the HD leaf, so vendored types must resolve via
// the `@midnightntwrk/wallet-sdk` umbrella. The key agent admits only pure-JS HD:
// type-only imports must not pull the umbrella's engine into its bundle.
import {
  HDWallet as Wallet,
  Roles as roles,
} from '@midnightntwrk/wallet-sdk-hd';

import type * as HD from '@midnightntwrk/wallet-sdk/hd';

export type HDWallet = HD.HDWallet;
export const HDWallet: typeof HD.HDWallet = Wallet;
export const Roles: typeof HD.Roles = roles;
