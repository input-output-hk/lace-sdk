vi.mock(
  '@ledgerhq/hw-transport-node-hid-noevents/lib/TransportNodeHid',
  () => ({ default: null }),
);
vi.mock('node-hid', () => ({ default: null }));

describe('LedgerKeyAgent with the Node transport emptied', () => {
  it('loads when a browser bundle replaces the Node-only modules with an empty module', async () => {
    const { LedgerKeyAgent } = await import('../src');

    expect(LedgerKeyAgent).toBeTypeOf('function');
  });
});
