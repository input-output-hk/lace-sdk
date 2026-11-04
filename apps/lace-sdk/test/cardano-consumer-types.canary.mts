import * as cardanoEntry from '@laceio/sdk/cardano';
import {
  AccountId,
  Cardano,
  createLaceWallet,
  createLazyInMemoryVaultModule,
  createPasskeyKeySource,
  createRemotePasskeySigner,
  HexBlob,
  FEATURE_FLAG_CARDANO,
  FEATURE_FLAG_HYDRA_HEADS,
  findAccountHydraHeads,
  fromHydraHeadsIndexSnapshot,
  m,
  Serialization,
  toHydraDepositActivityStates,
  toHydraHeadCards,
  toHydraHeadPositions,
  type CardanoHydraActivityMetadata,
  type CreateLazyInMemoryVaultModuleProps,
  type HydraAccountHead,
  type HydraDepositActivityStates,
  type HydraHeadCards,
  type HydraHeadPositions,
  type HydraHeadsIndexHead,
  type HydraUtxo,
  type WithMnemonicWords,
} from '@laceio/sdk/cardano';
import * as rootEntry from '@laceio/sdk';
import {
  type Result,
  createLazyInMemoryVaultModule as createFromRoot,
  createPasskeyKeySource as createFromRootKeySource,
  type WithMnemonicWords as RootWithMnemonicWords,
} from '@laceio/sdk';

// The canary build's twin of test/cardano-consumer-types.mts: the stable
// fixture plus the preview exports of the canary Cardano entry. A consumer
// that lacks a package the declarations import reads its types as `any`, which accepts every value, so each directive below
// goes unused. A type-level `0 extends 1 & T` test misses this `any`, because
// the `any` of an unresolved import satisfies `false` as well as `true`.
// @ts-expect-error A number is not a Result.
0 satisfies Result<number, Error>;
// @ts-expect-error A number is not an address.
0 satisfies Cardano.PaymentAddress;
// @ts-expect-error A number is not a UTxO.
0 satisfies Cardano.Utxo;
// @ts-expect-error A number is not a transaction.
0 satisfies Serialization.Transaction;
// @ts-expect-error A number is not a hex blob.
0 satisfies HexBlob;

// Experimental exports are absent from both entries in either build: only
// the canary build's experimental entry has them (ADR 66).
// @ts-expect-error Custody accounts are experimental.
void cardanoEntry.createCardanoCustodyAccount;
// @ts-expect-error Custody accounts are experimental.
void rootEntry.createCardanoCustodyAccount;
// @ts-expect-error The custody sponsor client is experimental.
void cardanoEntry.createCardanoCustodySponsorClient;
// @ts-expect-error Passport accounts are experimental.
void rootEntry.m.createPassportAccountModule;
// @ts-expect-error Passport accounts are experimental.
void rootEntry.createRemotePassportSeams;
// @ts-expect-error MIP-0015 secrets are experimental.
void rootEntry.deriveSymmetricSecret;
// @ts-expect-error Hydra Head recognition is on the Cardano entry alone.
void rootEntry.findAccountHydraHeads;

declare const source: WithMnemonicWords;
const rootSource: RootWithMnemonicWords = source;
const props: CreateLazyInMemoryVaultModuleProps = {
  withMnemonicWords: rootSource,
};
createLazyInMemoryVaultModule(props);
createFromRoot(props);

const cardanoKeySource = createPasskeyKeySource({ rpId: 'localhost' });
cardanoKeySource.withPasskeyMnemonic(async words => words.length);
// @ts-expect-error The key source exposes the wallet words only.
cardanoKeySource.deriveSecret({ domain: 'consumer', context: 'account-0' });
// @ts-expect-error No entry point exposes session mnemonic access.
cardanoKeySource.withSessionMnemonic(async words => words.length);
const rootKeySource = createFromRootKeySource({ rpId: 'localhost' });
// @ts-expect-error The key source exposes the wallet words only.
rootKeySource.deriveSecret({ domain: 'consumer', context: 'account-0' });
// @ts-expect-error No entry point exposes session mnemonic access.
rootKeySource.withSessionMnemonic(async words => words.length);

const wallet = await createLaceWallet({
  modules: [
    m.featureDev,
    m.storageInMemory,
    m.blockchainCardano,
    m.cardanoProviderBlockfrost,
    m.cryptoCardanoSdk,
  ] as const,
  environment: 'development',
  config: {},
});
void wallet;
const hostedSigner = createRemotePasskeySigner({
  signerUrl: 'https://signer.example',
});
void hostedSigner;

const hydraUtxo: HydraUtxo = {
  txId: 'ab'.repeat(32),
  index: 0,
  address: 'addr_test1wq4erflxvet45fr9hrrldflevr2cwr83x622vlejzhspf3gn6jry8',
  value: { coins: 2_000_000n, assets: new Map() },
};
const hydraHeads: HydraAccountHead[] = findAccountHydraHeads(
  [hydraUtxo],
  ['ab'.repeat(28)],
);
const hydraPositions: HydraHeadPositions = toHydraHeadPositions({
  heads: hydraHeads,
  deposits: [],
  now: Date.now(),
});
const hydraCards: HydraHeadCards = toHydraHeadCards({
  ...fromHydraHeadsIndexSnapshot({ heads: [], deposits: [] }),
  now: Date.now(),
});
void hydraCards;
// Store selectors, provider shapes and read limits stay off the SDK.
// @ts-expect-error Store selectors are not part of the SDK.
void cardanoEntry.hydraHeadsIndexSelectors;
// @ts-expect-error Store selectors are not part of the SDK.
void cardanoEntry.selectHydraDepositActivityStates;
// @ts-expect-error Provider wire formats are not part of the SDK.
void cardanoEntry.fromBlockfrostUtxo;
// @ts-expect-error Provider wire formats are not part of the SDK.
void cardanoEntry.parseHydraTxTagFromJsonMetadata;
// @ts-expect-error Read limits consumers cannot set are not part of the SDK.
void cardanoEntry.HYDRA_HEAD_HISTORY_LIMITS;
// @ts-expect-error A number is not a Hydra head.
0 satisfies HydraAccountHead;
const hydraActivity: CardanoHydraActivityMetadata = {
  protocol: 'HydraV2',
  txName: 'DepositTx',
  depositDeadline: '2026-01-01T00:00:00.000Z',
};
const lockedHeadId = (head: HydraHeadsIndexHead): string => head.headId;
const hydraWallet = await createLaceWallet({
  modules: [
    m.featureDev,
    m.storageInMemory,
    m.blockchainCardano,
    m.cardanoProviderBlockfrost,
    m.cryptoCardanoSdk,
  ] as const,
  environment: 'development',
  featureFlags: [
    { key: FEATURE_FLAG_CARDANO },
    { key: FEATURE_FLAG_HYDRA_HEADS },
  ],
  config: {},
});
hydraWallet.stateObservables.hydraHeadsIndex.selectIndexByAccount$.subscribe(
  index => Object.keys(index),
);
hydraWallet.stateObservables.hydraHeadsIndex.selectHydraDepositsByAccount$.subscribe(
  depositsOf => {
    const states: HydraDepositActivityStates = toHydraDepositActivityStates(
      depositsOf(AccountId('account')),
      Date.now(),
    );
    return states.byActivityId;
  },
);
void [hydraHeads, hydraPositions, hydraActivity.txName, lockedHeadId];
