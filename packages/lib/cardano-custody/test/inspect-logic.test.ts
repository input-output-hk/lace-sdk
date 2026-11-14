import { Cardano, Serialization } from '@lace-lib/cardano-core';
import { Hash28ByteBase16 } from '@lace-lib/cardano-crypto';
import { describe, expect, it } from 'vitest';

import {
  addCustodyDevice,
  CURRENT_CUSTODY_CONTRACT_VERSION,
  removeCustodyDevice,
  revokeCustodyGrant,
} from '../src';
import { diffCustodyStates } from '../src/analysis/state-change';

import {
  account,
  buildTransaction,
  CONTRACT_ADDRESS,
  CONTRACT_DATA,
  CONTRACT_HASH,
  CONTRACT_SCRIPT,
  CONTRACT_TOKEN,
  contractCall,
  contractOrder,
  contractPin,
  contractScriptCarrier,
  controlOutput,
  COST_MODELS,
  creation,
  device,
  deviceRewrite,
  embedded,
  fund,
  fundOutput,
  grantIssue,
  grantSpend,
  grantSweep,
  identity,
  LOGIC,
  LOGIC_REWARD_ACCOUNT,
  logicRun,
  ownerContractCall,
  PARKED_LOGIC,
  PARKED_PROXY,
  PARKED_SCRIPTS,
  payout,
  POOL_ID,
  SPONSOR_ADDRESS,
  sponsorFee,
  STAKE_CREDENTIAL,
  STRANGER_ADDRESS,
  UNKNOWN_LOGIC,
  utxo,
} from './custody-transactions';
import {
  fixtureGrants,
  grantedState,
  initialState,
  LOGIC_HASH,
  OTHER_DEVICE_KEY,
  TOKEN_NAME,
  TOKEN_POLICY,
} from './fixtures';
import {
  accepted,
  grantOf,
  inspect,
  inspectBuilt,
  onlyAccount,
  reasonsOf,
  REFERENCE_SCRIPT,
  refusalsOf,
  transition,
} from './inspect-helpers';

import type {
  CardanoContractPin,
  CustodyAccountState,
  CustodyContractDatum,
  CustodyContractLocation,
} from '../src';
import type { TransactionShape } from './custody-transactions';
import type { CustodyInspectionOptions } from '../src/analysis/inspect';

const GRANT_SPEND = {
  allowGrantSpend: true,
  deviceKeyHash: undefined,
} as const satisfies Partial<CustodyInspectionOptions>;

const [lovelaceGrant] = fixtureGrants;
const TOKEN = Cardano.AssetId(`${TOKEN_POLICY}${TOKEN_NAME}`);

const scriptCredential = (hash: string): Cardano.Credential => ({
  type: Cardano.CredentialType.ScriptHash,
  hash: Hash28ByteBase16(hash),
});

/** The withdrawal that would run the unreviewed logic. */
const unknownLogicRun = (quantity = 0n): Cardano.Withdrawal => ({
  stakeAddress: Cardano.RewardAccount.fromCredential(
    scriptCredential(UNKNOWN_LOGIC),
    Cardano.NetworkId.Testnet,
  ),
  quantity,
});

const control = utxo(0x10, controlOutput(grantedState));
const funds = utxo(0x11, fundOutput(10_000_000n));

const delegation: Cardano.Certificate = {
  __typename: Cardano.CertificateType.StakeDelegation,
  stakeCredential: STAKE_CREDENTIAL,
  poolId: POOL_ID,
};

/** A sponsored owner spend of 3 tADA to the stranger from a 10 tADA fund UTxO. */
const ownerSpend = (): TransactionShape => ({
  ...deviceRewrite(grantedState, grantedState),
  inputs: [control, funds, sponsorFee],
  spendRedeemers: [device(control), fund(funds)],
  outputs: [
    controlOutput(grantedState),
    payout(3_000_000n),
    fundOutput(7_000_000n),
    payout(4_800_000n, SPONSOR_ADDRESS),
  ],
});

const FEE = 200_000n;

/**
 * An owner operation the account pays for alone: the control UTxO pays the
 * fee and the sponsor lends only its collateral. `controlLovelace` is what
 * the control output keeps.
 */
const accountPaid = (
  controlLovelace: bigint,
  changes: Partial<TransactionShape> = {},
): TransactionShape => ({
  ...deviceRewrite(grantedState, grantedState),
  inputs: [control],
  outputs: [controlOutput(grantedState, controlLovelace)],
  fee: FEE,
  ...changes,
});

const DRAW = 500_000n;

/** The transaction CBOR with one byte sequence of its body replaced. */
const patchedBody = (
  shape: TransactionShape,
  from: string,
  to: string,
): ReturnType<typeof buildTransaction> => {
  const built = buildTransaction(shape);
  const cbor = built.transaction.toCbor();
  expect(cbor.split(from)).toHaveLength(2);
  return {
    ...built,
    transaction: Serialization.Transaction.fromCbor(
      Serialization.TxCBOR(cbor.replace(from, to)),
    ),
  };
};

/** CBOR of the withdrawal map entry `rewardAccount: 0`. */
const zeroWithdrawalEntry = (rewardAccount: Cardano.RewardAccount): string =>
  `581d${Cardano.Address.fromBech32(rewardAccount).toBytes()}00`;

describe('inspectCustodyTransaction on revision 3', () => {
  describe('accepts what Lace builds', () => {
    const replacedState = { ...grantedState, revoked: [1n] };
    const operations: [
      string,
      () => TransactionShape,
      Partial<CustodyInspectionOptions>,
      unknown[],
    ][] = [
      ['a creation', () => creation(initialState), {}, [{ kind: 'create' }]],
      [
        'an added device',
        () =>
          deviceRewrite(
            initialState,
            transition(addCustodyDevice(initialState, OTHER_DEVICE_KEY, [])),
          ),
        {},
        [{ kind: 'add-device', device: OTHER_DEVICE_KEY }],
      ],
      [
        'a removed device',
        () => {
          const before = {
            ...grantedState,
            devices: [...grantedState.devices, OTHER_DEVICE_KEY],
          };
          return deviceRewrite(
            before,
            transition(removeCustodyDevice(before, OTHER_DEVICE_KEY)),
          );
        },
        {},
        [{ kind: 'remove-device', device: OTHER_DEVICE_KEY }],
      ],
      [
        'an issued grant',
        () => grantIssue(grantedState, [grantOf({ slot: 3n })]),
        {},
        [{ kind: 'issue-grant', slot: 3n }],
      ],
      [
        'a revoked grant',
        () =>
          deviceRewrite(
            grantedState,
            transition(revokeCustodyGrant(grantedState, 1n, fixtureGrants)),
          ),
        {},
        [{ kind: 'revoke-grant', slot: 1n }],
      ],
      [
        'a replaced grant',
        () =>
          grantIssue(grantedState, [grantOf({ slot: 3n })], {
            ...replacedState,
            nextSlot: 4n,
            outstanding: 4n,
          }),
        {},
        [{ kind: 'replace-grant', slot: 1n, issuedSlot: 3n }],
      ],
      [
        'a swept grant',
        () => grantSweep({ ...grantedState, revoked: [0n] }, [lovelaceGrant]),
        {},
        [{ kind: 'sweep-grants', slots: [0n] }],
      ],
      ['an owner spend', ownerSpend, {}, [{ kind: 'owner-spend' }]],
      [
        'a delegation',
        () => ({
          ...deviceRewrite(grantedState, grantedState),
          certificates: [delegation],
        }),
        {},
        [{ kind: 'delegate', poolId: POOL_ID }],
      ],
      [
        'a reward withdrawal beside the logic run',
        () => {
          const rewrite = deviceRewrite(grantedState, grantedState);
          return {
            ...rewrite,
            withdrawals: [
              { stakeAddress: identity.rewardAccount, quantity: 5_000_000n },
            ],
            outputs: [...rewrite.outputs, fundOutput(5_000_000n)],
          };
        },
        {},
        [{ kind: 'withdraw-rewards', quantity: 5_000_000n }],
      ],
      [
        'a grant spend',
        () => grantSpend(grantedState, lovelaceGrant),
        GRANT_SPEND,
        [{ kind: 'grant-spend', slot: 0n }],
      ],
    ];

    describe.each([
      [
        'with the proxy and the logic referenced',
        (shape: TransactionShape) => shape,
      ],
      ['with the proxy and the logic attached', embedded],
    ])('%s', (_, form) => {
      it.each(
        operations.map(([name, shapeOf, options, expected]) => ({
          name,
          shapeOf,
          options,
          expected,
        })),
      )('reads $name', ({ shapeOf, options, expected }) => {
        const report = onlyAccount(accepted(inspect(form(shapeOf()), options)));
        expect(report.operations).toEqual(expected);
        expect(report.logicDraw).toBeUndefined();
      });
    });

    it('keeps the logic run apart from the account reward withdrawal', () => {
      const report = onlyAccount(
        accepted(inspect(deviceRewrite(grantedState, grantedState))),
      );
      expect(report.withdrawal).toBeUndefined();
      expect(report.certificates).toEqual([]);
      expect(report.operations).toEqual([]);
    });

    it('reads a deposit, which runs no logic', () => {
      const inspection = accepted(
        inspect(
          {
            inputs: [sponsorFee],
            outputs: [
              fundOutput(3_000_000n),
              payout(1_800_000n, SPONSOR_ADDRESS),
            ],
          },
          { accountRecord: undefined },
        ),
      );
      expect(inspection.accounts).toEqual([]);
      expect(inspection.deposits).toMatchObject([
        { outputIndex: 0, ...account },
      ]);
    });

    it('accepts a reference input that carries no script', () => {
      const rewrite = deviceRewrite(grantedState, grantedState);
      expect(
        inspect({
          ...rewrite,
          referenceInputs: [
            ...PARKED_SCRIPTS,
            utxo(0x30, payout(1_000_000n, SPONSOR_ADDRESS)),
          ],
        }).ok,
      ).toBe(true);
    });
  });

  describe('runs the logic the control UTxO names', () => {
    it.each<
      [string, () => TransactionShape, Partial<CustodyInspectionOptions>]
    >([
      ['a creation', () => creation(initialState), {}],
      ['a device rewrite', () => deviceRewrite(grantedState, grantedState), {}],
      [
        'a grant spend',
        () => grantSpend(grantedState, lovelaceGrant),
        GRANT_SPEND,
      ],
    ])('refuses %s without the logic run', (_, shapeOf, options) => {
      expect(
        refusalsOf(inspect({ ...shapeOf(), logicRuns: [] }, options)),
      ).toEqual([
        {
          code: 'custody-unsupported-operation',
          reason: 'logic-withdrawal-missing',
          account,
          logic: LOGIC_HASH,
        },
      ]);
    });

    it('refuses a logic run from the reward account on another network', () => {
      expect(
        reasonsOf(
          inspect({
            ...deviceRewrite(grantedState, grantedState),
            logicRuns: [
              {
                stakeAddress: Cardano.RewardAccount.fromCredential(
                  scriptCredential(LOGIC.hash),
                  Cardano.NetworkId.Mainnet,
                ),
                quantity: 0n,
              },
            ],
          }),
        ),
      ).toEqual(['custody-context-mismatch/network-mismatch']);
    });

    it('refuses an attached logic that no withdrawal runs', () => {
      expect(
        reasonsOf(
          inspect(
            embedded({
              ...deviceRewrite(grantedState, grantedState),
              logicRuns: [],
            }),
          ),
        ),
      ).toEqual([
        'custody-context-mismatch/unused-logic',
        'custody-unsupported-operation/logic-withdrawal-missing',
      ]);
    });

    it('refuses a logic run over no control UTxO that names the logic', () => {
      expect(
        refusalsOf(
          inspect(
            {
              inputs: [sponsorFee],
              outputs: [fundOutput(3_000_000n)],
              logicRuns: [logicRun()],
            },
            { accountRecord: undefined },
          ),
        ),
      ).toEqual([
        {
          code: 'custody-context-mismatch',
          reason: 'unused-logic',
          logic: LOGIC.hash,
        },
      ]);
    });

    it('refuses the logic reward account withdrawn from twice', () => {
      const entry = zeroWithdrawalEntry(LOGIC_REWARD_ACCOUNT);
      expect(
        refusalsOf(
          inspectBuilt(
            patchedBody(
              deviceRewrite(grantedState, grantedState),
              `05a1${entry}`,
              `05a2${entry}${entry}`,
            ),
          ),
        ),
      ).toEqual([
        {
          code: 'custody-unsupported-operation',
          reason: 'duplicate-withdrawal',
          rewardAccount: LOGIC_REWARD_ACCOUNT,
        },
      ]);
    });

    it('refuses the account reward account withdrawn from twice, whatever the decoded body keeps', () => {
      const shape: TransactionShape = {
        ...deviceRewrite(grantedState, grantedState),
        withdrawals: [{ stakeAddress: identity.rewardAccount, quantity: 0n }],
      };
      const entries = [
        zeroWithdrawalEntry(identity.rewardAccount),
        zeroWithdrawalEntry(LOGIC_REWARD_ACCOUNT),
      ].sort();
      const repeated = zeroWithdrawalEntry(identity.rewardAccount).replace(
        /00$/,
        '1a004c4b40',
      );
      expect(
        reasonsOf(
          inspectBuilt(
            patchedBody(
              shape,
              `05a2${entries.join('')}`,
              `05a3${entries.join('')}${repeated}`,
            ),
          ),
        ),
      ).toEqual(['custody-unsupported-operation/duplicate-withdrawal']);
    });

    it('is never handed a body that repeats its withdrawal map, which the decoder refuses', () => {
      const shape = deviceRewrite(grantedState, grantedState);
      const built = buildTransaction(shape);
      const body = built.transaction.body().toCbor();
      const fields = Number.parseInt(body.slice(1, 2), 16);
      const repeated = `a${(fields + 1).toString(16)}${body.slice(
        2,
      )}05a1${zeroWithdrawalEntry(LOGIC_REWARD_ACCOUNT)}`;
      expect(() => patchedBody(shape, body, repeated)).toThrow(
        /Duplicate transaction body map key: 5/,
      );
    });
  });

  describe('accepts only the logics of the catalogue', () => {
    const unknownState: CustodyAccountState = {
      ...grantedState,
      logic: UNKNOWN_LOGIC,
    };

    it('refuses a control UTxO that names an unknown logic', () => {
      expect(
        refusalsOf(
          inspect({
            ...deviceRewrite(unknownState, unknownState),
            logicRuns: [unknownLogicRun()],
          }),
        ),
      ).toEqual([
        {
          code: 'custody-unsupported-version',
          reason: 'unknown-logic',
          account,
          logic: UNKNOWN_LOGIC,
        },
        {
          code: 'custody-unsupported-operation',
          reason: 'foreign-withdrawal',
          rewardAccount: unknownLogicRun().stakeAddress,
        },
      ]);
    });

    it('refuses a control UTxO that names an unknown logic beside a run of a known one', () => {
      expect(
        reasonsOf(inspect(deviceRewrite(unknownState, unknownState))),
      ).toEqual([
        'custody-context-mismatch/unused-logic',
        'custody-unsupported-version/unknown-logic',
        'custody-unsupported-operation/logic-withdrawal-missing',
      ]);
    });

    it('refuses a rewrite away from an unknown logic', () => {
      expect(
        reasonsOf(
          inspect({
            ...deviceRewrite(unknownState, grantedState),
            logicRuns: [unknownLogicRun(), logicRun()],
          }),
        ),
      ).toEqual([
        'custody-unsupported-version/unknown-logic',
        'custody-unsupported-operation/foreign-withdrawal',
        'custody-unsupported-operation/logic-changed',
      ]);
    });

    it('refuses a creation that names an unknown logic, which is no initial state Lace writes', () => {
      expect(
        reasonsOf(
          inspect(
            creation(
              { ...initialState, logic: UNKNOWN_LOGIC },
              { logicRuns: [unknownLogicRun()] },
            ),
          ),
        ),
      ).toEqual([
        'custody-unsupported-version/unknown-logic',
        'custody-unsupported-operation/foreign-withdrawal',
        'custody-context-mismatch/initial-state',
      ]);
    });

    it('refuses a grant spend against a referenced control UTxO that names an unknown logic', () => {
      expect(
        reasonsOf(
          inspect(
            {
              ...grantSpend(unknownState, lovelaceGrant),
              logicRuns: [unknownLogicRun()],
            },
            GRANT_SPEND,
          ),
        ),
      ).toEqual([
        'custody-unsupported-version/unknown-logic',
        'custody-unsupported-operation/foreign-withdrawal',
      ]);
    });

    it('refuses an upgrade to another logic, shaped like a revoke-all', () => {
      const after = {
        ...unknownState,
        grantGeneration: grantedState.grantGeneration + 1n,
        revoked: [],
      };
      const refusals = refusalsOf(
        inspect({
          ...deviceRewrite(grantedState, after),
          logicRuns: [logicRun(), unknownLogicRun()],
        }),
      );
      expect(refusals.map(({ reason }) => reason)).toEqual([
        'unknown-logic',
        'foreign-withdrawal',
        'logic-changed',
      ]);
      expect(refusals[2]).toEqual({
        code: 'custody-unsupported-operation',
        reason: 'logic-changed',
        account,
        before: LOGIC_HASH,
        after: UNKNOWN_LOGIC,
      });
    });

    it('reads a logic change between two control states', () => {
      expect(diffCustodyStates(grantedState, unknownState).logic).toEqual({
        before: LOGIC_HASH,
        after: UNKNOWN_LOGIC,
      });
      expect(
        diffCustodyStates(grantedState, grantedState).logic,
      ).toBeUndefined();
    });
  });

  describe('lets a logic run draw only into the account', () => {
    it('accepts a draw the control output keeps when the account pays its own fee', () => {
      const report = onlyAccount(
        accepted(
          inspect(
            accountPaid(2_000_000n - FEE + DRAW, {
              logicRuns: [logicRun(DRAW)],
            }),
          ),
        ),
      );
      expect(report.logicDraw).toBe(DRAW);
      expect(report.netOutflow.lovelace).toBe(FEE - DRAW);
      expect(report.operations).toEqual([]);
    });

    /**
     * A new account holds nothing before, and the bytes cannot tell the draw
     * from the lovelace the sponsor funds, so a creation keeps the draw when
     * its control output holds at least that much.
     */
    it('accepts a creation whose control output holds the draw', () => {
      const report = onlyAccount(
        accepted(
          inspect(
            creation(initialState, {
              outputs: [
                controlOutput(initialState, 2_100_000n + DRAW),
                payout(700_000n, SPONSOR_ADDRESS),
              ],
              logicRuns: [logicRun(DRAW)],
            }),
          ),
        ),
      );
      expect(report.logicDraw).toBe(DRAW);
      expect(report.operations).toEqual([{ kind: 'create' }]);
    });

    it.each<
      [string, () => TransactionShape, Partial<CustodyInspectionOptions>]
    >([
      [
        'a draw paid to a stranger',
        () =>
          accountPaid(2_000_000n - FEE, {
            outputs: [
              controlOutput(grantedState, 2_000_000n - FEE),
              payout(DRAW, STRANGER_ADDRESS),
            ],
            logicRuns: [logicRun(DRAW)],
          }),
        {},
      ],
      [
        'a draw the sponsor change takes',
        () => {
          const rewrite = deviceRewrite(grantedState, grantedState);
          return {
            ...rewrite,
            outputs: [
              rewrite.outputs[0],
              payout(4_700_000n + DRAW, SPONSOR_ADDRESS),
            ],
            logicRuns: [logicRun(DRAW)],
          };
        },
        {},
      ],
      [
        'a draw the sponsor change takes in place of part of the fee',
        () => {
          const rewrite = deviceRewrite(grantedState, grantedState);
          return {
            ...rewrite,
            outputs: [
              rewrite.outputs[0],
              payout(4_700_000n + 200_000n, SPONSOR_ADDRESS),
            ],
            logicRuns: [logicRun(200_000n)],
            fee: 300_000n,
          };
        },
        {},
      ],
      [
        'a creation whose sponsor change takes more of the draw than the control output holds',
        () =>
          creation(initialState, {
            outputs: [
              controlOutput(initialState, 2_100_000n),
              payout(700_000n + 3_000_000n, SPONSOR_ADDRESS),
            ],
            logicRuns: [logicRun(3_000_000n)],
          }),
        {},
      ],
      [
        'a draw beside an owner spend, where it cannot be told from the account lovelace',
        () => {
          const spend = ownerSpend();
          return {
            ...spend,
            outputs: [
              spend.outputs[0],
              spend.outputs[1],
              fundOutput(7_000_000n + DRAW),
              spend.outputs[3],
            ],
            logicRuns: [logicRun(DRAW)],
          };
        },
        {},
      ],
      [
        'a draw in a grant spend, even one the account keeps',
        () => {
          const spend = grantSpend(grantedState, lovelaceGrant, 0n);
          return {
            ...spend,
            outputs: [spend.outputs[0], fundOutput(20_000_000n - FEE + DRAW)],
            logicRuns: [logicRun(DRAW)],
          };
        },
        GRANT_SPEND,
      ],
    ])('refuses %s', (_, shapeOf, options) => {
      const refusals = refusalsOf(inspect(shapeOf(), options));
      expect(refusals).toContainEqual({
        code: 'custody-unsupported-operation',
        reason: 'logic-draw-leaves-account',
        account,
        logic: LOGIC_HASH,
        quantity: expect.any(BigInt) as bigint,
      });
      expect(refusals.map(({ reason }) => reason)).toEqual([
        'logic-draw-leaves-account',
      ]);
    });
  });

  describe('admits only the parked contract scripts as reference scripts', () => {
    const rewrite = deviceRewrite(grantedState, grantedState);
    const withReferences = (...referenceInputs: Cardano.Utxo[]) =>
      inspect({ ...rewrite, referenceInputs });

    it.each<[string, Cardano.Script]>([
      ['the proxy', CURRENT_CUSTODY_CONTRACT_VERSION.accountValidator],
      ['another script', REFERENCE_SCRIPT],
    ])(
      'refuses %s carried at an output reference no version pins',
      (_, script) => {
        const carrier = utxo(0xf2, {
          ...payout(20_000_000n, SPONSOR_ADDRESS),
          scriptReference: script,
        });
        expect(refusalsOf(withReferences(PARKED_LOGIC, carrier))).toEqual([
          {
            code: 'custody-unsupported-operation',
            reason: 'foreign-reference-script',
            input: { txId: carrier[0].txId, index: 0 },
          },
        ]);
      },
    );

    it.each<[string, Cardano.Script | undefined]>([
      ['another contract script', LOGIC.script],
      ['no script', undefined],
    ])('refuses a parked output reference resolved with %s', (_, script) => {
      const [input, output] = PARKED_PROXY;
      const { scriptReference: _pinned, ...withoutScript } = output;
      expect(
        refusalsOf(
          withReferences(
            [
              input,
              script ? { ...output, scriptReference: script } : withoutScript,
            ],
            PARKED_LOGIC,
          ),
        ),
      ).toEqual([
        {
          code: 'custody-context-mismatch',
          reason: 'reference-script-mismatch',
          input: { txId: input.txId, index: input.index },
        },
      ]);
    });

    it('refuses another script on an owner operation unless contract calls are allowed', () => {
      expect(
        reasonsOf(
          inspect(
            {
              ...rewrite,
              referenceInputs: [...PARKED_SCRIPTS, contractScriptCarrier],
              mint: new Map([[CONTRACT_TOKEN, 1n]]),
            },
            { allowGrantSpend: true },
          ),
        ),
      ).toEqual([
        'custody-unsupported-operation/foreign-mint',
        'custody-unsupported-operation/foreign-reference-script',
      ]);
    });

    it('refuses a parked output reference resolved with the called script on a contract call', () => {
      const shape = contractCall({ grant: lovelaceGrant });
      const [input, output] = PARKED_PROXY;
      expect(
        reasonsOf(
          inspect(
            {
              ...shape,
              referenceInputs: shape.referenceInputs!.map(reference =>
                reference === PARKED_PROXY
                  ? [input, { ...output, scriptReference: CONTRACT_SCRIPT }]
                  : reference,
              ),
            },
            { ...GRANT_SPEND, allowContractCall: true },
          ),
        ),
      ).toEqual(['custody-context-mismatch/reference-script-mismatch']);
    });

    it('refuses the parked scripts on a network that pins none there', () => {
      expect(
        reasonsOf(
          inspect(rewrite, {
            chainId: Cardano.ChainIds.Preview,
            accountRecord: undefined,
          }),
        ),
      ).toEqual([
        'custody-unsupported-operation/foreign-reference-script',
        'custody-unsupported-operation/foreign-reference-script',
      ]);
    });
  });

  describe('accepts only the grant spend shape agents sign', () => {
    const spend = () => grantSpend(grantedState, lovelaceGrant);

    it.each<[string, () => TransactionShape, string[]]>([
      [
        'an input outside the account address',
        () => {
          const shape = spend();
          return {
            ...shape,
            inputs: [...shape.inputs, sponsorFee],
            outputs: [...shape.outputs, payout(5_000_000n, SPONSOR_ADDRESS)],
          };
        },
        ['custody-unsupported-operation/grant-spend-foreign-input'],
      ],
      [
        'a withdrawal from the account reward account',
        () => ({
          ...spend(),
          withdrawals: [{ stakeAddress: identity.rewardAccount, quantity: 0n }],
        }),
        ['custody-unsupported-operation/stake-operation-without-control'],
      ],
      [
        'a withdrawal from another reward account',
        () => ({
          ...spend(),
          withdrawals: [
            {
              stakeAddress: Cardano.RewardAccount.fromCredential(
                scriptCredential('fa'.repeat(28)),
                Cardano.NetworkId.Testnet,
              ),
              quantity: 0n,
            },
          ],
        }),
        ['custody-unsupported-operation/foreign-withdrawal'],
      ],
      [
        'a mint',
        () => ({ ...spend(), mint: new Map([[TOKEN, 1n]]) }),
        ['custody-unsupported-operation/foreign-mint'],
      ],
      [
        'a certificate',
        () => ({ ...spend(), certificates: [delegation] }),
        ['custody-unsupported-operation/stake-operation-without-control'],
      ],
    ])('refuses a grant spend with %s', (_, shapeOf, reasons) => {
      expect(reasonsOf(inspect(shapeOf(), GRANT_SPEND))).toEqual(reasons);
    });

    it('names the input outside the account address', () => {
      const shape = spend();
      expect(
        refusalsOf(
          inspect(
            {
              ...shape,
              inputs: [...shape.inputs, sponsorFee],
              outputs: [...shape.outputs, payout(5_000_000n, SPONSOR_ADDRESS)],
            },
            GRANT_SPEND,
          ),
        ),
      ).toEqual([
        {
          code: 'custody-unsupported-operation',
          reason: 'grant-spend-foreign-input',
          account,
          input: { txId: sponsorFee[0].txId, index: 0 },
        },
      ]);
    });
  });

  it('refuses no grant spend for its foreign inputs unless it is allowed', () => {
    const shape = grantSpend(grantedState, lovelaceGrant);
    expect(
      reasonsOf(
        inspect(
          { ...shape, inputs: [...shape.inputs, sponsorFee] },
          { deviceKeyHash: undefined },
        ),
      ),
    ).toEqual(['custody-unsupported-operation/grant-spend']);
  });

  describe('calls other contracts from an owner operation', () => {
    const CALL = { allowContractCall: true } as const;
    const pinned = (...contractPins: CardanoContractPin[]) => ({
      ...CALL,
      contractPins,
      costModels: COST_MODELS,
    });
    const BYTES = { title: 'Key', dataType: 'bytes' } as const;
    const INTEGER = { dataType: 'integer' } as const;
    const DECODED_DATA = {
      kind: 'decoded',
      value: { kind: 'integer', value: CONTRACT_DATA },
    } as const;
    const RAW_DATA = { kind: 'raw', data: CONTRACT_DATA } as const;
    const orderInput = { txId: contractOrder[0].txId, index: 0 };
    const DATUM_HASH: Cardano.DatumHash =
      Serialization.PlutusData.fromCore(CONTRACT_DATA).hash();
    const { mint: _mint, ...spendPin } = contractPin();
    const { spend: _spend, ...mintPin } = contractPin();

    /** The owner call with the order UTxO carrying its datum by hash. */
    const hashedOrderCall = (
      datums?: readonly Cardano.PlutusData[],
    ): TransactionShape => {
      const shape = ownerContractCall();
      const [input, { datum: _datum, ...output }] = contractOrder;
      const order: Cardano.Utxo = [input, { ...output, datumHash: DATUM_HASH }];
      return {
        ...shape,
        inputs: shape.inputs.map(spent =>
          spent === contractOrder ? order : spent,
        ),
        spendRedeemers: shape.spendRedeemers!.map(redeemer =>
          redeemer.utxo === contractOrder
            ? { ...redeemer, utxo: order }
            : redeemer,
        ),
        ...(datums ? { datums } : {}),
      };
    };

    /** The owner call with its output to the contract carrying `datum` inline. */
    const withContractDatum = (datum: Cardano.PlutusData): TransactionShape => {
      const shape = ownerContractCall();
      return {
        ...shape,
        outputs: shape.outputs.map((output, index) =>
          index === 1 ? { ...output, datum } : output,
        ),
      };
    };

    it('refuses the call unless contract calls are allowed', () => {
      expect(reasonsOf(inspect(ownerContractCall()))).toEqual([
        'custody-unsupported-operation/foreign-mint',
        'custody-unsupported-operation/foreign-reference-script',
        'custody-unsupported-operation/foreign-script-input',
      ]);
    });

    it('refuses a foreign Plutus script attached to an owner operation', () => {
      expect(
        refusalsOf(
          inspect({
            ...deviceRewrite(grantedState, grantedState),
            scripts: [CONTRACT_SCRIPT],
          }),
        ),
      ).toEqual([
        {
          code: 'custody-unsupported-operation',
          reason: 'foreign-attached-script',
          scriptHash: CONTRACT_HASH,
        },
      ]);
    });

    it('reads a call without pins, its data raw', () => {
      const inspection = accepted(inspect(ownerContractCall(), CALL));
      expect(onlyAccount(inspection).operations).toEqual([
        { kind: 'owner-spend' },
      ]);
      expect(inspection.contractCalls).toEqual({
        spends: [
          {
            input: orderInput,
            scriptHash: CONTRACT_HASH,
            value: { coins: 5_000_000n },
            redeemer: RAW_DATA,
            datum: RAW_DATA,
          },
        ],
        mints: [
          {
            policyId: CONTRACT_HASH,
            assets: new Map([[CONTRACT_TOKEN, 1n]]),
            redeemer: RAW_DATA,
          },
        ],
        referenceInputs: [
          {
            input: { txId: contractScriptCarrier[0].txId, index: 0 },
            address: CONTRACT_ADDRESS,
            value: { coins: 10_000_000n },
            referenceScriptHash: CONTRACT_HASH,
          },
        ],
      });
      expect(inspection.externalOutputs[0]).toEqual(
        expect.objectContaining({ outputIndex: 1, datum: RAW_DATA }),
      );
    });

    it('accepts a call that attaches the script it runs', () => {
      expect(
        accepted(
          inspect(
            {
              ...ownerContractCall(),
              referenceInputs: PARKED_SCRIPTS,
              scripts: [CONTRACT_SCRIPT],
            },
            CALL,
          ),
        ).contractCalls?.referenceInputs,
      ).toEqual([]);
    });

    it('reports no contract calls on an owner operation that makes none', () => {
      expect(accepted(inspect(ownerSpend(), CALL)).contractCalls).toEqual({
        spends: [],
        mints: [],
        referenceInputs: [],
      });
      expect(accepted(inspect(ownerSpend())).contractCalls).toBeUndefined();
    });

    it('never lets a creation call a contract', () => {
      const shape = creation(initialState);
      expect(
        reasonsOf(
          inspect(
            {
              ...shape,
              mint: new Map([...shape.mint!, [CONTRACT_TOKEN, 1n]]),
            },
            CALL,
          ),
        ),
      ).toContain('custody-unsupported-operation/foreign-mint');
    });

    it('reads a pinned call with its labels and decoded data', () => {
      const inspection = accepted(
        inspect(ownerContractCall(), pinned(contractPin())),
      );
      expect(inspection.contractCalls?.spends).toEqual([
        expect.objectContaining({
          input: orderInput,
          label: 'Order book',
          redeemer: DECODED_DATA,
          datum: DECODED_DATA,
        }),
      ]);
      expect(inspection.contractCalls?.mints).toEqual([
        expect.objectContaining({
          policyId: CONTRACT_HASH,
          label: 'Order book',
          redeemer: DECODED_DATA,
        }),
      ]);
      expect(inspection.externalOutputs).toEqual([
        expect.objectContaining({
          outputIndex: 1,
          label: 'Order book',
          datum: DECODED_DATA,
        }),
      ]);
    });

    it.each<[string, CardanoContractPin[], CustodyContractLocation[]]>([
      [
        'no pin',
        [],
        [
          { kind: 'input', input: orderInput },
          { kind: 'mint', policyId: Cardano.PolicyId(CONTRACT_HASH) },
        ],
      ],
      [
        'a pin without a mint handler',
        [spendPin],
        [{ kind: 'mint', policyId: Cardano.PolicyId(CONTRACT_HASH) }],
      ],
      [
        'a pin without a spend handler',
        [mintPin],
        [{ kind: 'input', input: orderInput }],
      ],
    ])('refuses a call to a script with %s', (_, pins, locations) => {
      expect(refusalsOf(inspect(ownerContractCall(), pinned(...pins)))).toEqual(
        locations.map(location => ({
          code: 'custody-unsupported-operation',
          reason: 'unknown-contract',
          location,
          scriptHash: CONTRACT_HASH,
        })),
      );
    });

    it('refuses an unpinned script beside a pinned one', () => {
      expect(
        reasonsOf(
          inspect(
            ownerContractCall(),
            pinned(
              contractPin({ scriptHash: Hash28ByteBase16('fa'.repeat(28)) }),
            ),
          ),
        ),
      ).toEqual([
        'custody-unsupported-operation/unknown-contract',
        'custody-unsupported-operation/unknown-contract',
      ]);
    });

    it.each<{
      name: string;
      pin: CardanoContractPin;
      location: CustodyContractLocation;
      data: 'datum' | 'redeemer';
    }>([
      {
        name: 'a spend redeemer',
        pin: contractPin({ spend: { redeemer: BYTES, datum: INTEGER } }),
        location: { kind: 'input', input: orderInput },
        data: 'redeemer',
      },
      {
        name: 'a spent datum',
        pin: contractPin({ spend: { redeemer: INTEGER, datum: BYTES } }),
        location: { kind: 'input', input: orderInput },
        data: 'datum',
      },
      {
        name: 'a mint redeemer',
        pin: contractPin({ mint: { redeemer: BYTES } }),
        location: { kind: 'mint', policyId: Cardano.PolicyId(CONTRACT_HASH) },
        data: 'redeemer',
      },
    ])(
      'refuses $name that does not decode against the pin',
      ({ pin, location, data }) => {
        expect(
          refusalsOf(inspect(ownerContractCall(), pinned(pin))),
        ).toContainEqual({
          code: 'custody-unsupported-operation',
          reason: 'contract-data-mismatch',
          location,
          scriptHash: CONTRACT_HASH,
          data,
          path: '',
          expected: 'Key as bytes',
        });
      },
    );

    it('refuses an output datum that does not decode against the pin', () => {
      expect(
        refusalsOf(
          inspect(
            withContractDatum(new Uint8Array([0xaa])),
            pinned(contractPin()),
          ),
        ),
      ).toEqual([
        {
          code: 'custody-unsupported-operation',
          reason: 'contract-data-mismatch',
          location: { kind: 'output', index: 1 },
          scriptHash: CONTRACT_HASH,
          data: 'datum',
          path: '',
          expected: expect.any(String) as string,
        },
      ]);
    });

    it('decodes a spent datum from the preimage the witness set carries', () => {
      expect(
        accepted(
          inspect(hashedOrderCall([CONTRACT_DATA]), pinned(contractPin())),
        ).contractCalls?.spends[0].datum,
      ).toEqual(DECODED_DATA);
    });

    it('refuses a spent datum hash without its preimage when the pin has a datum schema', () => {
      expect(
        refusalsOf(inspect(hashedOrderCall(), pinned(contractPin()))),
      ).toEqual([
        {
          code: 'custody-unsupported-operation',
          reason: 'contract-data-mismatch',
          location: { kind: 'input', input: orderInput },
          scriptHash: CONTRACT_HASH,
          data: 'datum',
          path: '',
          expected: 'a datum',
        },
      ]);
    });

    it('shows a spent datum unchecked when the pin has no datum schema', () => {
      const pin = contractPin({ spend: { redeemer: INTEGER } });
      expect(
        accepted(inspect(hashedOrderCall(), pinned(pin))).contractCalls
          ?.spends[0].datum,
      ).toEqual({ kind: 'hash', hash: DATUM_HASH });
      expect(
        accepted(inspect(ownerContractCall(), pinned(pin))).contractCalls
          ?.spends[0].datum,
      ).toEqual(RAW_DATA);
    });

    it('refuses pins that name one script twice', () => {
      expect(
        refusalsOf(
          inspect(ownerContractCall(), pinned(contractPin(), contractPin())),
        ),
      ).toEqual([
        {
          code: 'custody-context-mismatch',
          reason: 'duplicate-contract-pin',
          scriptHash: CONTRACT_HASH,
        },
      ]);
    });

    it.each<[string, Partial<Cardano.TxOut>, CustodyContractDatum]>([
      ['an inline datum raw', { datum: CONTRACT_DATA }, RAW_DATA],
      [
        'a datum hash as its hash',
        { datumHash: DATUM_HASH },
        { kind: 'hash', hash: DATUM_HASH },
      ],
    ])('shows %s on an output to a key address', (_, datum, expected) => {
      const shape = ownerSpend();
      const inspection = accepted(
        inspect(
          {
            ...shape,
            outputs: shape.outputs.map((output, index) =>
              index === 1 ? { ...output, ...datum } : output,
            ),
          },
          pinned(contractPin()),
        ),
      );
      expect(inspection.externalOutputs[0]).toEqual({
        outputIndex: 1,
        address: STRANGER_ADDRESS,
        value: { coins: 3_000_000n },
        datum: expected,
      });
    });

    /** The owner call with its output to the contract carrying `datum` in place of its inline datum. */
    const withContractOutputDatum = (
      datum: Partial<Cardano.TxOut>,
      datums?: readonly Cardano.PlutusData[],
    ): TransactionShape => {
      const shape = ownerContractCall();
      return {
        ...shape,
        outputs: shape.outputs.map((output, index) => {
          if (index !== 1) return output;
          const { datum: _datum, ...rest } = output;
          return { ...rest, ...datum };
        }),
        ...(datums ? { datums } : {}),
      };
    };

    const NO_OUTPUT_DATUM = {
      code: 'custody-unsupported-operation',
      reason: 'contract-data-mismatch',
      location: { kind: 'output', index: 1 },
      scriptHash: CONTRACT_HASH,
      data: 'datum',
      path: '',
      expected: 'a datum',
    } as const;

    it('refuses an output to a pinned contract that carries only a datum hash', () => {
      expect(
        refusalsOf(
          inspect(
            withContractOutputDatum({ datumHash: DATUM_HASH }),
            pinned(contractPin()),
          ),
        ),
      ).toEqual([NO_OUTPUT_DATUM]);
    });

    it('decodes an output datum hash from the preimage the witness set carries', () => {
      expect(
        accepted(
          inspect(
            withContractOutputDatum({ datumHash: DATUM_HASH }, [CONTRACT_DATA]),
            pinned(contractPin()),
          ),
        ).externalOutputs[0].datum,
      ).toEqual(DECODED_DATA);
    });

    it('refuses an output to a pinned contract that carries no datum', () => {
      expect(
        refusalsOf(inspect(withContractOutputDatum({}), pinned(contractPin()))),
      ).toEqual([NO_OUTPUT_DATUM]);
    });

    describe('binds the data consent shows to the body', () => {
      const declared = buildTransaction(ownerContractCall())
        .transaction.body()
        .toCore().scriptIntegrityHash;

      /** The owner call with other witness data under the body's original script data hash. */
      const reWitnessed = (
        changes: Partial<TransactionShape>,
      ): TransactionShape => ({
        ...ownerContractCall(),
        costModels: undefined,
        body: { scriptIntegrityHash: declared },
        ...changes,
      });

      it('accepts a pinned call whose body commits to its script data', () => {
        expect(declared).toBeDefined();
        expect(
          accepted(inspect(ownerContractCall(), pinned(contractPin())))
            .contractCalls?.spends,
        ).toHaveLength(1);
      });

      it.each<[string, Partial<TransactionShape>]>([
        [
          'spend',
          {
            spendRedeemers: ownerContractCall().spendRedeemers!.map(redeemer =>
              redeemer.utxo === contractOrder
                ? { ...redeemer, data: 43n }
                : redeemer,
            ),
          },
        ],
        ['mint', { mintRedeemer: 43n }],
      ])(
        'refuses a swapped %s redeemer under the original hash',
        (_, changes) => {
          expect(
            refusalsOf(inspect(reWitnessed(changes), pinned(contractPin()))),
          ).toEqual([
            {
              code: 'custody-unsupported-operation',
              reason: 'script-data-hash-mismatch',
              declared,
              computed: expect.any(String) as string,
            },
          ]);
        },
      );

      it('refuses a pinned call whose body commits to no script data', () => {
        expect(
          reasonsOf(
            inspect(
              { ...ownerContractCall(), costModels: undefined },
              pinned(contractPin()),
            ),
          ),
        ).toEqual(['custody-unsupported-operation/missing-script-data-hash']);
      });

      it('refuses a pinned call without cost models', () => {
        expect(
          refusalsOf(
            inspect(ownerContractCall(), {
              ...pinned(contractPin()),
              costModels: undefined,
            }),
          ),
        ).toEqual([
          {
            code: 'custody-unsupported-operation',
            reason: 'missing-cost-models',
          },
        ]);
      });

      it('refuses a pinned call without the cost model of a language it carries', () => {
        expect(
          refusalsOf(
            inspect(ownerContractCall(), {
              ...pinned(contractPin()),
              costModels: new Map(),
            }),
          ),
        ).toEqual([
          {
            code: 'custody-unsupported-operation',
            reason: 'missing-cost-model',
            language: Cardano.PlutusLanguageVersion.V3,
          },
        ]);
      });

      it('needs no cost models for an owner operation that calls nothing', () => {
        expect(
          accepted(
            inspect(ownerSpend(), {
              ...pinned(contractPin()),
              costModels: undefined,
            }),
          ).contractCalls,
        ).toEqual({ spends: [], mints: [], referenceInputs: [] });
      });

      it('leaves the hash of a call without pins unchecked', () => {
        expect(
          accepted(
            inspect({ ...ownerContractCall(), costModels: undefined }, CALL),
          ).contractCalls,
        ).toBeDefined();
      });
    });

    describe('keeps the control of an account that calls', () => {
      const added = transition(
        addCustodyDevice(grantedState, OTHER_DEVICE_KEY, fixtureGrants),
      );
      const STATE_CHANGE = [
        {
          code: 'custody-unsupported-operation',
          reason: 'contract-call-with-state-change',
          account,
        },
      ];

      /** The call of `ownerContractCall` riding on another owner operation. */
      const callingOn = (shape: TransactionShape): TransactionShape => {
        const [, contractOutput] = ownerContractCall().outputs;
        return {
          ...shape,
          inputs: [...shape.inputs, contractOrder],
          spendRedeemers: [
            ...shape.spendRedeemers!,
            { utxo: contractOrder, data: CONTRACT_DATA },
          ],
          referenceInputs: [
            ...(shape.referenceInputs ?? []),
            contractScriptCarrier,
          ],
          outputs: [
            ...shape.outputs,
            { ...contractOutput, value: { coins: 5_000_000n } },
          ],
        };
      };

      it('refuses a call beside an added device', () => {
        const shape = ownerContractCall();
        expect(
          refusalsOf(
            inspect(
              {
                ...shape,
                outputs: [controlOutput(added), ...shape.outputs.slice(1)],
              },
              CALL,
            ),
          ),
        ).toEqual(STATE_CHANGE);
      });

      it('refuses a call beside an issued grant', () => {
        expect(
          refusalsOf(
            inspect(
              callingOn(grantIssue(grantedState, [grantOf({ slot: 3n })])),
              CALL,
            ),
          ),
        ).toEqual(STATE_CHANGE);
      });

      it('refuses an added device that reads a plain foreign reference input', () => {
        const rewrite = deviceRewrite(grantedState, added);
        const plain = utxo(0xf3, payout(20_000_000n, SPONSOR_ADDRESS));
        expect(
          refusalsOf(
            inspect(
              {
                ...rewrite,
                referenceInputs: [...(rewrite.referenceInputs ?? []), plain],
              },
              CALL,
            ),
          ),
        ).toEqual(STATE_CHANGE);
      });

      it('accepts an added device that calls nothing when calls are allowed', () => {
        expect(
          onlyAccount(
            accepted(inspect(deviceRewrite(grantedState, added), CALL)),
          ).operations,
        ).toEqual([{ kind: 'add-device', device: OTHER_DEVICE_KEY }]);
      });
    });
  });
});

describe('bindScriptData', () => {
  const BIND = { bindScriptData: true, costModels: COST_MODELS } as const;
  const hashed = (): TransactionShape => ({
    ...ownerSpend(),
    costModels: COST_MODELS,
  });
  const declared = buildTransaction(hashed())
    .transaction.body()
    .toCore().scriptIntegrityHash;

  /** The owner spend with one more witness datum under the body's original script data hash. */
  const reWitnessed = (): TransactionShape => ({
    ...ownerSpend(),
    datums: [42n],
    body: { scriptIntegrityHash: declared },
  });

  it('accepts an owner operation whose body binds its witness set', () => {
    expect(declared).toBeDefined();
    expect(accepted(inspect(hashed(), BIND)).accounts).toHaveLength(1);
  });

  it('refuses other witness data under the original hash of an operation that calls nothing', () => {
    expect(refusalsOf(inspect(reWitnessed(), BIND))).toEqual([
      {
        code: 'custody-unsupported-operation',
        reason: 'script-data-hash-mismatch',
        declared,
        computed: expect.any(String) as string,
      },
    ]);
  });

  it('refuses a body that declares a hash without cost models', () => {
    expect(
      reasonsOf(inspect(hashed(), { ...BIND, costModels: undefined })),
    ).toEqual(['custody-unsupported-operation/missing-cost-models']);
  });

  it('needs no cost models for a body that declares no hash', () => {
    expect(
      accepted(inspect(ownerSpend(), { ...BIND, costModels: undefined }))
        .accounts,
    ).toHaveLength(1);
  });

  it('leaves the hash of an operation that calls nothing unchecked without it', () => {
    expect(accepted(inspect(reWitnessed())).accounts).toHaveLength(1);
  });
});
