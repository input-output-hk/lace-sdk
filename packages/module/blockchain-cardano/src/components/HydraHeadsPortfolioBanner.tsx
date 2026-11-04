import {
  FEATURE_FLAG_HYDRA_HEADS,
  getCardanoNativeTokenInfoForNetwork,
} from '@lace-contract/cardano-context';
import { useTranslation } from '@lace-contract/i18n';
import { AccountId } from '@lace-contract/wallet-repo';
import { HydraHeadCard, HydraHeadsSection } from '@lace-lib/ui-toolkit';
import React, { useEffect, useMemo, useState } from 'react';

import { useLaceSelector } from '../hooks';

import { toHydraHeadCards } from './hydra-head-cards';

import type { PortfolioBannerAssetView } from '@lace-contract/app';
import type {
  HydraHeadsIndexDeposit,
  HydraHeadsIndexHead,
} from '@lace-contract/cardano-context';

/** Props of the banner listing the Hydra heads of one account. */
interface HydraHeadsPortfolioBannerProps {
  /** The Cardano account whose heads are listed. */
  accountId: string;
  /** The portfolio tab in view; heads show only on the tokens tab. */
  assetView?: PortfolioBannerAssetView;
}

/** A stable empty list for an account the index has no heads for. */
const NO_HEADS: HydraHeadsIndexHead[] = [];

/** A stable empty list for an account the index has no deposits for. */
const NO_DEPOSITS: HydraHeadsIndexDeposit[] = [];

/** The longest delay `setTimeout` honours; a longer one fires at once. */
const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * Lists the Hydra heads one Cardano account has funds in, under the account's
 * Tokens tab. The funds sit in the heads rather than in the account, so they
 * are shown apart and never added to a balance or to the portfolio total.
 * Renders nothing while the Hydra Head feature flag is off, on the other tabs,
 * or when the account has no head. A single timer refreshes the countdowns
 * of closing heads, and the deposits that turn recoverable, while the section
 * is visible, rather than one per card.
 */
export const HydraHeadsPortfolioBanner = ({
  accountId,
  assetView,
}: HydraHeadsPortfolioBannerProps) => {
  const { t } = useTranslation();
  const { featureFlags } = useLaceSelector('features.selectLoadedFeatures');
  const heads = useLaceSelector(
    'hydraHeadsIndex.selectHydraHeadsByAccount',
    AccountId(accountId),
  );
  const deposits = useLaceSelector(
    'hydraHeadsIndex.selectHydraDepositsByAccount',
    AccountId(accountId),
  );
  const networkType = useLaceSelector('network.selectNetworkType');

  const isVisible =
    assetView === 'tokens' &&
    featureFlags.some(flag => flag.key === FEATURE_FLAG_HYDRA_HEADS);

  const currency = useMemo(() => {
    const { decimals, displayShortName } =
      getCardanoNativeTokenInfoForNetwork(networkType);
    return { decimals, ticker: displayShortName };
  }, [networkType]);

  const [now, setNow] = useState(Date.now);
  const { cards, nextChangeAt } = useMemo(
    () =>
      toHydraHeadCards({
        heads: isVisible ? heads : NO_HEADS,
        deposits: isVisible ? deposits : NO_DEPOSITS,
        now,
        currency,
        t,
      }),
    [isVisible, heads, deposits, now, currency, t],
  );

  useEffect(() => {
    if (nextChangeAt === undefined) return;
    const timeout = setTimeout(() => {
      setNow(Date.now());
    }, Math.min(Math.max(nextChangeAt - Date.now(), 0), MAX_TIMEOUT_MS));
    return () => {
      clearTimeout(timeout);
    };
  }, [nextChangeAt, now]);

  if (cards.length === 0) return null;

  return (
    <HydraHeadsSection
      title={t('v2.portfolio.hydra-heads.title')}
      testID="hydra-heads-section">
      {cards.map(({ headId, ...card }) => (
        <HydraHeadCard key={headId} {...card} />
      ))}
    </HydraHeadsSection>
  );
};
