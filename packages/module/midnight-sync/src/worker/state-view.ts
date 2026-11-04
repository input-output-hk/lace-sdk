import { getDesignationTargetType } from '@lace-contract/midnight-context';
import { BigNumber, HexBytes } from '@lace-lib/util';

import type {
  DustGenerationDetails,
  MidnightAccountPublicKeys,
} from '@lace-contract/midnight-context';
import type {
  FacadeState,
  UtxoWithMeta,
} from '@midnightntwrk/wallet-sdk/facade';

/**
 * What page-side readers take from an engine state, as plain data. The engine state itself holds WASM objects and
 * cannot leave the worker, so the worker computes this from each engine state it passes to the page.
 */
export type MidnightStateView = {
  readonly unshielded: {
    readonly availableCoins: readonly UtxoWithMeta[];
    readonly pendingCoins: readonly UtxoWithMeta[];
  };
  readonly dust: {
    /** Generated DUST of every coin, including the one a pending transaction pays with. */
    readonly balance: bigint;
    /** Generated DUST of the coins no pending transaction spends. */
    readonly available: bigint;
    /** Absent while the account has no DUST coin. */
    readonly generation: DustGenerationDetails | undefined;
  };
  readonly shieldedPublicKeys: MidnightAccountPublicKeys;
  /**
   * Whether each sub-wallet has strictly caught up with the chain. It travels with the coins, so that a reader gets
   * both from one state: the view is throttled, and `syncProgress$` is not.
   */
  readonly isStrictlyComplete: {
    readonly unshielded: boolean;
    readonly shielded: boolean;
    readonly dust: boolean;
  };
};

const generatedDustOf = (coins: readonly { generatedNow: bigint }[]) =>
  coins.reduce((sum, coin) => sum + coin.generatedNow, 0n);

// Sums totalCoins rather than state.dust.balance: totalCoins is
// availableCoins ++ pendingCoins, and a build moves the whole DUST coin it
// pays with into pending.
export const midnightDustBalances = ({
  dust,
}: {
  dust: {
    totalCoins: readonly { generatedNow: bigint }[];
    availableCoins: readonly { generatedNow: bigint }[];
  };
}): { balance: bigint; available: bigint } => ({
  balance: generatedDustOf(dust.totalCoins),
  available: generatedDustOf(dust.availableCoins),
});

const plainCoins = (coins: readonly UtxoWithMeta[]): UtxoWithMeta[] =>
  coins.map(({ utxo, meta }) => ({ utxo: { ...utxo }, meta: { ...meta } }));

/**
 * The DUST generation of an engine state's coins; absent while there is none. Pass `totalCoins` rather than
 * `availableCoins`, so that a pending DUST spend does not show as no generation.
 *
 * @param coins - The engine state's DUST coins.
 */
export const dustGenerationDetailsOf = (
  coins: FacadeState['dust']['totalCoins'],
): DustGenerationDetails | undefined => {
  if (coins.length === 0) return undefined;
  const sum = (field: 'generatedNow' | 'maxCap' | 'rate') =>
    coins.reduce((total, coin) => total + coin[field], 0n);
  const times = (field: 'dtime' | 'maxCapReachedAt') =>
    coins
      .map(coin => coin[field]?.getTime())
      .filter((time): time is number => time !== undefined);
  const decayTimes = times('dtime');
  const maxCapTimes = times('maxCapReachedAt');
  return {
    currentValue: sum('generatedNow'),
    maxCap: sum('maxCap'),
    decayTime: decayTimes.length > 0 ? Math.min(...decayTimes) : undefined,
    maxCapReachedAt:
      maxCapTimes.length > 0 ? Math.max(...maxCapTimes) : undefined,
    rate: sum('rate'),
  };
};

/**
 * The shielded public keys of an engine state, as hex.
 *
 * @param state - The engine state.
 */
export const shieldedPublicKeysOfState = ({
  shielded,
}: FacadeState): MidnightAccountPublicKeys => ({
  coin: HexBytes(shielded.coinPublicKey.toHexString()),
  encryption: HexBytes(shielded.encryptionPublicKey.toHexString()),
});

/**
 * Whether each sub-wallet of an engine state has strictly caught up with the chain.
 *
 * @param state - The engine state.
 */
export const strictCompletionOfState = ({
  unshielded,
  shielded,
  dust,
}: FacadeState): MidnightStateView['isStrictlyComplete'] => ({
  unshielded: unshielded.state.progress.isStrictlyComplete(),
  shielded: shielded.state.progress.isStrictlyComplete(),
  dust: dust.state.progress.isStrictlyComplete(),
});

/**
 * Whether the account takes part in DUST generation. The engine does not report where registered NIGHT
 * generates, so this covers a designation to the account's own address and to an external one alike.
 *
 * @param state - The engine state.
 * @param nightCoins - The account's available NIGHT coins.
 */
export const isDesignatedForDust = (
  state: FacadeState,
  nightCoins: readonly UtxoWithMeta[],
): boolean =>
  getDesignationTargetType(
    nightCoins.map(({ utxo, meta }) => ({
      status: 'available' as const,
      value: BigNumber(utxo.value),
      registeredForDustGeneration: meta.registeredForDustGeneration,
    })),
    generatedDustOf(state.dust.totalCoins),
  ) !== 'none' || state.dust.totalCoins.some(coin => coin.maxCap > 0n);

/**
 * The plain view of an engine state.
 *
 * @param state - The engine state.
 */
export const toMidnightStateView = (state: FacadeState): MidnightStateView => {
  const { availableCoins, pendingCoins } = state.unshielded;
  return {
    unshielded: {
      availableCoins: plainCoins(availableCoins),
      pendingCoins: plainCoins(pendingCoins),
    },
    dust: {
      ...midnightDustBalances(state),
      generation: dustGenerationDetailsOf(state.dust.totalCoins),
    },
    shieldedPublicKeys: shieldedPublicKeysOfState(state),
    isStrictlyComplete: strictCompletionOfState(state),
  };
};
