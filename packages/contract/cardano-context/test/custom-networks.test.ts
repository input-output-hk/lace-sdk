import { Cardano } from '@lace-lib/cardano-core';
import { describe, expect, it } from 'vitest';

import {
  customCardanoChainId,
  customCardanoSlotConfig,
  registerCustomCardanoNetwork,
} from '../src/custom-networks';
import { CardanoNetworkId } from '../src/value-objects';

const slotConfig = { slotLength: 1000, zeroSlot: 0, zeroTime: 1_000_000 };

describe('registerCustomCardanoNetwork', () => {
  it('makes the network a testnet with its slot configuration', () => {
    registerCustomCardanoNetwork({ networkMagic: 42, slotConfig });

    expect(customCardanoChainId(42)).toEqual({
      networkId: Cardano.NetworkId.Testnet,
      networkMagic: 42,
    });
    expect(customCardanoSlotConfig(42)).toEqual(slotConfig);
  });

  it('replaces the slot configuration when registered again', () => {
    const afterReset = { ...slotConfig, zeroTime: 2_000_000 };
    registerCustomCardanoNetwork({ networkMagic: 43, slotConfig });
    registerCustomCardanoNetwork({ networkMagic: 43, slotConfig: afterReset });

    expect(customCardanoSlotConfig(43)).toEqual(afterReset);
  });

  it('knows nothing of a network it was not given', () => {
    expect(customCardanoChainId(44)).toBeUndefined();
    expect(customCardanoSlotConfig(44)).toBeUndefined();
  });

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['fractional', 1.5],
    ['not a number', Number.NaN],
    ['above 32 bits', 0x1_00_00_00_00],
    ['mainnet', Cardano.NetworkMagics.Mainnet],
    ['preprod', Cardano.NetworkMagics.Preprod],
    ['preview', Cardano.NetworkMagics.Preview],
    ['sanchonet', Cardano.NetworkMagics.Sanchonet],
  ])('refuses a magic that is %s', (_, networkMagic) => {
    expect(() => {
      registerCustomCardanoNetwork({ networkMagic, slotConfig });
    }).toThrow('cannot be a custom Cardano network magic');
  });

  it.each([
    ['a zero slot length', { ...slotConfig, slotLength: 0 }],
    ['a fractional slot length', { ...slotConfig, slotLength: 0.5 }],
    ['a negative zero slot', { ...slotConfig, zeroSlot: -1 }],
    ['a negative zero time', { ...slotConfig, zeroTime: -1 }],
    [
      'a zero time that is not a number',
      { ...slotConfig, zeroTime: Number.NaN },
    ],
  ])('refuses %s', (_, invalid) => {
    expect(() => {
      registerCustomCardanoNetwork({ networkMagic: 45, slotConfig: invalid });
    }).toThrow('Invalid slot configuration');
    expect(customCardanoChainId(45)).toBeUndefined();
  });

  it('leaves the public networks to their own chain ids', () => {
    expect(
      CardanoNetworkId.getChainId(
        CardanoNetworkId(Cardano.NetworkMagics.Mainnet),
      ),
    ).toBe(Cardano.ChainIds.Mainnet);
  });
});
