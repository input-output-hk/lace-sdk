/**
 * Framework-less primitives for recognising Hydra Head activity on Cardano
 * layer 1: the per-version validator address registry, the head state token
 * names, the transaction metadata marker, deposit and head datum decoding,
 * the matchers that find an account's deposits and heads, the check that
 * proves a head genuine by its minting script, the reconstruction of what a
 * head absorbed for an account's keys and paid back to them, where the
 * account stands in each head at a given instant, and what the card of each
 * head says, and the policy every wallet stack sweeps the validators with:
 * how they are read, which heads are checked and read, and which are
 * listed. Pure functions with no IO, so any consumer can use them on a hot
 * path.
 */

export { toHydraHeadCards } from './cards';

export { classifyHydraTxByAddresses } from './classify';

export {
  HYDRA_HEAD_HISTORY_LIMITS,
  HYDRA_HEAD_STATE_TOKEN_NAMES,
  HYDRA_METADATA_LABEL,
} from './constants';

export type { HydraHeadHistoryLimits } from './constants';

export { decodeHydraDepositDatum } from './deposit-datum';

export { findAccountHydraDeposits, getHydraDepositStatus } from './deposits';

export { decodeHydraHeadState } from './head-datum';

export { reconstructHydraHeadFunds } from './funds';

export { findAccountHydraHeads, findHydraHeadsById } from './heads';

export {
  continuesHydraHeadHistory,
  countHydraHeadHistoryOutsideInputs,
  getHydraHeadAccountFunds,
  getHydraHeadHistoryWindow,
  getHydraHeadStateTokenUnit,
} from './history';

export { isHydraHeadMintingScript } from './minting-script';

export { toHydraHeadPositions } from './positions';

export {
  findHydraHeadVersion,
  getHydraScriptRegistry,
  isHydraDepositAddress,
  isHydraHeadAddress,
} from './registry';

export {
  HYDRA_VALIDATOR_READ_LIMITS,
  findHydraDepositedHeadIds,
  getHydraValidatorAddresses,
  matchAccountHydra,
  selectHydraHeadsToCheck,
  selectHydraHeadsToRead,
  settleHydraAccountHeads,
  settleHydraValidatorReads,
} from './sweep';

export type {
  HydraAccountMatch,
  HydraDepositHint,
  HydraHeadPick,
  HydraValidatorRead,
  HydraValidatorReads,
} from './sweep';

export { parseHydraTxTag } from './tx-tag';

export { fromBlockfrostUtxo, fromCardanoUtxo } from './utxo';

export type {
  HydraAccountDeposit,
  HydraAccountHead,
  HydraBlockfrostUtxo,
  HydraCommittedOutput,
  HydraDepositDatum,
  HydraDepositStatus,
  HydraHeadCard,
  HydraHeadCards,
  HydraHeadCardState,
  HydraHeadFunds,
  HydraHeadHistoryTx,
  HydraHeadMintingScriptTemplate,
  HydraHeadPosition,
  HydraHeadPositions,
  HydraHeadState,
  HydraHeadStateName,
  HydraLiveHeadStateName,
  HydraOutRef,
  HydraPositionDeposit,
  HydraPositionHead,
  HydraProtocolVersion,
  HydraRemainingTime,
  HydraScriptRegistryEntry,
  HydraSeedEncoding,
  HydraTxClassification,
  HydraTxEndpoint,
  HydraTxName,
  HydraTxProtocol,
  HydraTxTag,
  HydraUtxo,
  HydraValue,
  HydraWaitingDeposits,
} from './types';
