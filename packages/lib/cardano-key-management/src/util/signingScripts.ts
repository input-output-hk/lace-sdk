import { Serialization } from '@lace-lib/cardano-core';
import uniqBy from 'lodash/uniqBy.js';

import type { SignTransactionContext } from '../types';
import type { Cardano } from '@lace-lib/cardano-core';

/**
 * Joins the scripts a signer looks up required keys in, keeping the first
 * of each script hash so a script given twice counts once.
 *
 * @param sources The scripts of each source, in order of precedence.
 * @returns Every distinct script of the sources.
 */
export const signingScripts = (
  ...sources: (Cardano.Script[] | undefined)[]
): Cardano.Script[] =>
  uniqBy(
    sources.flatMap(scripts => scripts ?? []),
    script => Serialization.Script.fromCore(script).hash(),
  );

/**
 * Adds the scripts a transaction carries in its witness set to a signing
 * context, so the keys its native scripts require are signed with even when
 * the caller does not pass them.
 *
 * @param context The signing context.
 * @param carried The scripts in the transaction's witness set.
 * @returns The context, with the carried scripts after its own when there
 *   are any.
 */
export const withCarriedScripts = (
  context: SignTransactionContext,
  carried: Cardano.Script[] | undefined,
): SignTransactionContext =>
  carried?.length
    ? { ...context, scripts: signingScripts(context.scripts, carried) }
    : context;
