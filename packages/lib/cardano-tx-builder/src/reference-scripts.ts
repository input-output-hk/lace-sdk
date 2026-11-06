import { Cardano, Serialization } from '@lace-lib/cardano-core';

import { toRational } from './exact-fees';

/** The protocol parameters {@link referenceScriptFee} prices reference scripts with. */
export type ReferenceScriptFeeProtocolParameters = Pick<
  Cardano.ProtocolParameters,
  | 'minFeeRefScriptCostPerByte'
  | 'refScriptCostMultiplier'
  | 'refScriptCostStride'
>;

/** Bytes per tier of the reference-script fee before Dijkstra makes it a protocol parameter. */
const CONWAY_REFERENCE_SCRIPT_COST_STRIDE = 25_600;

/** Growth of the per-byte price from one tier to the next before Dijkstra makes it a protocol parameter. */
const CONWAY_REFERENCE_SCRIPT_COST_MULTIPLIER = '1.2';

/** The protocol major version of Dijkstra, whose parameters set the reference-script fee tiers. */
const DIJKSTRA_PROTOCOL_VERSION = 12;

/** A reference-script fee tier parameter and the value priced in its place when it is missing. */
export interface ReferenceScriptTierFallback {
  name: 'refScriptCostMultiplier' | 'refScriptCostStride';
  fallback: string;
}

/**
 * The reference-script fee tier parameters `protocolParameters` lack while
 * their protocol version sets them, from Dijkstra on, each with the Conway
 * value {@link referenceScriptFee} prices with in its place. Before
 * Dijkstra the tiers are Conway's, so nothing is missing.
 *
 * @param protocolParameters - The protocol parameters, with their protocol version.
 * @returns The missing parameters, empty when none is.
 */
export const missingReferenceScriptTiers = ({
  protocolVersion,
  refScriptCostMultiplier,
  refScriptCostStride,
}: Partial<
  Pick<
    Cardano.ProtocolParameters,
    'protocolVersion' | 'refScriptCostMultiplier' | 'refScriptCostStride'
  >
>): ReferenceScriptTierFallback[] => {
  if ((protocolVersion?.major ?? 0) < DIJKSTRA_PROTOCOL_VERSION) return [];
  const missing: ReferenceScriptTierFallback[] = [];
  if (!refScriptCostStride) {
    missing.push({
      name: 'refScriptCostStride',
      fallback: String(CONWAY_REFERENCE_SCRIPT_COST_STRIDE),
    });
  }
  if (refScriptCostMultiplier === undefined) {
    missing.push({
      name: 'refScriptCostMultiplier',
      fallback: CONWAY_REFERENCE_SCRIPT_COST_MULTIPLIER,
    });
  }
  return missing;
};

/**
 * The size the ledger counts for a reference script: the raw bytes of a
 * Plutus script, without the CBOR that wraps them in an output, and the CBOR
 * of a native script.
 *
 * @param script - The script an output carries.
 */
const scriptSize = (script: Cardano.Script) =>
  Cardano.isPlutusScript(script)
    ? script.bytes.length / 2
    : Serialization.NativeScript.fromCore(script).toCbor().length / 2;

/**
 * Bytes of reference script the ledger reads for `inputs`: the scripts carried
 * by the outputs they resolve to in `resolvedInputs`, each measured as the
 * ledger measures it. An input missing from `resolvedInputs` adds nothing.
 *
 * Pass the spent inputs and the reference inputs together. As in the ledger,
 * an input listed more than once is read once, while the same script carried
 * by two different outputs counts twice.
 */
export const referenceScriptSize = (
  inputs: readonly Cardano.TxIn[],
  resolvedInputs: readonly Cardano.Utxo[],
): number => {
  const read = new Set<string>();
  let size = 0;
  for (const input of inputs) {
    const key = `${input.txId}#${input.index}`;
    if (read.has(key)) continue;
    read.add(key);
    const script = resolvedInputs.find(
      ([txIn]) => txIn.txId === input.txId && txIn.index === input.index,
    )?.[1].scriptReference;
    if (script) size += scriptSize(script);
  }
  return size;
};

/**
 * The reference-script fee for `size` bytes, priced in tiers as the ledger
 * prices it: each `refScriptCostStride` bytes cost `minFeeRefScriptCostPerByte`
 * per byte, raised by `refScriptCostMultiplier` from one tier to the next,
 * summed exactly and rounded down once. Parameters the protocol does not set
 * yet take Conway's values, 25600 bytes and 1.2.
 */
export const referenceScriptFee = (
  size: number,
  {
    minFeeRefScriptCostPerByte,
    refScriptCostMultiplier = CONWAY_REFERENCE_SCRIPT_COST_MULTIPLIER,
    refScriptCostStride,
  }: ReferenceScriptFeeProtocolParameters,
): bigint => {
  if (!minFeeRefScriptCostPerByte || size <= 0) return 0n;
  const multiplier = toRational(refScriptCostMultiplier);
  const stride = BigInt(
    refScriptCostStride || CONWAY_REFERENCE_SCRIPT_COST_STRIDE,
  );
  let { numerator: tierPrice, denominator } = toRational(
    minFeeRefScriptCostPerByte,
  );
  let remaining = BigInt(size);
  let fee = 0n;
  for (;;) {
    const tierBytes = remaining < stride ? remaining : stride;
    fee += tierBytes * tierPrice;
    remaining -= tierBytes;
    if (remaining === 0n) return fee / denominator;
    fee *= multiplier.denominator;
    denominator *= multiplier.denominator;
    tierPrice *= multiplier.numerator;
  }
};
