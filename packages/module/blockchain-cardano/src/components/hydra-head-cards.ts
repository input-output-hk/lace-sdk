import { fromHydraHeadsIndexSnapshot } from '@lace-contract/cardano-context';
import { toHydraHeadCards as toCards } from '@lace-lib/hydra-head';
import {
  convertAmountToDenominated,
  valueToLocale,
} from '@lace-lib/util-render';

import type {
  HydraHeadsIndexDeposit,
  HydraHeadsIndexHead,
} from '@lace-contract/cardano-context';
import type { TranslationKey } from '@lace-contract/i18n';
import type { HydraHeadCard, HydraRemainingTime } from '@lace-lib/hydra-head';
import type {
  HydraHeadCardProps,
  HydraHeadDeposit,
} from '@lace-lib/ui-toolkit';

/** Characters of a head id kept before the ellipsis. */
const HEAD_ID_PREFIX_LENGTH = 8;
/** Characters of a head id kept after the ellipsis. */
const HEAD_ID_SUFFIX_LENGTH = 4;

/**
 * Translates a key, picking its plural form from a numeric `count` the way
 * the i18next `t` does.
 */
type TFunction = (
  key: TranslationKey,
  values?: Record<string, number | string>,
) => string;

/** The native currency a head's amounts are shown in. */
export type HydraHeadCurrency = {
  decimals: number;
  ticker: string;
};

/** A head card, ready to render, with the identity of its head. */
type HydraHeadCardModel = HydraHeadCardProps & {
  headId: string;
};

/** The cards to show, and when they next change because time passes. */
type HydraHeadCardsModel = {
  cards: HydraHeadCardModel[];
  /** Epoch milliseconds of the next change a deadline causes, if any. */
  nextChangeAt?: number;
};

/**
 * The remaining time as at most two units, for example "2d 3h", "1h 5m" or
 * "42m".
 */
const formatRemainingTime = (
  { days, hours, minutes }: HydraRemainingTime,
  t: TFunction,
): string => {
  const label = (unit: 'days' | 'hours' | 'minutes', value: number) =>
    t(`v2.portfolio.hydra-heads.duration.${unit}`, { value: String(value) });
  const pair = (major: string, minor: string) =>
    t('v2.portfolio.hydra-heads.duration.pair', { major, minor });
  if (days > 0) {
    return hours > 0
      ? pair(label('days', days), label('hours', hours))
      : label('days', days);
  }
  if (hours > 0) {
    return minutes > 0
      ? pair(label('hours', hours), label('minutes', minutes))
      : label('hours', hours);
  }
  return label('minutes', minutes);
};

/** The head id with its middle left out, for example "324c8b81...5bdc". */
const shortenHeadId = (headId: string): string =>
  headId.length <= HEAD_ID_PREFIX_LENGTH + HEAD_ID_SUFFIX_LENGTH
    ? headId
    : `${headId.slice(0, HEAD_ID_PREFIX_LENGTH)}...${headId.slice(
        -HEAD_ID_SUFFIX_LENGTH,
      )}`;

/** The lovelace of a value as an amount with the currency ticker. */
const formatCoins = (
  coins: bigint,
  { decimals, ticker }: HydraHeadCurrency,
): string =>
  `${valueToLocale(
    convertAmountToDenominated(coins.toString(), decimals),
  )} ${ticker}`;

/** The wording and colour of what the head is doing. */
const formatState = (
  { state }: HydraHeadCard,
  t: TFunction,
): Pick<HydraHeadCardProps, 'stateLabel' | 'stateTone'> => {
  switch (state.kind) {
    case 'open':
      return {
        stateLabel: t('v2.portfolio.hydra-heads.state.open'),
        stateTone: 'open',
      };
    case 'closing':
      return {
        stateLabel: t('v2.portfolio.hydra-heads.state.closing', {
          time: formatRemainingTime(state.remaining, t),
        }),
        stateTone: 'closing',
      };
    case 'closed':
      return {
        stateLabel: t('v2.portfolio.hydra-heads.state.closed'),
        stateTone: 'closing',
      };
    case 'payingOut':
      return {
        stateLabel: t('v2.portfolio.hydra-heads.state.paying-out'),
        stateTone: 'closing',
      };
  }
};

/** The deposited amount and, when any, the withdrawn amount beside it. */
const formatFunds = (
  { funds }: HydraHeadCard,
  currency: HydraHeadCurrency,
  t: TFunction,
): string | undefined => {
  if (funds === undefined) return undefined;
  const deposited = t('v2.portfolio.hydra-heads.deposited', {
    amount: formatCoins(funds.deposited, currency),
  });
  return funds.withdrawn === undefined
    ? deposited
    : t('v2.portfolio.hydra-heads.amounts', {
        deposited,
        withdrawn: t('v2.portfolio.hydra-heads.withdrawn', {
          amount: formatCoins(funds.withdrawn, currency),
        }),
      });
};

/** One line per status of the deposits waiting for the head. */
const formatWaiting = (
  { waiting }: HydraHeadCard,
  currency: HydraHeadCurrency,
  t: TFunction,
): HydraHeadDeposit[] | undefined => {
  if (waiting === undefined) return undefined;
  const lines: HydraHeadDeposit[] = [];
  if (waiting.pending !== undefined) {
    lines.push({
      label: t('v2.portfolio.hydra-heads.waiting', {
        amount: formatCoins(waiting.pending, currency),
      }),
      tone: 'pending',
    });
  }
  if (waiting.recoverable !== undefined) {
    lines.push({
      label: t('v2.portfolio.hydra-heads.recoverable', {
        amount: formatCoins(waiting.recoverable, currency),
      }),
      tone: 'recoverable',
    });
  }
  return lines;
};

/** Who else is in the head. */
const formatParticipants = (
  { participants }: HydraHeadCard,
  t: TFunction,
): string | undefined =>
  participants &&
  t(
    participants.isShared
      ? 'v2.portfolio.hydra-heads.shared'
      : 'v2.portfolio.hydra-heads.participants',
    { count: participants.count },
  );

/** Words and formats one card. */
const formatCard = (
  card: HydraHeadCard,
  currency: HydraHeadCurrency,
  t: TFunction,
): HydraHeadCardModel => {
  const total = t('v2.portfolio.hydra-heads.total', {
    amount: formatCoins(card.total, currency),
  });
  const shared = formatParticipants(card, t);
  const totalAndShared = shared
    ? t('v2.portfolio.hydra-heads.details', { total, shared })
    : total;
  const [amount, amountDetail] = card.leadsWithFunds
    ? [formatFunds(card, currency, t), totalAndShared]
    : [total, shared];
  return {
    headId: card.headId,
    title: t('v2.portfolio.hydra-heads.head', {
      id: shortenHeadId(card.headId),
    }),
    ...formatState(card, t),
    amount,
    deposits: formatWaiting(card, currency, t),
    amountDetail,
    footnote: t('v2.portfolio.hydra-heads.footnote'),
    testID: `hydra-head-${card.headId}`,
  };
};

/**
 * Words and formats the cards of the heads the account has funds in, as of
 * `now` in epoch milliseconds, from the account's Hydra heads index snapshot.
 * What each card says comes from `toHydraHeadCards`; only the wording and
 * the number formatting are decided here.
 */
export const toHydraHeadCards = ({
  heads,
  deposits,
  now,
  currency,
  t,
}: {
  heads: readonly HydraHeadsIndexHead[];
  deposits: readonly HydraHeadsIndexDeposit[];
  now: number;
  currency: HydraHeadCurrency;
  t: TFunction;
}): HydraHeadCardsModel => {
  const { cards, nextChangeAt } = toCards({
    ...fromHydraHeadsIndexSnapshot({ heads, deposits }),
    now,
  });
  return {
    cards: cards.map(card => formatCard(card, currency, t)),
    ...(nextChangeAt === undefined ? {} : { nextChangeAt }),
  };
};
