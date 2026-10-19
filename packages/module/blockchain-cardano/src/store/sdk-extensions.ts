// The side effects the SDK's Cardano module runs for the custody account and
// cNIGHT designation features. The stable SDK build resolves
// sdk-extensions.stable.ts instead, which runs neither.
// Keep the two files' exports in step, apart from the names the variant
// declares on stable-omits lines; the SDK's stable variant parity check
// enforces it.
import { custodyTransactionSideEffects } from './custody/build-side-effect';
import { nightDesignationFlowSideEffects } from './night-designation-flow-side-effects';

export const sdkExtensionSideEffects = [
  ...nightDesignationFlowSideEffects,
  ...custodyTransactionSideEffects,
];
