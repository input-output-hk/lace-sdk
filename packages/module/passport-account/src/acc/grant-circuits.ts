import type { GranteeScheme } from '@lace-contract/passport';

/**
 * The gated circuits the grant flows authorise, named once so the flow
 * that submits a call, the authoriser that builds its challenge and the
 * signer that scopes a key session to it agree on the circuit.
 */
export const ISSUE_GRANT_CIRCUIT = 'issue_grant_with_jubjub';
export const REVOKE_GRANT_CIRCUIT = 'revoke_grant_with_jubjub';
export const REVOKE_ALL_GRANTS_CIRCUIT = 'revoke_all_grants_with_jubjub';

/** The withdrawals a grantee may run under a grant. */
const GRANT_WITHDRAWAL_BASES = [
  'withdraw_unshielded',
  'withdraw_shielded',
  'withdraw_shielded_to_contract',
] as const;

/**
 * The withdrawal circuits a grantee of each scheme spends through. An
 * account holds them only when its deployment installed them, and a grant
 * to a grantee whose withdrawals the account lacks can never be spent.
 */
export const GRANTEE_WITHDRAWAL_CIRCUITS: Record<
  GranteeScheme,
  readonly string[]
> = {
  'jubjub-schnorr': GRANT_WITHDRAWAL_BASES.map(
    base => `${base}_with_grant_jubjub`,
  ),
  'secp256k1-ecdsa': GRANT_WITHDRAWAL_BASES.map(
    base => `${base}_with_grant_k256`,
  ),
};
