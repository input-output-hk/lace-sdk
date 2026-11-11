// The engine-side code the headless SDK runs where an engine runs; kept apart from `./sdk`, whose static closure
// the SDK's Midnight entry carries.
export { createMidnightEngineHost } from './worker/engine-host';
export {
  buildConnectorTransaction,
  buildTransaction,
  discardRecipe,
  estimateFee,
  preparePendingActivity,
  proveRecipe,
  signRecipe,
  submitTransaction,
} from './worker/engine-operations';
export {
  checkCircuitThroughPort,
  proveCircuitThroughPort,
} from './worker/prover-port';
