import { decodeHydraHeadState } from './head-datum';
import { findHydraHeadVersion, getHydraHeadStateTokenName } from './registry';
import { toHydraOutRef } from './utxo';

import type { HydraAccountHead, HydraUtxo } from './types';

/** Hex length of a policy id. */
const POLICY_ID_LENGTH = 56;

/** Hex length of a participation token name, which is a payment key hash. */
const PARTICIPANT_NAME_LENGTH = 56;

/**
 * Returns the head id when exactly one unit of the generation's state token
 * sits on the UTxO.
 */
const findHeadId = (
  utxo: HydraUtxo,
  stateTokenName: string,
): string | undefined => {
  const stateTokens = [...utxo.value.assets].filter(
    ([unit, quantity]) =>
      unit.length === POLICY_ID_LENGTH + stateTokenName.length &&
      unit.endsWith(stateTokenName) &&
      quantity === 1n,
  );
  return stateTokens.length === 1
    ? stateTokens[0][0].slice(0, POLICY_ID_LENGTH)
    : undefined;
};

/** Returns the payment key hashes named by the head's participation tokens. */
const findParticipants = (utxo: HydraUtxo, headId: string): string[] =>
  [...utxo.value.assets]
    .filter(
      ([unit, quantity]) =>
        unit.startsWith(headId) &&
        unit.length === POLICY_ID_LENGTH + PARTICIPANT_NAME_LENGTH &&
        quantity === 1n,
    )
    .map(([unit]) => unit.slice(POLICY_ID_LENGTH));

/** A head UTxO read without regard to any account. */
type HeadUtxo = Omit<
  HydraAccountHead,
  'isParticipant' | 'isSoleParticipant' | 'participantCount'
> & {
  /** Payment key hashes named by the participation tokens. */
  readonly participants: readonly string[];
};

/**
 * Reads a head UTxO, or returns undefined when it is not at a head address,
 * lacks a single state token of the address's generation, carries no
 * decodable datum or is not one of the wanted heads.
 */
const readHeadUtxo = (
  utxo: HydraUtxo,
  isWanted: (headId: string, participants: readonly string[]) => boolean,
): HeadUtxo | undefined => {
  const version = findHydraHeadVersion(utxo.address);
  if (version === undefined || !utxo.inlineDatum) return undefined;
  const stateTokenName = getHydraHeadStateTokenName(version);
  const headId = findHeadId(utxo, stateTokenName);
  if (headId === undefined) return undefined;
  const participants = findParticipants(utxo, headId);
  if (!isWanted(headId, participants)) return undefined;
  const state = decodeHydraHeadState(utxo.inlineDatum, version);
  if (!state) return undefined;
  return {
    ...state,
    headId,
    version,
    outpoint: toHydraOutRef(utxo),
    headValue: utxo.value,
    participants,
  };
};

/** Describes a head UTxO as seen by the account owning the given keys. */
const toAccountHead = (
  { participants, ...head }: HeadUtxo,
  owned: ReadonlySet<string>,
): HydraAccountHead => {
  const ownParticipants = participants.filter(keyHash => owned.has(keyHash));
  return {
    ...head,
    participantCount: participants.length,
    isParticipant: ownParticipants.length > 0,
    isSoleParticipant:
      ownParticipants.length > 0 &&
      ownParticipants.length === participants.length,
  };
};

/**
 * Picks the heads the account participates in out of the UTxOs at the head
 * validator addresses. A head UTxO carries the state token, whose policy id
 * is the head id, and one participation token per participant named after
 * the participant's payment key hash. UTxOs that are not at a head address,
 * lack a single state token of the address's generation, carry no decodable
 * datum, or hold no participation token of the account are skipped.
 *
 * First generation heads in the `initial` state never match, because their
 * participation tokens sit at the initial validator until collected.
 *
 * @remarks Anyone can place a lookalike head at a head validator, so a head
 * is genuine only once it passes `isHydraHeadMintingScript`. The value
 * a head UTxO holds belongs to all its participants and is not the
 * account's balance.
 *
 * @param utxos - UTxOs at the head validator addresses.
 * @param ownedPaymentKeyHashes - Hex payment key hashes of the account.
 */
export const findAccountHydraHeads = (
  utxos: readonly HydraUtxo[],
  ownedPaymentKeyHashes: Iterable<string>,
): HydraAccountHead[] => {
  const owned = new Set(ownedPaymentKeyHashes);
  return utxos.flatMap(utxo => {
    const head = readHeadUtxo(utxo, (_, participants) =>
      participants.some(keyHash => owned.has(keyHash)),
    );
    return head ? [toAccountHead(head, owned)] : [];
  });
};

/**
 * Picks the heads with the given ids out of the UTxOs at the head validator
 * addresses, whether or not the account participates in them. From 2.0.0
 * anyone can deposit into an open head, so a depositor may hold no
 * participation token; `isParticipant` tells the two apart. The head UTxOs
 * are anchored as in `findAccountHydraHeads`, so a head id that names no
 * head UTxO, such as one read from a spoofed transaction, finds nothing.
 *
 * @remarks Anyone can place a lookalike head at a head validator under any
 * id, so a head is genuine only once it passes `isHydraHeadMintingScript`.
 * The value a head UTxO holds belongs to all its participants and is not the
 * account's balance.
 *
 * @param utxos - UTxOs at the head validator addresses.
 * @param headIds - Hex policy ids of the head state tokens to look for.
 * @param ownedPaymentKeyHashes - Hex payment key hashes of the account.
 */
export const findHydraHeadsById = (
  utxos: readonly HydraUtxo[],
  headIds: Iterable<string>,
  ownedPaymentKeyHashes: Iterable<string>,
): HydraAccountHead[] => {
  const wanted = new Set(headIds);
  if (wanted.size === 0) return [];
  const owned = new Set(ownedPaymentKeyHashes);
  return utxos.flatMap(utxo => {
    const head = readHeadUtxo(utxo, headId => wanted.has(headId));
    return head ? [toAccountHead(head, owned)] : [];
  });
};
