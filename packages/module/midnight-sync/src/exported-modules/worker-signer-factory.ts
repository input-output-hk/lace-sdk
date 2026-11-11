import { midnightWalletsForRuntime } from '@lace-contract/midnight-context';

import { MidnightWorkerSignerFactory } from '../signing/midnight-worker-signer-factory';

import type { MidnightSignerFactory } from '@lace-contract/midnight-context';
import type { ModuleInitProps } from '@lace-contract/module';

// Worker mode's signer factory addon: it signs through the engines in the worker and imports none of the engine's
// code, unlike signer-factory.ts, whose in-memory signers do.
const initSignerFactory = ({
  runtime,
}: Pick<ModuleInitProps, 'runtime'>): MidnightSignerFactory =>
  new MidnightWorkerSignerFactory(midnightWalletsForRuntime(runtime));

export default initSignerFactory;
