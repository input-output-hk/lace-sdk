import { Cardano, Serialization } from '@lace-lib/cardano-core';
import { describe, expect, it } from 'vitest';

import {
  getUniqueSignerKeyHashes,
  getUniqueSubTransactionSignerKeyHashes,
} from '../src/getUniqueSigners';

import type * as Crypto from '@lace-lib/cardano-crypto';

const basePaymentKeyStakeScript =
  'addr1yx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzerkr0vd4msrxnuwnccdxlhdjar77j6lg0wypcc9uar5d2shs2z78ve';
const basePaymentScriptStakeScript =
  'addr1x8phkx6acpnf78fuvxn0mkew3l0fd058hzquvz7w36x4gt7r0vd4msrxnuwnccdxlhdjar77j6lg0wypcc9uar5d2shskhj42g';
const testnetPointerKey =
  'addr_test1gz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer5pnz75xxcrdw5vky';
const testnetRewardKey =
  'stake_test1uqehkck0lajq8gr28t9uxnuvgcqrc6070x3k9r8048z8y5gssrtvn';
const testnetRewardScript =
  'stake_test17rphkx6acpnf78fuvxn0mkew3l0fd058hzquvz7w36x4gtcljw6kf';
const testnetOtherRewardKey =
  'stake_test1up7pvfq8zn4quy45r2g572290p9vf99mr9tn7r9xrgy2l2qdsf58d';
const poolId = 'pool1ev8vy6fyj7693ergzty2t0azjvw35tvkt2vcjwpgajqs7z6u2vn';
const poolOperatorKeyHash =
  'cb0ec2692497b458e46812c8a5bfa2931d1a2d965a99893828ec810f';
const ownerKeyHash = '337b62cfff6403a06a3acbc34f8c46003c69fe79a3628cefa9c47251';
const otherOwnerKeyHash =
  '7c16240714ea0e12b41a914f2945784ac494bb19573f0ca61a08afa8';

const nativeKeyHash =
  'e3c1b4a7d9a2f0f1e2d3c4b5a69788796a5b4c3d2e1f0a1b2c3d4e5f';
const otherNativeKeyHash =
  'f1e2d3c4b5a69788796a5b4c3d2e1f0a1b2c3d4e5fe3c1b4a7d9a2f0';

const requireSignature = (keyHash: string): Cardano.NativeScript => ({
  __type: Cardano.ScriptType.Native,
  kind: Cardano.NativeScriptKind.RequireSignature,
  keyHash: keyHash as Crypto.Ed25519KeyHashHex,
});

const scriptHashOf = (script: Cardano.Script) =>
  Serialization.Script.fromCore(script).hash();

const mintedBy = (script: Cardano.Script) =>
  Cardano.AssetId.fromParts(
    Cardano.PolicyId(scriptHashOf(script)),
    Cardano.AssetName(''),
  );

const scriptAddress = (script: Cardano.Script) =>
  Cardano.EnterpriseAddress.fromCredentials(Cardano.NetworkId.Testnet, {
    hash: scriptHashOf(script),
    type: Cardano.CredentialType.ScriptHash,
  })
    .toAddress()
    .toBech32();

const keyCred = (hash: string) => ({
  type: Cardano.CredentialType.KeyHash,
  hash: hash as Crypto.Hash32ByteBase16,
});
const scriptCred = (hash: string) => ({
  type: Cardano.CredentialType.ScriptHash,
  hash: hash as Crypto.Hash32ByteBase16,
});

const txIn = (txId: string, index: number): Cardano.TxIn => ({
  txId: txId as Cardano.TransactionId,
  index,
});
const utxo = (
  index: Cardano.TxIn,
  address: string,
  coins: bigint = 0n,
): Cardano.Utxo => [
  { ...index, address: address as Cardano.PaymentAddress },
  { address: address as Cardano.PaymentAddress, value: { coins } },
];

describe('getUniqueSignerKeyHashes', () => {
  it('includes required extra signatures and dedupes them', () => {
    const tx = {
      body: {
        inputs: [],
        requiredExtraSignatures: [
          'aa',
          'bb',
          'aa',
        ] as Crypto.Hash32ByteBase16[],
      },
      witness: { scripts: [] as unknown[] },
    } as unknown as Cardano.Tx;

    const result = getUniqueSignerKeyHashes(tx, []);
    expect([...result].sort()).toEqual(['aa', 'bb']);
  });

  it('counts key hash guards as signers and leaves script hash guards out', () => {
    const tx = {
      body: {
        inputs: [],
        guards: [keyCred('aa'), scriptCred('bb'), keyCred('cc')],
      },
      witness: { scripts: [] as unknown[] },
    } as unknown as Cardano.Tx;

    const result = getUniqueSignerKeyHashes(tx, []);
    expect([...result].sort()).toEqual(['aa', 'cc']);
  });

  it('adds input signer key hashes for inputs and collaterals (found in resolvedInputs)', () => {
    const index0 = txIn('t1', 0);
    const index1 = txIn('t1', 1);
    const c0 = txIn('t9', 0);

    const tx = {
      body: {
        inputs: [index0, index1],
        collaterals: [c0],
      },
      witness: { scripts: [] as unknown[] },
    } as unknown as Cardano.Tx;

    const resolved: Cardano.Utxo[] = [
      utxo(index0, basePaymentKeyStakeScript, 10n),
      utxo(c0, testnetPointerKey, 5n),
    ];

    const result = getUniqueSignerKeyHashes(tx, resolved);
    expect(new Set(result)).toEqual(
      new Set(['9493315cd92eb5d8c4304e67b7e16ae36d61d34502694657811a2c8e']),
    );
  });

  it('paymentKeyHashFromAddress returns undefined for script credentials and reward addresses', () => {
    const t = {
      body: { inputs: [txIn('x', 0)] },
      witness: { scripts: [] },
    } as unknown as Cardano.Tx;

    const resolved: Cardano.Utxo[] = [
      utxo(txIn('x', 0), basePaymentScriptStakeScript, 1n),
    ];
    let result = getUniqueSignerKeyHashes(t, resolved);
    expect(result.size).toBe(0);

    const resolved2: Cardano.Utxo[] = [
      utxo(txIn('x', 0), testnetRewardKey, 1n),
    ];
    result = getUniqueSignerKeyHashes(t, resolved2);
    expect(result.size).toBe(0);
  });

  it('withdrawals: adds KeyHash from reward addresses', () => {
    const tx = {
      body: {
        inputs: [],
        withdrawals: [{ stakeAddress: testnetRewardKey }],
      },
      witness: { scripts: [] },
    } as unknown as Cardano.Tx;

    const result = getUniqueSignerKeyHashes(tx, []);
    expect(
      result.has('337b62cfff6403a06a3acbc34f8c46003c69fe79a3628cefa9c47251'),
    ).toBe(true);
  });

  it('withdrawals: ignores ScriptHash reward credentials', () => {
    const tx = {
      body: {
        inputs: [],
        withdrawals: [{ stakeAddress: testnetRewardScript }],
      },
      witness: { scripts: [] },
    } as unknown as Cardano.Tx;

    const result = getUniqueSignerKeyHashes(tx, []);
    expect(result.size).toBe(0);
  });

  it('certificates: stake-related kinds add stakeCredential (as implemented)', () => {
    const stakeKH = keyCred('stake-cred-kh');
    const includedKinds = [
      Cardano.CertificateType.VoteDelegation,
      Cardano.CertificateType.StakeVoteDelegation,
      Cardano.CertificateType.StakeRegistrationDelegation,
      Cardano.CertificateType.VoteRegistrationDelegation,
      Cardano.CertificateType.StakeVoteRegistrationDelegation,
      Cardano.CertificateType.Registration,
      Cardano.CertificateType.Unregistration,
      Cardano.CertificateType.StakeDeregistration,
      Cardano.CertificateType.StakeDelegation,
    ];

    const tx = {
      body: {
        inputs: [],
        certificates: includedKinds.map(__typename => ({
          __typename,
          stakeCredential: stakeKH,
        })),
      },
      witness: { scripts: [] },
    } as unknown as Cardano.Tx;

    const result = getUniqueSignerKeyHashes(tx, []);
    expect(result.has('stake-cred-kh')).toBe(true);
    expect(result.size).toBe(1);
  });

  it('certificates: dRep kinds add dRepCredential; ignored kinds do not add', () => {
    const drepKH = keyCred('drep-kh');

    const includedDRep = [
      Cardano.CertificateType.RegisterDelegateRepresentative,
      Cardano.CertificateType.UnregisterDelegateRepresentative,
      Cardano.CertificateType.UpdateDelegateRepresentative,
    ].map(__typename => ({ __typename, dRepCredential: drepKH }));

    const ignored = [
      Cardano.CertificateType.StakeRegistration,
      Cardano.CertificateType.MIR,
      Cardano.CertificateType.GenesisKeyDelegation,
    ].map(__typename => ({ __typename, stakeCredential: keyCred('ignored') }));

    const tx = {
      body: {
        inputs: [],
        certificates: [...includedDRep, ...ignored],
      },
      witness: { scripts: [] },
    } as unknown as Cardano.Tx;

    const result = getUniqueSignerKeyHashes(tx, []);
    expect(result.has('drep-kh')).toBe(true);
    expect(result.size).toBe(1);
  });

  it('certificates: committee kinds add a KeyHash coldCredential, not a ScriptHash one or the hot credential', () => {
    const tx = {
      body: {
        inputs: [],
        certificates: [
          {
            __typename: Cardano.CertificateType.AuthorizeCommitteeHot,
            coldCredential: keyCred('authorize-cold-kh'),
            hotCredential: keyCred('hot-kh'),
          },
          {
            __typename: Cardano.CertificateType.ResignCommitteeCold,
            coldCredential: keyCred('resign-cold-kh'),
            anchor: null,
          },
          {
            __typename: Cardano.CertificateType.ResignCommitteeCold,
            coldCredential: scriptCred('resign-cold-sh'),
            anchor: null,
          },
        ],
      },
      witness: { scripts: [] },
    } as unknown as Cardano.Tx;

    expect([...getUniqueSignerKeyHashes(tx, [])]).toEqual([
      'authorize-cold-kh',
      'resign-cold-kh',
    ]);
  });

  it('certificates: a pool registration adds the pool operator and every owner, a pool retirement the pool operator', () => {
    const tx = {
      body: {
        inputs: [],
        certificates: [
          {
            __typename: Cardano.CertificateType.PoolRegistration,
            poolParameters: {
              id: poolId,
              owners: [testnetRewardKey, testnetOtherRewardKey],
            },
          },
          {
            __typename: Cardano.CertificateType.PoolRetirement,
            poolId,
            epoch: 300,
          },
        ],
      },
      witness: { scripts: [] },
    } as unknown as Cardano.Tx;

    expect([...getUniqueSignerKeyHashes(tx, [])]).toEqual([
      poolOperatorKeyHash,
      ownerKeyHash,
      otherOwnerKeyHash,
    ]);
  });

  it('votingProcedures: adds voter.credential when KeyHash', () => {
    const tx = {
      body: {
        inputs: [],
        votingProcedures: [
          { voter: { credential: keyCred('voter-kh') } },
          { voter: { credential: scriptCred('voter-sh') } }, // ignored
        ],
      },
      witness: { scripts: [] },
    } as unknown as Cardano.Tx;

    const result = getUniqueSignerKeyHashes(tx, []);
    expect(result.has('voter-kh')).toBe(true);
    expect(result.size).toBe(1);
  });

  it('native scripts: while an input is unresolved, collects RequireSignature and recurses into all-of/any-of/n-of', () => {
    const scripts: Cardano.Script[] = [
      {
        __type: Cardano.ScriptType.Native,
        kind: Cardano.NativeScriptKind.RequireSignature,
        keyHash: 'ns1' as Crypto.Ed25519KeyHashHex,
      },
      {
        __type: Cardano.ScriptType.Native,
        kind: Cardano.NativeScriptKind.RequireAllOf,
        scripts: [
          {
            __type: Cardano.ScriptType.Native,
            kind: Cardano.NativeScriptKind.RequireSignature,
            keyHash: 'ns2' as Crypto.Ed25519KeyHashHex,
          },
          {
            __type: Cardano.ScriptType.Native,
            kind: Cardano.NativeScriptKind.RequireAnyOf,
            scripts: [
              {
                __type: Cardano.ScriptType.Native,
                kind: Cardano.NativeScriptKind.RequireSignature,
                keyHash: 'ns3' as Crypto.Ed25519KeyHashHex,
              },
              {
                __type: Cardano.ScriptType.Native,
                kind: Cardano.NativeScriptKind.RequireNOf,
                required: 1,
                scripts: [
                  {
                    __type: Cardano.ScriptType.Native,
                    kind: Cardano.NativeScriptKind.RequireSignature,
                    keyHash: 'ns4' as Crypto.Ed25519KeyHashHex,
                  },
                ],
              },
            ],
          },
          {
            __type: Cardano.ScriptType.Native,
            kind: Cardano.NativeScriptKind.RequireTimeAfter,
            slot: Cardano.Slot(123),
          },
        ],
      },
    ];

    const tx = {
      body: {
        inputs: [txIn('unresolved', 0)],
      },
      witness: { scripts },
    } as unknown as Cardano.Tx;

    const result = getUniqueSignerKeyHashes(tx, []);
    expect(new Set(result)).toEqual(new Set(['ns1', 'ns2', 'ns3', 'ns4']));
  });

  it('integration: combines everything and dedupes', () => {
    const required = ['aa', 'bb', 'aa'];

    const index0 = txIn('T', 0);
    const ic = txIn('T', 9);

    const stakeKH = keyCred('stake-x');
    const drepKH = keyCred('drep-y');

    const scripts = [
      requireSignature(nativeKeyHash),
      {
        __type: Cardano.ScriptType.Native,
        kind: Cardano.NativeScriptKind.RequireTimeBefore,
        slot: 999n,
      },
    ];

    const tx = {
      body: {
        inputs: [index0],
        collaterals: [ic],
        mint: new Map([[mintedBy(requireSignature(nativeKeyHash)), 1n]]),
        requiredExtraSignatures: required,
        withdrawals: [{ stakeAddress: testnetRewardKey }],
        certificates: [
          {
            __typename: Cardano.CertificateType.StakeDelegation,
            stakeCredential: stakeKH,
          },
          {
            __typename: Cardano.CertificateType.RegisterDelegateRepresentative,
            dRepCredential: drepKH,
          },
          {
            __typename: Cardano.CertificateType.PoolRetirement,
            poolId,
          },
        ],
      },
      witness: { scripts },
    } as unknown as Cardano.Tx;

    const resolved: Cardano.Utxo[] = [
      utxo(index0, basePaymentKeyStakeScript, 2n),
      utxo(ic, testnetPointerKey, 1n),
    ];

    const result = getUniqueSignerKeyHashes(tx, resolved);
    expect(new Set(result)).toEqual(
      new Set([
        'aa',
        'bb',
        '9493315cd92eb5d8c4304e67b7e16ae36d61d34502694657811a2c8e',
        '337b62cfff6403a06a3acbc34f8c46003c69fe79a3628cefa9c47251',
        'stake-x',
        'drep-y',
        poolOperatorKeyHash,
        nativeKeyHash,
      ]),
    );
  });

  describe('native scripts the body needs', () => {
    const script = requireSignature(nativeKeyHash);
    const otherScript = requireSignature(otherNativeKeyHash);
    const keyInput = txIn('k', 0);
    const scriptInput = txIn('sc', 0);

    const txSpending = (
      inputs: Cardano.TxIn[],
      scripts: Cardano.Script[],
      subTransactionScripts?: Cardano.Script[],
    ) =>
      ({
        body: {
          inputs,
          outputs: [],
          ...(subTransactionScripts && {
            subTransactions: [
              {
                body: { inputs: [], outputs: [] },
                witness: {
                  scripts: subTransactionScripts,
                  signatures: new Map(),
                },
              },
            ],
          }),
        },
        witness: { scripts, signatures: new Map() },
      } as unknown as Cardano.Tx);

    it('counts no script the body does not need', () => {
      expect([
        ...getUniqueSignerKeyHashes(txSpending([keyInput], [script]), [
          utxo(keyInput, basePaymentKeyStakeScript),
        ]),
      ]).toEqual(['9493315cd92eb5d8c4304e67b7e16ae36d61d34502694657811a2c8e']);
    });

    it('counts the script that locks a resolved input, and not another', () => {
      expect([
        ...getUniqueSignerKeyHashes(
          txSpending([scriptInput], [script, otherScript]),
          [utxo(scriptInput, scriptAddress(script))],
        ),
      ]).toEqual([nativeKeyHash]);
    });

    it('counts the script a sub transaction carries for a top level input it locks', () => {
      expect([
        ...getUniqueSignerKeyHashes(txSpending([scriptInput], [], [script]), [
          utxo(scriptInput, scriptAddress(script)),
        ]),
      ]).toEqual([nativeKeyHash]);
    });
  });

  it('handles undefined/empty fields gracefully (no throws)', () => {
    const tx = {
      body: {
        inputs: [],
      },
      witness: {},
    } as unknown as Cardano.Tx;

    const result = getUniqueSignerKeyHashes(tx, []);
    expect(result.size).toBe(0);
  });
});

describe('getUniqueSubTransactionSignerKeyHashes', () => {
  const paymentKeyHash =
    '9493315cd92eb5d8c4304e67b7e16ae36d61d34502694657811a2c8e';
  const stakeKeyHash =
    '337b62cfff6403a06a3acbc34f8c46003c69fe79a3628cefa9c47251';
  const spent = txIn('s1', 0);
  const scriptSpent = txIn('s2', 0);
  const resolved: Cardano.Utxo[] = [
    utxo(spent, basePaymentKeyStakeScript, 1n),
    utxo(scriptSpent, basePaymentScriptStakeScript, 1n),
  ];

  const subTransactionOf = (
    body: Partial<Cardano.SubTransactionBody>,
    scripts: Cardano.Script[] = [],
  ) =>
    ({
      body: { inputs: [], outputs: [], ...body },
      witness: { signatures: new Map(), scripts },
    } as unknown as Cardano.SubTransaction);

  it.each([
    {
      rule: 'an input that spends a key address needs its payment key',
      subTransaction: subTransactionOf({ inputs: [spent] }),
      signers: [paymentKeyHash],
    },
    {
      rule: 'an input that spends a script address needs no key',
      subTransaction: subTransactionOf({ inputs: [scriptSpent] }),
      signers: [],
    },
    {
      rule: 'a withdrawal from a key reward account needs its stake key',
      subTransaction: subTransactionOf({
        withdrawals: [
          {
            stakeAddress: testnetRewardKey as Cardano.RewardAccount,
            quantity: 1n,
          },
        ],
      }),
      signers: [stakeKeyHash],
    },
    {
      rule: 'a withdrawal from a script reward account needs no key',
      subTransaction: subTransactionOf({
        withdrawals: [
          {
            stakeAddress: testnetRewardScript as Cardano.RewardAccount,
            quantity: 1n,
          },
        ],
      }),
      signers: [],
    },
    {
      rule: 'a certificate needs the key of its stake credential',
      subTransaction: subTransactionOf({
        certificates: [
          {
            __typename: Cardano.CertificateType.StakeDelegation,
            stakeCredential: keyCred('stake-kh'),
          } as unknown as Cardano.Certificate,
        ],
      }),
      signers: ['stake-kh'],
    },
    {
      rule: 'a DRep certificate needs the key of its DRep credential',
      subTransaction: subTransactionOf({
        certificates: [
          {
            __typename: Cardano.CertificateType.RegisterDelegateRepresentative,
            dRepCredential: keyCred('drep-kh'),
          } as unknown as Cardano.Certificate,
        ],
      }),
      signers: ['drep-kh'],
    },
    {
      rule: 'a committee certificate needs the key of its cold credential',
      subTransaction: subTransactionOf({
        certificates: [
          {
            __typename: Cardano.CertificateType.AuthorizeCommitteeHot,
            coldCredential: keyCred('cold-kh'),
            hotCredential: keyCred('hot-kh'),
          } as unknown as Cardano.Certificate,
        ],
      }),
      signers: ['cold-kh'],
    },
    {
      rule: 'a pool registration needs the keys of its operator and owners',
      subTransaction: subTransactionOf({
        certificates: [
          {
            __typename: Cardano.CertificateType.PoolRegistration,
            poolParameters: { id: poolId, owners: [testnetRewardKey] },
          } as unknown as Cardano.Certificate,
        ],
      }),
      signers: [poolOperatorKeyHash, ownerKeyHash],
    },
    {
      rule: 'a pool retirement needs the key of its operator',
      subTransaction: subTransactionOf({
        certificates: [
          {
            __typename: Cardano.CertificateType.PoolRetirement,
            poolId,
          } as unknown as Cardano.Certificate,
        ],
      }),
      signers: [poolOperatorKeyHash],
    },
    {
      rule: 'a key hash voter needs its key',
      subTransaction: subTransactionOf({
        votingProcedures: [
          { voter: { credential: keyCred('voter-kh') } },
          { voter: { credential: scriptCred('voter-sh') } },
        ] as unknown as Cardano.VotingProcedures,
      }),
      signers: ['voter-kh'],
    },
    {
      rule: 'a key hash guard needs its key and a script hash guard none',
      subTransaction: subTransactionOf({
        guards: [keyCred('guard-kh'), scriptCred('guard-sh')],
      } as unknown as Partial<Cardano.SubTransactionBody>),
      signers: ['guard-kh'],
    },
    {
      rule: 'a required signer needs its key',
      subTransaction: subTransactionOf({
        requiredExtraSignatures: ['signer-kh' as Crypto.Ed25519KeyHashHex],
      }),
      signers: ['signer-kh'],
    },
    {
      rule: 'a native script in its witness set needs the keys it requires, of signatures and key hash guards, while an input is unresolved',
      subTransaction: subTransactionOf({ inputs: [txIn('unknown', 0)] }, [
        {
          __type: Cardano.ScriptType.Native,
          kind: Cardano.NativeScriptKind.RequireAnyOf,
          scripts: [
            {
              __type: Cardano.ScriptType.Native,
              kind: Cardano.NativeScriptKind.RequireSignature,
              keyHash: 'native-kh' as Crypto.Ed25519KeyHashHex,
            },
            {
              __type: Cardano.ScriptType.Native,
              kind: Cardano.NativeScriptKind.RequireGuard,
              credential: keyCred('native-guard-kh'),
            },
          ],
        } as unknown as Cardano.Script,
      ]),
      signers: ['native-kh', 'native-guard-kh'],
    },
    {
      rule: 'a direct deposit needs no key',
      subTransaction: subTransactionOf({
        directDeposits: [
          {
            stakeAddress: testnetRewardKey as Cardano.RewardAccount,
            quantity: 1n,
          },
        ],
      }),
      signers: [],
    },
    {
      rule: 'an account balance interval needs no key',
      subTransaction: subTransactionOf({
        accountBalanceIntervals: [
          {
            rewardAccount: testnetRewardKey as Cardano.RewardAccount,
            interval: { exactBalance: 1n },
          },
        ],
      }),
      signers: [],
    },
    {
      rule: 'a guard required of the enclosing transaction needs no key in the sub transaction',
      subTransaction: subTransactionOf({
        requiredTopLevelGuards: [
          { credential: keyCred('top-level-kh'), datum: null },
        ],
      } as unknown as Partial<Cardano.SubTransactionBody>),
      signers: [],
    },
  ])('$rule', ({ subTransaction, signers }) => {
    expect([
      ...getUniqueSubTransactionSignerKeyHashes(subTransaction, resolved),
    ]).toEqual(signers);
  });

  it('counts the native script that locks an input it spends, and not another', () => {
    const script = requireSignature(nativeKeyHash);
    const scriptInput = txIn('sc', 0);

    expect([
      ...getUniqueSubTransactionSignerKeyHashes(
        subTransactionOf({ inputs: [scriptInput] }, [
          script,
          requireSignature(otherNativeKeyHash),
        ]),
        [utxo(scriptInput, scriptAddress(script))],
      ),
    ]).toEqual([nativeKeyHash]);
  });

  it('skips an input it cannot resolve', () => {
    expect(
      getUniqueSubTransactionSignerKeyHashes(
        subTransactionOf({ inputs: [txIn('unknown', 0)] }),
        resolved,
      ).size,
    ).toBe(0);
  });

  it('combines every part of the body and dedupes', () => {
    const result = getUniqueSubTransactionSignerKeyHashes(
      subTransactionOf({
        inputs: [spent, scriptSpent],
        requiredExtraSignatures: [
          paymentKeyHash as Crypto.Ed25519KeyHashHex,
          'signer-kh' as Crypto.Ed25519KeyHashHex,
        ],
        withdrawals: [
          {
            stakeAddress: testnetRewardKey as Cardano.RewardAccount,
            quantity: 1n,
          },
        ],
      }),
      resolved,
    );

    expect(new Set(result)).toEqual(
      new Set([paymentKeyHash, 'signer-kh', stakeKeyHash]),
    );
  });
});
