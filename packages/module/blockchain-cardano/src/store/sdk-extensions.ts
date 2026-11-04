// The side effects the SDK's Cardano module runs for the cNIGHT designation
// and Hydra Head features. The stable SDK build resolves
// sdk-extensions.stable.ts instead, which runs none of them. Custody accounts
// have a module of their own (custody-sdk.ts).
// Keep the two files' exports in step, apart from the names the variant
// declares on stable-omits lines; the SDK's stable variant parity check
// enforces it.
import { makeHydraHeadsIndexSweep } from './hydra-heads/index-side-effect';
import { makeHydraActivitiesRetagging } from './hydra-heads/retag-activities-side-effect';
import { nightDesignationFlowSideEffects } from './night-designation-flow-side-effects';

export const sdkExtensionSideEffects = [
  ...nightDesignationFlowSideEffects,
  makeHydraHeadsIndexSweep(),
  makeHydraActivitiesRetagging(),
];
