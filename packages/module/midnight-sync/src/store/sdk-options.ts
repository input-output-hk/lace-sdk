import { MidnightSDKTestNetworkId } from '@lace-contract/midnight-context';

import { createApplyNetworkDefaultsMiddleware } from './side-effects/network-config';

import type { MidnightEngineOptions } from './dependencies';
import type { MidnightNetworkStartupConfig } from './side-effects/network-config';
import type { ConnectMidnightEngine } from '../worker/engine-client';
import type { MidnightWorkerStorageKind } from '../worker/protocol';
import type {
  AccessAuthSecret,
  Authenticate,
} from '@lace-contract/authentication-prompt';
import type { AppConfig } from '@lace-contract/module';

// What both store inits of the headless module share; neither init imports the other.

/**
 * What the engine needs to decrypt account keys. The app shell serves these
 * from the authentication prompt; a headless loadout serves them itself.
 */
export type MidnightSyncAuth = {
  accessAuthSecret: AccessAuthSecret;
  authenticate: Authenticate;
};

/** Runs every account's engine in a worker shared by the app's pages instead of on this page. */
export type MidnightSyncWorkerOptions = {
  /** Opens a connection to the worker's engine host. */
  connect: ConnectMidnightEngine;
  /** Where the worker keeps the engines' checkpoints. */
  storage: MidnightWorkerStorageKind;
  /** Attach to an engine already running with other settings, adopting them, instead of failing. */
  adopt?: boolean;
};

export type MidnightSyncSdkOptions = MidnightNetworkStartupConfig &
  Pick<MidnightEngineOptions, 'batchUpdates' | 'createAttestedProver'> & {
    auth: MidnightSyncAuth;
    /** Absent: the engine runs on this page. */
    worker?: MidnightSyncWorkerOptions;
  };

/**
 * The contract starts the wallet on this testnet and reads it without a
 * fallback, so a headless loadout without it would sync a network named
 * "undefined". The application shells always set it.
 */
export const assertDefaultTestnetConfigured = (
  config: Partial<AppConfig> | undefined,
): void => {
  const networkId = config?.defaultMidnightTestnetNetworkId;
  if (!networkId || !MidnightSDKTestNetworkId.includes(networkId))
    throw new Error(
      `createLaceWallet needs config.defaultMidnightTestnetNetworkId, the Midnight testnet a wallet starts on: one of ${MidnightSDKTestNetworkId.join(
        ', ',
      )}; got ${String(networkId)}`,
    );
};

/** The store middleware of a headless loadout: the networks it serves and their default proof servers. */
export const createSdkMiddleware = ({
  supportedNetworkIds,
  defaultProofServers,
}: Pick<
  MidnightSyncSdkOptions,
  'defaultProofServers' | 'supportedNetworkIds'
>) => [
  createApplyNetworkDefaultsMiddleware({
    supportedNetworkIds,
    defaultProofServers,
  }),
];
