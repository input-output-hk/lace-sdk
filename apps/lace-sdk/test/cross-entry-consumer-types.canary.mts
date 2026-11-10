// The canary build's fixture; test/cross-entry-consumer-types.mts covers the
// stable build. One program imports every entry, as an app that takes each
// feature from the entry that exports it does. The entries re-export one
// declaration of each type they share, so a module or wallet typed by any
// entry fits every other entry's functions. Copies of a type do not: they
// differ in their `unique symbol` brands and in the addons each copy
// declares, and TypeScript relates copies of a generic type such as a module
// by structure, which fails.
import * as bitcoinEntry from '@laceio/sdk/bitcoin';
import * as cardanoEntry from '@laceio/sdk/cardano';
import * as experimentalEntry from '@laceio/sdk/experimental';
import * as midnightEntry from '@laceio/sdk/midnight';
import * as rootEntry from '@laceio/sdk';

type IsAny<T> = 0 extends 1 & T ? true : false;
type Concrete<T extends false> = T;
// `Equal` holds only for types TypeScript treats as identical. The two
// function types stay inline: through a helper alias, `any` equals every type.
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B
  ? 1
  : 2
  ? true
  : false;
type Expect<T extends true> = T;

type RootModule = Parameters<
  typeof rootEntry.createLaceWallet
>[0]['modules'][number];
type BitcoinModule = Parameters<
  typeof bitcoinEntry.createLaceWallet
>[0]['modules'][number];
type CardanoModule = Parameters<
  typeof cardanoEntry.createLaceWallet
>[0]['modules'][number];
type ExperimentalModule = Parameters<
  typeof experimentalEntry.createLaceWallet
>[0]['modules'][number];
type MidnightModule = Parameters<
  typeof midnightEntry.createLaceWallet
>[0]['modules'][number];
type PassportModule = ReturnType<
  typeof experimentalEntry.m.createPassportAccountModule
>;
type RootActivityDetails = rootEntry.ActivitiesSliceState['activityDetails'];
type ExperimentalActivityDetails = NonNullable<
  ReturnType<experimentalEntry.LaceWallet['getState']>['activities']
>['activityDetails'];

// An `any` fits every type, so the assertions below would hold for it.
// `IsAny` catches an `any` the declarations write. The `any` of an import the
// consumer cannot resolve satisfies `false` as well as `true`, so each type
// also refuses a number, and that directive goes unused for an `any`.
// `Equal` fails when only one side is `any`, so the root entry's types cover
// the types they are compared with.
export type NotAny = [
  Concrete<IsAny<RootModule>>,
  Concrete<IsAny<BitcoinModule>>,
  Concrete<IsAny<CardanoModule>>,
  Concrete<IsAny<ExperimentalModule>>,
  Concrete<IsAny<MidnightModule>>,
  Concrete<IsAny<PassportModule>>,
  Concrete<IsAny<rootEntry.Contract>>,
  Concrete<IsAny<rootEntry.LaceWallet>>,
  Concrete<IsAny<rootEntry.AppConfig>>,
  Concrete<IsAny<rootEntry.CardanoRemoteSignerFactory>>,
  Concrete<IsAny<RootActivityDetails>>,
];
// @ts-expect-error A number is not a module.
0 satisfies RootModule;
// @ts-expect-error A number is not a module.
0 satisfies BitcoinModule;
// @ts-expect-error A number is not a module.
0 satisfies CardanoModule;
// @ts-expect-error A number is not a module.
0 satisfies ExperimentalModule;
// @ts-expect-error A number is not a module.
0 satisfies MidnightModule;
// @ts-expect-error A number is not a Passport module.
0 satisfies PassportModule;
// @ts-expect-error A number is not a contract.
0 satisfies rootEntry.Contract;
// @ts-expect-error A number is not a wallet.
0 satisfies rootEntry.LaceWallet;
// @ts-expect-error A number is not an app configuration.
0 satisfies rootEntry.AppConfig;
// @ts-expect-error A number is not a signer factory.
0 satisfies rootEntry.CardanoRemoteSignerFactory;
// @ts-expect-error A number is not a serialized activity detail.
0 satisfies RootActivityDetails;

export type OneDeclaration = [
  Expect<Equal<RootModule, BitcoinModule>>,
  Expect<Equal<RootModule, CardanoModule>>,
  Expect<Equal<RootModule, ExperimentalModule>>,
  Expect<Equal<RootModule, MidnightModule>>,
  Expect<Equal<rootEntry.Contract, experimentalEntry.Contract>>,
  Expect<Equal<rootEntry.LaceWallet, bitcoinEntry.LaceWallet>>,
  Expect<Equal<rootEntry.LaceWallet, cardanoEntry.LaceWallet>>,
  Expect<Equal<rootEntry.LaceWallet, experimentalEntry.LaceWallet>>,
  Expect<Equal<rootEntry.LaceWallet, midnightEntry.LaceWallet>>,
  Expect<Equal<rootEntry.AppConfig, bitcoinEntry.AppConfig>>,
  Expect<Equal<rootEntry.AppConfig, cardanoEntry.AppConfig>>,
  Expect<Equal<rootEntry.AppConfig, experimentalEntry.AppConfig>>,
  Expect<Equal<rootEntry.AppConfig, midnightEntry.AppConfig>>,
  Expect<
    Equal<
      rootEntry.CardanoRemoteSignerFactory,
      cardanoEntry.CardanoRemoteSignerFactory
    >
  >,
  Expect<
    Equal<
      rootEntry.CardanoRemoteSignerFactory,
      experimentalEntry.CardanoRemoteSignerFactory
    >
  >,
  Expect<Equal<RootActivityDetails, ExperimentalActivityDetails>>,
];

// The root entry's createLaceWallet takes every other entry's modules.
declare const passportProps: Parameters<
  typeof experimentalEntry.m.createPassportAccountModule
>[0];
declare const hostedPassportSigner: Parameters<
  typeof experimentalEntry.createRemotePassportSeams
>[0];
declare const withMnemonicWords: bitcoinEntry.WithMnemonicWords;
declare const midnightProps: midnightEntry.CreateMidnightModuleProps;
const rootWallet = await rootEntry.createLaceWallet({
  modules: [
    rootEntry.m.featureDev,
    rootEntry.m.storageInMemory,
    cardanoEntry.m.blockchainCardano,
    cardanoEntry.m.cardanoProviderBlockfrost,
    cardanoEntry.m.cryptoCardanoSdk,
    experimentalEntry.m.blockchainCardanoCustody,
    experimentalEntry.m.createPassportAccountModule({
      ...passportProps,
      ...experimentalEntry.createRemotePassportSeams(hostedPassportSigner),
    }),
    bitcoinEntry.m.blockchainBitcoin,
    bitcoinEntry.m.bitcoinProviderMaestro,
    bitcoinEntry.createBitcoinLazyInMemoryVaultModule({ withMnemonicWords }),
    midnightEntry.createMidnightModule(midnightProps),
  ] as const,
  environment: 'development',
  config: { defaultFeatureFlags: [], extraFeatureFlags: [] },
});
// The other entries' createLaceWallet take the root entry's modules.
const bitcoinWallet = await bitcoinEntry.createLaceWallet({
  modules: [
    rootEntry.m.featureDev,
    rootEntry.m.storageInMemory,
    rootEntry.m.blockchainBitcoin,
    rootEntry.m.bitcoinProviderMaestro,
    rootEntry.createBitcoinLazyInMemoryVaultModule({ withMnemonicWords }),
  ] as const,
  environment: 'development',
  config: {},
});
const experimentalWallet = await experimentalEntry.createLaceWallet({
  modules: [
    rootEntry.m.featureDev,
    rootEntry.m.storageInMemory,
    rootEntry.m.blockchainCardano,
    rootEntry.m.cardanoProviderBlockfrost,
    rootEntry.m.cryptoCardanoSdk,
    experimentalEntry.m.blockchainCardanoCustody,
  ] as const,
  environment: 'development',
  config: {},
});

// The wallet is typed from the other entries' modules: their selectors and
// actions are present and checked.
const { passport } = rootWallet.stateObservables;
passport.selectFlow$.subscribe((flow: experimentalEntry.PassportFlow) => flow);
// @ts-expect-error The flow is not a number.
passport.selectFlow$.subscribe((flow: number) => flow);
rootWallet.dispatch('passport.createAccount', { lockAccount: true });
// @ts-expect-error The Passport slice has no such action.
rootWallet.dispatch('passport.noSuchAction');
// @ts-expect-error The wallet has no such scope.
void rootWallet.stateObservables.noSuchScope.selectX$;

// Each entry's helpers take another entry's wallet.
declare const accountId: rootEntry.AccountId;
declare const grantId: experimentalEntry.GrantId;
declare const signBitcoinProps: bitcoinEntry.SignBitcoinTxProps;
const entityProps: cardanoEntry.CreateInMemoryWalletEntityProps = {
  mnemonicWords: [],
  walletName: 'Cardano',
};
rootWallet.dispatch(
  'wallets.addWallet',
  await cardanoEntry.createInMemoryWalletEntity(rootWallet, entityProps),
);
experimentalWallet.dispatch(
  'wallets.addWallet',
  await rootEntry.createInMemoryWalletEntity(experimentalWallet, entityProps),
);
void rootEntry.createInMemoryWalletEntity(bitcoinWallet, entityProps);
void bitcoinEntry.signBitcoinTx(rootWallet, signBitcoinProps);
void rootEntry.signBitcoinTx(bitcoinWallet, signBitcoinProps);
void experimentalEntry.observeCardanoCustodyAccountState(rootWallet, accountId);
void experimentalEntry.exportPassportAgentPolicy(rootWallet, { grantId });
void experimentalEntry.observeCardanoCustodyAccountState(
  // @ts-expect-error A wallet created without m.blockchainCardanoCustody has no custody store.
  bitcoinWallet,
  accountId,
);

// `Serializable`'s brand is one `unique symbol`: the serialized state of a
// wallet one entry types is the type another entry's state declares.
const rootDetails: RootActivityDetails =
  experimentalWallet.getState().activities?.activityDetails;
const experimentalDetails: ExperimentalActivityDetails = rootDetails;
void experimentalDetails;
declare const detail: rootEntry.ActivityDetail;
// @ts-expect-error An activity detail is not its serialized form.
detail satisfies RootActivityDetails;

// A class with private members is one class to every entry.
declare const experimentalFactory: experimentalEntry.CardanoRemoteSignerFactory;
const rootFactory: rootEntry.CardanoRemoteSignerFactory = experimentalFactory;
rootFactory satisfies cardanoEntry.CardanoRemoteSignerFactory;
