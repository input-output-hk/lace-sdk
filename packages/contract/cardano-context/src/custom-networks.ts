import { Cardano } from '@lace-lib/cardano-core';

import type { SlotConfig } from '@lace-lib/cardano-tx-builder';

/** A local Cardano test network, as its genesis describes it. */
export type CustomCardanoNetwork = {
  /** The network's magic: an unsigned 32-bit integer no public network uses. */
  networkMagic: number;
  /**
   * When the network's slots start and how long they last, in milliseconds:
   * `zeroTime` is the POSIX time of `zeroSlot`. A devnet takes these from its
   * genesis, and a reset that changes the genesis needs them registered again.
   */
  slotConfig: Pick<SlotConfig, 'slotLength' | 'zeroSlot' | 'zeroTime'>;
};

type RegisteredNetwork = Pick<CustomCardanoNetwork, 'slotConfig'> & {
  chainId: Cardano.ChainId;
};

const MAX_NETWORK_MAGIC = 0xff_ff_ff_ff;

const registeredNetworks = new Map<number, RegisteredNetwork>();

const isCustomNetworkMagic = (networkMagic: number): boolean =>
  Number.isInteger(networkMagic) &&
  networkMagic > 0 &&
  networkMagic <= MAX_NETWORK_MAGIC &&
  Cardano.NetworkMagics[networkMagic] === undefined;

const isSlotConfig = ({
  slotLength,
  zeroSlot,
  zeroTime,
}: CustomCardanoNetwork['slotConfig']): boolean =>
  Number.isSafeInteger(slotLength) &&
  slotLength > 0 &&
  Number.isSafeInteger(zeroSlot) &&
  zeroSlot >= 0 &&
  Number.isSafeInteger(zeroTime) &&
  zeroTime >= 0;

/**
 * Makes a local test network, such as a devnet, known to this process, so
 * Cardano custody accounts can run on it. Call it before creating the wallet,
 * and set the network's Blockfrost configuration and `defaultTestnetChainId`.
 * The network is always a testnet. Registering a magic again replaces its slot
 * configuration.
 *
 * @throws When the magic is not an unsigned 32-bit integer above zero, belongs
 *   to a public network, or the slot configuration is not made of whole
 *   non-negative numbers with a positive slot length.
 */
export const registerCustomCardanoNetwork = ({
  networkMagic,
  slotConfig,
}: CustomCardanoNetwork): void => {
  if (!isCustomNetworkMagic(networkMagic)) {
    throw new Error(`${networkMagic} cannot be a custom Cardano network magic`);
  }
  if (!isSlotConfig(slotConfig)) {
    throw new Error(`Invalid slot configuration for network ${networkMagic}`);
  }
  registeredNetworks.set(networkMagic, {
    chainId: { networkId: Cardano.NetworkId.Testnet, networkMagic },
    slotConfig,
  });
};

/** The chain id of a registered custom network, or undefined for any other. */
export const customCardanoChainId = (
  networkMagic: number,
): Cardano.ChainId | undefined => registeredNetworks.get(networkMagic)?.chainId;

/** The slot configuration of a registered custom network, or undefined for any other. */
export const customCardanoSlotConfig = (
  networkMagic: number,
): CustomCardanoNetwork['slotConfig'] | undefined =>
  registeredNetworks.get(networkMagic)?.slotConfig;
