import { Cardano } from '@lace-lib/cardano-core';
import { Ed25519KeyHashHex } from '@lace-lib/cardano-crypto';

import {
  signingScripts,
  withCarriedScripts,
} from '../../src/util/signingScripts';

import type { SignTransactionContext } from '../../src';

const requireSignature = (byte: string): Cardano.NativeScript => ({
  __type: Cardano.ScriptType.Native,
  keyHash: Ed25519KeyHashHex(byte.repeat(28)),
  kind: Cardano.NativeScriptKind.RequireSignature,
});

describe('signingScripts', () => {
  it('joins the scripts of every source in order', () => {
    const first = requireSignature('11');
    const second = requireSignature('22');

    expect(signingScripts([first], undefined, [second])).toEqual([
      first,
      second,
    ]);
  });

  it('keeps one script per script hash', () => {
    const script = requireSignature('11');

    expect(signingScripts([script], [{ ...script }])).toEqual([script]);
  });
});

describe('withCarriedScripts', () => {
  const context: SignTransactionContext = {
    knownAddresses: [],
    txInKeyPathMap: {},
  };

  it('returns the context as it is when the transaction carries no scripts', () => {
    expect(withCarriedScripts(context, undefined)).toBe(context);
    expect(withCarriedScripts(context, [])).toBe(context);
  });

  it('adds the carried scripts after the scripts of the context', () => {
    const passed = requireSignature('11');
    const carried = requireSignature('22');

    expect(
      withCarriedScripts({ ...context, scripts: [passed] }, [carried, passed]),
    ).toEqual({ ...context, scripts: [passed, carried] });
  });
});
