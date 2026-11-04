import { createUICustomisation } from '@lace-lib/util-render';

import { HydraHeadsPortfolioBanner } from '../components/HydraHeadsPortfolioBanner';

import type { PortfolioBannerUICustomisation } from '@lace-contract/app';

const CARDANO_BLOCKCHAIN_NAME = 'Cardano';

const portfolioBannerCustomisation =
  createUICustomisation<PortfolioBannerUICustomisation>({
    key: 'cardano',
    uiCustomisationSelector: (blockchainName?: string) =>
      blockchainName === CARDANO_BLOCKCHAIN_NAME,
    PortfolioBanner: HydraHeadsPortfolioBanner,
  });

const loadPortfolioBannerCustomisation = () => portfolioBannerCustomisation;

export default loadPortfolioBannerCustomisation;
