import { Cardano, Serialization } from '@lace-lib/vendor';
import { describe, expect, it, vi } from 'vitest';

import {
  collateralRefusalCase,
  collateralRefusalMessage,
  resolveCollateralOwnershipSets,
  toCollateralOwnershipSets,
} from '../../../src/dapp-connector/signing';

import type { CollateralOwnershipErrorCase } from '../../../src/dapp-connector/signing';
import type { Crypto } from '@lace-lib/vendor';

const txIn = (id: string, index: number): Cardano.TxIn =>
  ({ txId: id, index } as unknown as Cardano.TxIn);

const refKey = (id: string, index: number) => `${id}#${index}`;

const addr = (label: string) => `addr_test1${label}` as Cardano.PaymentAddress;

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
const WALLET_PAYMENT_FOREIGN_STAKE = base('aa', 'cc');
const FOREIGN = base('dd', 'ee');
const ownAddresses = [WALLET];

/**
 * K: identified as ours. F: identified as someone else's. U: not identifiable,
 * the resolver answers null. T: not identifiable, the resolver throws.
 */
type Kind = 'F' | 'K' | 'T' | 'U';
type Return = 'foreign' | 'none' | 'own';
const REFUSE: CollateralOwnershipErrorCase = 'foreign-collateral-return';

const ROWS: {
  collateral: Kind[];
  ret: Return;
  verdict: CollateralOwnershipErrorCase | null;
}[] = [
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

describe('LW-15596 T-7: asset-bearing collateral return', () => {
  it.each([
    { destination: FOREIGN, expected: REFUSE },
    { destination: WALLET_PAYMENT_FOREIGN_STAKE, expected: REFUSE },
    { destination: WALLET, expected: null },
  ])(
    'classifies the complete return address $destination',
    ({ destination, expected }) => {
      const collateral = {
        txId: Cardano.TransactionId('11'.repeat(32)),
        index: 0,
      };
      const tx = Serialization.Transaction.fromCore({
        id: collateral.txId,
        body: body({
          collaterals: [collateral],
          collateralReturn: {
            address: destination,
            value: {
              coins: 2_000_000n,
              assets: new Map([
                [Cardano.AssetId(`${'ab'.repeat(28)}4e4654`), 1n],
              ]),
            },
          },
        }),
        witness: { signatures: new Map() },
      });
      const decoded = Serialization.Transaction.fromCbor(tx.toCbor())
        .body()
        .toCore();
      expect(
        collateralRefusalCase(
          decoded,
          toCollateralOwnershipSets({
            ownInputs: [collateral],
            ownAddresses,
          }),
        ),
      ).toBe(expected);
    },
  );
});

describe('the rule over the resolver authority', () => {
  it.each(MATRIX)(
    '$label -> $verdict',
    async ({ collateral, ret, verdict }) => {
      const collaterals = classify(collateral);
      const txBody = bodyOf(collaterals, ret);
      const sets = await resolveCollateralOwnershipSets({
        body: txBody,
        resolveInput: async input => {
          const { kind } = collaterals.find(
            c =>
              refKey(c.input.txId, c.input.index) ===
              refKey(input.txId, input.index),
          )!;
          switch (kind) {
            case 'K':
              return txOut(WALLET);
            case 'F':
              return txOut(FOREIGN);
            case 'U':
              return null;
            case 'T':
              throw new Error('provider down');
          }
        },
        ownAddresses,
      });

      expect([...sets.ownUtxoRefs].sort()).toEqual(
        collaterals
          .filter(({ kind }) => kind === 'K')
          .map(({ input }) => refKey(input.txId, input.index))
          .sort(),
      );
      expect(collateralRefusalCase(txBody, sets)).toBe(verdict);
    },
  );
});

describe('payment-credential reuse', () => {
  it('a base collateral_return sharing the wallet payment credential with a FOREIGN stake credential is refused (strict full-address match, never payment-credential match)', () => {
    expect(WALLET_PAYMENT_FOREIGN_STAKE).not.toEqual(WALLET);
    expect(
      Cardano.Address.fromBech32(WALLET_PAYMENT_FOREIGN_STAKE)
        .asBase()!
        .getPaymentCredential().hash,
    ).toEqual(
      Cardano.Address.fromBech32(WALLET).asBase()!.getPaymentCredential().hash,
    );

    expect(
      collateralRefusalCase(
        body({
          collaterals: [txIn('t1', 0)],
          collateralReturn: txOut(WALLET_PAYMENT_FOREIGN_STAKE),
        }),
        {
          ownUtxoRefs: new Set([refKey('t1', 0)]),
          ownAddresses: new Set([WALLET]),
        },
      ),
    ).toBe('foreign-collateral-return');
  });
});

describe('transactions with no collateral', () => {
  it('no collaterals field -> allow, no throw', () => {
    expect(
      collateralRefusalCase(body({}), {
        ownUtxoRefs: new Set(),
        ownAddresses: new Set(),
      }),
    ).toBeNull();
  });

  it('empty collaterals array -> allow (an unguarded dereference would fail-closed-block ALL ordinary signing)', () => {
    expect(
      collateralRefusalCase(body({ collaterals: [] }), {
        ownUtxoRefs: new Set(),
        ownAddresses: new Set(),
      }),
    ).toBeNull();
  });
});

/**
 * `ownAddresses` is built from DISCOVERED addresses, so an undiscovered
 * address of this very wallet reads as foreign. Pinned as an accepted
 * trade-off (refusing a legitimate transaction beats signing a hostile one),
 * so a future change to address discovery cannot move it silently.
 */
describe('the accepted false positive', () => {
  it('refuses a collateral_return paying an OWN but not-yet-derived address', () => {
    expect(
      collateralRefusalCase(
        body({
          collaterals: [txIn('t1', 0)],
          collateralReturn: txOut(addr('own-but-undiscovered')),
        }),
        {
          ownUtxoRefs: new Set([refKey('t1', 0)]),
          ownAddresses: new Set([addr('wallet-return')]),
        },
      ),
    ).toBe('foreign-collateral-return');
  });
});

describe('building the ownership authority from own inputs', () => {
  it('keys own inputs the way the rule keys collateral inputs', () => {
    const foreignReturn = body({
      collaterals: [txIn('t1', 1)],
      collateralReturn: txOut(FOREIGN),
    });
    const setsOwning = (input: Cardano.TxIn) =>
      toCollateralOwnershipSets({ ownInputs: [input], ownAddresses });

    expect(
      collateralRefusalCase(foreignReturn, setsOwning(txIn('t1', 1))),
    ).toBe('foreign-collateral-return');
    expect(
      collateralRefusalCase(foreignReturn, setsOwning(txIn('t1', 0))),
    ).toBeNull();
  });
});

describe('resolving the ownership authority', () => {
  const resolverOver =
    (entries: Record<string, Cardano.PaymentAddress>) =>
    async (input: Cardano.TxIn) => {
      const address = entries[refKey(input.txId, input.index)];
      return address ? txOut(address) : null;
    };

  it('an input resolved to a wallet address is own; one resolved to a foreign address is not', async () => {
    const sets = await resolveCollateralOwnershipSets({
      body: body({ collaterals: [txIn('t1', 0), txIn('t2', 0)] }),
      resolveInput: resolverOver({
        [refKey('t1', 0)]: WALLET,
        [refKey('t2', 0)]: FOREIGN,
      }),
      ownAddresses,
    });

    expect([...sets.ownUtxoRefs]).toEqual([refKey('t1', 0)]);
    expect(sets.ownAddresses).toEqual(new Set([WALLET]));
  });

  it('INPUT ownership is by payment credential: a UTxO at the wallet payment key with a foreign stake key is own, because our witness would satisfy it', async () => {
    const sets = await resolveCollateralOwnershipSets({
      body: body({ collaterals: [txIn('t1', 0)] }),
      resolveInput: resolverOver({
        [refKey('t1', 0)]: WALLET_PAYMENT_FOREIGN_STAKE,
      }),
      ownAddresses,
    });

    expect(sets.ownUtxoRefs.has(refKey('t1', 0))).toBe(true);
  });

  it('RETURN ownership stays whole-address: the same wallet-payment/foreign-stake address as a return is refused', async () => {
    const collateral = txIn('t1', 0);
    const sets = await resolveCollateralOwnershipSets({
      body: body({ collaterals: [collateral] }),
      resolveInput: resolverOver({ [refKey('t1', 0)]: WALLET }),
      ownAddresses,
    });

    expect(
      collateralRefusalCase(
        body({
          collaterals: [collateral],
          collateralReturn: txOut(WALLET_PAYMENT_FOREIGN_STAKE),
        }),
        sets,
      ),
    ).toBe('foreign-collateral-return');
  });

  it('a transaction without collateral never calls the resolver', async () => {
    const resolveInput = vi.fn(async () => null);

    const sets = await resolveCollateralOwnershipSets({
      body: body({}),
      resolveInput,
      ownAddresses,
    });

    expect(resolveInput).not.toHaveBeenCalled();
    expect(sets.ownUtxoRefs.size).toBe(0);
  });
});

describe('the dApp-facing message', () => {
  it('is pinned verbatim, independent of any locale', () => {
    expect(collateralRefusalMessage('foreign-collateral-return')).toBe(
      "if the smart contract fails, this transaction would send this wallet's funds to an address this wallet doesn't own; Lace won't sign it.",
    );
  });
});
