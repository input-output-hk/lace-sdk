/**
 * The CIP-30 `partialSign: false` gate, over REAL Ed25519 seeds — the "own"
 * hashes are derived from one account's xpub and the "foreign" ones from a
 * genuinely different seed, so no case can agree with itself the way a
 * hand-authored hash pair could.
 *
 * ## The enumerated verdict set — the bound this file measures
 *
 * `ForeignSignatureRequirement` (`src/dapp-connector/signing/foreign-signatures.ts`) is a CLOSED union
 * of 10 members, and the verdict space is those 10 PLUS `undefined`. Re-derived
 * from the declaration and written out here member by member, with the case
 * that reaches each; `ALL_REQUIREMENTS` below re-states the 10 and is checked
 * against the union at COMPILE time (so an 11th member cannot be added without
 * failing here) and against what these cases actually reach at RUN time.
 *
 *  1. `unsatisfiable-script`        — cases (6), (7), (7g)
 *  2. `foreign-input`              — cases (1), (3), (4), (5)
 *  3. `foreign-required-signer`     — case (8)
 *  4. `unsupported-required-signer` — case (9c)
 *  5. `foreign-withdrawal`          — case (10)
 *  6. `foreign-stake-credential`    — cases (12), (19)
 *  7. `foreign-drep-credential`     — case (13)
 *  8. `foreign-voter`               — case (14)
 *  9. `committee-certificate`       — case (15)
 * 10. `unwitnessed-own-key`         — case (18)
 * 11. `undefined` (nothing foreign) — cases (2), (5b), (7d), (7e), (7f),
 *                                     (7h), (9a), (9b), (11), (11b), (16),
 *                                     (18b)
 *
 * Reaching a member is not the same as covering the ACCEPT paths, so every
 * branch that continues instead of refusing has its own case too: the
 * own-satisfiable script input (2), the 30-input boundary that still resolves
 * (5b), a Ledger script whose own key the body already requires (7d, 7e) and
 * a Ledger script input it exempts (7f, 7h), required
 * signers by own payment / stake / DRep-with-certificate hash (9a, 9b),
 * withdrawals by own stake key (11) and by own script hash (11b), the
 * own-DRep certificate that must NOT be refused (16), and an own-key vote the
 * signer does witness (18b).
 */
import {
  AddressType,
  Bip32Account,
  Cardano,
  Crypto,
  KeyRole,
  Serialization,
  util as KeyManagementUtil,
} from '@lace-lib/vendor';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { findForeignSignatureRequirement } from '../../../src/dapp-connector/signing';

import type { ForeignSignatureRequirement } from '../../../src/dapp-connector/signing';
import type { GroupedAddress } from '@lace-lib/vendor';

type AccountKeyDerivationPath = Parameters<Bip32Account['derivePublicKey']>[0];

/** The SDK's input key for `txInKeyPathMap` (key-management `TxInId`). */
const TxInId = ({ txId, index }: Cardano.TxIn) => `${txId}_${index}`;

/**
 * Every own key path the SDK finds, the ones a native script names included:
 * what a signer told every own key (the software key agent) witnesses.
 */
const bodyAndScriptWitnessPaths = ({
  dRepKeyHash,
  knownAddresses,
  scripts,
  txBody,
  txInKeyPathMap,
}: {
  dRepKeyHash: Crypto.Ed25519KeyHashHex;
  knownAddresses: readonly GroupedAddress[];
  scripts: Cardano.Script[] | undefined;
  txBody: Cardano.TxBody;
  txInKeyPathMap: Record<string, AccountKeyDerivationPath>;
}): AccountKeyDerivationPath[] =>
  KeyManagementUtil.ownSignatureKeyPaths(
    txBody,
    [...knownAddresses],
    txInKeyPathMap,
    dRepKeyHash,
    scripts,
  );

const deriveKeyHashes = async (
  account: Bip32Account,
  paths: readonly AccountKeyDerivationPath[],
): Promise<string[]> =>
  Promise.all(
    paths.map(async path =>
      Crypto.Ed25519PublicKey.fromHex(await account.derivePublicKey(path))
        .hash()
        .hex(),
    ),
  );

/** The 10 members, re-derived from the union's declaration. */
const ALL_REQUIREMENTS = [
  'committee-certificate',
  'foreign-drep-credential',
  'foreign-input',
  'foreign-required-signer',
  'foreign-stake-credential',
  'foreign-voter',
  'foreign-withdrawal',
  'unsatisfiable-script',
  'unsupported-required-signer',
  'unwitnessed-own-key',
] as const;

// Compile-time exhaustiveness in BOTH directions: a member added to the union
// and not to the list above (or the reverse) makes one of these `Exclude`s
// non-`never`, and `AssertNever` then fails to compile. The runtime
// `toHaveLength(10)` below cannot see that — a literal list always has the
// length it was written with.
type AssertNever<T extends never> = T;
type UnlistedMember = AssertNever<
  Exclude<ForeignSignatureRequirement, (typeof ALL_REQUIREMENTS)[number]>
>;
type ListedNonMember = AssertNever<
  Exclude<(typeof ALL_REQUIREMENTS)[number], ForeignSignatureRequirement>
>;

const HARDENED = 0x80_00_00_00;
const NETWORK_ID = 0;
const OWN_TX_ID = Cardano.TransactionId('00'.repeat(32));
const UNKNOWN_TX_ID = Cardano.TransactionId('22'.repeat(32));
const OWN_INPUT: Cardano.TxIn = { index: 0, txId: OWN_TX_ID };

/** m/1852'/1815'/0' for one seed: its account xpub and role-3 private key. */
const keysFor = (bip32Ed25519: Crypto.Bip32Ed25519, entropyByte: string) => {
  const accountKey = bip32Ed25519.derivePrivateKey(
    bip32Ed25519.fromBip39Entropy(
      Buffer.from(entropyByte.repeat(32), 'hex'),
      '',
    ),
    [1852 + HARDENED, 1815 + HARDENED, HARDENED],
  );
  return {
    accountXpub: bip32Ed25519.getBip32PublicKey(accountKey),
    dRepKey: bip32Ed25519.getRawPrivateKey(
      bip32Ed25519.derivePrivateKey(accountKey, [KeyRole.DRep, 0]),
    ),
  };
};

const requireSignature = (
  keyHash: Crypto.Ed25519KeyHashHex,
): Cardano.NativeScript => ({
  __type: Cardano.ScriptType.Native,
  keyHash,
  kind: Cardano.NativeScriptKind.RequireSignature,
});

const buildFixtures = async () => {
  const bip32Ed25519 = await Crypto.SodiumBip32Ed25519.create();
  const dependencies = { bip32Ed25519, blake2b: Crypto.blake2b };
  const chainId = { networkId: NETWORK_ID, networkMagic: 1 } as const;

  const accountOf = async (entropyByte: string) => {
    const keys = keysFor(bip32Ed25519, entropyByte);
    const account = new Bip32Account(
      {
        accountIndex: 0,
        chainId,
        extendedAccountPublicKey: keys.accountXpub,
      },
      dependencies,
    );
    const knownAddress = await account.deriveAddress(
      { index: 0, type: AddressType.External },
      0,
    );
    return {
      account,
      // From the seed's role-3 PRIVATE key, which the account object never
      // sees — so a gate that derived the wrong role would leave a
      // certificate unmatched instead of silently agreeing with itself.
      dRepKeyHash: Crypto.Ed25519PublicKey.fromHex(
        bip32Ed25519.getPublicKey(keys.dRepKey),
      )
        .hash()
        .hex(),
      knownAddress,
      paymentKeyHash: Cardano.Address.fromBech32(String(knownAddress.address))
        .asBase()!
        .getPaymentCredential().hash,
      stakeKeyHash: Cardano.RewardAccount.toHash(knownAddress.rewardAccount),
    };
  };

  const own = await accountOf('00');
  const foreign = await accountOf('11');

  // A script this account CAN satisfy alone, and one it cannot.
  const ownKeyScript = requireSignature(
    own.paymentKeyHash as unknown as Crypto.Ed25519KeyHashHex,
  );
  const foreignKeyScript = requireSignature(
    foreign.paymentKeyHash as unknown as Crypto.Ed25519KeyHashHex,
  );
  const ownScriptHash =
    Serialization.NativeScript.fromCore(ownKeyScript).hash();
  const scriptCredential = {
    hash: ownScriptHash,
    type: Cardano.CredentialType.ScriptHash,
  } as const;

  return {
    foreign,
    foreignKeyScript,
    own,
    ownKeyScript,
    // The address an input spending `ownKeyScript` pays to.
    ownScriptAddress: Cardano.EnterpriseAddress.fromCredentials(
      NETWORK_ID,
      scriptCredential,
    ).toAddress(),
    ownScriptRewardAccount: Cardano.RewardAccount(
      Cardano.RewardAddress.fromCredentials(NETWORK_ID, scriptCredential)
        .toAddress()
        .toBech32(),
    ),
  };
};

type Fixtures = Awaited<ReturnType<typeof buildFixtures>>;

/** Filled in `beforeAll`. A container rather than a module-scope `let`, which
 * the workspace bans (`functional/no-let`), so that every case can keep
 * reading the same `fx.…` names. */
const fx = {} as Fixtures;

/** Every verdict any case below reached — the run-time half of the bound. */
const reached = new Set<ForeignSignatureRequirement | undefined>();

const txWith = (
  body: Partial<Cardano.TxBody>,
  scripts?: Cardano.Script[],
): Cardano.Tx => ({
  body: { fee: 155_381n, inputs: [OWN_INPUT], outputs: [], ...body },
  id: OWN_TX_ID,
  witness: { scripts, signatures: new Map() },
});

/**
 * Which keys the signer witnesses, computed by the SDK as the real signers do:
 * every own key it finds (the software key agent, the air-gapped devices), or
 * the body's own keys only (Ledger, Trezor).
 */
type WitnessRule = 'body-keys' | 'every-own-key';

const check = async ({
  knownAddresses,
  resolveInput = async () => undefined,
  witnessRule = 'every-own-key',
  witnesses,
  tx,
}: {
  knownAddresses?: readonly GroupedAddress[];
  resolveInput?: (txIn: Cardano.TxIn) => Promise<Cardano.Address | undefined>;
  witnessRule?: WitnessRule;
  /** A device's own answer, in place of either SDK rule. */
  witnesses?: readonly string[];
  tx: Cardano.Tx;
}): Promise<ForeignSignatureRequirement | undefined> => {
  const addresses = knownAddresses ?? [fx.own.knownAddress];
  // OWN_INPUT belongs to this account's address 0, as the local UTxO set below
  // says — so every case starts from "inputs are ours" and refuses, when it
  // refuses, for the reason the case is about. An input absent from this map
  // (a script input) has no own key path.
  const txInKeyPathMap = tx.body.inputs.some(
    input => input.txId === OWN_INPUT.txId && input.index === OWN_INPUT.index,
  )
    ? { [TxInId(OWN_INPUT)]: { index: 0, role: KeyRole.External } }
    : {};
  const pathInputs = {
    dRepKeyHash: fx.own.dRepKeyHash,
    knownAddresses: addresses,
    txBody: tx.body,
    txInKeyPathMap,
  };
  const witnessKeyHashes = new Set(
    witnesses ??
      (await deriveKeyHashes(
        fx.own.account,
        witnessRule === 'body-keys'
          ? KeyManagementUtil.ownSignatureKeyPaths(
              tx.body,
              [...addresses],
              txInKeyPathMap,
              fx.own.dRepKeyHash,
            )
          : bodyAndScriptWitnessPaths({
              ...pathInputs,
              scripts: tx.witness.scripts,
            }),
      )),
  );
  const verdict = await findForeignSignatureRequirement({
    dRepKeyHash: fx.own.dRepKeyHash,
    knownAddresses: addresses,
    resolveInput,
    tx,
    witnessKeyHashes,
    utxoSet: [
      [
        { ...OWN_INPUT, address: fx.own.knownAddress.address },
        {
          address: fx.own.knownAddress.address,
          value: { coins: 10_000_000n },
        },
      ],
    ],
  });
  reached.add(verdict);
  return verdict;
};

beforeAll(async () => {
  Object.assign(fx, await buildFixtures());
});

describe('findForeignSignatureRequirement — inputs and native scripts', () => {
  it('(1) refuses an input outside the wallet UTxO set when no script could exempt it', async () => {
    expect(
      await check({
        tx: txWith({ inputs: [{ index: 7, txId: UNKNOWN_TX_ID }] }),
      }),
    ).toBe('foreign-input');
  });

  it('(1b) does not consult the resolver when no owned script hash exists to match against', async () => {
    const resolveInput = vi.fn(async () => fx.ownScriptAddress);
    await check({
      resolveInput,
      tx: txWith({ inputs: [{ index: 7, txId: UNKNOWN_TX_ID }] }),
    });
    expect(resolveInput).toHaveBeenCalledTimes(0);
  });

  it('(2) accepts an unknown input that spends a script this account satisfies alone', async () => {
    expect(
      await check({
        resolveInput: async () => fx.ownScriptAddress,
        tx: txWith({ inputs: [{ index: 7, txId: UNKNOWN_TX_ID }] }, [
          fx.ownKeyScript,
        ]),
      }),
    ).toBeUndefined();
  });

  it('(3) refuses the same unknown input when it resolves to an unrelated address', async () => {
    expect(
      await check({
        resolveInput: async () =>
          Cardano.Address.fromBech32(String(fx.foreign.knownAddress.address)),
        tx: txWith({ inputs: [{ index: 7, txId: UNKNOWN_TX_ID }] }, [
          fx.ownKeyScript,
        ]),
      }),
    ).toBe('foreign-input');
  });

  it('(4) refuses an unknown input the resolver cannot resolve — the gate fails closed', async () => {
    expect(
      await check({
        resolveInput: async () => undefined,
        tx: txWith({ inputs: [{ index: 7, txId: UNKNOWN_TX_ID }] }, [
          fx.ownKeyScript,
        ]),
      }),
    ).toBe('foreign-input');
  });

  it('(5) refuses 31 unknown inputs WITHOUT calling the resolver even once', async () => {
    const resolveInput = vi.fn(async () => fx.ownScriptAddress);
    const inputs = Array.from({ length: 31 }, (_, index) => ({
      index,
      txId: UNKNOWN_TX_ID,
    }));
    expect(
      await check({
        resolveInput,
        tx: txWith({ inputs }, [fx.ownKeyScript]),
      }),
    ).toBe('foreign-input');
    // The cap exists so a hostile transaction cannot drive provider traffic
    // before the user is even prompted: past it, nothing is fetched at all.
    expect(resolveInput).toHaveBeenCalledTimes(0);
  });

  it('(5b) still resolves at exactly 30 unknown inputs, so the cap is a boundary and not a blanket refusal', async () => {
    const resolveInput = vi.fn(async () => fx.ownScriptAddress);
    const inputs = Array.from({ length: 30 }, (_, index) => ({
      index,
      txId: UNKNOWN_TX_ID,
    }));
    expect(
      await check({ resolveInput, tx: txWith({ inputs }, [fx.ownKeyScript]) }),
    ).toBeUndefined();
    expect(resolveInput).toHaveBeenCalledTimes(30);
  });

  it('(6) refuses a witness script requiring a key this account does not hold', async () => {
    expect(await check({ tx: txWith({}, [fx.foreignKeyScript]) })).toBe(
      'unsatisfiable-script',
    );
  });

  it('(7) refuses an own key only a script requires when the signer witnesses body keys only (Ledger)', async () => {
    const ownStakeKeyScript = requireSignature(
      fx.own.stakeKeyHash as unknown as Crypto.Ed25519KeyHashHex,
    );
    expect(
      await check({
        tx: txWith({}, [ownStakeKeyScript]),
        witnessRule: 'body-keys',
      }),
    ).toBe('unsatisfiable-script');
  });

  it('(7d) accepts an own-key script on Ledger when the body already requires that key through an own input', async () => {
    expect(
      await check({
        tx: txWith({}, [fx.ownKeyScript]),
        witnessRule: 'body-keys',
      }),
    ).toBeUndefined();
  });

  it('(7e) accepts on Ledger an any-of script one branch of which the body key already meets', async () => {
    const eitherOwnKey: Cardano.NativeScript = {
      __type: Cardano.ScriptType.Native,
      kind: Cardano.NativeScriptKind.RequireAnyOf,
      scripts: [
        fx.ownKeyScript,
        requireSignature(
          fx.own.stakeKeyHash as unknown as Crypto.Ed25519KeyHashHex,
        ),
      ],
    };
    expect(
      await check({
        tx: txWith({}, [eitherOwnKey]),
        witnessRule: 'body-keys',
      }),
    ).toBeUndefined();
  });

  it('(7f) exempts on Ledger a script input the own input already witnesses, after one resolver call', async () => {
    const resolveInput = vi.fn(async () => fx.ownScriptAddress);
    expect(
      await check({
        resolveInput,
        tx: txWith({ inputs: [OWN_INPUT, { index: 0, txId: UNKNOWN_TX_ID }] }, [
          fx.ownKeyScript,
        ]),
        witnessRule: 'body-keys',
      }),
    ).toBeUndefined();
    expect(resolveInput).toHaveBeenCalledTimes(1);
  });

  it('(7g) refuses on Ledger a transaction spending only script inputs, whose script key the body never asks for', async () => {
    expect(
      await check({
        resolveInput: async () => fx.ownScriptAddress,
        tx: txWith({ inputs: [{ index: 0, txId: UNKNOWN_TX_ID }] }, [
          fx.ownKeyScript,
        ]),
        witnessRule: 'body-keys',
      }),
    ).toBe('unsatisfiable-script');
  });

  it('(7h) accepts that same script-only spend on Ledger once an own required signer puts the key in the body', async () => {
    expect(
      await check({
        resolveInput: async () => fx.ownScriptAddress,
        tx: txWith(
          {
            inputs: [{ index: 0, txId: UNKNOWN_TX_ID }],
            requiredExtraSignatures: [
              fx.own.paymentKeyHash as unknown as Crypto.Ed25519KeyHashHex,
            ],
          },
          [fx.ownKeyScript],
        ),
        witnessRule: 'body-keys',
      }),
    ).toBeUndefined();
  });

  it('(7b) treats a COLLATERAL outside the UTxO set as an unknown input too', async () => {
    expect(
      await check({
        tx: txWith({ collaterals: [{ index: 3, txId: UNKNOWN_TX_ID }] }),
      }),
    ).toBe('foreign-input');
  });

  it('(7c) de-duplicates the unknown-input set, so one outpoint costs one resolver call', async () => {
    const resolveInput = vi.fn(async () => fx.ownScriptAddress);
    const sameOutpoint = { index: 4, txId: UNKNOWN_TX_ID };
    expect(
      await check({
        resolveInput,
        tx: txWith({ collaterals: [sameOutpoint], inputs: [sameOutpoint] }, [
          fx.ownKeyScript,
        ]),
      }),
    ).toBeUndefined();
    expect(resolveInput).toHaveBeenCalledTimes(1);
  });
});

/**
 * The script-kind recursion, which is where a mis-port would be silent: an
 * over-permissive kind signs a transaction the node then rejects, an
 * over-strict one refuses a transaction the wallet could have signed. Each
 * kind is probed in BOTH directions.
 */
describe('findForeignSignatureRequirement — native script satisfiability by kind', () => {
  const allOf = (...scripts: Cardano.NativeScript[]): Cardano.NativeScript => ({
    __type: Cardano.ScriptType.Native,
    kind: Cardano.NativeScriptKind.RequireAllOf,
    scripts,
  });

  it('RequireAllOf holds only when EVERY child does', async () => {
    expect(
      await check({ tx: txWith({}, [allOf(fx.ownKeyScript)]) }),
    ).toBeUndefined();
    expect(
      await check({
        tx: txWith({}, [allOf(fx.ownKeyScript, fx.foreignKeyScript)]),
      }),
    ).toBe('unsatisfiable-script');
  });

  it('RequireAnyOf holds when ONE child does', async () => {
    const anyOf = (...scripts: Cardano.NativeScript[]) =>
      ({
        __type: Cardano.ScriptType.Native,
        kind: Cardano.NativeScriptKind.RequireAnyOf,
        scripts,
      } as Cardano.NativeScript);
    expect(
      await check({
        tx: txWith({}, [anyOf(fx.foreignKeyScript, fx.ownKeyScript)]),
      }),
    ).toBeUndefined();
    expect(await check({ tx: txWith({}, [anyOf(fx.foreignKeyScript)]) })).toBe(
      'unsatisfiable-script',
    );
  });

  it('RequireNOf counts the satisfiable children against `required`', async () => {
    const nOf = (required: number, ...scripts: Cardano.NativeScript[]) =>
      ({
        __type: Cardano.ScriptType.Native,
        kind: Cardano.NativeScriptKind.RequireNOf,
        required,
        scripts,
      } as Cardano.NativeScript);
    expect(
      await check({
        tx: txWith({}, [nOf(1, fx.ownKeyScript, fx.foreignKeyScript)]),
      }),
    ).toBeUndefined();
    expect(
      await check({
        tx: txWith({}, [nOf(2, fx.ownKeyScript, fx.foreignKeyScript)]),
      }),
    ).toBe('unsatisfiable-script');
  });

  const timeBefore = (slot: number): Cardano.NativeScript => ({
    __type: Cardano.ScriptType.Native,
    kind: Cardano.NativeScriptKind.RequireTimeBefore,
    slot: Cardano.Slot(slot),
  });
  const timeAfter = (slot: number): Cardano.NativeScript => ({
    __type: Cardano.ScriptType.Native,
    kind: Cardano.NativeScriptKind.RequireTimeAfter,
    slot: Cardano.Slot(slot),
  });
  const within = async (
    validityInterval: Cardano.ValidityInterval | undefined,
    script: Cardano.NativeScript,
  ) => check({ tx: txWith({ validityInterval }, [script]) });

  it('RequireTimeBefore holds only when the upper bound is at or before its slot', async () => {
    expect(
      await within({ invalidHereafter: Cardano.Slot(100) }, timeBefore(100)),
    ).toBeUndefined();
    expect(
      await within({ invalidHereafter: Cardano.Slot(101) }, timeBefore(100)),
    ).toBe('unsatisfiable-script');
    // No upper bound: the transaction may land after the slot.
    expect(await within(undefined, timeBefore(100))).toBe(
      'unsatisfiable-script',
    );
  });

  it('RequireTimeAfter holds only when the lower bound is at or after its slot', async () => {
    expect(
      await within({ invalidBefore: Cardano.Slot(100) }, timeAfter(100)),
    ).toBeUndefined();
    expect(
      await within({ invalidBefore: Cardano.Slot(99) }, timeAfter(100)),
    ).toBe('unsatisfiable-script');
    expect(await within(undefined, timeAfter(100))).toBe(
      'unsatisfiable-script',
    );
  });

  it('does not let a timelock the bounds cannot meet stand in for a foreign signature', async () => {
    const policy = (time: Cardano.NativeScript): Cardano.NativeScript => ({
      __type: Cardano.ScriptType.Native,
      kind: Cardano.NativeScriptKind.RequireAnyOf,
      scripts: [fx.foreignKeyScript, time],
    });
    const bounds = {
      invalidBefore: Cardano.Slot(200),
      invalidHereafter: Cardano.Slot(300),
    };
    expect(await within(bounds, policy(timeBefore(100)))).toBe(
      'unsatisfiable-script',
    );
    expect(await within(bounds, policy(timeBefore(400)))).toBeUndefined();
    expect(await within(bounds, policy(timeAfter(100)))).toBeUndefined();
  });

  it('fails a timelock closed at a slot the SDK cannot read exactly', async () => {
    const at2To53 = Serialization.Transaction.fromCore(
      txWith(
        { validityInterval: { invalidHereafter: Cardano.Slot(2 ** 53) } },
        [timeBefore(2 ** 53)],
      ),
    ).toCbor();
    // TTL 2^53 -> 2^53 + 1, past the script's slot; the SDK reads it back as 2^53.
    const lateCbor = at2To53.replace(
      '031b0020000000000000',
      '031b0020000000000001',
    );
    expect(lateCbor).not.toBe(at2To53);
    const late = Serialization.Transaction.fromCbor(
      Serialization.TxCBOR(lateCbor),
    ).toCore();
    expect(late.body.validityInterval?.invalidHereafter).toBe(2 ** 53);

    expect(await check({ tx: late })).toBe('unsatisfiable-script');
  });

  it('refuses a script with a slot the SDK cannot read exactly, although an own-key branch meets it', async () => {
    const policy = (time: Cardano.NativeScript): Cardano.NativeScript => ({
      __type: Cardano.ScriptType.Native,
      kind: Cardano.NativeScriptKind.RequireAnyOf,
      scripts: [fx.ownKeyScript, time],
    });
    const exact = Serialization.Transaction.fromCore(
      txWith({}, [policy(timeBefore(2 ** 53))]),
    ).toCbor();
    // TimeBefore(2^53) -> TimeBefore(2^53 + 1): the SDK reads it back rounded,
    // so the hash it computes names another script.
    const inexactCbor = exact.replace(
      '82051b0020000000000000',
      '82051b0020000000000001',
    );
    expect(inexactCbor).not.toBe(exact);
    const inexact = Serialization.Transaction.fromCbor(
      Serialization.TxCBOR(inexactCbor),
    ).toCore();

    expect(
      await check({ tx: txWith({}, [policy(timeBefore(100))]) }),
    ).toBeUndefined();
    expect(await check({ tx: inexact })).toBe('unsatisfiable-script');
  });

  it('RequireGuard holds for an own KEY credential and never for a script one', async () => {
    const guard = (credential: Cardano.Credential): Cardano.NativeScript =>
      ({
        __type: Cardano.ScriptType.Native,
        credential,
        kind: Cardano.NativeScriptKind.RequireGuard,
      } as Cardano.NativeScript);
    expect(
      await check({
        tx: txWith({}, [
          guard({
            hash: fx.own.paymentKeyHash,
            type: Cardano.CredentialType.KeyHash,
          }),
        ]),
      }),
    ).toBeUndefined();
    // A guard over a non-key credential can never be met by key witnesses.
    expect(
      await check({
        tx: txWith({}, [
          guard({
            hash: fx.own.paymentKeyHash,
            type: Cardano.CredentialType.ScriptHash,
          }),
        ]),
      }),
    ).toBe('unsatisfiable-script');
  });

  it('refuses a native script of an unrecognised kind rather than passing it', async () => {
    // Body keys: the SDK's own script walk cannot read the kind either, and no
    // CBOR transaction can carry one.
    expect(
      await check({
        witnessRule: 'body-keys',
        tx: txWith({}, [
          {
            __type: Cardano.ScriptType.Native,
            kind: 99,
          } as unknown as Cardano.NativeScript,
        ]),
      }),
    ).toBe('unsatisfiable-script');
  });
});

describe('findForeignSignatureRequirement — required extra signers', () => {
  it('(8) refuses a required signer that is not a key this account holds', async () => {
    expect(
      await check({
        tx: txWith({
          requiredExtraSignatures: [
            fx.foreign.paymentKeyHash as unknown as Crypto.Ed25519KeyHashHex,
          ],
        }),
      }),
    ).toBe('foreign-required-signer');
  });

  it('(9a) accepts a required signer that is this account own payment key hash', async () => {
    expect(
      await check({
        tx: txWith({
          requiredExtraSignatures: [
            fx.own.paymentKeyHash as unknown as Crypto.Ed25519KeyHashHex,
          ],
        }),
      }),
    ).toBeUndefined();
  });

  it('(9a) accepts a required signer that is this account own stake key hash', async () => {
    expect(
      await check({
        tx: txWith({
          requiredExtraSignatures: [
            fx.own.stakeKeyHash as unknown as Crypto.Ed25519KeyHashHex,
          ],
        }),
      }),
    ).toBeUndefined();
  });

  it('(9b) accepts this account own DRep key hash as required signer WHEN the same tx carries its own DRep certificate', async () => {
    const tx = txWith({
      certificates: [
        {
          __typename: Cardano.CertificateType.UpdateDelegateRepresentative,
          anchor: null,
          dRepCredential: {
            hash: fx.own.dRepKeyHash,
            type: Cardano.CredentialType.KeyHash,
          },
        },
      ],
      requiredExtraSignatures: [fx.own.dRepKeyHash],
    });
    expect(await check({ tx })).toBeUndefined();
    // The reason it is accepted, stated as the SDK states it: this is the only
    // shape for which the generic request set carries role 3 / index 0, which
    // is what makes the DRep witness one a signer will actually produce.
    const requested: AccountKeyDerivationPath[] =
      KeyManagementUtil.ownSignatureKeyPaths(
        tx.body,
        [fx.own.knownAddress],
        {},
        fx.own.dRepKeyHash,
        undefined,
      );
    expect(requested).toContainEqual({ index: 0, role: KeyRole.DRep });
  });

  it('(9c) refuses this account own DRep key hash as required signer when nothing else asks for a DRep witness', async () => {
    const tx = txWith({ requiredExtraSignatures: [fx.own.dRepKeyHash] });
    expect(await check({ tx })).toBe('unsupported-required-signer');
    // The same statement from the other side: no role-3 path is requested, so
    // accepting would sign after consent and still be incomplete.
    expect(
      KeyManagementUtil.ownSignatureKeyPaths(
        tx.body,
        [fx.own.knownAddress],
        {},
        fx.own.dRepKeyHash,
        undefined,
      ),
    ).not.toContainEqual({ index: 0, role: KeyRole.DRep });
  });
});

describe('findForeignSignatureRequirement — withdrawals', () => {
  it('(10) refuses a withdrawal from a reward account this account does not hold', async () => {
    expect(
      await check({
        tx: txWith({
          withdrawals: [
            {
              quantity: 5_000_000n,
              stakeAddress: fx.foreign.knownAddress.rewardAccount,
            },
          ],
        }),
      }),
    ).toBe('foreign-withdrawal');
  });

  it('(11) accepts a withdrawal from this account own reward account', async () => {
    expect(
      await check({
        tx: txWith({
          withdrawals: [
            {
              quantity: 5_000_000n,
              stakeAddress: fx.own.knownAddress.rewardAccount,
            },
          ],
        }),
      }),
    ).toBeUndefined();
  });

  it('(11b) accepts a withdrawal from a reward account controlled by an own native script', async () => {
    expect(
      await check({
        tx: txWith(
          {
            withdrawals: [
              { quantity: 5_000_000n, stakeAddress: fx.ownScriptRewardAccount },
            ],
          },
          [fx.ownKeyScript],
        ),
      }),
    ).toBeUndefined();
  });

  it('(11d) refuses a withdrawal from an own reward account whose stake key this wallet cannot derive', async () => {
    // The SDK's rule, not an extra one: an address carrying no
    // `stakeKeyDerivationPath` has no path to request, so claiming the
    // withdrawal would promise a witness nothing can produce.
    expect(
      await check({
        knownAddresses: [
          { ...fx.own.knownAddress, stakeKeyDerivationPath: undefined },
        ],
        tx: txWith({
          withdrawals: [
            {
              quantity: 5_000_000n,
              stakeAddress: fx.own.knownAddress.rewardAccount,
            },
          ],
        }),
      }),
    ).toBe('foreign-withdrawal');
  });

  it('(11e) refuses a withdrawal whose stake address does not parse, instead of throwing', async () => {
    expect(
      await check({
        tx: txWith({
          withdrawals: [
            {
              quantity: 1n,
              stakeAddress: 'not-an-address' as Cardano.RewardAccount,
            },
          ],
        }),
      }),
    ).toBe('foreign-withdrawal');
  });

  it('(11c) refuses a script-controlled withdrawal whose script the request does not carry', async () => {
    // Whether a device's signing mode accepts a script withdrawal at all is
    // the device adapter's answer, not this gate's.
    expect(
      await check({
        tx: txWith({
          withdrawals: [
            { quantity: 5_000_000n, stakeAddress: fx.ownScriptRewardAccount },
          ],
        }),
      }),
    ).toBe('foreign-withdrawal');
  });
});

describe('findForeignSignatureRequirement — certificates and votes', () => {
  it('(12) refuses a stake-credential certificate for a credential this account does not hold', async () => {
    expect(
      await check({
        tx: txWith({
          certificates: [
            {
              __typename: Cardano.CertificateType.StakeDelegation,
              poolId: Cardano.PoolId.fromKeyHash(
                fx.foreign.stakeKeyHash as unknown as Crypto.Ed25519KeyHashHex,
              ),
              stakeCredential: {
                hash: fx.foreign.stakeKeyHash,
                type: Cardano.CredentialType.KeyHash,
              },
            },
          ],
        }),
      }),
    ).toBe('foreign-stake-credential');
  });

  it('(12b) de-duplicates known addresses by reward account, so a second address for the same stake key changes nothing', async () => {
    const certificates: Cardano.Certificate[] = [
      {
        __typename: Cardano.CertificateType.StakeDelegation,
        poolId: Cardano.PoolId.fromKeyHash(
          fx.own.stakeKeyHash as unknown as Crypto.Ed25519KeyHashHex,
        ),
        stakeCredential: {
          hash: fx.own.stakeKeyHash,
          type: Cardano.CredentialType.KeyHash,
        },
      },
    ];
    expect(
      await check({
        knownAddresses: [fx.own.knownAddress, fx.own.knownAddress],
        tx: txWith({ certificates }),
      }),
    ).toBeUndefined();
  });

  it('(12c) drops a known address with no stake derivation path before the certificate check', async () => {
    // Same rule as (11d), one step later: the address cannot contribute a
    // stake signer, so its own delegation certificate is foreign.
    expect(
      await check({
        knownAddresses: [
          { ...fx.own.knownAddress, stakeKeyDerivationPath: undefined },
        ],
        tx: txWith({
          certificates: [
            {
              __typename: Cardano.CertificateType.StakeDelegation,
              poolId: Cardano.PoolId.fromKeyHash(
                fx.own.stakeKeyHash as unknown as Crypto.Ed25519KeyHashHex,
              ),
              stakeCredential: {
                hash: fx.own.stakeKeyHash,
                type: Cardano.CredentialType.KeyHash,
              },
            },
          ],
        }),
      }),
    ).toBe('foreign-stake-credential');
  });

  it('(13) refuses a DRep certificate for a credential that is not this account own DRep key', async () => {
    expect(
      await check({
        tx: txWith({
          certificates: [
            {
              __typename: Cardano.CertificateType.UpdateDelegateRepresentative,
              anchor: null,
              dRepCredential: {
                hash: fx.foreign.dRepKeyHash,
                type: Cardano.CredentialType.KeyHash,
              },
            },
          ],
        }),
      }),
    ).toBe('foreign-drep-credential');
  });

  it('(14) refuses a vote cast by a DRep that is not this account', async () => {
    expect(
      await check({
        tx: txWith({
          votingProcedures: [
            {
              voter: {
                __typename: Cardano.VoterType.dRepKeyHash,
                credential: {
                  hash: fx.foreign.dRepKeyHash,
                  type: Cardano.CredentialType.KeyHash,
                },
              },
              votes: [],
            },
          ],
        }),
      }),
    ).toBe('foreign-voter');
  });

  it('(15) refuses a committee certificate, whose keys this stack never derives', async () => {
    expect(
      await check({
        tx: txWith({
          certificates: [
            {
              __typename: Cardano.CertificateType.AuthorizeCommitteeHot,
              coldCredential: {
                hash: fx.foreign.stakeKeyHash,
                type: Cardano.CredentialType.KeyHash,
              },
              hotCredential: {
                hash: fx.foreign.paymentKeyHash,
                type: Cardano.CredentialType.KeyHash,
              },
            },
          ],
        }),
      }),
    ).toBe('committee-certificate');
  });

  it('(16) does NOT refuse this account own DRep certificate', async () => {
    expect(
      await check({
        tx: txWith({
          certificates: [
            {
              __typename: Cardano.CertificateType.UpdateDelegateRepresentative,
              anchor: null,
              dRepCredential: {
                hash: fx.own.dRepKeyHash,
                type: Cardano.CredentialType.KeyHash,
              },
            },
          ],
        }),
      }),
    ).toBeUndefined();
  });

  it('(16b) refuses that same own-DRep certificate when the gate is handed no DRep key hash', async () => {
    // Why the hash has to be threaded at all: the SDK reads a missing one
    // exactly like a foreign credential, so without it the account's OWN
    // governance transaction is refused before consent.
    const verdict = await findForeignSignatureRequirement({
      dRepKeyHash: undefined as unknown as Crypto.Ed25519KeyHashHex,
      knownAddresses: [fx.own.knownAddress],
      resolveInput: async () => undefined,
      tx: txWith({
        certificates: [
          {
            __typename: Cardano.CertificateType.UpdateDelegateRepresentative,
            anchor: null,
            dRepCredential: {
              hash: fx.own.dRepKeyHash,
              type: Cardano.CredentialType.KeyHash,
            },
          },
        ],
      }),
      witnessKeyHashes: new Set([fx.own.paymentKeyHash]),
      utxoSet: [
        [
          { ...OWN_INPUT, address: fx.own.knownAddress.address },
          { address: fx.own.knownAddress.address, value: { coins: 10n } },
        ],
      ],
    });
    expect(verdict).toBe('foreign-drep-credential');
  });

  it('(17) does NOT refuse a vote cast by this account own DRep credential', async () => {
    // The VOTE half of own-governance handling, paired with case (16)'s
    // certificate half: `getVotingProcedureKeyPaths` is a SEPARATE hand-off of
    // the DRep hash, so dropping it there would refuse the account's own vote
    // pre-consent with nothing to catch it.
    //
    // The vote carries a real action id: the gate is a pure function over
    // `Cardano.Tx` and would answer the same for an empty list, but an empty
    // one is a transaction the CBOR encoder refuses, so pinning it would pin a
    // shape that can never reach a device.
    const tx = txWith({
      votingProcedures: [
        {
          voter: {
            __typename: Cardano.VoterType.dRepKeyHash,
            credential: {
              hash: fx.own.dRepKeyHash,
              type: Cardano.CredentialType.KeyHash,
            },
          },
          votes: [
            {
              actionId: { actionIndex: 0, id: UNKNOWN_TX_ID },
              votingProcedure: { anchor: null, vote: Cardano.Vote.yes },
            },
          ],
        },
      ],
    });
    expect(() => Serialization.Transaction.fromCore(tx).toCbor()).not.toThrow();

    expect(await check({ tx })).toBeUndefined();
  });
});

describe('findForeignSignatureRequirement — own keys the device request does not name', () => {
  // A stake-pool vote under the account's stake key: the SDK counts the key as
  // own, but the Ledger request sends the voter as a hash, so the device never
  // witnesses it.
  const stakePoolVote = () =>
    txWith({
      votingProcedures: [
        {
          voter: {
            __typename: Cardano.VoterType.stakePoolKeyHash,
            credential: {
              hash: fx.own.stakeKeyHash,
              type: Cardano.CredentialType.KeyHash,
            },
          },
          votes: [
            {
              actionId: { actionIndex: 0, id: UNKNOWN_TX_ID },
              votingProcedure: { anchor: null, vote: Cardano.Vote.yes },
            },
          ],
        },
      ],
    });

  it('(18) refuses an own-key obligation missing from the witness set the device answered with', async () => {
    expect(
      await check({
        tx: stakePoolVote(),
        witnesses: [fx.own.paymentKeyHash],
      }),
    ).toBe('unwitnessed-own-key');
  });

  it('(19) refuses a pool registration whose operator key no signer of this account holds', async () => {
    // The SDK's certificate check looks at the owners only, and the own owner
    // passes it; the operator's cold key still has to witness.
    expect(
      await check({
        tx: txWith({
          certificates: [
            {
              __typename: Cardano.CertificateType.PoolRegistration,
              poolParameters: {
                cost: 340_000_000n,
                id: Cardano.PoolId.fromKeyHash(
                  'ab'.repeat(28) as Crypto.Ed25519KeyHashHex,
                ),
                margin: { denominator: 100, numerator: 1 },
                owners: [fx.own.knownAddress.rewardAccount],
                pledge: 1_000_000n,
                relays: [],
                rewardAccount: fx.own.knownAddress.rewardAccount,
                vrf: Cardano.VrfVkHex('cd'.repeat(32)),
              },
            },
          ],
        }),
      }),
    ).toBe('foreign-stake-credential');
  });

  it('(18b) accepts the same vote from a signer that witnesses the stake key', async () => {
    expect(
      await check({
        tx: stakePoolVote(),
        witnesses: [fx.own.paymentKeyHash, fx.own.stakeKeyHash],
      }),
    ).toBeUndefined();
  });
});

// Declared LAST on purpose: vitest runs a file's suites in declaration order,
// so by the time this runs `reached` holds every verdict the cases above
// produced — the coverage claim is measured, not just asserted.
describe('the enumerated verdict set', () => {
  it('is exactly 10 members, with nothing in the union the list omits', () => {
    // These two bindings only keep the compile-time checks above alive; the
    // check itself is `tsc`, which cannot produce `never[]` values otherwise.
    const unlisted: UnlistedMember[] = [];
    const listedNonMembers: ListedNonMember[] = [];
    expect([...unlisted, ...listedNonMembers]).toEqual([]);
    expect(ALL_REQUIREMENTS).toHaveLength(10);
    expect(new Set(ALL_REQUIREMENTS).size).toBe(10);
  });

  it('is fully probed: every member plus the undefined verdict was reached by a case above', () => {
    expect([...reached].sort()).toEqual([...ALL_REQUIREMENTS, undefined]);
  });
});
