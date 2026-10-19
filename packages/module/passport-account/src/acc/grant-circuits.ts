/**
 * The gated circuits the grant flows authorise, named once so the flow
 * that submits a call, the authoriser that builds its challenge and the
 * signer that scopes a key session to it agree on the circuit.
 */
export const ISSUE_GRANT_CIRCUIT = 'issue_grant_with_jubjub';
export const REVOKE_GRANT_CIRCUIT = 'revoke_grant_with_jubjub';
export const REVOKE_ALL_GRANTS_CIRCUIT = 'revoke_all_grants_with_jubjub';
