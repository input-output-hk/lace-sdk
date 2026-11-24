/**
 * Hydra Head recognition, a preview feature of the canary Cardano entry
 * (ADR 66): the primitives that recognise Hydra activity on Cardano layer 1,
 * where an account stands in each head at a given instant and what the card
 * of each head says, the status of its deposit activities at a given
 * instant, the transaction that recovers a deposit past its deadline, and
 * the Cardano context data that tracks the funds an account has locked in
 * Hydra heads. The indexed state itself is read through
 * `wallet.stateObservables.hydraHeadsIndex`; `fromHydraHeadsIndexSnapshot`
 * reads an account's snapshot into what the positions and cards take, so a
 * consumer shows Lace's figures from the same implementation as the apps.
 * Every instant these functions take or give is in epoch milliseconds.
 */
export {
  classifyHydraTxByAddresses,
  decodeHydraDepositDatum,
  decodeHydraHeadState,
  findAccountHydraDeposits,
  findAccountHydraHeads,
  findHydraHeadsById,
  findHydraHeadVersion,
  fromCardanoUtxo,
  getHydraDepositStatus,
  getHydraScriptRegistry,
  HYDRA_HEAD_STATE_TOKEN_NAMES,
  HYDRA_METADATA_LABEL,
  isHydraDepositAddress,
  isHydraHeadAddress,
  isHydraHeadMintingScript,
  parseHydraTxTag,
  reconstructHydraHeadFunds,
  toHydraHeadCards,
  toHydraHeadPositions,
} from '@lace-lib/hydra-head';
export type {
  HydraAccountDeposit,
  HydraAccountHead,
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
} from '@lace-lib/hydra-head';
export { buildHydraRecoverTx } from './build-hydra-recover-tx';
export type {
  BuildHydraRecoverTxProps,
  WalletWithHydraRecovery,
} from './build-hydra-recover-tx';
export {
  FEATURE_FLAG_HYDRA_HEADS,
  fromHydraHeadsIndexSnapshot,
  toHydraDepositActivityStates,
} from '@lace-contract/cardano-context';
export type {
  CardanoHydraActivityMetadata,
  CardanoHydraDepositActivityState,
  HydraDepositActivityStates,
  HydraHeadsIndexDeposit,
  HydraHeadsIndexEntry,
  HydraHeadsIndexHead,
  HydraHeadsIndexOutRef,
  HydraHeadsIndexValue,
  HydraHeadsSnapshot,
} from '@lace-contract/cardano-context';
