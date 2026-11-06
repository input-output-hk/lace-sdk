import { ChainIds, NetworkId, NetworkMagics } from '../../src/Cardano';

describe('Cardano.ChainIds', () => {
  it('exposes the Musashi network magic', () => {
    expect(NetworkMagics.Musashi).toBe(164);
  });

  it('identifies Musashi as a testnet with its network magic', () => {
    expect(ChainIds.Musashi).toEqual({
      networkId: NetworkId.Testnet,
      networkMagic: 164,
    });
  });
});
