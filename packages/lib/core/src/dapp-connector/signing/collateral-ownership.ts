import { Cardano } from '@lace-lib/vendor';

import { getPaymentCredential } from '../../address';

export type CollateralOwnershipErrorCase = 'foreign-collateral-return';

// Claims non-ownership, never attacker intent: the wallet cannot know whether
// the return target is hostile or the user's own not-yet-derived address.
const MESSAGE: Record<CollateralOwnershipErrorCase, string> = {
  'foreign-collateral-return':
    "if the smart contract fails, this transaction would send this wallet's funds to an address this wallet doesn't own; Lace won't sign it.",
};

/**
 * The dApp-facing refusal sentence. Untranslated by contract: it travels over
 * CIP-30 to a dApp, so it must not depend on the user's locale. The on-screen
 * copy is separate, and localized.
 */
export const collateralRefusalMessage = (
  errorCase: CollateralOwnershipErrorCase,
): string => MESSAGE[errorCase];

/**
 * The ownership authority the rule reads. Callers decide what these sets
 * contain and build them with {@link toCollateralOwnershipSets}; this module
 * only classifies against them.
 */
export interface CollateralOwnershipSets {
  /** Outpoint keys of every collateral-input UTxO the signing account owns. */
  ownUtxoRefs: ReadonlySet<string>;
  /** The signing account's known addresses on the active network. */
  ownAddresses: ReadonlySet<Cardano.PaymentAddress>;
}

const outpointKey = (input: Cardano.TxIn) => `${input.txId}#${input.index}`;

/**
 * The authority in the shape {@link collateralRefusalCase} reads, from the
 * collateral inputs the caller counts as the account's own. The only builder
 * of `ownUtxoRefs`, so every caller keys them the way the rule keys
 * collateral inputs.
 */
export const toCollateralOwnershipSets = ({
  ownInputs,
  ownAddresses,
}: {
  ownInputs: readonly Cardano.TxIn[];
  ownAddresses: readonly Cardano.PaymentAddress[];
}): CollateralOwnershipSets => ({
  ownUtxoRefs: new Set(ownInputs.map(outpointKey)),
  ownAddresses: new Set(ownAddresses),
});

/**
 * The signing-boundary authority: a collateral input is ours only when
 * `resolveInput` traces it to an output at one of our payment keys; one that
 * does not resolve, or whose resolver throws, is not (LW-15506).
 *
 * The return-address set stays whole-address: see {@link collateralRefusalCase}.
 */
export const resolveCollateralOwnershipSets = async ({
  body,
  resolveInput,
  ownAddresses,
}: {
  body: Cardano.TxBody;
  resolveInput: Cardano.InputResolver['resolveInput'];
  ownAddresses: readonly Cardano.PaymentAddress[];
}): Promise<CollateralOwnershipSets> => {
  const ownPaymentKeyHashes = new Set(
    ownAddresses.flatMap(address => {
      const credential = getPaymentCredential(address);
      return credential?.type === Cardano.CredentialType.KeyHash
        ? [credential.hash]
        : [];
    }),
  );
  const isOwn = async (input: Cardano.TxIn) => {
    const output = await resolveInput(input).catch(() => null);
    if (!output) return false;
    const credential = getPaymentCredential(output.address);
    return (
      credential?.type === Cardano.CredentialType.KeyHash &&
      ownPaymentKeyHashes.has(credential.hash)
    );
  };

  const verdicts = await Promise.all(
    (body.collaterals ?? []).map(async input => ({
      input,
      own: await isOwn(input),
    })),
  );
  return toCollateralOwnershipSets({
    ownInputs: verdicts.filter(({ own }) => own).map(({ input }) => input),
    ownAddresses,
  });
};

/**
 * The collateral-return rule (LW-15390): if any collateral input is ours, the
 * collateral return must be ours. Returns the refusal case, or `null` when the
 * transaction may be signed (no return at all is pure ADA by ledger rule).
 *
 * Return-address ownership is STRICT full-address membership, NEVER
 * payment-credential membership: an attacker base address that reuses the
 * wallet's payment credential with a foreign stake credential is a different
 * full address and must read as foreign.
 */
export const collateralRefusalCase = (
  body: Cardano.TxBody,
  ownership: CollateralOwnershipSets,
): CollateralOwnershipErrorCase | null => {
  const collaterals = body.collaterals;
  // Ordinary collateral-free requests short-circuit before any classification.
  if (!collaterals || collaterals.length === 0) {
    return null;
  }

  if (
    !collaterals.some(input => ownership.ownUtxoRefs.has(outpointKey(input)))
  ) {
    return null;
  }

  const collateralReturn = body.collateralReturn;
  if (!collateralReturn) {
    return null;
  }

  return ownership.ownAddresses.has(collateralReturn.address)
    ? null
    : 'foreign-collateral-return';
};
