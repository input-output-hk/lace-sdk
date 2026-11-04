import { describe, expect, it } from 'vitest';

import {
  HYDRA_HEAD_STATE_TOKEN_NAMES,
  findAccountHydraHeads,
  findHydraHeadsById,
  fromBlockfrostUtxo,
  fromCardanoUtxo,
} from '../src';

import { toCardanoUtxo } from './fixtures/cardano';
import { preprodUtxos } from './fixtures/preprod';

import type { HydraBlockfrostUtxo, HydraUtxo } from '../src';

const HEAD_ID = '324c8b8198c4c9db7526d6dccb79e992c4863b24b56453bb16995bdc';
const OWNER = 'ba1e067abfb07ecd833cec7005a8aa89cbdf09e10d6c87bb73da9e35';
const LIVE_OWNER = '4d6885624e031c24dcf87fa672150660d81a706174b8470abacd0c28';
const STRANGER = 'ab'.repeat(28);
const FANNING_OUT_HEAD_ID =
  'd7f3a349772cb36206c2005f108b77bdad46da96b1a6378702feed00';
const FANNING_OUT_DEPOSITOR =
  '088d20811270899db3efe4eb2851da07182e88581a57d2645457a9a9';
const FANNING_OUT_PARTICIPANT =
  '7099552de5127f5ca4f671d47f6ab785a2a676fb415d4329e9459bf6';

const converters: [string, (utxo: HydraBlockfrostUtxo) => HydraUtxo][] = [
  ['Blockfrost JSON', fromBlockfrostUtxo],
  ['Cardano.Utxo', utxo => fromCardanoUtxo(toCardanoUtxo(utxo))],
];

const isStateToken = (unit: string) =>
  unit.endsWith(HYDRA_HEAD_STATE_TOKEN_NAMES.v1) ||
  unit.endsWith(HYDRA_HEAD_STATE_TOKEN_NAMES.v2);

const headIdOf = (utxo: HydraUtxo) => {
  const stateToken = [...utxo.value.assets.keys()].find(isStateToken);
  if (!stateToken) throw new Error('fixture has no state token');
  return stateToken.slice(0, 56);
};

const participantsOf = (utxo: HydraUtxo) =>
  [...utxo.value.assets.keys()]
    .filter(unit => unit.startsWith(headIdOf(utxo)) && !isStateToken(unit))
    .map(unit => unit.slice(56));

describe.each(converters)('findAccountHydraHeads from %s', (_, convert) => {
  const allHeads = Object.entries(preprodUtxos)
    .filter(([name]) => name.startsWith('head'))
    .map(([, utxo]) => convert(utxo));

  it('finds the open head of a sole participant', () => {
    const utxo = convert(preprodUtxos.headV2Open);
    expect(findAccountHydraHeads([utxo], [OWNER])).toEqual([
      {
        state: 'open',
        headId: HEAD_ID,
        version: '2.3.0',
        outpoint: { txId: preprodUtxos.headV2Open.tx_hash, index: 0 },
        headValue: utxo.value,
        participantCount: 1,
        isParticipant: true,
        isSoleParticipant: true,
      },
    ]);
  });

  it('carries the contestation deadline of a closed head', () => {
    const [head] = findAccountHydraHeads(
      [convert(preprodUtxos.headV2Closed)],
      [OWNER],
    );
    expect(head.state).toBe('closed');
    expect(head.contestationDeadline).toEqual(
      Date.parse('2026-09-01T14:32:30.000Z'),
    );
  });

  it('finds the live head of a Preprod payment key among all heads', () => {
    expect(
      findAccountHydraHeads(allHeads, [LIVE_OWNER]).map(
        ({ headId, state }) => ({ headId, state }),
      ),
    ).toEqual([
      {
        headId: '87e5931f96faa62899239102381dd637acd7d7b20752f070651f8890',
        state: 'closed',
      },
    ]);
  });

  it('ignores heads in which only other keys participate', () => {
    expect(findAccountHydraHeads(allHeads, [STRANGER])).toEqual([]);
  });

  it.each([
    {
      name: 'second generation open',
      fixture: preprodUtxos.headV2OpenThreeParties,
      expectedState: 'open',
      expectedCount: 3,
    },
    {
      name: 'first generation closed',
      fixture: preprodUtxos.headV1ClosedFourParties,
      expectedState: 'closed',
      expectedCount: 4,
    },
  ])(
    'counts every participant of a $name head',
    ({ fixture, expectedState, expectedCount }) => {
      const utxo = convert(fixture);
      const [participant, ...others] = participantsOf(utxo);

      const [head] = findAccountHydraHeads([utxo], [participant]);
      expect(head).toMatchObject({
        headId: headIdOf(utxo),
        state: expectedState,
        participantCount: expectedCount,
        isSoleParticipant: false,
      });
      expect(
        findAccountHydraHeads([utxo], [participant, ...others])[0]
          .isSoleParticipant,
      ).toBe(true);
    },
  );

  it.each([
    { fixture: preprodUtxos.head015Open, version: '0.15.0', state: 'open' },
    { fixture: preprodUtxos.head015Closed, version: '0.15.0', state: 'closed' },
    { fixture: preprodUtxos.head018Closed, version: '0.18.0', state: 'closed' },
    { fixture: preprodUtxos.head019Closed, version: '0.19.0', state: 'closed' },
    {
      fixture: preprodUtxos.headV1ClosedFourParties,
      version: '1.0.0',
      state: 'closed',
    },
    { fixture: preprodUtxos.head200Open, version: '2.0.0', state: 'open' },
    { fixture: preprodUtxos.head200Closed, version: '2.0.0', state: 'closed' },
    { fixture: preprodUtxos.head210Open, version: '2.1.0', state: 'open' },
    {
      fixture: preprodUtxos.head210ClosedThreeParties,
      version: '2.1.0',
      state: 'closed',
    },
    { fixture: preprodUtxos.head220Open, version: '2.2.0', state: 'open' },
  ])(
    'finds a participant of a $state $version Preprod head',
    ({ fixture, version, state }) => {
      const utxo = convert(fixture);
      const [participant] = participantsOf(utxo);
      expect(findAccountHydraHeads([utxo], [participant])).toMatchObject([
        { headId: headIdOf(utxo), version, state },
      ]);
    },
  );

  it('finds every 2.0.0 head of one payment key', () => {
    const owner = '305fc77760a60bdefd5397c44dd8395e92e527ff40f0a39a61b17115';
    expect(
      findAccountHydraHeads(allHeads, [owner]).map(({ headId, state }) => ({
        headId,
        state,
      })),
    ).toEqual([
      {
        headId: '95e30221a4aedb141f4b0573cd4597c4886273efd84f1b53e34aa8c6',
        state: 'open',
      },
      {
        headId: 'ca23701fa1cead9c450016c009f981a9328b775e454307d63e650fcc',
        state: 'closed',
      },
    ]);
  });

  it('finds first generation open heads', () => {
    const utxo = convert(preprodUtxos.headV1Open);
    const [head] = findAccountHydraHeads([utxo], participantsOf(utxo));
    expect(head).toMatchObject({
      headId: headIdOf(utxo),
      state: 'open',
      version: '1.3.0',
      participantCount: 2,
      isSoleParticipant: true,
    });
  });

  it('never matches an initial head, whose participation tokens sit elsewhere', () => {
    const utxo = convert(preprodUtxos.headV1Initial);
    expect(utxo.value.assets.size).toBe(1);
    expect(findAccountHydraHeads([utxo], [OWNER, STRANGER])).toEqual([]);
  });
});

describe('findAccountHydraHeads anchoring', () => {
  const open = fromBlockfrostUtxo(preprodUtxos.headV2Open);

  it('ignores a head UTxO outside the head addresses', () => {
    const moved = { ...open, address: preprodUtxos.depositV2.address };
    expect(findAccountHydraHeads([moved], [OWNER])).toEqual([]);
  });

  it('ignores a state token of the other generation', () => {
    const v1Address = preprodUtxos.headV1Open.address;
    expect(
      findAccountHydraHeads([{ ...open, address: v1Address }], [OWNER]),
    ).toEqual([]);
  });

  it('skips undecodable or missing datums', () => {
    const { inlineDatum: _, ...withoutDatum } = open;
    expect(
      findAccountHydraHeads(
        [{ ...open, inlineDatum: 'deadbeef' }, withoutDatum],
        [OWNER],
      ),
    ).toEqual([]);
  });

  it('skips a UTxO holding two state tokens', () => {
    const assets = new Map(open.value.assets);
    assets.set(`${'cd'.repeat(28)}${HYDRA_HEAD_STATE_TOKEN_NAMES.v2}`, 1n);
    expect(
      findAccountHydraHeads(
        [{ ...open, value: { ...open.value, assets } }],
        [OWNER],
      ),
    ).toEqual([]);
  });
});

describe.each(converters)('findHydraHeadsById from %s', (_, convert) => {
  const allHeads = Object.entries(preprodUtxos)
    .filter(([name]) => name.startsWith('head'))
    .map(([, utxo]) => convert(utxo));

  it('finds a head the account deposited into without participating', () => {
    const utxo = convert(preprodUtxos.headV2FanningOut);
    expect(
      findHydraHeadsById(
        allHeads,
        [FANNING_OUT_HEAD_ID],
        [FANNING_OUT_DEPOSITOR],
      ),
    ).toEqual([
      {
        state: 'fanningOut',
        contestationDeadline: expect.any(Number) as unknown,
        headId: FANNING_OUT_HEAD_ID,
        version: '2.3.0',
        outpoint: { txId: preprodUtxos.headV2FanningOut.tx_hash, index: 0 },
        headValue: utxo.value,
        participantCount: 2,
        isParticipant: false,
        isSoleParticipant: false,
      },
    ]);
  });

  it('tells a participant of the head apart', () => {
    expect(
      findHydraHeadsById(
        allHeads,
        [FANNING_OUT_HEAD_ID],
        [FANNING_OUT_PARTICIPANT],
      ),
    ).toMatchObject([
      {
        headId: FANNING_OUT_HEAD_ID,
        isParticipant: true,
        isSoleParticipant: false,
      },
    ]);
  });

  it('finds nothing for a head id that names no head UTxO', () => {
    expect(
      findHydraHeadsById(allHeads, ['cd'.repeat(28)], [FANNING_OUT_DEPOSITOR]),
    ).toEqual([]);
    expect(findHydraHeadsById(allHeads, [], [FANNING_OUT_DEPOSITOR])).toEqual(
      [],
    );
  });

  it('ignores a head UTxO with the id outside the head addresses', () => {
    const utxo = convert(preprodUtxos.headV2FanningOut);
    const moved = { ...utxo, address: preprodUtxos.depositV2.address };
    expect(
      findHydraHeadsById(
        [moved],
        [FANNING_OUT_HEAD_ID],
        [FANNING_OUT_DEPOSITOR],
      ),
    ).toEqual([]);
  });
});
