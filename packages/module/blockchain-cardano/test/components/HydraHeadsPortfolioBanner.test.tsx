import { FEATURE_FLAG_HYDRA_HEADS } from '@lace-contract/cardano-context';
import { BigNumber } from '@lace-lib/util';
import React from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HydraHeadsPortfolioBanner } from '../../src/components/HydraHeadsPortfolioBanner';

import type {
  HydraHeadsIndexDeposit,
  HydraHeadsIndexHead,
} from '@lace-contract/cardano-context';
import type { ReactTestRenderer } from 'react-test-renderer';

const HEAD_ID = '324c8b8198c4c9db7526d6dccb79e992c4863b24b56453bb16995bdc';
const ACCOUNT_ID = 'cardano-1';

const { selectorState } = vi.hoisted(() => ({
  selectorState: {
    featureFlags: [] as { key: string }[],
    headsByAccount: {} as Record<string, unknown[]>,
    depositsByAccount: {} as Record<string, unknown[]>,
    requested: [] as unknown[][],
  },
}));

vi.mock('../../src/hooks', () => ({
  useLaceSelector: (selector: string, ...params: unknown[]) => {
    selectorState.requested.push([selector, ...params]);
    switch (selector) {
      case 'features.selectLoadedFeatures':
        return { featureFlags: selectorState.featureFlags };
      case 'network.selectNetworkType':
        return 'testnet';
      case 'hydraHeadsIndex.selectHydraDepositsByAccount':
        return selectorState.depositsByAccount[params[0] as string] ?? [];
      default:
        return selectorState.headsByAccount[params[0] as string] ?? [];
    }
  },
}));

vi.mock('@lace-contract/i18n', async importOriginal => ({
  ...(await importOriginal<object>()),
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      `${key}${params ? JSON.stringify(params) : ''}`,
  }),
}));

vi.mock('@lace-lib/ui-toolkit', () => ({
  HydraHeadsSection: 'HydraHeadsSection',
  HydraHeadCard: 'HydraHeadCard',
}));

const openHead: HydraHeadsIndexHead = {
  headId: HEAD_ID,
  version: '2.0.0',
  outpoint: { txId: 'aa'.repeat(32), index: 0 },
  state: 'open',
  headValue: { coins: BigNumber(12_000_000n), assets: {} },
  participantCount: 1,
  isParticipant: true,
  isSoleParticipant: true,
  depositedValue: { coins: BigNumber(10_000_000n), assets: {} },
  withdrawnValue: { coins: BigNumber(0n), assets: {} },
};

const render = (
  props: Partial<React.ComponentProps<typeof HydraHeadsPortfolioBanner>> = {},
): ReactTestRenderer => {
  let renderer: ReactTestRenderer | undefined;
  act(() => {
    renderer = create(
      <HydraHeadsPortfolioBanner
        accountId={ACCOUNT_ID}
        assetView="tokens"
        {...props}
      />,
    );
  });
  if (!renderer) throw new Error('banner did not render');
  return renderer;
};

describe('HydraHeadsPortfolioBanner', () => {
  beforeEach(() => {
    selectorState.featureFlags = [{ key: FEATURE_FLAG_HYDRA_HEADS }];
    selectorState.headsByAccount = { [ACCOUNT_ID]: [openHead] };
    selectorState.depositsByAccount = {};
    selectorState.requested = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('lists the heads of the account on the Tokens tab', () => {
    const renderer = render();

    const cards = renderer.root.findAllByType('HydraHeadCard' as never);
    expect(cards).toHaveLength(1);
    expect(cards[0].props).toMatchObject({
      stateTone: 'open',
      amount: 'v2.portfolio.hydra-heads.deposited{"amount":"10 tADA"}',
    });
    expect(selectorState.requested).toContainEqual([
      'hydraHeadsIndex.selectHydraHeadsByAccount',
      ACCOUNT_ID,
    ]);
  });

  it('renders nothing for an account without heads', () => {
    selectorState.headsByAccount = { 'other-account': [openHead] };

    expect(render().toJSON()).toBeNull();
  });

  it('renders nothing while the feature flag is off', () => {
    selectorState.featureFlags = [];

    expect(render().toJSON()).toBeNull();
  });

  it.each(['nfts', 'activities', undefined] as const)(
    'renders nothing on the %s tab',
    assetView => {
      expect(render({ assetView }).toJSON()).toBeNull();
    },
  );

  it('updates the countdown of a closing head when its time passes', () => {
    vi.useFakeTimers();
    const now = Date.parse('2026-09-01T12:00:00.000Z');
    vi.setSystemTime(now);
    selectorState.headsByAccount = {
      [ACCOUNT_ID]: [
        {
          ...openHead,
          state: 'closed',
          contestationDeadline: new Date(now + 90_000).toISOString(),
        },
      ],
    };

    const renderer = render();
    expect(vi.getTimerCount()).toBe(1);
    const label = () =>
      renderer.root.findByType('HydraHeadCard' as never).props
        .stateLabel as string;
    expect(label()).toMatch(/value\\+":\\+"2/);

    act(() => {
      vi.advanceTimersByTime(31_000);
    });
    expect(label()).toMatch(/value\\+":\\+"1/);

    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(label()).toBe('v2.portfolio.hydra-heads.state.closed');
  });

  it('turns a waiting deposit recoverable once its deadline passes', () => {
    vi.useFakeTimers();
    const now = Date.parse('2026-09-01T12:00:00.000Z');
    vi.setSystemTime(now);
    const deposit: HydraHeadsIndexDeposit = {
      outpoint: { txId: 'bb'.repeat(32), index: 0 },
      headId: HEAD_ID,
      deadline: new Date(now + 60_000).toISOString(),
      value: { coins: BigNumber(4_630_000n), assets: {} },
      status: 'pending',
    };
    selectorState.depositsByAccount = { [ACCOUNT_ID]: [deposit] };

    const renderer = render();
    const deposits = () =>
      renderer.root.findByType('HydraHeadCard' as never).props.deposits as {
        tone: string;
      }[];
    expect(deposits()).toEqual([expect.objectContaining({ tone: 'pending' })]);
    expect(selectorState.requested).toContainEqual([
      'hydraHeadsIndex.selectHydraDepositsByAccount',
      ACCOUNT_ID,
    ]);

    act(() => {
      vi.advanceTimersByTime(60_001);
    });
    expect(deposits()).toEqual([
      expect.objectContaining({ tone: 'recoverable' }),
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears the countdown timer on unmount', () => {
    vi.useFakeTimers();
    const now = Date.parse('2026-09-01T12:00:00.000Z');
    vi.setSystemTime(now);
    selectorState.headsByAccount = {
      [ACCOUNT_ID]: [
        {
          ...openHead,
          state: 'closed',
          contestationDeadline: new Date(now + 90_000).toISOString(),
        },
      ],
    };

    const renderer = render();
    expect(vi.getTimerCount()).toBe(1);

    act(() => {
      renderer.unmount();
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});
