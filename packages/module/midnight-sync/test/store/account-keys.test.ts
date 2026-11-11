import { randomBytes } from 'node:crypto';

import { AuthSecret } from '@lace-contract/authentication-prompt';
import { ByteArray } from '@lace-lib/util';
import { createKeystore } from '@midnightntwrk/wallet-sdk/unshielded';
import { firstValueFrom, of } from 'rxjs';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  buildAccountKeys,
  createAccountKeyManager,
  decryptKey,
} from '../../src/store/account-keys';
import {
  PASSWORD,
  sealedAccount,
  useFastKeyDerivation,
} from '../worker/engine-host-fakes';

import type { SideEffect } from '../../src/context';

const seeds = () =>
  [randomBytes(32), randomBytes(32), randomBytes(32)] as const;

describe('account-keys', () => {
  beforeAll(() => {
    useFastKeyDerivation();
  });

  it('builds the ledger key objects and the unshielded keystore from the decrypted buffers, and clears them together', () => {
    const [night, dust, zswap] = seeds();
    const buffers = [
      ByteArray(new Uint8Array(night)),
      ByteArray(new Uint8Array(dust)),
      ByteArray(new Uint8Array(zswap)),
    ] as const;

    const keys = buildAccountKeys(buffers, 'undeployed');

    expect(keys.unshieldedKeystore.getBech32Address().asString()).toBe(
      createKeystore(night, 'undeployed').getBech32Address().asString(),
    );
    expect(keys.walletKeys.dustKeyBuffer).toBe(buffers[1]);
    expect(keys.walletKeys.zswapKeyBuffer).toBe(buffers[2]);
    expect(keys.walletKeys.zswapSecretKeys.coinPublicKey).toBeTypeOf('string');
    keys.clear();
    for (const buffer of buffers)
      expect([...buffer].every(byte => byte === 0)).toBe(true);
  });

  it('decrypts a sealed key with the auth secret and refuses another password', async () => {
    const [night] = seeds();
    const account = await sealedAccount({
      seeds: [night, randomBytes(32), randomBytes(32)],
    });
    const { encryptedKey } = account.blockchainSpecific.nightExternalKey;

    expect(
      await decryptKey(
        encryptedKey,
        AuthSecret(ByteArray(new Uint8Array(PASSWORD))),
      ),
    ).toEqual(ByteArray(new Uint8Array(night)));
    await expect(
      decryptKey(encryptedKey, AuthSecret(ByteArray.fromUTF8('other'))),
    ).rejects.toThrow();
  });

  it("serves the account's keys through the key manager from the side effect's auth secret, and destroys them", async () => {
    const [night, dust, zswap] = seeds();
    const account = await sealedAccount({ seeds: [night, dust, zswap] });
    const dependencies = {
      accessAuthSecret: (use: (secret: AuthSecret) => unknown) =>
        use(AuthSecret(ByteArray(new Uint8Array(PASSWORD)))),
    } as unknown as Parameters<SideEffect>[2];
    const { keyManager, destroyAccountKeyManager } = createAccountKeyManager(
      account,
    )(
      {} as Parameters<SideEffect>[0],
      {} as Parameters<SideEffect>[1],
      dependencies,
    );

    const keys = await firstValueFrom(keyManager.keys$);
    expect(keys.unshieldedKeystore.getBech32Address().asString()).toBe(
      createKeystore(night, account.blockchainSpecific.networkId)
        .getBech32Address()
        .asString(),
    );
    expect(await firstValueFrom(keyManager.areKeysAvailable$)).toBe(true);
    destroyAccountKeyManager();
    expect(
      await firstValueFrom(keyManager.areKeysAvailable$.pipe(), {
        defaultValue: false,
      }),
    ).toBe(false);
    expect(of(1)).toBeDefined();
  });
});
