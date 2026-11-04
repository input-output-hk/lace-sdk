/**
 * The device commitment and public key vectors below come from the
 * reference Account Custody Contract client (the passport contract
 * repository, src/wallet/signer.ts) over the same fixed scalar, address,
 * epoch, and counter.
 */
import {
  AccAddress,
  AccBindingVersion,
  AccountBundleUnknownError,
  CircuitNotRegisteredError,
  DeviceEpoch,
  UseCounter,
} from '@lace-contract/passport';
import { HexBytes } from '@lace-lib/util';
import { jubjub } from '@noble/curves/misc.js';
import { describe, expect, it, vi } from 'vitest';

import { expectedVk, pureCircuits } from '../../src/acc/acc-module';
import { jubjubChallenges } from '../../src/acc/challenges';
import { DEPLOYED_OPERATIONS } from '../../src/acc/deployed-operations';
import { devJubjubAuthoriser } from '../../src/acc/dev-authoriser';
import {
  ISSUE_GRANT_CIRCUIT,
  REVOKE_ALL_GRANTS_CIRCUIT,
  REVOKE_GRANT_CIRCUIT,
} from '../../src/acc/grant-circuits';
import { issueGrantBinding, scopeArgs } from '../../src/acc/grants';
import { accManifest } from '../../src/acc/manifest';
import { createPassportRegistry } from '../../src/acc/registry';
import { bytesToBigIntLE, JUBJUB_R } from '../../src/acc/signer';

import type {
  AccountBundle,
  Authorisation,
  AuthorisationRequest,
} from '@lace-contract/passport';

const SK = BigInt(
  '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
);
const EXPECTED_PK_X = BigInt(
  '0x09b5a8331d01ee2bae5f0a79aeb181cbf0d0c30624e91b168f92a1ee141f1eb5',
);
const EXPECTED_PK_Y = BigInt(
  '0x04cace00c5ac40ee25037dac862ee498605d93ff626ac4930edb43ef08d575c5',
);
const EXPECTED_ENTRY =
  '73b71bbbedfc07c5a859cc3c48e64fef1182818d19527ebf314e7194b2d4a1a8';

const CONTRACT_ADDRESS = Uint8Array.from(
  { length: 32 },
  (_, index) => index + 1,
);
const ACCOUNT = AccAddress(HexBytes.fromByteArray(CONTRACT_ADDRESS));
const NEW_ENTRY = new Uint8Array(32).fill(0x5a);

const GRANT_ID = new Uint8Array(32).fill(0x31);
const SCOPE_SALT = new Uint8Array(32).fill(0x32);
const ZERO32 = new Uint8Array(32);
const issueArgs = [
  GRANT_ID,
  ...scopeArgs({
    opWithdrawUnshielded: true,
    opWithdrawShielded: false,
    opWithdrawShieldedToContract: false,
    read: false,
    color: ZERO32,
    recipientKind: 0n,
    recipient: ZERO32,
    maxCoinValue: 300n,
    perCallCap: 300n,
    cap: 450n,
    expiresAt: 0n,
    rpIdHash: ZERO32,
    readPkHash: ZERO32,
    windowLen: 0n,
    windowCap: 0n,
  }),
  SCOPE_SALT,
];

const addDeviceRequest: AuthorisationRequest = {
  account: ACCOUNT,
  circuit: 'add_device_with_jubjub',
  args: [NEW_ENTRY],
  witnessValues: [],
  authNonce: 7n,
  useCounter: UseCounter(3n),
};

const TALLY_CIRCUIT = 'tally_set_with_jubjub';
const TALLY_CHALLENGE = 'challenge_tally_set_with_jubjub';
const TALLY_ADDRESS = { bytes: new Uint8Array(32).fill(0x21) };
/** A fixed challenge whose little-endian value is below JUBJUB_R, so the grind ends at once. */
const TALLY_CHALLENGE_BYTES = Uint8Array.from({ length: 32 }, (_, index) =>
  index === 31 ? 0 : 0x33,
);

const tallySetRequest: AuthorisationRequest = {
  ...addDeviceRequest,
  circuit: TALLY_CIRCUIT,
  args: [TALLY_ADDRESS, TALLY_ADDRESS, 5n],
  bundleId: 'account-tally',
};

/**
 * A build of the account with one circuit calling a tally, whose module
 * records the arguments its challenge pure circuit is handed and answers
 * a fixed challenge.
 */
const tallyBundle = (circuits: Record<string, unknown>): AccountBundle => ({
  id: 'account-tally',
  bindingVersion: AccBindingVersion('0.1.0-tally.1'),
  module: async () => ({
    Contract: class {},
    ledger: () => ({}),
    pureCircuits: circuits,
    expectedVk: { ...expectedVk, [TALLY_CIRCUIT]: 'aa'.repeat(32) },
    circuitSignatures: {},
    declaredInterfaces: {},
  }),
  manifest: {
    ...accManifest,
    bindingVersion: AccBindingVersion('0.1.0-tally.1'),
  },
  operations: [...DEPLOYED_OPERATIONS, TALLY_CIRCUIT],
  verifierKeys: { ...expectedVk, [TALLY_CIRCUIT]: 'aa'.repeat(32) },
  constructorArgs: [],
  circuits: {
    [TALLY_CIRCUIT]: {
      label: 'Set the tally',
      args: [
        { name: 'tally', label: 'Tally', type: 'contract', interface: 'Tally' },
        { name: 'tally_addr', type: 'contract-address', of: 'tally' },
        {
          name: 'value',
          label: 'Value',
          type: 'uint',
          maxval: '18446744073709551615',
        },
      ],
      challenge: TALLY_CHALLENGE,
      challengeArgs: ['tally_addr', 'value'],
      witnesses: [],
    },
  },
});

/** Schnorr verification of the signature over `challenge`: s * G = R + c * pk. */
const verifies = (
  { pk, sigR, sigS }: Authorisation,
  challenge: Uint8Array,
): boolean =>
  jubjub.Point.fromAffine(sigR)
    .add(jubjub.Point.fromAffine(pk).multiply(bytesToBigIntLE(challenge)))
    .equals(
      jubjub.Point.fromAffine(
        pureCircuits.compute_public_point_with_jubjub(sigS),
      ),
    );

describe('devJubjubAuthoriser', () => {
  const authoriser = devJubjubAuthoriser(SK);

  it('implements the jubjub-schnorr scheme', () => {
    expect(authoriser.scheme).toBe('jubjub-schnorr');
  });

  it('exposes the reference public key for the fixed scalar', async () => {
    await expect(authoriser.devicePublicKey()).resolves.toEqual({
      x: EXPECTED_PK_X,
      y: EXPECTED_PK_Y,
    });
  });

  it('derives the reference device commitment', async () => {
    await expect(
      authoriser.deviceCommitment(ACCOUNT, DeviceEpoch(0n), UseCounter(0n)),
    ).resolves.toBe(EXPECTED_ENTRY);
  });

  it('computes batched commitments equal to per-counter calls', async () => {
    const counters = [UseCounter(0n), UseCounter(1n), UseCounter(2n)];

    const batch = await authoriser.deviceCommitments!(
      ACCOUNT,
      DeviceEpoch(0n),
      counters,
    );
    const perCall = await Promise.all(
      counters.map(async counter =>
        authoriser.deviceCommitment(ACCOUNT, DeviceEpoch(0n), counter),
      ),
    );

    expect(batch).toEqual(perCall);
    expect(batch[0]).toBe(EXPECTED_ENTRY);
  });

  it('authorises an addDevice call with a verifiable challenge', async () => {
    const authorisation = await authoriser.authorise(addDeviceRequest);

    expect(authorisation.scheme).toBe('jubjub-schnorr');
    expect(authorisation.pk).toEqual({ x: EXPECTED_PK_X, y: EXPECTED_PK_Y });
    expect(authorisation.useCounter).toBe(3n);
    expect(authorisation.sigS).toBeLessThan(JUBJUB_R);

    const builder = jubjubChallenges.addDevice(
      { contractAddress: CONTRACT_ADDRESS, authNonce: 7n },
      authorisation.pk,
      NEW_ENTRY,
    );
    expect(
      bytesToBigIntLE(builder(authorisation.sigR, authorisation.grindNonce)),
    ).toBeLessThan(JUBJUB_R);
    for (let nonce = 0n; nonce < authorisation.grindNonce; nonce++) {
      expect(
        bytesToBigIntLE(builder(authorisation.sigR, nonce)),
      ).toBeGreaterThanOrEqual(JUBJUB_R);
    }
  });

  it('authorises a removeDevice call against its own challenge builder', async () => {
    const entry = Uint8Array.from(Buffer.from(EXPECTED_ENTRY, 'hex'));
    const authorisation = await authoriser.authorise({
      ...addDeviceRequest,
      circuit: 'remove_device_with_jubjub',
      args: [entry],
    });

    const builder = jubjubChallenges.removeDevice(
      { contractAddress: CONTRACT_ADDRESS, authNonce: 7n },
      authorisation.pk,
      entry,
    );
    expect(
      bytesToBigIntLE(builder(authorisation.sigR, authorisation.grindNonce)),
    ).toBeLessThan(JUBJUB_R);
  });

  it('authorises an issueGrant call over the grant id and the scope digest', async () => {
    const authorisation = await authoriser.authorise({
      ...addDeviceRequest,
      circuit: ISSUE_GRANT_CIRCUIT,
      args: issueArgs,
    });

    const builder = jubjubChallenges.issueGrant(
      { contractAddress: CONTRACT_ADDRESS, authNonce: 7n },
      authorisation.pk,
      issueGrantBinding(issueArgs),
    );
    expect(
      bytesToBigIntLE(builder(authorisation.sigR, authorisation.grindNonce)),
    ).toBeLessThan(JUBJUB_R);
  });

  it('authorises a revokeGrant call over the grant id', async () => {
    const authorisation = await authoriser.authorise({
      ...addDeviceRequest,
      circuit: REVOKE_GRANT_CIRCUIT,
      args: [GRANT_ID],
    });

    const builder = jubjubChallenges.revokeGrant(
      { contractAddress: CONTRACT_ADDRESS, authNonce: 7n },
      authorisation.pk,
      GRANT_ID,
    );
    expect(
      bytesToBigIntLE(builder(authorisation.sigR, authorisation.grindNonce)),
    ).toBeLessThan(JUBJUB_R);
  });

  it('authorises a revokeAllGrants call with no argument', async () => {
    const authorisation = await authoriser.authorise({
      ...addDeviceRequest,
      circuit: REVOKE_ALL_GRANTS_CIRCUIT,
      args: [],
    });

    const builder = jubjubChallenges.revokeAllGrants(
      { contractAddress: CONTRACT_ADDRESS, authNonce: 7n },
      authorisation.pk,
    );
    expect(
      bytesToBigIntLE(builder(authorisation.sigR, authorisation.grindNonce)),
    ).toBeLessThan(JUBJUB_R);
  });

  it('rejects a revokeAllGrants request carrying an argument', async () => {
    await expect(
      authoriser.authorise({
        ...addDeviceRequest,
        circuit: REVOKE_ALL_GRANTS_CIRCUIT,
        args: [GRANT_ID],
      }),
    ).rejects.toThrow(/takes no argument/);
  });

  it('rejects an issueGrant request whose arguments are not a scope', async () => {
    await expect(
      authoriser.authorise({
        ...addDeviceRequest,
        circuit: ISSUE_GRANT_CIRCUIT,
        args: issueArgs.slice(1),
      }),
    ).rejects.toThrow(/scope arguments/);
  });

  it('rejects circuits without a challenge builder that name no bundle', async () => {
    for (const circuit of [
      'activate_initial_device_with_jubjub',
      'withdraw_unshielded_with_jubjub',
    ]) {
      await expect(
        authoriser.authorise({ ...addDeviceRequest, circuit }),
      ).rejects.toThrow(CircuitNotRegisteredError);
    }
  });

  it('signs a descriptor circuit over the challenge the bundle module builds from the address, key, challenge arguments and nonces', async () => {
    const challenge = vi.fn(() => TALLY_CHALLENGE_BYTES);
    const withTally = devJubjubAuthoriser(
      SK,
      createPassportRegistry({
        bundles: [tallyBundle({ [TALLY_CHALLENGE]: challenge })],
      }),
    );

    const authorisation = await withTally.authorise(tallySetRequest);

    expect(authorisation.pk).toEqual({ x: EXPECTED_PK_X, y: EXPECTED_PK_Y });
    expect(authorisation.useCounter).toBe(3n);
    expect(authorisation.grindNonce).toBe(0n);
    expect(challenge).toHaveBeenCalledExactlyOnceWith(
      { bytes: CONTRACT_ADDRESS },
      authorisation.sigR,
      authorisation.pk,
      TALLY_ADDRESS,
      5n,
      7n,
      0n,
    );
    expect(verifies(authorisation, TALLY_CHALLENGE_BYTES)).toBe(true);
    expect(
      verifies(authorisation, new Uint8Array(32).fill(0x44).fill(0, 31)),
    ).toBe(false);
  });

  it('still signs the module circuits over their fixed builders when a bundle is registered', async () => {
    const withTally = devJubjubAuthoriser(
      SK,
      createPassportRegistry({ bundles: [tallyBundle({})] }),
    );

    const authorisation = await withTally.authorise({
      ...addDeviceRequest,
      bundleId: 'account-tally',
    });

    const builder = jubjubChallenges.addDevice(
      { contractAddress: CONTRACT_ADDRESS, authNonce: 7n },
      authorisation.pk,
      NEW_ENTRY,
    );
    expect(
      verifies(
        authorisation,
        builder(authorisation.sigR, authorisation.grindNonce),
      ),
    ).toBe(true);
  });

  it('rejects a descriptor circuit whose request names no bundle', async () => {
    const withTally = devJubjubAuthoriser(
      SK,
      createPassportRegistry({ bundles: [tallyBundle({})] }),
    );

    await expect(
      withTally.authorise({ ...tallySetRequest, bundleId: undefined }),
    ).rejects.toThrow(CircuitNotRegisteredError);
    await expect(
      withTally.authorise({ ...tallySetRequest, bundleId: undefined }),
    ).rejects.toThrow(
      `Circuit ${TALLY_CIRCUIT} is not one of the module's own and names no account bundle.`,
    );
  });

  it('rejects a circuit the named bundle does not describe', async () => {
    const withTally = devJubjubAuthoriser(
      SK,
      createPassportRegistry({ bundles: [tallyBundle({})] }),
    );

    await expect(
      withTally.authorise({ ...tallySetRequest, circuit: 'tally_get' }),
    ).rejects.toThrow(CircuitNotRegisteredError);
    await expect(
      withTally.authorise({ ...tallySetRequest, circuit: 'tally_get' }),
    ).rejects.toThrow(
      "Account bundle 'account-tally' describes no circuit 'tally_get'.",
    );
  });

  it('does not take an inherited property name for a circuit of the module or the bundle', async () => {
    const withTally = devJubjubAuthoriser(
      SK,
      createPassportRegistry({ bundles: [tallyBundle({})] }),
    );

    await expect(
      withTally.authorise({ ...tallySetRequest, circuit: 'constructor' }),
    ).rejects.toThrow(
      "Account bundle 'account-tally' describes no circuit 'constructor'.",
    );
  });

  it('rejects a descriptor circuit of a bundle that is not registered', async () => {
    await expect(authoriser.authorise(tallySetRequest)).rejects.toThrow(
      AccountBundleUnknownError,
    );
  });

  it('rejects a descriptor whose challenge the bundle module does not export', async () => {
    const withTally = devJubjubAuthoriser(
      SK,
      createPassportRegistry({ bundles: [tallyBundle({})] }),
    );

    await expect(withTally.authorise(tallySetRequest)).rejects.toThrow(
      CircuitNotRegisteredError,
    );
    await expect(withTally.authorise(tallySetRequest)).rejects.toThrow(
      `names challenge '${TALLY_CHALLENGE}', which its bundle module does not export`,
    );
  });

  it('rejects a request whose first argument is not a byte array', async () => {
    await expect(
      authoriser.authorise({ ...addDeviceRequest, args: ['5a5a'] }),
    ).rejects.toThrow(/byte-array entry/);
  });

  it('rejects an account address that is not lowercase hex bytes', async () => {
    await expect(
      authoriser.deviceCommitment(
        AccAddress('not-hex'),
        DeviceEpoch(0n),
        UseCounter(0n),
      ),
    ).rejects.toThrow(/lowercase hex/);
  });

  it('generates a working device when no scalar is given', async () => {
    const generated = devJubjubAuthoriser();
    const commitment = await generated.deviceCommitment(
      ACCOUNT,
      DeviceEpoch(0n),
      UseCounter(0n),
    );

    expect(commitment).toMatch(/^[0-9a-f]{64}$/);
    expect(commitment).not.toBe(EXPECTED_ENTRY);
  });
});
