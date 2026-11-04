import { Cardano } from '@cardano-sdk/core';

import { HYDRA_HEAD_STATE_TOKEN_NAMES } from './constants';
import {
  MAINNET_HYDRA_SCRIPT_REGISTRY,
  TESTNET_HYDRA_SCRIPT_REGISTRY,
} from './registry-data';

import type {
  HydraHeadGeneration,
  HydraHeadMintingScriptTemplate,
  HydraProtocolVersion,
  HydraScriptRegistryEntry,
} from './types';

/** Every registry entry of every network, used to derive the lookup structures. */
const allEntries: readonly HydraScriptRegistryEntry[] = [
  ...TESTNET_HYDRA_SCRIPT_REGISTRY,
  ...MAINNET_HYDRA_SCRIPT_REGISTRY,
];

/** Head validator addresses mapped to the Hydra version they belong to. */
const headAddresses = new Map<string, HydraProtocolVersion>(
  allEntries.map(entry => [entry.headAddress, entry.version]),
);

/** Head validator addresses mapped to the head minting script of their release. */
const headMintingScripts = new Map<string, HydraHeadMintingScriptTemplate>(
  allEntries.map(entry => [entry.headAddress, entry.headMintingScript]),
);

/** Deposit validator addresses of every version that has one. */
const depositAddresses = new Set<string>(
  allEntries.flatMap(({ depositAddress }) =>
    depositAddress === undefined ? [] : [depositAddress],
  ),
);

/**
 * Returns the Hydra script addresses for a network. Preprod and Preview share
 * one registry, Mainnet has its own.
 */
export const getHydraScriptRegistry = (
  networkId: Cardano.NetworkId,
): readonly HydraScriptRegistryEntry[] =>
  networkId === Cardano.NetworkId.Mainnet
    ? MAINNET_HYDRA_SCRIPT_REGISTRY
    : TESTNET_HYDRA_SCRIPT_REGISTRY;

/** True when the address is the head validator of any known Hydra version. */
export const isHydraHeadAddress = (address: string): boolean =>
  headAddresses.has(address);

/** True when the address is the deposit validator of any known Hydra version. */
export const isHydraDepositAddress = (address: string): boolean =>
  depositAddresses.has(address);

/**
 * Returns the Hydra version whose head validator lives at the address, or
 * undefined when it is not a head address. Deposit validators are shared by
 * several versions, so they identify no single version.
 */
export const findHydraHeadVersion = (
  address: string,
): HydraProtocolVersion | undefined => headAddresses.get(address);

/**
 * Returns the head minting script template of the release whose head
 * validator lives at the address, or undefined when it is not a head address.
 */
export const findHydraHeadMintingScriptTemplate = (
  address: string,
): HydraHeadMintingScriptTemplate | undefined =>
  headMintingScripts.get(address);

/**
 * Returns the head generation of a Hydra release. Releases from 2.0.0 use the
 * `HydraHeadV2` state token, older ones `HydraHeadV1`.
 */
export const getHydraHeadGeneration = (
  version: HydraProtocolVersion,
): HydraHeadGeneration => (Number.parseInt(version, 10) >= 2 ? 'v2' : 'v1');

/**
 * Returns the hex name of the state token a head UTxO of the release holds,
 * the one of the release's generation.
 */
export const getHydraHeadStateTokenName = (
  version: HydraProtocolVersion,
): string => HYDRA_HEAD_STATE_TOKEN_NAMES[getHydraHeadGeneration(version)];

/**
 * Returns the hex name of the state token a head UTxO at the address holds,
 * the one of its release's generation, or undefined when it is not a head
 * address.
 */
export const findHydraHeadStateTokenName = (
  address: string,
): string | undefined => {
  const version = findHydraHeadVersion(address);
  return version === undefined
    ? undefined
    : getHydraHeadStateTokenName(version);
};
