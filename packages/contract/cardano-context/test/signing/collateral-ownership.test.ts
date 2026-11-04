import { Cardano } from '@cardano-sdk/core';
import { describe, expect, it } from 'vitest';

import {
  collateralOwnershipSets,
  collateralRefusalCase,
} from '../../src/signing/collateral-ownership';

import type { CollateralOwnershipErrorCase } from '../../src/signing/assert-collateral-ownership';
import type * as Crypto from '@cardano-sdk/crypto';
import type { GroupedAddress } from '@cardano-sdk/key-management';

const txIn = (id: string, index: number): Cardano.TxIn =>
  ({ txId: id, index } as unknown as Cardano.TxIn);

const refKey = (id: string, index: number) => `${id}#${index}`;

const addr = (label: string) => `addr_test1${label}` as Cardano.PaymentAddress;

const WALLET_RETURN = addr('wallet-return');

const txOut = (address: Cardano.PaymentAddress): Cardano.TxOut =>
  ({ address, value: { coins: 2_000_000n } } as unknown as Cardano.TxOut);

const body = (fields: Partial<Cardano.TxBody>): Cardano.TxBody =>
  ({
    inputs: [],
    outputs: [],
    fee: 170_000n,
    ...fields,
  } as unknown as Cardano.TxBody);

const keyCred = (byte: string): Cardano.Credential => ({
  type: Cardano.CredentialType.KeyHash,
  hash: byte.repeat(28) as Crypto.Hash28ByteBase16,
});
const base = (payment: string, stake: string) =>
  Cardano.BaseAddress.fromCredentials(
    Cardano.NetworkId.Testnet,
    keyCred(payment),
    keyCred(stake),
  )
    .toAddress()
    .toBech32() as Cardano.PaymentAddress;

const WALLET = base('aa', 'bb');
const FOREIGN = base('dd', 'ee');
const knownAddresses = [{ address: WALLET } as unknown as GroupedAddress];

/**
 * K: identified as ours. F: identified as someone else's. U: not identifiable,
 * the resolver answers null. T: not identifiable, the resolver throws.
 * Membership cannot tell F, U and T apart; the resolver can, and the verdict
 * must not change: @lace-lib/core runs the same rows over the resolver.
 */
type Kind = 'F' | 'K' | 'T' | 'U';
type Return = 'foreign' | 'none' | 'own';
const REFUSE: CollateralOwnershipErrorCase = 'foreign-collateral-return';

type Row = {
  collateral: Kind[];
  ret: Return;
  verdict: CollateralOwnershipErrorCase | null;
};

const ROWS: Row[] = [
  { collateral: ['K'], ret: 'own', verdict: null },
  { collateral: ['K'], ret: 'foreign', verdict: REFUSE },
  { collateral: ['K', 'K', 'K'], ret: 'foreign', verdict: REFUSE },
  { collateral: ['K', 'U'], ret: 'own', verdict: null },
  { collateral: ['K', 'F'], ret: 'own', verdict: null },
  { collateral: ['K', 'T'], ret: 'own', verdict: null },
  { collateral: ['K', 'U'], ret: 'foreign', verdict: REFUSE },
  { collateral: ['K', 'F'], ret: 'foreign', verdict: REFUSE },
  { collateral: ['K', 'T'], ret: 'foreign', verdict: REFUSE },
  { collateral: ['K'], ret: 'none', verdict: null },
  { collateral: ['K', 'U'], ret: 'none', verdict: null },
  { collateral: ['K', 'F'], ret: 'none', verdict: null },
  { collateral: ['U'], ret: 'own', verdict: null },
  { collateral: ['U'], ret: 'foreign', verdict: null },
  { collateral: ['F'], ret: 'own', verdict: null },
  { collateral: ['F'], ret: 'foreign', verdict: null },
  { collateral: ['T'], ret: 'foreign', verdict: null },
  { collateral: ['U', 'F'], ret: 'foreign', verdict: null },
  { collateral: [], ret: 'foreign', verdict: null },
  { collateral: [], ret: 'none', verdict: null },
];

const MATRIX = ROWS.map(row => ({
  ...row,
  label: `${row.collateral.join('+') || 'no collateral'}, return ${row.ret}`,
}));

const classify = (kinds: Kind[]) =>
  kinds.map((kind, index) => ({ kind, input: txIn(`${kind}${index}`, index) }));

const bodyOf = (
  collaterals: ReturnType<typeof classify>,
  returnValue: Return,
): Cardano.TxBody =>
  body({
    collaterals: collaterals.map(({ input }) => input),
    ...(returnValue === 'none'
      ? {}
      : { collateralReturn: txOut(returnValue === 'own' ? WALLET : FOREIGN) }),
  });

const identifiedKeys = (collaterals: ReturnType<typeof classify>) =>
  collaterals
    .filter(({ kind }) => kind === 'K')
    .map(({ input }) => refKey(input.txId, input.index))
    .sort();

describe('the rule over the membership authority (pre-consent)', () => {
  it.each(MATRIX)('$label -> $verdict', ({ collateral, ret, verdict }) => {
    const collaterals = classify(collateral);
    const sets = collateralOwnershipSets({
      ownershipUtxos: collaterals
        .filter(({ kind }) => kind === 'K')
        .map(({ input }) => [input, txOut(WALLET)] as unknown as Cardano.Utxo),
      knownAddresses,
    });

    expect([...sets.ownUtxoRefs].sort()).toEqual(identifiedKeys(collaterals));
    expect(collateralRefusalCase(bodyOf(collaterals, ret), sets)).toBe(verdict);
  });
});

describe('assembling the ownership authority', () => {
  const utxo = (id: string, index: number): Cardano.Utxo =>
    [txIn(id, index), txOut(WALLET_RETURN)] as unknown as Cardano.Utxo;

  it('keys UTxOs the way the rule reads them, and addresses in full', () => {
    const sets = collateralOwnershipSets({
      ownershipUtxos: [utxo('t1', 3)],
      knownAddresses: [{ address: WALLET_RETURN } as unknown as GroupedAddress],
    });

    expect(
      collateralRefusalCase(
        body({
          collaterals: [txIn('t1', 3)],
          collateralReturn: txOut(WALLET_RETURN),
        }),
        sets,
      ),
    ).toBeNull();
    expect(sets.ownUtxoRefs.has(refKey('t1', 3))).toBe(true);
    expect(sets.ownAddresses.has(WALLET_RETURN)).toBe(true);
  });
});
