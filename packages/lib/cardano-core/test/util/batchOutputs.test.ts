import { Serialization, batchLeavingOutputs } from '../../src';

import { createDijkstraBatchFixture } from './dijkstraBatchFixture';

describe('batchLeavingOutputs', () => {
  it('leaves out the output a sibling sub transaction spends and tags each output with its level', () => {
    const { actors, cbor } = createDijkstraBatchFixture();

    const outputs = batchLeavingOutputs(
      Serialization.Transaction.fromCbor(cbor),
    );

    expect(
      outputs.map(({ level, output }) => [
        level,
        output.address,
        output.value.coins,
      ]),
    ).toEqual([
      [0, actors.walletAddress, 5_700_000n],
      [1, actors.walletAddress, 12_000_000n],
      [2, actors.counterparty1Address, 1_000_000n],
    ]);
  });

  it('leaves every output of a transaction without sub transactions at the top level', () => {
    const { tx } = createDijkstraBatchFixture();
    const plain = Serialization.Transaction.fromCore({
      ...tx,
      body: { ...tx.body, subTransactions: undefined },
    });

    expect(
      batchLeavingOutputs(plain).map(({ level, output }) => [
        level,
        output.value.coins,
      ]),
    ).toEqual(tx.body.outputs.map(output => [0, output.value.coins]));
  });
});
