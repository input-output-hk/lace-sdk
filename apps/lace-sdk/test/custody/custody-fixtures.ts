import { ActivityType } from '@lace-contract/activities';
import {
  cardanoContextActions,
  cardanoCustodyActions,
  CardanoNetworkId,
  classifyCardanoCustodyAccount,
  inFlightTransactionOf,
  isCardanoCustodyAccount,
} from '@lace-contract/cardano-context';
import { Cardano, Milliseconds, Serialization } from '@lace-lib/cardano-core';
import {
  Ed25519PrivateKey,
  Hash28ByteBase16,
  ready,
} from '@lace-lib/cardano-crypto';
import { CURRENT_CUSTODY_CONTRACT_VERSION } from '@lace-lib/cardano-custody';
import { HexBlob } from '@lace-lib/cardano-util';
import { BehaviorSubject, combineLatest, map, Subject } from 'rxjs';
import { vi } from 'vitest';

// Test-only imports of the custody transactions the signer tests sign; no
// test code enters the SDK.
// eslint-disable-next-line @nx/enforce-module-boundaries
import {
  CONTRACT_HASH,
  CONTRACT_TOKEN,
  contractOrder,
  contractScriptCarrier as orderBookScriptCarrier,
  controlOutput,
  creation,
  DEVICE_0,
  deviceRewrite,
  EXPIRY,
  FILL,
  fundUtxo,
  grantedState,
  grantOutput,
  grantUtxo,
  identity,
  initialState,
  issueGrant,
  logicRun,
  ownerContractCall,
  PARKED_SCRIPTS,
  payout,
  PREPROD,
  record,
  serializeCustodyTransaction,
  sweepGrants,
  TESTNET_CUSTODY_XPUB,
  utxo,
  VALID_UNTIL,
} from '../../../../packages/contract/cardano-context/test/signing/custody-sign-request.fixtures';
import { vkeyWitnessSetOf } from '../../src/custody/cardano-custody-witnesses';

// eslint-disable-next-line @nx/enforce-module-boundaries
import type { CustodyTransactionShape } from '../../../../packages/contract/cardano-context/test/signing/custody-sign-request.fixtures';
import type { WalletWithCardanoCustody } from '../../src/custody/cardano-custody-wallet';
import type { requestCardanoCustodyBuild } from '../../src/custody/request-cardano-custody-build';
import type { Activity } from '@lace-contract/activities';
import type {
  CardanoCustodyBuildRequest,
  CardanoCustodyBuildResult,
  CardanoCustodyContractCall,
  CardanoCustodyCreatorIndexProbeError,
  CardanoCustodyCreatorIndexProbeRequest,
  CardanoCustodyCreatorIndexProbeResult,
  CardanoCustodyDeviceBinding,
  CardanoTransactionHistoryItem,
  CardanoVkeyWitness,
  DecodedInFlightTransaction,
  RequiredProtocolParameters,
} from '@lace-contract/cardano-context';
import type {
  AccountId,
  AnyAccount,
  AnyWallet,
  WalletId,
} from '@lace-contract/wallet-repo';
import type { EraSummary } from '@lace-lib/cardano-core';
import type { CustodyGrant } from '@lace-lib/cardano-custody';
import type { HexBytes } from '@lace-lib/util';

type CardanoCustodyBuildOutcome = Awaited<
  ReturnType<typeof requestCardanoCustodyBuild>
>;

// eslint-disable-next-line @nx/enforce-module-boundaries
export {
  controlOutput,
  COST_MODELS,
  DEVICE_0,
  DEVICE_1,
  EXPIRY,
  fundUtxo,
  GRANT_LOVELACE,
  grantedState,
  grantOutput,
  grantUtxo,
  identity,
  initialState,
  LOGIC_REWARD_ACCOUNT,
  orderBookPin,
  ownerContractCall,
  payout,
  PREPROD,
  record,
  revokedState,
  serializeResolvedInput,
  TESTNET_CUSTODY_XPUB,
  utxo,
  VALID_UNTIL,
} from '../../../../packages/contract/cardano-context/test/signing/custody-sign-request.fixtures';
// eslint-disable-next-line @nx/enforce-module-boundaries
export { words } from '../../../../packages/contract/cardano-context/test/signing/sign-with-words.fixtures';

/** A raw Ed25519 key, as a fee sponsor or an agent's wallet holds one. */
export const signingKey = (seed: number) => {
  const privateKey = Ed25519PrivateKey.fromNormalBytes(
    new Uint8Array(32).fill(seed),
  );
  const publicKey = privateKey.toPublic();
  return {
    keyHash: publicKey.hash().hex(),
    witnessOver: (bodyHash: Cardano.TransactionId): CardanoVkeyWitness => ({
      vkey: publicKey.hex(),
      signature: privateKey.sign(HexBlob(bodyHash)).hex(),
    }),
  };
};

await ready();
export const sponsorKey = signingKey(0x51);
export const agentKey = signingKey(0x61);
export const otherAgentKey = signingKey(0x62);
export const strangerKey = signingKey(0x71);

const enterpriseAddress = (keyHash: string) =>
  Cardano.EnterpriseAddress.fromCredentials(Cardano.NetworkId.Testnet, {
    type: Cardano.CredentialType.KeyHash,
    hash: Hash28ByteBase16(keyHash),
  })
    .toAddress()
    .toBech32() as Cardano.PaymentAddress;

export const SPONSOR_ADDRESS = enterpriseAddress(sponsorKey.keyHash);
export const RECIPIENT_ADDRESS = enterpriseAddress('ab'.repeat(28));

export const sponsorFee = utxo(0xf0, payout(5_000_000n, SPONSOR_ADDRESS));
export const sponsorCollateral = utxo(
  0xf1,
  payout(5_000_000n, SPONSOR_ADDRESS),
);

const collateralMode = {
  collaterals: [sponsorCollateral],
  collateralReturn: payout(4_625_000n, SPONSOR_ADDRESS),
  totalCollateral: 375_000n,
};

/** The grant the fixture agent key holds, in slot 0. */
export const agentGrant: CustodyGrant = {
  slot: 0n,
  grantee: HexBlob(agentKey.keyHash),
  generation: 0n,
  scope: {
    asset: { policyId: HexBlob(''), assetName: HexBlob('') },
    perCallCap: 10_000_000n,
    cap: 15_000_000n,
    lovelacePerCallCap: 0n,
    lovelaceCap: 0n,
    expiresAt: EXPIRY,
    recipients: [],
  },
};

/** The sponsor's fee mode: its leased UTxO pays the fee, deposit and control output. */
export const creationShape = (): CustodyTransactionShape => ({
  ...creation(),
  inputs: [sponsorFee],
  outputs: [
    controlOutput(initialState, 1_500_000n),
    payout(1_250_000n, SPONSOR_ADDRESS),
  ],
  ...collateralMode,
});

export const liveControl = utxo(0x10, controlOutput(initialState));
export const grantedControl = utxo(0x10, controlOutput(grantedState));
export const agentGrantUtxo = grantUtxo(agentGrant);

/**
 * The sponsor's collateral mode, on this sponsor's collateral: a fund UTxO
 * pays the fee of issuing `agentGrant`.
 */
export const issueGrantShape = (): CustodyTransactionShape => ({
  ...issueGrant({ grant: agentGrant }),
  ...collateralMode,
});

/** Pays 2 tADA to the recipient from the fund UTxO, the rest returning as change. */
export const ownerSpendShape = (): CustodyTransactionShape => ({
  ...deviceRewrite(initialState),
  outputs: [
    controlOutput(initialState),
    payout(2_000_000n, RECIPIENT_ADDRESS),
    payout(7_750_000n, identity.address),
  ],
  ...collateralMode,
});

/** Removes the revoked `agentGrant`, its lovelace kept in the control output. */
export const sweepGrantShape = (): CustodyTransactionShape => ({
  ...sweepGrants({ grants: [agentGrant] }),
  ...collateralMode,
});

const GRANT_SPEND_PAYOUT = 2_000_000n;
const FEE = 250_000n;

/**
 * A spend under the agent grant: it references the control UTxO and the
 * parked contract scripts, runs the account's logic, spends the grant UTxO
 * and a fund UTxO, and recreates the grant with its cap lowered by the
 * payout and the fee.
 */
export const grantSpendShape = (): CustodyTransactionShape => {
  const leaving = GRANT_SPEND_PAYOUT + FEE;
  return {
    inputs: [agentGrantUtxo, fundUtxo],
    referenceInputs: [grantedControl, ...PARKED_SCRIPTS],
    spendRedeemers: [
      { spent: agentGrantUtxo, redeemer: { kind: 'spendWithGrant' } },
      { spent: fundUtxo, redeemer: { kind: 'fund' } },
    ],
    outputs: [
      grantOutput({
        ...agentGrant,
        scope: { ...agentGrant.scope, cap: agentGrant.scope.cap - leaving },
      }),
      payout(GRANT_SPEND_PAYOUT, RECIPIENT_ADDRESS),
      payout(fundUtxo[1].value.coins - leaving, identity.address),
    ],
    withdrawals: [logicRun()],
    ...collateralMode,
    requiredSigners: [agentKey.keyHash],
  };
};

/** The validator of another contract an agent calls. */
export const CONTRACT_SCRIPT: Cardano.PlutusScript = {
  __type: Cardano.ScriptType.Plutus,
  version: Cardano.PlutusLanguageVersion.V3,
  bytes: HexBlob('4e4d01000033222220051200120011'),
};

const CONTRACT_ADDRESS = Cardano.EnterpriseAddress.fromCredentials(
  Cardano.NetworkId.Testnet,
  {
    type: Cardano.CredentialType.ScriptHash,
    hash: Serialization.Script.fromCore(CONTRACT_SCRIPT).hash(),
  },
)
  .toAddress()
  .toBech32() as Cardano.PaymentAddress;

/** The datum and redeemer the called contract reads. */
const CONTRACT_DATA: Cardano.PlutusData = 42n;

/** An order UTxO the called contract locks, which the call spends. */
export const contractOrderUtxo = utxo(0x20, {
  address: CONTRACT_ADDRESS,
  value: { coins: 5_000_000n },
  datum: CONTRACT_DATA,
});

/** The UTxO that parks the called contract's script, which the call reads. */
export const contractScriptCarrier = utxo(0x21, {
  address: CONTRACT_ADDRESS,
  value: { coins: 10_000_000n },
  scriptReference: CONTRACT_SCRIPT,
});

/** The contract call of `contractCallShape`, as an app passes it. */
export const contractCall: CardanoCustodyContractCall = {
  inputs: [{ utxo: contractOrderUtxo, redeemer: CONTRACT_DATA }],
  referenceInputs: [contractScriptCarrier],
};

/**
 * The agent's grant spend that also calls another contract: it spends the
 * contract's order UTxO, reads the contract's parked script and returns
 * the order's value to the contract, so the account pays what the plain
 * spend pays.
 */
export const contractCallShape = (): CustodyTransactionShape => {
  const shape = grantSpendShape();
  return {
    ...shape,
    inputs: [...shape.inputs, contractOrderUtxo],
    referenceInputs: [...(shape.referenceInputs ?? []), contractScriptCarrier],
    outputs: [
      ...shape.outputs,
      {
        address: CONTRACT_ADDRESS,
        value: contractOrderUtxo[1].value,
        datum: CONTRACT_DATA,
      },
    ],
  };
};

/**
 * The owner spend that calls the order book, on this sponsor's collateral:
 * it fills the order UTxO, mints the contract's token and pays the
 * contract's continuing output.
 */
export const ownerContractCallShape = (): CustodyTransactionShape => ({
  ...ownerContractCall(),
  ...collateralMode,
});

/** The contract call of `ownerContractCallShape`, as an app passes it. */
export const ownerContractCallRequest: CardanoCustodyContractCall = {
  inputs: [{ utxo: contractOrder, redeemer: FILL }],
  mint: [
    {
      policyId: Cardano.PolicyId(CONTRACT_HASH),
      assets: new Map([[Cardano.AssetId.getAssetName(CONTRACT_TOKEN), 1n]]),
      redeemer: FILL,
    },
  ],
  referenceInputs: [orderBookScriptCarrier],
};

export const transactionOf = (shape: CustodyTransactionShape) =>
  Serialization.Transaction.fromCbor(
    Serialization.TxCBOR(serializeCustodyTransaction(shape)),
  );

/** What the build side effect answers for a shape. */
export const buildResultOf = (
  shape: CustodyTransactionShape,
  extra: Partial<CardanoCustodyBuildResult> = {},
): CardanoCustodyBuildResult => {
  const transaction = transactionOf(shape);
  return {
    transaction: transaction.toCbor(),
    bodyHash: transaction.getId(),
    resolvedInputs: [
      ...shape.inputs,
      ...(shape.referenceInputs ?? []),
      ...(shape.collaterals ?? []),
    ],
    accountRecord: record,
    fee: FEE,
    invalidHereafter: VALID_UNTIL,
    ...extra,
  };
};

export const creationResult = () =>
  buildResultOf(creationShape(), {
    creation: {
      creatorIndex: 0,
      identity: {
        chainId: PREPROD,
        accountValidatorHash:
          CURRENT_CUSTODY_CONTRACT_VERSION.accountValidatorHash,
        creatorKeyHash: identity.creatorKeyHash,
        stakeScriptHash: identity.stakeScriptHash,
        address: identity.address,
        rewardAccount: identity.rewardAccount,
      },
    },
  });

export const sponsorWitnessSetFor = (
  bodyHash: Cardano.TransactionId,
  key = sponsorKey,
) => vkeyWitnessSetOf([key.witnessOver(bodyHash)]);

export const hostedChannel = {
  type: 'hosted',
  origin: 'https://signer.example',
} as const;

export const localChannel = {
  type: 'local',
  credentialId: 'AQID',
  rpId: 'localhost',
} as const;

export const creatorBinding = (
  channel: CardanoCustodyDeviceBinding['channel'] = hostedChannel,
): CardanoCustodyDeviceBinding => ({
  extendedAccountPublicKey: TESTNET_CUSTODY_XPUB,
  index: 0,
  keyHash: DEVICE_0,
  channel,
});

/** The Preprod parameters custody classification reads. */
const PREPROD_PROTOCOL_PARAMETERS = {
  coinsPerUtxoByte: 4310,
} as RequiredProtocolParameters;

/** The Preprod era history from its Shelley start, enough for custody slots. */
export const preprodEraSummaries: EraSummary[] = [
  {
    parameters: { epochLength: 432_000, slotLength: Milliseconds(1000) },
    start: { slot: 86_400, time: new Date(1_655_769_600_000) },
  },
];

type SubmitAnswer = 'ok' | 'silent' | { error: string };

const outpointOf = ([{ txId, index }]: Cardano.Utxo) => `${txId}#${index}`;

/**
 * An account's settled UTxOs with the transactions in flight applied, as the
 * store's in-flight view does: the inputs they spend leave, and the outputs
 * they pay to `address` join.
 */
const withInFlight = (
  settled: readonly Cardano.Utxo[],
  address: Cardano.PaymentAddress | undefined,
  inFlight: readonly DecodedInFlightTransaction[],
): Cardano.Utxo[] => {
  const spent = new Set(
    inFlight.flatMap(({ effects }) =>
      effects.consumedInputs.map(({ txId, index }) => `${txId}#${index}`),
    ),
  );
  const unspent = settled.filter(utxo => !spent.has(outpointOf(utxo)));
  const known = new Set(unspent.map(outpointOf));
  return [
    ...unspent,
    ...inFlight
      .flatMap(({ effects }) => effects.producedOutputs)
      .filter(
        utxo =>
          utxo[1].address === address &&
          !spent.has(outpointOf(utxo)) &&
          !known.has(outpointOf(utxo)),
      ),
  ];
};

/**
 * A wallet whose store holds wallets, settled UTxOs, the transactions in
 * flight and activities, and whose Cardano module answers builds and
 * submissions as each test says. An accepted submission is recorded in
 * flight before it completes, as the Cardano sync module records it. Custody
 * account states are classified from the settled UTxOs with the transactions
 * in flight applied, as the real selector does.
 */
export const createCustodyTestWallet = () => {
  const wallets$ = new BehaviorSubject<AnyWallet[]>([]);
  const settledUtxos$ = new BehaviorSubject<Record<AccountId, Cardano.Utxo[]>>(
    {},
  );
  const activities$ = new BehaviorSubject<Record<AccountId, Activity[]>>({});
  const inFlight$ = new BehaviorSubject<DecodedInFlightTransaction[]>([]);
  const history$ = new BehaviorSubject<
    Record<AccountId, CardanoTransactionHistoryItem[]>
  >({});
  const tip$ = new BehaviorSubject<Cardano.Tip | undefined>(undefined);
  const chainId$ = new BehaviorSubject<Cardano.ChainId | undefined>(PREPROD);
  const networkInfo$ = new BehaviorSubject<
    Partial<
      Record<
        CardanoNetworkId,
        { protocolParameters?: RequiredProtocolParameters }
      >
    >
  >({
    [CardanoNetworkId(PREPROD.networkMagic)]: {
      protocolParameters: PREPROD_PROTOCOL_PARAMETERS,
    },
  });
  const eraSummaries$ = new BehaviorSubject<EraSummary[] | undefined>(
    preprodEraSummaries,
  );

  const buildCompleted$ = new Subject<
    ReturnType<
      typeof cardanoCustodyActions.cardanoCustody.buildCustodyTransactionCompleted
    >
  >();
  const buildFailed$ = new Subject<
    ReturnType<
      typeof cardanoCustodyActions.cardanoCustody.buildCustodyTransactionFailed
    >
  >();
  const probeCompleted$ = new Subject<
    ReturnType<
      typeof cardanoCustodyActions.cardanoCustody.probeCustodyCreatorIndexCompleted
    >
  >();
  const probeFailed$ = new Subject<
    ReturnType<
      typeof cardanoCustodyActions.cardanoCustody.probeCustodyCreatorIndexFailed
    >
  >();
  const submitCompleted$ = new Subject<
    ReturnType<typeof cardanoContextActions.cardanoContext.submitTxCompleted>
  >();
  const submitFailed$ = new Subject<
    ReturnType<typeof cardanoContextActions.cardanoContext.submitTxFailed>
  >();

  const builds: CardanoCustodyBuildRequest[] = [];
  const probes: CardanoCustodyCreatorIndexProbeRequest[] = [];
  const submitted: string[] = [];
  const control = {
    answerBuild: (
      _request: CardanoCustodyBuildRequest,
    ): CardanoCustodyBuildOutcome => ({
      ok: false,
      error: { code: 'unavailable', message: 'no build answer set' },
    }),
    answerProbe: (
      _request: CardanoCustodyCreatorIndexProbeRequest,
    ):
      | { ok: false; error: CardanoCustodyCreatorIndexProbeError }
      | { ok: true; result: CardanoCustodyCreatorIndexProbeResult } => ({
      ok: false,
      error: { code: 'unavailable', message: 'no probe answer set' },
    }),
    answerSubmit: (): SubmitAnswer => 'ok',
  };

  const custodyAccounts = () =>
    wallets$.value
      .flatMap(wallet => wallet.accounts as AnyAccount[])
      .filter(isCardanoCustodyAccount);

  /** Records a transaction in flight, keeping the record it already holds. */
  const recordInFlight = (transaction: DecodedInFlightTransaction) => {
    if (inFlight$.value.some(({ txId }) => txId === transaction.txId)) return;
    inFlight$.next([...inFlight$.value, transaction]);
  };

  const utxosWithInFlight$ = combineLatest([
    wallets$,
    settledUtxos$,
    inFlight$,
  ]).pipe(
    map(([, settled, inFlight]) =>
      Object.fromEntries(
        Object.entries(settled).map(([accountId, utxos]) => [
          accountId,
          withInFlight(
            utxos,
            custodyAccounts().find(account => account.accountId === accountId)
              ?.blockchainSpecific.address,
            inFlight,
          ),
        ]),
      ),
    ),
  );

  const accountState$ = combineLatest([
    wallets$,
    settledUtxos$,
    inFlight$,
    networkInfo$,
  ]).pipe(
    map(([, settled, inFlight, networkInfo]) => (accountId: AccountId) => {
      const account = custodyAccounts().find(
        candidate => candidate.accountId === accountId,
      );
      if (!account) return undefined;
      const { address, chainId } = account.blockchainSpecific;
      const { protocolParameters } =
        networkInfo[CardanoNetworkId(chainId.networkMagic)] ?? {};
      if (!protocolParameters) return undefined;
      return classifyCardanoCustodyAccount({
        account: account.blockchainSpecific,
        utxos: withInFlight(settled[accountId] ?? [], address, inFlight),
        withdrawableRewards: 0n,
        protocolParameters,
      });
    }),
  );

  const settledAccountState$ = combineLatest([
    wallets$,
    settledUtxos$,
    networkInfo$,
  ]).pipe(
    map(([, settled, networkInfo]) => (accountId: AccountId) => {
      const account = custodyAccounts().find(
        candidate => candidate.accountId === accountId,
      );
      if (!account || !settled[accountId]) return undefined;
      const { protocolParameters } =
        networkInfo[
          CardanoNetworkId(account.blockchainSpecific.chainId.networkMagic)
        ] ?? {};
      return (
        protocolParameters &&
        classifyCardanoCustodyAccount({
          account: account.blockchainSpecific,
          utxos: settled[accountId],
          withdrawableRewards: 0n,
          protocolParameters,
        })
      );
    }),
  );

  const { cardanoContext: actions } = cardanoContextActions;
  const { cardanoCustody: custodyActions } = cardanoCustodyActions;
  const dispatch = vi.fn((key: string, ...args: unknown[]) => {
    switch (key) {
      case 'cardanoCustody.buildCustodyTransaction': {
        const request = args[0] as CardanoCustodyBuildRequest;
        builds.push(request);
        // The build reads the era summaries in the store, as the module does.
        const outcome: CardanoCustodyBuildOutcome = eraSummaries$.value?.length
          ? control.answerBuild(request)
          : {
              ok: false,
              error: {
                code: 'unavailable',
                message: 'Cardano era summaries not available',
              },
            };
        if (outcome.ok) {
          buildCompleted$.next(
            custodyActions.buildCustodyTransactionCompleted({
              requestId: request.requestId,
              result: outcome.result,
            }),
          );
        } else {
          buildFailed$.next(
            custodyActions.buildCustodyTransactionFailed({
              requestId: request.requestId,
              error: outcome.error,
            }),
          );
        }
        return;
      }
      case 'cardanoCustody.probeCustodyCreatorIndex': {
        const request = args[0] as CardanoCustodyCreatorIndexProbeRequest;
        probes.push(request);
        const outcome = control.answerProbe(request);
        if (outcome.ok) {
          probeCompleted$.next(
            custodyActions.probeCustodyCreatorIndexCompleted({
              requestId: request.requestId,
              result: outcome.result,
            }),
          );
        } else {
          probeFailed$.next(
            custodyActions.probeCustodyCreatorIndexFailed({
              requestId: request.requestId,
              error: outcome.error,
            }),
          );
        }
        return;
      }
      case 'cardanoContext.submitTx': {
        const { serializedTx } = args[0] as { serializedTx: string };
        submitted.push(serializedTx);
        const txId = Serialization.Transaction.fromCbor(
          Serialization.TxCBOR(serializedTx),
        ).getId();
        const answer = control.answerSubmit();
        if (answer === 'ok') {
          recordInFlight(
            inFlightTransactionOf({
              serializedTx: serializedTx as HexBytes,
              chainId: chainId$.value ?? PREPROD,
            }),
          );
          submitCompleted$.next(
            actions.submitTxCompleted({ txId: txId as never }),
          );
        } else if (answer !== 'silent') {
          submitFailed$.next(
            actions.submitTxFailed({
              txId: txId as never,
              error: answer.error,
            }),
          );
        }
        return;
      }
      case 'cardanoContext.recordInFlightTransaction': {
        recordInFlight(args[0] as DecodedInFlightTransaction);
        return;
      }
      case 'activities.upsertActivities': {
        const { accountId, activities } = args[0] as {
          accountId: AccountId;
          activities: Activity[];
        };
        // Upserted by id, as the activities slice does.
        const byId = new Map(
          [...(activities$.value[accountId] ?? []), ...activities].map(
            activity => [activity.activityId, activity] as const,
          ),
        );
        activities$.next({
          ...activities$.value,
          [accountId]: [...byId.values()],
        });
        return;
      }
      case 'wallets.addWallet': {
        const wallet = args[0] as AnyWallet;
        if (!wallets$.value.some(w => w.walletId === wallet.walletId)) {
          wallets$.next([...wallets$.value, wallet]);
        }
        return;
      }
      case 'wallets.updateWallet': {
        const { id, changes } = args[0] as {
          id: WalletId;
          changes: Partial<AnyWallet>;
        };
        wallets$.next(
          wallets$.value.map(wallet =>
            wallet.walletId === id
              ? ({ ...wallet, ...changes } as AnyWallet)
              : wallet,
          ),
        );
        return;
      }
      case 'wallets.updateAccount': {
        const [walletId, accountId, changes] = args as [
          WalletId,
          AccountId,
          Partial<AnyAccount>,
        ];
        wallets$.next(
          wallets$.value.map(wallet =>
            wallet.walletId === walletId
              ? ({
                  ...wallet,
                  accounts: wallet.accounts.map(account =>
                    account.accountId === accountId
                      ? { ...account, ...changes }
                      : account,
                  ),
                } as AnyWallet)
              : wallet,
          ),
        );
        return;
      }
      default:
        throw new Error(`Unexpected dispatch ${key}`);
    }
  });

  const wallet = {
    stateObservables: {
      cardanoContext: {
        selectAccountUtxos$: settledUtxos$,
        selectAccountUtxosWithInFlight$: utxosWithInFlight$,
        selectChainId$: chainId$,
        selectEraSummaries$: eraSummaries$,
        selectTip$: tip$,
        selectTransactionHistoryGroupedByAccount$: history$,
      },
      cardanoCustody: {
        selectCardanoCustodyAccountState$: accountState$,
        selectSettledCardanoCustodyAccountState$: settledAccountState$,
      },
      wallets: { selectAll$: wallets$ },
      activities: {
        selectPendingActivitiesByAccount$: activities$.pipe(
          map(byAccount =>
            Object.fromEntries(
              Object.entries(byAccount).map(([accountId, activities]) => [
                accountId,
                activities.filter(
                  activity => activity.type === ActivityType.Pending,
                ),
              ]),
            ),
          ),
        ),
      },
    },
    actionObservables: {
      cardanoContext: {
        submitTxCompleted$: submitCompleted$,
        submitTxFailed$: submitFailed$,
      },
      cardanoCustody: {
        buildCustodyTransactionCompleted$: buildCompleted$,
        buildCustodyTransactionFailed$: buildFailed$,
        probeCustodyCreatorIndexCompleted$: probeCompleted$,
        probeCustodyCreatorIndexFailed$: probeFailed$,
      },
    },
    dispatch,
  } as unknown as WalletWithCardanoCustody;

  return {
    wallet,
    dispatch,
    control,
    builds,
    probes,
    submitted,
    wallets$,
    settledUtxos$,
    activities$,
    inFlight$,
    history$,
    tip$,
    chainId$,
    eraSummaries$,
    networkInfo$,
    /** Answer every build with `outcome`. */
    answerBuildsWith: (outcome: CardanoCustodyBuildOutcome) => {
      control.answerBuild = () => outcome;
    },
    custodyAccount: (accountId: AccountId) =>
      custodyAccounts().find(account => account.accountId === accountId),
  };
};

export type CustodyTestWallet = ReturnType<typeof createCustodyTestWallet>;
