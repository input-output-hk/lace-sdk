// Mirrors src/policy/script-data.ts of Biglup/cardano-account-custody-fee-sponsor
// at revision 4de7a3812af99c631870724a0633f6250ed4f23a (Apache-2.0). Modified
// for Lace: it reads @cardano-sdk/core values, returns typed problems, and
// leaves which Plutus languages a transaction may carry to its callers.

import { Cardano, Serialization } from '@lace-lib/cardano-core';
import { blake2b } from '@lace-lib/cardano-crypto';
import { HexBlob } from '@lace-lib/cardano-util';

import { bytesToHex } from '../hex';

import type { Hash32ByteBase16 } from '@lace-lib/cardano-crypto';

/**
 * What a transaction's script data hash covers: the witness set's
 * redeemers and datums, as the bytes it states them in, and the Plutus
 * languages whose cost models enter the language views.
 */
export interface ScriptData {
  readonly redeemers: HexBlob | undefined;
  readonly datums: HexBlob | undefined;
  /** Of every attached script, then of every reference script resolved. */
  readonly languages: readonly Cardano.PlutusLanguageVersion[];
}

/** Why the script data hash a body declares is not the one its script data calls for. */
export type ScriptDataHashProblem =
  | {
      readonly reason: 'missing-cost-model';
      readonly language: Cardano.PlutusLanguageVersion;
    }
  | {
      readonly reason: 'script-data-hash-mismatch';
      readonly declared: Hash32ByteBase16;
      readonly computed: Hash32ByteBase16;
    }
  | {
      readonly reason: 'unexpected-script-data-hash';
      readonly declared: Hash32ByteBase16;
    }
  | { readonly reason: 'missing-script-data-hash' };

/** Reads each entry of the CBOR map the reader is at, definite or not. */
export const readMapEntries = (
  reader: Serialization.CborReader,
  readEntry: () => void,
): void => {
  const count = reader.readStartMap();
  for (
    let read = 0;
    count === null
      ? reader.peekState() !== Serialization.CborReaderState.EndMap
      : read < count;
    read++
  ) {
    readEntry();
  }
};

/** The fields of an encoded body or witness set by key, each as the bytes it is stated in. */
export const fieldsOf = (encoded: Uint8Array): Map<bigint, HexBlob> => {
  const reader = new Serialization.CborReader(bytesToHex(encoded));
  const fields = new Map<bigint, HexBlob>();
  readMapEntries(reader, () =>
    fields.set(reader.readUInt(), bytesToHex(reader.readEncodedValue())),
  );
  return fields;
};

const WITNESS_DATUMS = 4n;
const WITNESS_REDEEMERS = 5n;

/** The redeemers that stand in for a witness set carrying datums and no redeemers. */
const EMPTY_REDEEMERS = 'a0';

/**
 * The script data of a transaction. Redeemers and datums are read from the
 * transaction's bytes, since the hash is taken over the bytes the witness
 * set carries. The languages are those of the scripts it attaches and of
 * the reference scripts the resolved outputs of its inputs and reference
 * inputs carry: a superset of what the ledger counts, so a hash over a
 * language the ledger would leave out fails to match rather than passing.
 *
 * @param resolved - the outputs the inputs and reference inputs spend or
 *   read, undefined where the caller resolved none
 */
export const scriptDataOf = (
  transaction: Serialization.Transaction,
  resolved: readonly (Cardano.TxOut | undefined)[],
): ScriptData => {
  const reader = new Serialization.CborReader(HexBlob(transaction.toCbor()));
  reader.readStartArray();
  reader.skipValue();
  const witnessSet = fieldsOf(reader.readEncodedValue());
  return {
    redeemers: witnessSet.get(WITNESS_REDEEMERS),
    datums: witnessSet.get(WITNESS_DATUMS),
    languages: [
      ...(transaction.witnessSet().toCore().scripts ?? []).flatMap(script =>
        Cardano.isPlutusScript(script) ? [script.version] : [],
      ),
      ...resolved.flatMap(output =>
        output?.scriptReference &&
        Cardano.isPlutusScript(output.scriptReference)
          ? [output.scriptReference.version]
          : [],
      ),
    ],
  };
};

/** Whether the witness set carries redeemers or datums, which a script data hash must cover. */
export const hasScriptData = ({ redeemers, datums }: ScriptData): boolean =>
  redeemers !== undefined || datums !== undefined;

/**
 * Checks the script data hash a body declares against the one its script
 * data hashes to under the cost models: the redeemers, the datums and the
 * language view of every language. A body with no script data must declare
 * none. It accepts any Plutus language; a caller that allows only some
 * checks the languages itself. A cost model that is wrong only makes the
 * hash fail to match.
 */
export const checkScriptDataHash = (
  declared: Hash32ByteBase16 | undefined,
  scriptData: ScriptData,
  costModels: Cardano.CostModels,
): ScriptDataHashProblem | undefined => {
  if (!hasScriptData(scriptData)) {
    return declared === undefined
      ? undefined
      : { reason: 'unexpected-script-data-hash', declared };
  }
  if (declared === undefined) return { reason: 'missing-script-data-hash' };
  const views = new Serialization.Costmdls();
  for (const language of new Set(scriptData.languages)) {
    const costs = costModels.get(language);
    if (!costs) return { reason: 'missing-cost-model', language };
    views.insert(new Serialization.CostModel(language, costs));
  }
  const computed = blake2b.hash<Hash32ByteBase16>(
    HexBlob(
      `${scriptData.redeemers ?? EMPTY_REDEEMERS}${
        scriptData.datums ?? ''
      }${views.languageViewsEncoding()}`,
    ),
    32,
  );
  return computed === declared
    ? undefined
    : { reason: 'script-data-hash-mismatch', declared, computed };
};
