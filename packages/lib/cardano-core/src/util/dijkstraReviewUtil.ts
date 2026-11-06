import { CredentialType } from '../Cardano/Address';

import type { SubTransactionBody, TxBody } from '../Cardano/types';

/**
 * A Dijkstra-era part of a transaction batch that a review surface must show the user before it
 * may let them approve the transaction.
 *
 * - `subTransactions`: sub transactions (body key 23), whose outputs, inputs, certificates,
 *   withdrawals and mint the review must count with the top level's.
 * - `directDeposits`: coin paid straight into reward accounts (body key 25).
 * - `accountBalanceIntervals`: account balance assertions (body keys 26 and 27).
 * - `scriptGuards`: guards (body key 14) that are script credentials. A key-hash guard is a
 *   required signer under another name and is not listed.
 * - `requiredTopLevelGuards`: guards the top level transaction must carry (body key 24).
 */
export type DijkstraReviewField =
  | 'accountBalanceIntervals'
  | 'directDeposits'
  | 'requiredTopLevelGuards'
  | 'scriptGuards'
  | 'subTransactions';

const fieldsOfBody = (
  body: SubTransactionBody | TxBody,
): DijkstraReviewField[] => [
  ...(body.directDeposits?.length ? (['directDeposits'] as const) : []),
  ...(body.accountBalanceIntervals?.length ||
  ('startingAccountBalanceIntervals' in body &&
    body.startingAccountBalanceIntervals?.length)
    ? (['accountBalanceIntervals'] as const)
    : []),
  ...(body.guards?.some(({ type }) => type === CredentialType.ScriptHash)
    ? (['scriptGuards'] as const)
    : []),
  ...(body.requiredTopLevelGuards?.length
    ? (['requiredTopLevelGuards'] as const)
    : []),
];

/**
 * Lists the Dijkstra-era parts a transaction carries anywhere in its batch: the top level body
 * and the body of every sub transaction.
 *
 * @param body The top level transaction body.
 * @returns Each part present, once.
 */
export const dijkstraReviewFields = (body: TxBody): DijkstraReviewField[] => {
  const subTransactions = body.subTransactions ?? [];
  return [
    ...new Set<DijkstraReviewField>([
      ...(subTransactions.length > 0 ? (['subTransactions'] as const) : []),
      ...fieldsOfBody(body),
      ...subTransactions.flatMap(subTransaction =>
        fieldsOfBody(subTransaction.body),
      ),
    ]),
  ];
};

/**
 * Lists the Dijkstra-era parts of a transaction batch that a review surface cannot show. A
 * surface lets the user approve a transaction only when this is empty, and refuses it otherwise.
 *
 * @param body The top level transaction body.
 * @param renders The parts the surface shows in full.
 * @returns The parts the transaction carries that the surface does not show.
 */
export const unrenderedDijkstraFields = (
  body: TxBody,
  renders: readonly DijkstraReviewField[] = [],
): DijkstraReviewField[] =>
  dijkstraReviewFields(body).filter(field => !renders.includes(field));
