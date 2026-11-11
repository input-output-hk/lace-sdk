import { SecretBox } from '@lace-lib/core';
import { ByteArray } from '@lace-lib/util';
import * as ledger from '@midnight-ntwrk/ledger-v8';
import { createKeystore } from '@midnightntwrk/wallet-sdk/unshielded';
import { from, map } from 'rxjs';

import { createAccountKeyManager as createAccountKeyManagerImpl } from './side-effects/account-key-manager';

import type { SideEffect } from '../context';
import type { AuthSecret } from '@lace-contract/authentication-prompt';
import type {
  AccountKeyManager,
  AccountKeys,
  MidnightAccountProps,
  MidnightSDKNetworkId,
} from '@lace-contract/midnight-context';
import type { InMemoryWalletAccount } from '@lace-contract/wallet-repo';
import type { HexBytes } from '@lace-lib/util';
import type { Observable } from 'rxjs';

// The account's keys as the engine uses them, built only by the JavaScript context that runs the engine.

/**
 * Helper to decrypt an encrypted key buffer with an auth secret.
 */
export const decryptKey = async (
  encryptedKey: HexBytes,
  authSecret: AuthSecret,
): Promise<ByteArray> =>
  ByteArray(await SecretBox.open(ByteArray.fromHex(encryptedKey), authSecret));

/**
 * Pre-computes ledger key objects from decrypted key buffers and assembles
 * the AccountKeys structure. Extracted as a top-level helper to avoid
 * deeply nested function expressions inside the requestKeys observable chain.
 */
export const buildAccountKeys = (
  [nightKeyBuffer, dustKeyBuffer, zswapKeyBuffer]: readonly [
    ByteArray,
    ByteArray,
    ByteArray,
  ],
  networkId: MidnightSDKNetworkId,
): AccountKeys => {
  // Pre-compute ledger key objects once to avoid repeated fromSeed() calls
  const dustSecretKey = ledger.DustSecretKey.fromSeed(dustKeyBuffer);
  const zswapSecretKeys = ledger.ZswapSecretKeys.fromSeed(zswapKeyBuffer);

  return {
    unshieldedKeystore: createKeystore(nightKeyBuffer, networkId),
    walletKeys: {
      dustKeyBuffer,
      zswapKeyBuffer,
      dustSecretKey,
      zswapSecretKeys,
    },
    clear: () => {
      nightKeyBuffer.fill(0);
      zswapKeyBuffer.fill(0);
      dustKeyBuffer.fill(0);
      // Safe for both: the sync streams hold their own copies derived from
      // these buffers, so clearing here cannot wedge them. Transaction paths
      // re-derive on their NEXT keys$ read; a call already in flight holds
      // these and fails — intended when locking mid-signing.
      zswapSecretKeys.clear();
      dustSecretKey.clear();
    },
  };
};

export type AccountKeyManagerResult = {
  keyManager: AccountKeyManager;
  destroyAccountKeyManager: () => void;
};

/** Builds the key manager the account watcher hands the engine start, from the side effect's dependencies. */
export type CreateAccountKeyManager = (
  account: InMemoryWalletAccount<MidnightAccountProps>,
) => (...props: Parameters<SideEffect>) => AccountKeyManagerResult;

/**
 * Creates an AccountKeyManager for a Midnight account with auth prompt integration.
 */
export const createAccountKeyManager: CreateAccountKeyManager =
  account =>
  (_, __, { accessAuthSecret }) => {
    const { networkId } = account.blockchainSpecific;

    /**
     * Decrypts all account keys using available auth secret.
     * Hangs on the secret access if app is locked.
     * Pre-computes ledger key objects (DustSecretKey, ZswapSecretKeys) to avoid
     * repeated fromSeed() calls during sync and wallet operations.
     */
    const requestKeys = (): Observable<AccountKeys> =>
      accessAuthSecret(authSecret =>
        from(
          Promise.all([
            decryptKey(
              account.blockchainSpecific.nightExternalKey.encryptedKey,
              authSecret,
            ),
            decryptKey(
              account.blockchainSpecific.dustKey.encryptedKey,
              authSecret,
            ),
            decryptKey(
              account.blockchainSpecific.zswapKey.encryptedKey,
              authSecret,
            ),
          ]),
        ),
      ).pipe(map(buffers => buildAccountKeys(buffers, networkId)));

    const keyManager = createAccountKeyManagerImpl({ requestKeys });

    return {
      keyManager,
      destroyAccountKeyManager: () => {
        keyManager.destroy();
      },
    };
  };
