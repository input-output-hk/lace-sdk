/**
 * One native-script evaluator for every question Lace asks of a transaction's
 * scripts: whether a signer's keys complete it (the full-sign gate), whether
 * the witnesses it actually produced do (the post-sign check), and whether a
 * device can contribute its share at all (hardware capability). The callers
 * differ only in which key witnesses they count and whether time is checked.
 */
import { Cardano } from '@lace-lib/vendor';

export type NativeScriptWitnesses = {
  /** Whether a vkey witness for this key hash counts as present. */
  hasKeyWitness: (keyHash: string) => boolean;
  isTimelockMet: (
    script: Cardano.RequireTimeAfterScript | Cardano.RequireTimeBeforeScript,
  ) => boolean;
};

/**
 * The ledger's `evalTimelock` rule for a transaction's validity interval: a
 * timelock holds only when the transaction's own bound proves it, so a missing
 * bound fails it. `RequireTimeAfter(s)` needs `invalidBefore >= s`;
 * `RequireTimeBefore(s)` needs `invalidHereafter <= s`.
 *
 * The core SDK reads slots as a `Number`, exact only below 2^53: a comparison
 * involving a larger slot fails closed.
 */
export const timelockMetWithin =
  (validityInterval: Cardano.ValidityInterval | undefined) =>
  (
    script: Cardano.RequireTimeAfterScript | Cardano.RequireTimeBeforeScript,
  ): boolean => {
    const isExact = (slot: number | undefined): slot is number =>
      slot !== undefined && Number.isSafeInteger(slot);
    if (!isExact(script.slot)) return false;
    if (script.kind === Cardano.NativeScriptKind.RequireTimeAfter) {
      const { invalidBefore } = validityInterval ?? {};
      return isExact(invalidBefore) && script.slot <= invalidBefore;
    }
    const { invalidHereafter } = validityInterval ?? {};
    return isExact(invalidHereafter) && invalidHereafter <= script.slot;
  };

/**
 * Whether every slot and threshold in `script` is below 2^53. The core SDK
 * reads them as a `Number`, so a larger one is rounded, and the script it
 * serialises again (to hash it, or for a device) is a different script.
 */
export const isNativeScriptExact = (script: Cardano.NativeScript): boolean => {
  switch (script.kind) {
    case Cardano.NativeScriptKind.RequireTimeAfter:
    case Cardano.NativeScriptKind.RequireTimeBefore: {
      return Number.isSafeInteger(script.slot);
    }
    case Cardano.NativeScriptKind.RequireNOf: {
      return (
        Number.isSafeInteger(script.required) &&
        script.scripts.every(isNativeScriptExact)
      );
    }
    case Cardano.NativeScriptKind.RequireAllOf:
    case Cardano.NativeScriptKind.RequireAnyOf: {
      return script.scripts.every(isNativeScriptExact);
    }
    case Cardano.NativeScriptKind.RequireSignature:
    case Cardano.NativeScriptKind.RequireGuard: {
      return true;
    }
  }
};

/**
 * Whether `witnesses` validate the script. A guard over a script credential is
 * never met by key witnesses, and an unrecognised kind fails closed.
 */
export const isNativeScriptSatisfied = (
  script: Cardano.NativeScript,
  witnesses: NativeScriptWitnesses,
): boolean => {
  switch (script.kind) {
    case Cardano.NativeScriptKind.RequireSignature: {
      return witnesses.hasKeyWitness(script.keyHash);
    }
    case Cardano.NativeScriptKind.RequireAllOf: {
      return script.scripts.every(child =>
        isNativeScriptSatisfied(child, witnesses),
      );
    }
    case Cardano.NativeScriptKind.RequireAnyOf: {
      return script.scripts.some(child =>
        isNativeScriptSatisfied(child, witnesses),
      );
    }
    case Cardano.NativeScriptKind.RequireNOf: {
      return (
        script.scripts.filter(child =>
          isNativeScriptSatisfied(child, witnesses),
        ).length >= script.required
      );
    }
    case Cardano.NativeScriptKind.RequireTimeAfter:
    case Cardano.NativeScriptKind.RequireTimeBefore: {
      return witnesses.isTimelockMet(script);
    }
    case Cardano.NativeScriptKind.RequireGuard: {
      return (
        script.credential.type === Cardano.CredentialType.KeyHash &&
        witnesses.hasKeyWitness(script.credential.hash)
      );
    }
    default: {
      return false;
    }
  }
};
