import { composerFlowSideEffects } from './composer-flow-side-effects';
import { composerFlowTxSideEffects } from './composer-flow-tx-side-effects';
import { initializeDependencies } from './dependencies';
import { makeHydraHeadsIndexSweep } from './hydra-heads/index-side-effect';
import { makeHydraActivitiesRetagging } from './hydra-heads/retag-activities-side-effect';
import { nightDesignationFlowSideEffects } from './night-designation-flow-side-effects';
import { nightDesignationFlowTxSideEffects } from './night-designation-flow-tx-side-effects';
import { recordSubmittedTransactions } from './record-submitted-transactions-side-effect';
import { createCardanoSideEffects } from './side-effects';

import type { LaceInit, LaceModuleStoreInit } from '@lace-contract/module';

// Full store init for the extension/mobile apps. Identical to the
// SDK-safe `./init` PLUS the cNIGHT confirm/submit side-effects, which
// pull in `@lace-contract/tx-executor` (→ authentication-prompt →
// react-i18next) and must stay out of the headless SDK bundle (ADR 30).
// The in-flight recorder of the tx-executor's Cardano submissions is here
// too: it reads the tx-executor's actions, which only the apps' store has.
// The SDK submits through `cardanoContext.submitTx`, which cardano-sync's
// `submitTxSideEffect` records.
// The headless SDK entry (`sdk.ts`) uses `./init` via `./store`; the full
// module entry (`index.ts`) uses this via `./store/full`.
const redux: LaceInit<LaceModuleStoreInit> = async (props, dependencies) => ({
  sideEffects: [
    ...createCardanoSideEffects(props.runtime.config),
    ...composerFlowSideEffects,
    ...composerFlowTxSideEffects,
    ...nightDesignationFlowSideEffects,
    ...nightDesignationFlowTxSideEffects,
    recordSubmittedTransactions,
    makeHydraHeadsIndexSweep(),
    makeHydraActivitiesRetagging(),
  ],
  sideEffectDependencies: await initializeDependencies(props, dependencies),
});

export default redux;
