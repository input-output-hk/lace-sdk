import { Cardano } from '@lace-lib/cardano-core';
import { describe, expect, it } from 'vitest';

import {
  HYDRA_HEAD_HISTORY_LIMITS,
  HYDRA_VALIDATOR_READ_LIMITS,
  findHydraDepositedHeadIds,
  getHydraScriptRegistry,
  getHydraValidatorAddresses,
  selectHydraHeadsToCheck,
  selectHydraHeadsToRead,
  settleHydraAccountHeads,
  settleHydraValidatorReads,
} from '../src';

import type {
  HydraAccountHead,
  HydraAccountMatch,
  HydraHeadFunds,
} from '../src';

const headOf = (headId: string): HydraAccountHead =>
  ({ headId } as HydraAccountHead);

const idsOf = (heads: readonly Pick<HydraAccountHead, 'headId'>[]) =>
  heads.map(({ headId }) => headId);

const matchOf = (
  heads: readonly string[],
  candidateHeads: readonly string[] = [],
): HydraAccountMatch => ({
  deposits: [],
  heads: heads.map(headOf),
  candidateHeads: candidateHeads.map(headOf),
});

const ada = (coins: bigint) => ({ coins, assets: new Map<string, bigint>() });

const fundsOf = (deposited: bigint): HydraHeadFunds => ({
  deposited: ada(deposited),
  withdrawn: ada(0n),
});

describe('getHydraValidatorAddresses', () => {
  it('lists the 17 distinct validators of each network, sharing the deposit validators between releases', () => {
    for (const networkId of [
      Cardano.NetworkId.Testnet,
      Cardano.NetworkId.Mainnet,
    ]) {
      expect(getHydraValidatorAddresses(networkId)).toHaveLength(17);
    }
  });

  it('lists each head and deposit validator of the network once', () => {
    const addresses = getHydraValidatorAddresses(Cardano.NetworkId.Testnet);
    const registry = getHydraScriptRegistry(Cardano.NetworkId.Testnet);

    expect(new Set(addresses).size).toBe(addresses.length);
    expect(addresses).toEqual(
      expect.arrayContaining(
        registry.flatMap(({ headAddress, depositAddress }) =>
          depositAddress ? [headAddress, depositAddress] : [headAddress],
        ),
      ),
    );
  });
});

describe('settleHydraValidatorReads', () => {
  const full = Array.from(
    {
      length:
        HYDRA_VALIDATOR_READ_LIMITS.pageSize *
        HYDRA_VALIDATOR_READ_LIMITS.maxPages,
    },
    (_, index) => index,
  );

  it('serves every address read now', () => {
    const settled = settleHydraValidatorReads(
      [
        { address: 'a', utxos: [1] },
        { address: 'b', utxos: [] },
      ],
      () => undefined,
    );

    expect(settled?.unreadAddresses).toEqual([]);
    expect([...(settled?.utxosByAddress ?? [])]).toEqual([
      ['a', [1]],
      ['b', []],
    ]);
  });

  it('stands in with the kept read of an address that failed or filled its last page', () => {
    const kept = new Map([
      ['b', [2]],
      ['c', [3]],
    ]);

    const settled = settleHydraValidatorReads(
      [
        { address: 'a', utxos: [1] },
        { address: 'b' },
        { address: 'c', utxos: full },
      ],
      address => kept.get(address),
    );

    expect(settled?.unreadAddresses).toEqual([]);
    expect(settled?.utxosByAddress.get('b')).toEqual([2]);
    expect(settled?.utxosByAddress.get('c')).toEqual([3]);
  });

  it('serves the other addresses and names the unread one when a failed address has nothing kept', () => {
    const settled = settleHydraValidatorReads(
      [
        { address: 'a', utxos: [1] },
        { address: 'b' },
        { address: 'c', utxos: full },
      ],
      () => undefined,
    );

    expect(settled?.unreadAddresses).toEqual(['b', 'c']);
    expect([...(settled?.utxosByAddress ?? [])]).toEqual([['a', [1]]]);
  });

  it('settles nothing when every address failed, whatever is kept', () => {
    expect(
      settleHydraValidatorReads(
        [{ address: 'a' }, { address: 'b', utxos: full }],
        () => [0],
      ),
    ).toBeUndefined();
  });
});

describe('findHydraDepositedHeadIds', () => {
  it('names the heads of the deposits the account sent, once each', () => {
    expect(
      findHydraDepositedHeadIds([
        { isSent: true, txName: 'DepositTx', headId: 'h1' },
        { isSent: true, txName: 'DepositTx', headId: 'h1' },
        { isSent: false, txName: 'DepositTx', headId: 'h2' },
        { isSent: true, txName: 'IncrementTx', headId: 'h3' },
        { isSent: true, txName: 'DepositTx' },
      ]),
    ).toEqual(['h1']);
  });
});

describe('selectHydraHeadsToCheck', () => {
  it('checks the heads of the account deposits first, then the others, each in head id order', () => {
    const match = matchOf(['d', 'b'], ['c', 'a']);

    expect(
      idsOf(
        selectHydraHeadsToCheck(match, {
          depositedHeadIds: new Set(['c', 'd']),
          genuineByHeadId: new Map(),
        }),
      ),
    ).toEqual(['c', 'd', 'a', 'b']);
  });

  it('checks no head with a verdict and stops at the check limit', () => {
    const match = matchOf(['a', 'b', 'c', 'd']);
    const limits = { ...HYDRA_HEAD_HISTORY_LIMITS, maxHeadChecksPerAccount: 2 };

    expect(
      idsOf(
        selectHydraHeadsToCheck(match, {
          depositedHeadIds: new Set(),
          genuineByHeadId: new Map([
            ['a', true],
            ['b', false],
          ]),
          limits,
        }),
      ),
    ).toEqual(['c', 'd']);
  });
});

describe('selectHydraHeadsToRead', () => {
  it('reads the genuine heads only, deposited ones first, up to the head limit', () => {
    const match = matchOf(['a', 'b', 'c'], ['d']);
    const limits = { ...HYDRA_HEAD_HISTORY_LIMITS, maxHeadsPerAccount: 2 };

    expect(
      idsOf(
        selectHydraHeadsToRead(match, {
          depositedHeadIds: new Set(['d']),
          genuineByHeadId: new Map([
            ['a', false],
            ['b', true],
            ['c', true],
            ['d', true],
          ]),
          limits,
        }),
      ),
    ).toEqual(['d', 'b']);
  });
});

describe('settleHydraAccountHeads', () => {
  const settle = ({
    heads = [],
    candidateHeads = [],
    waiting = [],
    genuine = [],
    lookalikes = [],
    funds = [],
    listed = [],
  }: {
    heads?: string[];
    candidateHeads?: string[];
    waiting?: string[];
    genuine?: string[];
    lookalikes?: string[];
    funds?: [string, HydraHeadFunds | undefined][];
    listed?: string[];
  }) => {
    const settled = settleHydraAccountHeads({
      heads: heads.map(headOf),
      candidateHeads: candidateHeads.map(headOf),
      waitingHeadIds: new Set(waiting),
      genuineByHeadId: new Map([
        ...genuine.map(headId => [headId, true] as const),
        ...lookalikes.map(headId => [headId, false] as const),
      ]),
      fundsByHeadId: new Map(funds),
      listedHeadIds: new Set(listed),
    });
    return { heads: idsOf(settled.heads), kept: settled.depositedHeadIds };
  };

  it('lists every genuine participated head, with or without figures, and no lookalike or unchecked one', () => {
    expect(
      settle({
        heads: ['genuine', 'unread', 'lookalike', 'unchecked'],
        genuine: ['genuine', 'unread'],
        lookalikes: ['lookalike'],
        funds: [['genuine', fundsOf(0n)]],
      }).heads,
    ).toEqual(['genuine', 'unread']);
  });

  it('lists a genuine deposit-only head while a deposit waits for it', () => {
    expect(
      settle({ candidateHeads: ['h'], waiting: ['h'], genuine: ['h'] }),
    ).toEqual({ heads: ['h'], kept: ['h'] });
  });

  it('lists a deposit-only head once its figures attribute a deposit to the account', () => {
    expect(
      settle({
        candidateHeads: ['h'],
        genuine: ['h'],
        funds: [['h', fundsOf(5n)]],
      }),
    ).toEqual({ heads: ['h'], kept: ['h'] });
  });

  it('forgets a deposit-only head whose figures attribute nothing once no deposit waits for it', () => {
    expect(
      settle({
        candidateHeads: ['h'],
        genuine: ['h'],
        funds: [['h', fundsOf(0n)]],
        listed: ['h'],
      }),
    ).toEqual({ heads: [], kept: [] });
  });

  it('keeps a deposit-only head without figures listed only while the previous settle listed it', () => {
    expect(
      settle({ candidateHeads: ['h'], genuine: ['h'], listed: ['h'] }),
    ).toEqual({ heads: ['h'], kept: ['h'] });
    expect(settle({ candidateHeads: ['h'], genuine: ['h'] })).toEqual({
      heads: [],
      kept: ['h'],
    });
  });

  it('keeps the id of an unchecked deposit-only head without listing it, and drops a lookalike', () => {
    expect(
      settle({
        candidateHeads: ['unchecked', 'lookalike'],
        waiting: ['unchecked', 'lookalike'],
        lookalikes: ['lookalike'],
      }),
    ).toEqual({ heads: [], kept: ['unchecked'] });
  });
});
