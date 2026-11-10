// The stable build's fixture; test/cross-entry-consumer-types.canary.mts
// covers the canary build. One program imports the root and Cardano entries,
// as an app that takes modules from one and helpers from the other does. Both
// entries re-export one declaration of each type they share, so a module or
// wallet typed by either fits the other's functions. Copies of a type do not:
// they differ in their `unique symbol` brands, and TypeScript relates copies of
// a generic type such as a module by structure, which fails.
import * as cardanoEntry from '@laceio/sdk/cardano';
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
type CardanoModule = Parameters<
  typeof cardanoEntry.createLaceWallet
>[0]['modules'][number];
type RootActivityDetails = rootEntry.ActivitiesSliceState['activityDetails'];
type CardanoActivityDetails = NonNullable<
  ReturnType<cardanoEntry.LaceWallet['getState']>['activities']
>['activityDetails'];

// An `any` fits every type, so the assertions below would hold for it.
// `IsAny` catches an `any` the declarations write. The `any` of an import the
// consumer cannot resolve satisfies `false` as well as `true`, so each type
// also refuses a number, and that directive goes unused for an `any`.
export type NotAny = [
  Concrete<IsAny<RootModule>>,
  Concrete<IsAny<CardanoModule>>,
  Concrete<IsAny<rootEntry.LaceWallet>>,
  Concrete<IsAny<cardanoEntry.LaceWallet>>,
  Concrete<IsAny<rootEntry.AppConfig>>,
  Concrete<IsAny<cardanoEntry.AppConfig>>,
  Concrete<IsAny<rootEntry.CardanoRemoteSignerFactory>>,
  Concrete<IsAny<cardanoEntry.CardanoRemoteSignerFactory>>,
  Concrete<IsAny<RootActivityDetails>>,
];
// @ts-expect-error A number is not a module.
0 satisfies RootModule;
// @ts-expect-error A number is not a module.
0 satisfies CardanoModule;
// @ts-expect-error A number is not a wallet.
0 satisfies rootEntry.LaceWallet;
// @ts-expect-error A number is not a wallet.
0 satisfies cardanoEntry.LaceWallet;
// @ts-expect-error A number is not an app configuration.
0 satisfies rootEntry.AppConfig;
// @ts-expect-error A number is not an app configuration.
0 satisfies cardanoEntry.AppConfig;
// @ts-expect-error A number is not a signer factory.
0 satisfies rootEntry.CardanoRemoteSignerFactory;
// @ts-expect-error A number is not a signer factory.
0 satisfies cardanoEntry.CardanoRemoteSignerFactory;
// @ts-expect-error A number is not a serialized activity detail.
0 satisfies RootActivityDetails;

export type OneDeclaration = [
  Expect<Equal<RootModule, CardanoModule>>,
  Expect<
    Equal<
      RootModule['implements']['contracts'][number],
      CardanoModule['implements']['contracts'][number]
    >
  >,
  Expect<Equal<rootEntry.LaceWallet, cardanoEntry.LaceWallet>>,
  Expect<Equal<rootEntry.AppConfig, cardanoEntry.AppConfig>>,
  Expect<
    Equal<
      rootEntry.CardanoRemoteSignerFactory,
      cardanoEntry.CardanoRemoteSignerFactory
    >
  >,
  Expect<Equal<RootActivityDetails, CardanoActivityDetails>>,
];

// Each entry's createLaceWallet takes the other entry's modules.
const rootWallet = await rootEntry.createLaceWallet({
  modules: [
    rootEntry.m.featureDev,
    cardanoEntry.m.storageInMemory,
    cardanoEntry.m.blockchainCardano,
    cardanoEntry.m.cardanoProviderBlockfrost,
    cardanoEntry.m.cryptoCardanoSdk,
  ] as const,
  environment: 'development',
  config: {},
});
const cardanoWallet = await cardanoEntry.createLaceWallet({
  modules: [
    cardanoEntry.m.featureDev,
    rootEntry.m.storageInMemory,
    rootEntry.m.blockchainCardano,
    rootEntry.m.cardanoProviderBlockfrost,
    rootEntry.m.cryptoCardanoSdk,
  ] as const,
  environment: 'development',
  config: {},
});

// The wallet is typed from the other entry's modules: their selectors and
// actions are present and checked.
const { cardanoContext } = rootWallet.stateObservables;
cardanoContext.selectChainId$.subscribe(
  (chainId: cardanoEntry.Cardano.ChainId | undefined) => chainId,
);
// @ts-expect-error The chain id is not a number.
cardanoContext.selectChainId$.subscribe((chainId: number) => chainId);
cardanoWallet.dispatch('cardanoContext.submitTx', {
  serializedTx: rootEntry.HexBytes('00'),
});
// @ts-expect-error The Cardano context has no such action.
cardanoWallet.dispatch('cardanoContext.noSuchAction');
// @ts-expect-error The wallet has no such scope.
void rootWallet.stateObservables.noSuchScope.selectX$;

// Each entry's helpers take the other entry's wallet.
const entityProps: cardanoEntry.CreateInMemoryWalletEntityProps = {
  mnemonicWords: [],
  walletName: 'Cardano',
};
declare const signProps: cardanoEntry.SignCardanoTxProps;
rootWallet.dispatch(
  'wallets.addWallet',
  await cardanoEntry.createInMemoryWalletEntity(rootWallet, entityProps),
);
cardanoWallet.dispatch(
  'wallets.addWallet',
  await rootEntry.createInMemoryWalletEntity(cardanoWallet, entityProps),
);
void cardanoEntry.signCardanoTx(rootWallet, signProps);
void rootEntry.signCardanoTx(cardanoWallet, signProps);
void cardanoEntry.waitForNetworkInfo(rootWallet);
void rootEntry.waitForNetworkInfo(cardanoWallet);
const walletWithoutCardano = await cardanoEntry.createLaceWallet({
  modules: [rootEntry.m.featureDev, rootEntry.m.storageInMemory] as const,
  environment: 'development',
  config: {},
});
// @ts-expect-error A wallet created without m.blockchainCardano has no Cardano context.
void rootEntry.waitForNetworkInfo(walletWithoutCardano);

// `Serializable`'s brand is one `unique symbol`: the serialized state of a
// wallet one entry types is the type the other entry's state declares.
const rootDetails: RootActivityDetails =
  cardanoWallet.getState().activities?.activityDetails;
const cardanoDetails: CardanoActivityDetails = rootDetails;
void cardanoDetails;
declare const detail: rootEntry.ActivityDetail;
// @ts-expect-error An activity detail is not its serialized form.
detail satisfies RootActivityDetails;

// A class with private members is one class to both entries.
declare const cardanoFactory: cardanoEntry.CardanoRemoteSignerFactory;
const rootFactory: rootEntry.CardanoRemoteSignerFactory = cardanoFactory;
rootFactory satisfies cardanoEntry.CardanoRemoteSignerFactory;
