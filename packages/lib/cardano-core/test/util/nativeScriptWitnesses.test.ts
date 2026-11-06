import { Hash28ByteBase16, Hash32ByteBase16 } from '@lace-lib/cardano-crypto';

import {
  Cardano,
  Serialization,
  batchWitnessScripts,
  neededNativeScripts,
  spentScriptHash,
} from '../../src';

const keyHash = 'f'.repeat(56);

const requireSignature = (hash: string): Cardano.NativeScript =>
  ({
    __type: Cardano.ScriptType.Native,
    keyHash: hash,
    kind: Cardano.NativeScriptKind.RequireSignature,
  } as Cardano.NativeScript);

const script = requireSignature(keyHash);
const otherScript = requireSignature('e'.repeat(56));
const scriptHash = Serialization.Script.fromCore(script).hash();
const scriptCredential: Cardano.Credential = {
  hash: scriptHash,
  type: Cardano.CredentialType.ScriptHash,
};
const txIn: Cardano.TxIn = {
  index: 0,
  txId: Cardano.TransactionId('0'.repeat(64)),
};
const body: Cardano.TxBody = { fee: 0n, inputs: [txIn], outputs: [] };

const enterpriseAddress = (credential: Cardano.Credential) =>
  Cardano.EnterpriseAddress.fromCredentials(
    Cardano.NetworkId.Testnet,
    credential,
  )
    .toAddress()
    .toBech32();

describe('nativeScriptWitnesses', () => {
  describe('spentScriptHash', () => {
    it('is the script hash of a script payment credential', () => {
      expect(spentScriptHash(enterpriseAddress(scriptCredential))).toBe(
        scriptHash,
      );
    });

    it('is null for a key payment credential', () => {
      expect(
        spentScriptHash(
          enterpriseAddress({
            hash: Hash28ByteBase16(keyHash),
            type: Cardano.CredentialType.KeyHash,
          }),
        ),
      ).toBeNull();
    });
  });

  describe('neededNativeScripts', () => {
    it('keeps the script that locks a spent input', () => {
      expect(
        neededNativeScripts({
          body,
          resolveSpentScriptHash: () => scriptHash,
          scripts: [script, otherScript],
        }),
      ).toEqual([script]);
    });

    it('keeps no script when keys lock every spent input', () => {
      expect(
        neededNativeScripts({
          body,
          resolveSpentScriptHash: () => null,
          scripts: [script],
        }),
      ).toEqual([]);
    });

    it('keeps every native script while a spent output is not known', () => {
      expect(
        neededNativeScripts({
          body,
          resolveSpentScriptHash: () => void 0,
          scripts: [script, otherScript],
        }),
      ).toEqual([script, otherScript]);
    });

    it('keeps a script the body names as a minting policy', () => {
      expect(
        neededNativeScripts({
          body: {
            ...body,
            mint: new Map([
              [
                Cardano.AssetId.fromParts(
                  Cardano.PolicyId(scriptHash),
                  Cardano.AssetName(''),
                ),
                1n,
              ],
            ]),
          },
          resolveSpentScriptHash: () => null,
          scripts: [script, otherScript],
        }),
      ).toEqual([script]);
    });

    it.each([
      {
        __typename: Cardano.GovernanceActionType.parameter_change_action,
        governanceActionId: null,
        policyHash: scriptHash,
        protocolParamUpdate: { maxTxSize: 16_384 },
      },
      {
        __typename: Cardano.GovernanceActionType.treasury_withdrawals_action,
        policyHash: scriptHash,
        withdrawals: new Set([
          {
            coin: 1n,
            rewardAccount: Cardano.RewardAccount(
              'stake1u89sasnfyjtmgk8ydqfv3fdl52f36x3djedfnzfc9rkgzrcss5vgr',
            ),
          },
        ]),
      },
    ] as Cardano.GovernanceAction[])(
      'keeps a script the body names as the policy of a $__typename proposal',
      governanceAction => {
        expect(
          neededNativeScripts({
            body: {
              ...body,
              proposalProcedures: [
                {
                  anchor: {
                    dataHash: Hash32ByteBase16('0'.repeat(64)),
                    url: 'https://example.com',
                  },
                  deposit: 100_000_000_000n,
                  governanceAction,
                  rewardAccount: Cardano.RewardAccount(
                    'stake1u89sasnfyjtmgk8ydqfv3fdl52f36x3djedfnzfc9rkgzrcss5vgr',
                  ),
                },
              ],
            },
            resolveSpentScriptHash: () => null,
            scripts: [script, otherScript],
          }),
        ).toEqual([script]);
      },
    );

    it('keeps no script for a proposal without a policy', () => {
      expect(
        neededNativeScripts({
          body: {
            ...body,
            proposalProcedures: [
              {
                anchor: {
                  dataHash: Hash32ByteBase16('0'.repeat(64)),
                  url: 'https://example.com',
                },
                deposit: 100_000_000_000n,
                governanceAction: {
                  __typename:
                    Cardano.GovernanceActionType.parameter_change_action,
                  governanceActionId: null,
                  policyHash: null,
                  protocolParamUpdate: { maxTxSize: 16_384 },
                },
                rewardAccount: Cardano.RewardAccount(
                  'stake1u89sasnfyjtmgk8ydqfv3fdl52f36x3djedfnzfc9rkgzrcss5vgr',
                ),
              },
            ],
          },
          resolveSpentScriptHash: () => null,
          scripts: [script],
        }),
      ).toEqual([]);
    });

    it('keeps a script a sub transaction requires of the top level as a guard', () => {
      expect(
        neededNativeScripts({
          body: {
            ...body,
            subTransactions: [
              {
                body: {
                  inputs: [],
                  outputs: [],
                  requiredTopLevelGuards: [
                    { credential: scriptCredential, datum: null },
                  ],
                },
                witness: { signatures: new Map() },
              },
            ],
          },
          resolveSpentScriptHash: () => null,
          scripts: [script],
        }),
      ).toEqual([script]);
    });
  });

  describe('batchWitnessScripts', () => {
    it('adds the scripts the sub transactions carry, each once', () => {
      expect(
        batchWitnessScripts(
          {
            ...body,
            subTransactions: [
              {
                body: { inputs: [], outputs: [] },
                witness: {
                  scripts: [script, otherScript],
                  signatures: new Map(),
                },
              },
            ],
          },
          [script],
        ),
      ).toEqual([script, otherScript]);
    });

    it('keeps the given scripts of a body without sub transactions', () => {
      expect(batchWitnessScripts(body, undefined)).toEqual([]);
    });
  });
});
