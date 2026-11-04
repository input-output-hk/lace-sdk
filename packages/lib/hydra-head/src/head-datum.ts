import {
  parsePlutusData,
  readAnyConstr,
  readConstr,
  readPosixTime,
} from './plutus-data';

import type {
  HydraHeadState,
  HydraHeadStateName,
  HydraProtocolVersion,
} from './types';
import type { Serialization } from '@cardano-sdk/core';

/**
 * Layout of one head state constructor. A state either carries its fields
 * directly on the constructor or wraps them in a record that is the
 * constructor's single field.
 */
interface StateLayout {
  readonly state: HydraHeadStateName;
  /** True when the fields sit in a record wrapped by the constructor. */
  readonly isRecord: boolean;
  readonly fieldCount: number;
  /** Position of the contestation deadline among the fields. */
  readonly deadlineField?: number;
}

/** Describes a state whose fields sit directly on the constructor. */
const inline = (
  state: HydraHeadStateName,
  fieldCount: number,
  deadlineField?: number,
): StateLayout => ({ state, isRecord: false, fieldCount, deadlineField });

/** Describes a state whose fields sit in a wrapped record. */
const record = (
  state: HydraHeadStateName,
  fieldCount: number,
  deadlineField?: number,
): StateLayout => ({ state, isRecord: true, fieldCount, deadlineField });

/** `Initial` with contestation period, parties, head id and seed. */
const INITIAL = inline('initial', 4);

/** `Final`, which carries no fields in any release. */
const FINAL = inline('final', 0);

/**
 * Releases 0.13.0 to 0.16.0: `Initial`, `Open` and `Closed` carry their
 * fields inline, and `Closed` holds the deadline after parties, snapshot
 * number and UTxO hash.
 */
const INLINE_LAYOUT = [
  INITIAL,
  inline('open', 4),
  inline('closed', 7, 3),
  FINAL,
];

/**
 * Releases 0.18.0 and 0.19.0: `Open` and `Closed` wrap records, and the
 * closed record ends with a single delta UTxO hash, the contesters and the
 * deadline.
 */
const DELTA_LAYOUT = [
  INITIAL,
  record('open', 5),
  record('closed', 9, 8),
  FINAL,
];

/**
 * Releases 0.20.0 to 1.3.0: as before, with separate commit and decommit
 * hashes in the closed record.
 */
const INCREMENT_LAYOUT = [
  INITIAL,
  record('open', 5),
  record('closed', 10, 9),
  FINAL,
];

/**
 * Releases 2.0.0 and 2.1.0: no `Initial` state, and the open record starts
 * with the head seed.
 */
const SEEDED_LAYOUT = [record('open', 6), record('closed', 10, 9), FINAL];

/**
 * Releases from 2.2.0: open and closed records track a UTxO accumulator, and
 * `FanoutProgress` marks a head distributed over several transactions.
 */
const ACCUMULATOR_LAYOUT = [
  record('open', 7),
  record('closed', 9, 6),
  FINAL,
  record('fanningOut', 5, 2),
];

/**
 * Head state constructors of every registered release, indexed by
 * constructor alternative, as declared in `Hydra.Contract.HeadState` of each
 * release.
 */
const LAYOUTS = new Map<HydraProtocolVersion, readonly StateLayout[]>([
  ['0.13.0', INLINE_LAYOUT],
  ['0.14.0', INLINE_LAYOUT],
  ['0.15.0', INLINE_LAYOUT],
  ['0.16.0', INLINE_LAYOUT],
  ['0.18.0', DELTA_LAYOUT],
  ['0.19.0', DELTA_LAYOUT],
  ['0.20.0', INCREMENT_LAYOUT],
  ['0.22.0', INCREMENT_LAYOUT],
  ['1.0.0', INCREMENT_LAYOUT],
  ['1.3.0', INCREMENT_LAYOUT],
  ['2.0.0', SEEDED_LAYOUT],
  ['2.1.0', SEEDED_LAYOUT],
  ['2.2.0', ACCUMULATOR_LAYOUT],
  ['2.3.0', ACCUMULATOR_LAYOUT],
]);

/** Returns the fields of a state as its layout places them. */
const readStateFields = (
  fields: readonly Serialization.PlutusData[],
  layout: StateLayout,
): readonly Serialization.PlutusData[] | undefined => {
  if (!layout.isRecord) {
    return fields.length === layout.fieldCount ? fields : undefined;
  }
  return fields.length === 1
    ? readConstr(fields[0], 0n, layout.fieldCount)
    : undefined;
};

/** Reads the state described by a layout, or undefined when it does not fit. */
const readState = (
  fields: readonly Serialization.PlutusData[],
  layout: StateLayout,
): HydraHeadState | undefined => {
  const stateFields = readStateFields(fields, layout);
  if (!stateFields) return undefined;
  if (layout.deadlineField === undefined) return { state: layout.state };
  const contestationDeadline = readPosixTime(stateFields[layout.deadlineField]);
  return contestationDeadline === undefined
    ? undefined
    : { state: layout.state, contestationDeadline };
};

/**
 * Decodes the inline datum of a head UTxO. The layout depends on the Hydra
 * release whose head validator holds the UTxO, which the head address
 * reveals. Constructors and field counts are checked strictly, so a datum of
 * another release is rejected rather than misread.
 *
 * @param datum - CBOR hex of the inline datum.
 * @param version - Hydra release of the head validator holding the UTxO.
 * @returns the state and, once closed, the contestation deadline, or
 * undefined when the datum does not fit the release or the release is
 * unknown. Never throws.
 */
export const decodeHydraHeadState = (
  datum: string,
  version: HydraProtocolVersion,
): HydraHeadState | undefined => {
  const layouts = LAYOUTS.get(version);
  if (!layouts) return undefined;
  try {
    const constr = readAnyConstr(parsePlutusData(datum));
    if (!constr) return undefined;
    const layout = layouts[Number(constr.alternative)];
    return layout && readState(constr.fields, layout);
  } catch {
    return undefined;
  }
};
