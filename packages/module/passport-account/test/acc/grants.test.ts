/**
 * Every derivation below is checked against the generated contract
 * module's own pure circuits, called with literal arguments in the
 * circuit's declaration order, so a change to the contract's encoding or
 * argument order breaks these tests before it reaches a device signature.
 */
import {
  GrantLimitReachedError,
  GrantScopeInvalidError,
  GrantSlot,
  TokenColor,
} from '@lace-contract/passport';
import { HexBytes } from '@lace-lib/util';
import { jubjub } from '@noble/curves/misc.js';
import { describe, expect, it } from 'vitest';

import { pureCircuits } from '../../src/acc/acc-module';
import {
  ISSUE_GRANT_CIRCUIT,
  REVOKE_ALL_GRANTS_CIRCUIT,
  REVOKE_GRANT_CIRCUIT,
} from '../../src/acc/grant-circuits';
import {
  circuitScope,
  deriveGrantId,
  issueGrantBinding,
  originHash,
  prepareIssueGrant,
  prepareRevokeAllGrants,
  prepareRevokeGrant,
  scopeArgs,
  scopeDigest,
} from '../../src/acc/grants';
import { JubjubDevice } from '../../src/acc/signer';

import type {
  GrantId,
  GrantRecord,
  GrantScopeInput,
} from '@lace-contract/passport';
import type { JubjubPoint } from '@midnight-ntwrk/compact-runtime';

const CONTRACT_ADDRESS = Uint8Array.from(
  { length: 32 },
  (_, index) => index + 1,
);
const ORIGIN = new Uint8Array(32).fill(0x11);
const SCOPE_SALT = new Uint8Array(32).fill(0x22);
const RECIPIENT_HEX = 'cd'.repeat(32);
const CALLER_HEX = 'ef'.repeat(32);
const NIGHT = TokenColor('00'.repeat(32));
const ZERO32 = new Uint8Array(32);

const EXPECTED_ORIGIN_HASHES = {
  'lace.io': 'f8b3d372bcdb710142d197d16374a5eead6ff02f9c66b028d432217d701a6778',
  'https://bank.example':
    '5847018b6d2663a49e27bd119ba50c0d0fdb9ceec83f6dddcf4ae3be648dc780',
};

const grantee = new JubjubDevice(55n);

/** The 32-byte compressed form a consumer supplies a grantee key in. */
const compress = (point: JubjubPoint): string =>
  HexBytes.fromByteArray(jubjub.Point.fromAffine(point).toBytes());

const spendScope: GrantScopeInput = {
  grantee: { scheme: 'jubjub-schnorr', publicKey: compress(grantee.pk) },
  operations: ['withdraw-unshielded'],
  color: NIGHT,
  recipient: { kind: 'any' },
  maxCoinValue: '300',
  perCallCap: '300',
  cap: '450',
  expiresAt: null,
};

const grantRecord = (id: GrantId, active = true): GrantRecord => ({
  id,
  slot: GrantSlot(0),
  active,
  epoch: 0,
  generation: 0,
  issuedAt: 1,
  scope: {
    operations: ['withdraw-unshielded'],
    read: false,
    objectCommit: '00'.repeat(32),
    perCallCap: '300',
    cap: '450',
    expiresAt: null,
    rpCommit: '00'.repeat(32),
    readPkHash: '00'.repeat(32),
    window: null,
    callerCommit: '00'.repeat(32),
  },
  spentWindow: { start: 0, spent: '0' },
});

const idAtSlot = (slot: number): GrantId =>
  deriveGrantId({
    contractAddress: CONTRACT_ADDRESS,
    granteePublicKey: grantee.pk,
    originHash: ORIGIN,
    slot: GrantSlot(slot),
  });

const rosterAtSlots = (slots: number[]): GrantRecord[] =>
  slots.map(slot => grantRecord(idAtSlot(slot)));

describe('originHash', () => {
  it.each(Object.entries(EXPECTED_ORIGIN_HASHES))(
    'hashes the padded origin tag and the client id %s',
    async (clientId, expected) => {
      expect(HexBytes.fromByteArray(await originHash(clientId))).toBe(expected);
    },
  );

  it('separates client ids that share a prefix', async () => {
    const [short, long] = await Promise.all([
      originHash('lace.io'),
      originHash('lace.io/'),
    ]);
    expect(HexBytes.fromByteArray(short)).not.toBe(
      HexBytes.fromByteArray(long),
    );
  });
});

describe('scopeDigest', () => {
  it('matches the contract pure circuit over the literal declaration order', () => {
    const scope = circuitScope({
      ...spendScope,
      recipient: { kind: 'user-address', value: RECIPIENT_HEX },
      expiresAt: 1_900_000_000,
      caller: CALLER_HEX,
    });
    const recipient = Uint8Array.from(Buffer.from(RECIPIENT_HEX, 'hex'));
    const caller = Uint8Array.from(Buffer.from(CALLER_HEX, 'hex'));

    const expected = pureCircuits.derive_grant_scope_digest(
      SCOPE_SALT,
      true,
      false,
      false,
      false,
      ZERO32,
      1n,
      recipient,
      300n,
      300n,
      450n,
      1_900_000_000n,
      ZERO32,
      ZERO32,
      0n,
      0n,
      { is_some: true, value: { bytes: caller } },
    );

    expect(scopeDigest(SCOPE_SALT, scopeArgs(scope))).toEqual(expected);
  });

  it('changes with the salt', () => {
    const args = scopeArgs(circuitScope(spendScope));

    expect(scopeDigest(SCOPE_SALT, args)).not.toEqual(
      scopeDigest(new Uint8Array(32).fill(0x23), args),
    );
  });
});

describe('deriveGrantId', () => {
  it('matches the contract pure circuit for a fixed grantee, origin and slot', () => {
    const expected = pureCircuits.derive_grant_id_with_jubjub(
      { bytes: CONTRACT_ADDRESS },
      grantee.pk,
      ORIGIN,
      3n,
    );

    expect(idAtSlot(3)).toBe(HexBytes.fromByteArray(expected));
  });

  it('differs per slot', () => {
    expect(idAtSlot(0)).not.toBe(idAtSlot(1));
  });
});

describe('prepareIssueGrant slot allocation', () => {
  const allocate = (roster: GrantRecord[]) =>
    prepareIssueGrant({
      contractAddress: CONTRACT_ADDRESS,
      scope: spendScope,
      originHash: ORIGIN,
      roster,
    }).slot;

  it('allocates slot 0 on an empty roster', () => {
    expect(allocate([])).toBe(0);
  });

  it('allocates the first slot without an active grant', () => {
    expect(allocate(rosterAtSlots([0, 1, 3]))).toBe(2);
  });

  it('reuses the slot of a revoked grant', () => {
    expect(allocate([grantRecord(idAtSlot(0), false)])).toBe(0);
  });

  it('ignores grants of other grantees', () => {
    const other = new JubjubDevice(56n);
    const foreign = deriveGrantId({
      contractAddress: CONTRACT_ADDRESS,
      granteePublicKey: other.pk,
      originHash: ORIGIN,
      slot: GrantSlot(0),
    });

    expect(allocate([grantRecord(foreign)])).toBe(0);
  });

  it('allocates slot 255 when the grantee has 255 slots used', () => {
    const used = Array.from({ length: 255 }, (_, slot) => slot);

    expect(allocate(rosterAtSlots(used))).toBe(255);
  });

  it('refuses a grantee with every slot used', () => {
    const used = Array.from({ length: 256 }, (_, slot) => slot);

    expect(() => allocate(rosterAtSlots(used))).toThrow(GrantLimitReachedError);
  });

  it('rejects a grantee key that is not a jubjub point', () => {
    const allocateKey = (publicKey: string) => () =>
      prepareIssueGrant({
        contractAddress: CONTRACT_ADDRESS,
        scope: {
          ...spendScope,
          grantee: { scheme: 'jubjub-schnorr', publicKey },
        },
        originHash: ORIGIN,
        roster: [],
      });

    expect(allocateKey('ff'.repeat(32))).toThrow(
      new GrantScopeInvalidError(
        'grantee public key is not a point on the jubjub curve',
      ),
    );
    expect(allocateKey('ab'.repeat(16))).toThrow(GrantScopeInvalidError);
    expect(allocateKey(`01${'00'.repeat(31)}`)).toThrow(
      new GrantScopeInvalidError('grantee public key has small order'),
    );
  });
});

describe('prepareIssueGrant', () => {
  const randomBytes = (length: number) => new Uint8Array(length).fill(0x22);
  const prepare = (scope: GrantScopeInput, roster: GrantRecord[] = []) =>
    prepareIssueGrant({
      contractAddress: CONTRACT_ADDRESS,
      scope,
      originHash: ORIGIN,
      roster,
      randomBytes,
    });

  it('derives the grant id from the compressed grantee key at the allocated slot', () => {
    const preparation = prepare(spendScope, rosterAtSlots([0]));

    expect(preparation.slot).toBe(1);
    expect(preparation.grantId).toBe(idAtSlot(1));
    expect(preparation.scopeSalt).toBe('22'.repeat(32));
    expect(preparation.scopeDigest).toBe(
      HexBytes.fromByteArray(
        scopeDigest(SCOPE_SALT, scopeArgs(circuitScope(spendScope))),
      ),
    );
  });

  it('lays the call out as grant id, scope in declaration order, then salt', () => {
    const { call, grantId } = prepare(spendScope);

    expect(call.circuit).toBe(ISSUE_GRANT_CIRCUIT);
    expect(call.args).toHaveLength(18);
    expect(call.args[0]).toEqual(Uint8Array.from(Buffer.from(grantId, 'hex')));
    expect(call.args.slice(1, 17)).toEqual(scopeArgs(circuitScope(spendScope)));
    expect(call.args[17]).toEqual(SCOPE_SALT);
  });

  it('binds the issue challenge to the digest the contract derives from the call', () => {
    const { call, grantId } = prepare(spendScope);

    const binding = issueGrantBinding(call.args);

    expect(HexBytes.fromByteArray(binding.grantId)).toBe(grantId);
    expect(binding.scopeDigest).toEqual(
      pureCircuits.derive_grant_scope_digest(
        SCOPE_SALT,
        true,
        false,
        false,
        false,
        ZERO32,
        0n,
        ZERO32,
        300n,
        300n,
        450n,
        0n,
        ZERO32,
        ZERO32,
        0n,
        0n,
        { is_some: false, value: { bytes: ZERO32 } },
      ),
    );
  });

  it('refuses a scope that breaks an issue rule before allocating', () => {
    expect(() =>
      prepare({ ...spendScope, read: true, rpId: 'lace.io' }),
    ).toThrow(GrantScopeInvalidError);
  });

  it('draws a fresh salt from Web Crypto by default', () => {
    const first = prepareIssueGrant({
      contractAddress: CONTRACT_ADDRESS,
      scope: spendScope,
      originHash: ORIGIN,
      roster: [],
    });
    const second = prepareIssueGrant({
      contractAddress: CONTRACT_ADDRESS,
      scope: spendScope,
      originHash: ORIGIN,
      roster: [],
    });

    expect(first.scopeSalt).toMatch(/^[0-9a-f]{64}$/);
    expect(first.scopeSalt).not.toBe(second.scopeSalt);
  });
});

describe('issueGrantBinding', () => {
  const { call } = prepareIssueGrant({
    contractAddress: CONTRACT_ADDRESS,
    scope: spendScope,
    originHash: ORIGIN,
    roster: [],
  });

  it.each([
    ['too few arguments', call.args.slice(0, 17)],
    ['a grant id that is not bytes', ['ab'.repeat(32), ...call.args.slice(1)]],
    ['a salt that is not bytes', [...call.args.slice(0, 17), 'salt']],
    [
      'a scope field of the wrong kind',
      [call.args[0], 1n, ...call.args.slice(2)],
    ],
    [
      'a caller that is not a Maybe<ContractAddress>',
      [...call.args.slice(0, 16), { bytes: ZERO32 }, call.args[17]],
    ],
  ])('rejects %s', (_label, args) => {
    expect(() => issueGrantBinding(args)).toThrow(
      /expects a grant id, 16 scope arguments and a scope salt/,
    );
  });
});

describe('prepareRevokeGrant', () => {
  it('passes the grant id bytes as the only argument', () => {
    const grantId = idAtSlot(4);

    expect(prepareRevokeGrant(grantId)).toEqual({
      circuit: REVOKE_GRANT_CIRCUIT,
      args: [Uint8Array.from(Buffer.from(grantId, 'hex'))],
    });
  });
});

describe('prepareRevokeAllGrants', () => {
  it('passes no argument', () => {
    expect(prepareRevokeAllGrants()).toEqual({
      circuit: REVOKE_ALL_GRANTS_CIRCUIT,
      args: [],
    });
  });
});
