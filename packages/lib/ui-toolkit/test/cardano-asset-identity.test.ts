import { describe, expect, it } from 'vitest';

import { getCardanoAssetIdentity } from '../src/design-system/molecules/cardanoAssetIdentity/assetIdentity';

const policy = '7eae28af2208be856f7a119668ae52a49b73725e326dc16579dcc373';

describe('Cardano signing asset identity', () => {
  it.each([
    ['', 'asset1rjklcrnsdzqp65wjgrg55sy9723kw09mlgvlc3'],
    ['504154415445', 'asset13n25uv0yaf5kus35fm2k86cqy60z58d9xmde92'],
  ])('matches CIP-14 for asset-name bytes %s', (name, fingerprint) => {
    expect(getCardanoAssetIdentity(policy + name)).toEqual({
      assetId: policy + name,
      policyId: policy,
      assetNameHex: name.toLowerCase(),
      fingerprint,
    });
  });

  it('distinguishes a policy difference hidden between equal prefixes and suffixes', () => {
    const lookalikePolicy = `${policy.slice(0, 20)}00${policy.slice(22)}`;
    const original = getCardanoAssetIdentity(policy + '4330374654');
    const copy = getCardanoAssetIdentity(lookalikePolicy + '4330374654');
    expect(original.policyId).not.toBe(copy.policyId);
    expect(original.fingerprint).not.toBe(copy.fingerprint);
    expect(original.assetNameHex).toBe(copy.assetNameHex);
  });

  it('preserves binary names and distinguishes names under the same policy', () => {
    const binary = getCardanoAssetIdentity(policy + '00ff80');
    const empty = getCardanoAssetIdentity(policy);
    expect(binary.assetNameHex).toBe('00ff80');
    expect(binary.policyId).toBe(empty.policyId);
    expect(binary.fingerprint).not.toBe(empty.fingerprint);
  });

  it.each(['', 'ADA', 'ab'.repeat(27), policy + 'ff'.repeat(33)])(
    'does not invent an identity for invalid ledger ID %s',
    assetId => {
      expect(() => getCardanoAssetIdentity(assetId)).toThrow();
    },
  );
});
