import { AuthorityRetiredError } from '@lace-contract/passport';
import { describe, expect, it } from 'vitest';

import { planDeployWaves, planResumeWaves } from '../../src/acc/wave-plan';

import type { DeployWave } from '../../src/acc/wave-plan';

/** Verifier key sizes measured from the vendored artefacts, in bytes. */
const JUBJUB_KEY_BYTES = 2313;
const DEPOSIT_UNSHIELDED_KEY_BYTES = 1353;
const DEPOSIT_SHIELDED_KEY_BYTES = 2121;

const DEVICE_CIRCUITS = [
  'activate_initial_device',
  'withdraw_unshielded',
  'append_inbox',
  'withdraw_shielded',
  'withdraw_shielded_to_contract',
  'rotate_enc_key',
  'add_device',
  'remove_device',
].map(base => `${base}_with_jubjub`);

const GRANT_CIRCUITS = [
  'issue_grant_with_jubjub',
  'revoke_grant_with_jubjub',
  'revoke_all_grants_with_jubjub',
  'withdraw_unshielded_with_grant_jubjub',
  'withdraw_shielded_with_grant_jubjub',
  'withdraw_shielded_to_contract_with_grant_jubjub',
];

const ROSTER = [
  'deposit_unshielded',
  'deposit_shielded',
  ...DEVICE_CIRCUITS,
  ...GRANT_CIRCUITS,
];

const sizeOf = (operation: string): number => {
  if (operation === 'deposit_unshielded') return DEPOSIT_UNSHIELDED_KEY_BYTES;
  if (operation === 'deposit_shielded') return DEPOSIT_SHIELDED_KEY_BYTES;
  return JUBJUB_KEY_BYTES;
};

const sizes = new Map(ROSTER.map(operation => [operation, sizeOf(operation)]));

const operationsOf = (waves: DeployWave[]): string[][] =>
  waves.map(wave => wave.operations);

describe('planDeployWaves', () => {
  it('packs the 16 operation roster into three waves under the 15,000 byte budget', () => {
    const waves = planDeployWaves(ROSTER, sizes, { retireAuthority: false });

    expect(waves.map(wave => wave.kind)).toEqual([
      'deploy',
      'maintenance',
      'maintenance',
    ]);
    expect(operationsOf(waves)).toEqual([
      ROSTER.slice(0, 6),
      ROSTER.slice(6, 12),
      ROSTER.slice(12),
    ]);
    expect(waves.map(wave => wave.verifierBytes)).toEqual([
      12_726, 13_878, 9252,
    ]);
    for (const wave of waves) {
      expect(wave.verifierBytes).toBeLessThanOrEqual(15_000);
    }
    expect(waves.flatMap(wave => wave.operations)).toEqual(ROSTER);
    expect(waves.reduce((total, wave) => total + wave.verifierBytes, 0)).toBe(
      35_856,
    );
  });

  it('keeps the roster order, so the activation circuit lands in the deploy', () => {
    const [deploy] = planDeployWaves(ROSTER, sizes, { retireAuthority: true });

    expect(deploy.operations).toContain('activate_initial_device_with_jubjub');
  });

  it('is deterministic for a given roster and key set', () => {
    const first = planDeployWaves(ROSTER, sizes, { retireAuthority: true });
    const second = planDeployWaves(ROSTER, sizes, { retireAuthority: true });

    expect(second).toEqual(first);
  });

  it('retires the authority in the last maintenance wave only', () => {
    const waves = planDeployWaves(ROSTER, sizes, { retireAuthority: true });

    expect(waves.map(wave => wave.retiresAuthority)).toEqual([
      false,
      false,
      true,
    ]);
  });

  it('retires nothing when the account stays open', () => {
    const waves = planDeployWaves(ROSTER, sizes, { retireAuthority: false });

    expect(waves.some(wave => wave.retiresAuthority)).toBe(false);
  });

  it('fits a roster within the budget into the deploy alone', () => {
    const roster = ROSTER.slice(0, 6);

    const waves = planDeployWaves(roster, sizes, { retireAuthority: false });

    expect(waves).toEqual([
      {
        kind: 'deploy',
        operations: roster,
        verifierBytes: 12_726,
        retiresAuthority: false,
      },
    ]);
  });

  it('adds a retire-only wave to a single-wave roster of a locked account', () => {
    const roster = ROSTER.slice(0, 6);

    const waves = planDeployWaves(roster, sizes, { retireAuthority: true });

    expect(waves).toHaveLength(2);
    expect(waves[1]).toEqual({
      kind: 'maintenance',
      operations: [],
      verifierBytes: 0,
      retiresAuthority: true,
    });
  });

  it('starts a new wave when the next key would exceed the budget exactly by one byte', () => {
    const roster = ['a', 'b', 'c'];
    const exact = new Map([
      ['a', 10],
      ['b', 5],
      ['c', 1],
    ]);

    expect(
      operationsOf(
        planDeployWaves(roster, exact, { retireAuthority: false, budget: 15 }),
      ),
    ).toEqual([['a', 'b'], ['c']]);
    expect(
      operationsOf(
        planDeployWaves(roster, exact, { retireAuthority: false, budget: 14 }),
      ),
    ).toEqual([['a'], ['b', 'c']]);
  });

  it('refuses a verifier key larger than the budget', () => {
    expect(() =>
      planDeployWaves(ROSTER, sizes, { retireAuthority: false, budget: 2000 }),
    ).toThrow(
      "The verifier key of 'deposit_shielded' (2121 bytes) exceeds the 2000 byte wave budget",
    );
  });

  it('refuses an operation with no measured key size', () => {
    expect(() =>
      planDeployWaves([...ROSTER, 'recover_submit'], sizes, {
        retireAuthority: false,
      }),
    ).toThrow("No verifier key size for operation 'recover_submit'");
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses the budget %s',
    budget => {
      expect(() =>
        planDeployWaves(ROSTER, sizes, { retireAuthority: false, budget }),
      ).toThrow('The verifier byte budget must be a positive number');
    },
  );

  it('refuses an empty roster', () => {
    expect(() =>
      planDeployWaves([], sizes, { retireAuthority: false }),
    ).toThrow('A deployment needs at least one operation');
  });
});

describe('planResumeWaves', () => {
  it('packs the operations the chain lacks into maintenance waves', () => {
    const waves = planResumeWaves({
      operations: ROSTER,
      sizes,
      installed: ROSTER.slice(0, 6),
      isAuthorityRetired: false,
      retireAuthority: false,
    });

    expect(waves.map(wave => wave.kind)).toEqual([
      'maintenance',
      'maintenance',
    ]);
    expect(operationsOf(waves)).toEqual([
      ROSTER.slice(6, 12),
      ROSTER.slice(12),
    ]);
    expect(waves.some(wave => wave.retiresAuthority)).toBe(false);
  });

  it('repacks from the installed set, so a wave that landed is never sent twice', () => {
    const waves = planResumeWaves({
      operations: ROSTER,
      sizes,
      installed: ROSTER.slice(0, 12),
      isAuthorityRetired: false,
      retireAuthority: true,
    });

    expect(operationsOf(waves)).toEqual([ROSTER.slice(12)]);
    expect(waves[0].retiresAuthority).toBe(true);
  });

  it('ignores the order and extras of the installed set', () => {
    const waves = planResumeWaves({
      operations: ROSTER,
      sizes,
      installed: [...ROSTER.slice(0, 6)].reverse().concat('recover_submit'),
      isAuthorityRetired: false,
      retireAuthority: false,
    });

    expect(waves.flatMap(wave => wave.operations)).toEqual(ROSTER.slice(6));
  });

  it('plans a retire-only wave when every operation is in but the lock is still due', () => {
    const waves = planResumeWaves({
      operations: ROSTER,
      sizes,
      installed: ROSTER,
      isAuthorityRetired: false,
      retireAuthority: true,
    });

    expect(waves).toEqual([
      {
        kind: 'maintenance',
        operations: [],
        verifierBytes: 0,
        retiresAuthority: true,
      },
    ]);
  });

  it('plans nothing when every operation is in and the account stays open', () => {
    expect(
      planResumeWaves({
        operations: ROSTER,
        sizes,
        installed: ROSTER,
        isAuthorityRetired: false,
        retireAuthority: false,
      }),
    ).toEqual([]);
  });

  it('plans nothing when every operation is in and the authority is already retired', () => {
    expect(
      planResumeWaves({
        operations: ROSTER,
        sizes,
        installed: ROSTER,
        isAuthorityRetired: true,
        retireAuthority: true,
      }),
    ).toEqual([]);
  });

  it('rejects with AuthorityRetiredError when operations are missing and nothing can install them', () => {
    expect(() =>
      planResumeWaves({
        operations: ROSTER,
        sizes,
        installed: ROSTER.slice(0, 12),
        isAuthorityRetired: true,
        retireAuthority: true,
      }),
    ).toThrow(
      new AuthorityRetiredError(
        `The maintenance authority is retired and 4 operations are not installed: ${ROSTER.slice(
          12,
        ).join(', ')}`,
      ),
    );
  });

  it('refuses a missing operation whose key exceeds the budget', () => {
    expect(() =>
      planResumeWaves({
        operations: ROSTER,
        sizes,
        installed: ROSTER.slice(0, 6),
        isAuthorityRetired: false,
        retireAuthority: false,
        budget: 2000,
      }),
    ).toThrow('exceeds the 2000 byte wave budget');
  });
});
