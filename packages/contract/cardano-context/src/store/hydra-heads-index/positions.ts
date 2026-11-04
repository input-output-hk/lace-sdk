import { fromHydraHeadsIndexValue } from './slice';

import type { HydraHeadsIndexDeposit, HydraHeadsIndexHead } from './types';
import type {
  HydraPositionDeposit,
  HydraPositionHead,
} from '@lace-lib/hydra-head';

/** Reads a head kept in the Hydra heads index into the shape positions read. */
const toPositionHead = ({
  contestationDeadline,
  depositedValue,
  withdrawnValue,
  headValue,
  ...head
}: HydraHeadsIndexHead): HydraPositionHead => ({
  ...head,
  headValue: fromHydraHeadsIndexValue(headValue),
  ...(contestationDeadline === undefined
    ? {}
    : { contestationDeadline: Date.parse(contestationDeadline) }),
  ...(depositedValue && withdrawnValue
    ? {
        funds: {
          deposited: fromHydraHeadsIndexValue(depositedValue),
          withdrawn: fromHydraHeadsIndexValue(withdrawnValue),
        },
      }
    : {}),
});

/** Reads a deposit kept in the Hydra heads index into the shape positions read. */
const toPositionDeposit = ({
  headId,
  deadline,
  value,
}: HydraHeadsIndexDeposit): HydraPositionDeposit => ({
  headId,
  deadline: Date.parse(deadline),
  value: fromHydraHeadsIndexValue(value),
});

/**
 * Reads the heads and deposits of an account's Hydra heads index snapshot,
 * as `hydraHeadsIndex` state holds them, into the heads and deposits
 * `toHydraHeadPositions` and `toHydraHeadCards` read, so a consumer of the
 * index gets Lace's figures from the same implementation as the apps.
 *
 * @remarks The snapshot lists only heads proven genuine by their minting
 * script, so every head it holds may be passed on. Its figures are what was
 * committed to the account's keys and paid back to them, never a balance.
 */
export const fromHydraHeadsIndexSnapshot = ({
  heads,
  deposits,
}: {
  heads: readonly HydraHeadsIndexHead[];
  deposits: readonly HydraHeadsIndexDeposit[];
}): {
  heads: HydraPositionHead[];
  deposits: HydraPositionDeposit[];
} => ({
  heads: heads.map(toPositionHead),
  deposits: deposits.map(toPositionDeposit),
});
