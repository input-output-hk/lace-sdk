import { ActivityType } from '@lace-contract/activities';
import { TokenId } from '@lace-contract/tokens';
import { AccountId } from '@lace-contract/wallet-repo';
import { BigNumber, Timestamp } from '@lace-lib/util';
import { formatDate, formatTime } from '@lace-lib/util-render';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import {
  activityListRowKey,
  formatAndGroupActivitiesByDate,
} from '../src/utils/formatActivity';

import type { Activity, ActivityStates } from '@lace-contract/activities';
import type { MetadataByTokenId } from '@lace-contract/tokens';

const fakeNowTimestamp = 1746526784955;
const hour = 1000 * 60 * 60;
const day = hour * 24;

vi.useFakeTimers().setSystemTime(new Date(fakeNowTimestamp));

const tokenId1 = TokenId('lovelace');
const tokenId2 = TokenId('0200000');
const tokenId3 = TokenId('0200001');

const tokensMetadataByTokenId: MetadataByTokenId = {
  [tokenId1]: {
    tokenId: tokenId1,
    decimals: 6,
    ticker: 'ADA',
    displayDecimalPlaces: 2,
    blockchainSpecific: {},
  },
  [tokenId2]: {
    tokenId: tokenId2,
    decimals: 2,
    ticker: 'tDust',
    displayDecimalPlaces: 2,
    blockchainSpecific: {},
  },
  [tokenId3]: {
    tokenId: tokenId3,
    decimals: 0,
    ticker: 'NFT',
    displayDecimalPlaces: 0,
    blockchainSpecific: {},
  },
};

const accountId = AccountId('account1');

const mockT = vi.fn((key: string) => {
  const translations: Record<string, string> = {
    'activity.label.today': 'Today',
    'activity.history.send': 'Send',
    'activity.history.receive': 'Receive',
    'activity.history.reward': 'Reward',
    'activity.history.self': 'Self',
    'activity.history.failed.title': 'Failed',
    'activity.history.pending.title': 'Pending',
    'activity.history.failed.subtitle': 'Transaction failed',
    'activity.history.pending.sending': 'Sending...',
    'activity.history.pending.receiving': 'Receiving...',
    'activity.unknown.ticker': 'Unknown',
    'activity.history.delegation': 'Delegation',
    'activity.history.registration': 'Registration',
    'activity.history.deregistration': 'Deregistration',
    'activity.history.withdrawal': 'Withdrawal',
    'activity.history.night-designation': 'DUST designation',
    'activity.history.night-designation.update': 'DUST target changed',
    'activity.history.night-designation.deregister': 'DUST generation stopped',
    'activity.history.hydra': 'Hydra',
    'activity.history.hydra.deposit': 'Hydra deposit',
    'activity.history.hydra.deposit.pending': 'Entering head...',
    'activity.history.hydra.deposit.recoverable': 'Recoverable',
    'activity.history.hydra.recover': 'Hydra recover',
    'activity.history.hydra.init': 'Hydra init',
    'activity.history.hydra.abort': 'Hydra abort',
    'activity.history.hydra.commit': 'Hydra commit',
    'activity.history.hydra.collect': 'Hydra collect',
    'activity.history.hydra.increment': 'Hydra increment',
    'activity.history.hydra.decommit': 'Hydra decommit',
    'activity.history.hydra.close': 'Hydra close',
    'activity.history.hydra.contest': 'Hydra contest',
    'activity.history.hydra.fanout': 'Hydra fanout',
    'activity.assets.nfts': 'NFTs',
    'activity.assets.tokens': 'Tokens',
    'activity.assets.mixed': 'Mixed',
  };
  return translations[key] || key;
});

describe('formatAndGroupActivitiesByDate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('basic functionality', () => {
    it('returns empty array when no activities provided', () => {
      const result = formatAndGroupActivitiesByDate({
        activities: [],
        t: mockT,
        tokensMetadataByTokenId,
      });

      expect(result).toEqual([]);
    });

    it('groups activities by date and sorts them by timestamp descending', () => {
      const activity1: Activity = {
        accountId,
        activityId: 'activity1',
        timestamp: Timestamp(fakeNowTimestamp - 12 * day),
        tokenBalanceChanges: [
          { tokenId: tokenId1, amount: BigNumber(1000000n) }, // 1 ADA
        ],
        type: ActivityType.Receive,
      };

      const activity2: Activity = {
        accountId,
        activityId: 'activity2',
        timestamp: Timestamp(fakeNowTimestamp - 3 * hour),
        tokenBalanceChanges: [
          { tokenId: tokenId1, amount: BigNumber(500000n) }, // 0.5 ADA
        ],
        type: ActivityType.Send,
      };

      const activity3: Activity = {
        accountId,
        activityId: 'activity3',
        timestamp: Timestamp(fakeNowTimestamp),
        tokenBalanceChanges: [
          { tokenId: tokenId1, amount: BigNumber(2000000n) }, // 2 ADA
        ],
        type: ActivityType.Send,
      };

      const result = formatAndGroupActivitiesByDate({
        activities: [activity1, activity2, activity3],
        t: mockT,
        tokensMetadataByTokenId,
      });

      expect(result).toEqual([
        // Today's activities (sorted by timestamp descending)
        expect.objectContaining({
          date: 'Today',
          items: [
            expect.objectContaining({
              id: 'activity3',
              rowKey: 'activity3-Send',
            }),
            expect.objectContaining({
              id: 'activity2',
              rowKey: 'activity2-Send',
            }),
          ],
        }),
        // Previous day's activities
        expect.objectContaining({
          date: formatDate({
            date: activity1.timestamp,
            type: 'local',
          }),
          items: [
            expect.objectContaining({
              id: 'activity1',
              rowKey: 'activity1-Receive',
            }),
          ],
        }),
      ]);
    });

    it('assigns distinct rowKeys when the same activity id appears for multiple activity types', () => {
      const sharedId = 'same-tx';
      const delegation: Activity = {
        accountId,
        activityId: sharedId,
        timestamp: Timestamp(fakeNowTimestamp),
        tokenBalanceChanges: [
          { tokenId: tokenId1, amount: BigNumber(-2000000n) },
        ],
        type: ActivityType.Delegation,
      };
      const registration: Activity = {
        accountId,
        activityId: sharedId,
        timestamp: Timestamp(fakeNowTimestamp),
        tokenBalanceChanges: [
          { tokenId: tokenId1, amount: BigNumber(-2000000n) },
        ],
        type: ActivityType.Registration,
      };

      const result = formatAndGroupActivitiesByDate({
        activities: [delegation, registration],
        t: mockT,
        tokensMetadataByTokenId,
      });

      const rowKeys = result[0].items.map(index => index.rowKey);
      expect(new Set(rowKeys).size).toBe(2);
      expect(rowKeys).toContain('same-tx-Delegation');
      expect(rowKeys).toContain('same-tx-Registration');
    });
  });

  describe('default activity type formatting with single balance change', () => {
    it('formats Send activity correctly', () => {
      const activity: Activity = {
        accountId,
        activityId: 'send-activity',
        timestamp: Timestamp(fakeNowTimestamp),
        tokenBalanceChanges: [
          { tokenId: tokenId1, amount: BigNumber(1000000n) },
        ],
        type: ActivityType.Send,
      };

      const result = formatAndGroupActivitiesByDate({
        activities: [activity],
        t: mockT,
        tokensMetadataByTokenId,
      });

      expect(result).toEqual([
        {
          date: 'Today',
          dateIcon: 'Calendar03',
          items: [
            {
              id: activity.activityId,
              rowKey: activityListRowKey(activity),
              iconBackground: 'positive',
              iconName: 'ArrowUp03',
              info: {
                subtitle: formatTime({
                  date: activity.timestamp,
                  type: 'local',
                }),
                title: 'send-activity',
              },
              status: 'sent',
              timestamp: activity.timestamp,
              value: {
                title: {
                  amount: '1.00',
                  label: 'ADA',
                },
              },
            },
          ],
        },
      ]);
    });

    it('formats Receive activity correctly', () => {
      const activity: Activity = {
        accountId,
        activityId: 'receive-activity',
        timestamp: Timestamp(fakeNowTimestamp),
        tokenBalanceChanges: [
          { tokenId: tokenId1, amount: BigNumber(2000000n) },
        ],
        type: ActivityType.Receive,
      };

      const result = formatAndGroupActivitiesByDate({
        activities: [activity],
        t: mockT,
        tokensMetadataByTokenId,
      });

      expect(result).toEqual([
        {
          date: 'Today',
          dateIcon: 'Calendar03',
          items: [
            {
              id: activity.activityId,
              rowKey: activityListRowKey(activity),
              iconBackground: 'positive',
              iconName: 'ArrowDown03',
              info: {
                subtitle: formatTime({
                  date: activity.timestamp,
                  type: 'local',
                }),
                title: 'receive-activity',
              },
              status: 'received',
              timestamp: activity.timestamp,
              value: {
                title: {
                  amount: '2.00',
                  label: 'ADA',
                },
              },
            },
          ],
        },
      ]);
    });

    it('formats Rewards activity correctly', () => {
      const activity: Activity = {
        accountId,
        activityId: 'rewards-activity',
        timestamp: Timestamp(fakeNowTimestamp),
        tokenBalanceChanges: [
          { tokenId: tokenId1, amount: BigNumber(5000000n) },
        ],
        type: ActivityType.Rewards,
      };

      const result = formatAndGroupActivitiesByDate({
        activities: [activity],
        t: mockT,
        tokensMetadataByTokenId,
      });

      expect(result).toEqual([
        {
          date: 'Today',
          dateIcon: 'Calendar03',
          items: [
            {
              id: activity.activityId,
              rowKey: activityListRowKey(activity),
              iconBackground: 'positive',
              iconName: 'Gift',
              info: {
                subtitle: formatTime({
                  date: activity.timestamp,
                  type: 'local',
                }),
                title: 'Reward',
              },
              status: 'rewards',
              timestamp: activity.timestamp,
              value: {
                title: {
                  amount: '5.00',
                  label: 'ADA',
                },
              },
            },
          ],
        },
      ]);
    });

    it('formats Self activity correctly', () => {
      const activity: Activity = {
        accountId,
        activityId: 'self-activity',
        timestamp: Timestamp(fakeNowTimestamp),
        tokenBalanceChanges: [
          { tokenId: tokenId1, amount: BigNumber(1000000n) },
        ],
        type: ActivityType.Self,
      };

      const result = formatAndGroupActivitiesByDate({
        activities: [activity],
        t: mockT,
        tokensMetadataByTokenId,
      });

      expect(result).toEqual([
        {
          date: 'Today',
          dateIcon: 'Calendar03',
          items: [
            {
              id: activity.activityId,
              rowKey: activityListRowKey(activity),
              iconBackground: 'secondary',
              iconName: 'Recycle03',
              info: {
                subtitle: formatTime({
                  date: activity.timestamp,
                  type: 'local',
                }),
                title: 'Self',
              },
              status: 'received',
              timestamp: activity.timestamp,
              value: {
                title: {
                  amount: '1.00',
                  label: 'ADA',
                },
              },
            },
          ],
        },
      ]);
    });

    it('formats Failed activity correctly', () => {
      const activity: Activity = {
        accountId,
        activityId: 'failed-activity',
        timestamp: Timestamp(fakeNowTimestamp),
        tokenBalanceChanges: [
          { tokenId: tokenId1, amount: BigNumber(1000000n) },
        ],
        type: ActivityType.Failed,
      };

      const result = formatAndGroupActivitiesByDate({
        activities: [activity],
        t: mockT,
        tokensMetadataByTokenId,
      });

      expect(result).toEqual([
        {
          date: 'Today',
          dateIcon: 'Calendar03',
          items: [
            {
              id: activity.activityId,
              rowKey: activityListRowKey(activity),
              iconBackground: 'negative',
              iconName: 'AlertTriangle',
              info: {
                title: 'Failed',
              },
              status: 'failed',
              timestamp: activity.timestamp,
              value: {
                subtitle: 'Transaction failed',
              },
            },
          ],
        },
      ]);
    });

    it('formats Pending activity correctly', () => {
      const activity: Activity = {
        accountId,
        activityId: 'pending-activity',
        timestamp: Timestamp(fakeNowTimestamp),
        tokenBalanceChanges: [
          { tokenId: tokenId1, amount: BigNumber(1000000n) },
        ],
        type: ActivityType.Pending,
      };

      const result = formatAndGroupActivitiesByDate({
        activities: [activity],
        t: mockT,
        tokensMetadataByTokenId,
      });

      expect(result).toEqual([
        {
          date: 'Today',
          dateIcon: 'Calendar03',
          items: [
            {
              id: activity.activityId,
              rowKey: activityListRowKey(activity),
              iconBackground: 'neutral',
              iconName: 'Loading03',
              info: {
                title: 'Pending',
              },
              status: 'pending',
              timestamp: activity.timestamp,
              value: {
                subtitle: 'Receiving...',
              },
            },
          ],
        },
      ]);
    });

    it('formats Delegation activity correctly', () => {
      const activity: Activity = {
        accountId,
        activityId: 'delegation-activity',
        timestamp: Timestamp(fakeNowTimestamp),
        tokenBalanceChanges: [
          { tokenId: tokenId1, amount: BigNumber(-2000000n) },
        ],
        type: ActivityType.Delegation,
      };

      const result = formatAndGroupActivitiesByDate({
        activities: [activity],
        t: mockT,
        tokensMetadataByTokenId,
      });

      expect(result[0].items[0]).toMatchObject({
        id: activity.activityId,
        rowKey: activityListRowKey(activity),
        iconBackground: 'secondary',
        iconName: 'ArrowUp03',
        status: 'delegation',
        info: {
          title: 'Delegation',
        },
      });
    });

    it('formats Registration activity correctly', () => {
      const activity: Activity = {
        accountId,
        activityId: 'registration-activity',
        timestamp: Timestamp(fakeNowTimestamp),
        tokenBalanceChanges: [
          { tokenId: tokenId1, amount: BigNumber(-2000000n) },
        ],
        type: ActivityType.Registration,
      };

      const result = formatAndGroupActivitiesByDate({
        activities: [activity],
        t: mockT,
        tokensMetadataByTokenId,
      });

      expect(result[0].items[0]).toMatchObject({
        id: activity.activityId,
        rowKey: activityListRowKey(activity),
        iconBackground: 'secondary',
        iconName: 'ArrowUp03',
        status: 'registration',
        info: {
          title: 'Registration',
        },
      });
    });

    it('formats Deregistration activity correctly', () => {
      const activity: Activity = {
        accountId,
        activityId: 'deregistration-activity',
        timestamp: Timestamp(fakeNowTimestamp),
        tokenBalanceChanges: [
          { tokenId: tokenId1, amount: BigNumber(1995000n) },
        ],
        type: ActivityType.Deregistration,
      };

      const result = formatAndGroupActivitiesByDate({
        activities: [activity],
        t: mockT,
        tokensMetadataByTokenId,
      });

      expect(result[0].items[0]).toMatchObject({
        id: activity.activityId,
        rowKey: activityListRowKey(activity),
        iconBackground: 'secondary',
        iconName: 'ArrowDown03',
        status: 'deregistration',
        info: {
          title: 'Deregistration',
        },
      });
    });

    it.each([
      ['designate', 'DUST designation'],
      ['update', 'DUST target changed'],
      ['deregister', 'DUST generation stopped'],
    ] as const)(
      'formats a NightDesignation activity with action %s using the per-action label',
      (action, expectedTitle) => {
        const activity: Activity = {
          accountId,
          activityId: `night-designation-${action}-activity`,
          timestamp: Timestamp(fakeNowTimestamp),
          tokenBalanceChanges: [
            { tokenId: tokenId1, amount: BigNumber(-2000000n) },
          ],
          type: ActivityType.NightDesignation,
          blockchainSpecific: { Cardano: { nightDesignation: { action } } },
        };

        const result = formatAndGroupActivitiesByDate({
          activities: [activity],
          t: mockT,
          tokensMetadataByTokenId,
        });

        expect(result[0].items[0]).toMatchObject({
          id: activity.activityId,
          rowKey: activityListRowKey(activity),
          iconBackground: 'secondary',
          iconName: 'Moon',
          status: 'nightDesignation',
          info: {
            title: expectedTitle,
          },
        });
      },
    );

    it.each([
      ['no blockchainSpecific at all', undefined],
      ['Cardano metadata without a nightDesignation entry', { Cardano: {} }],
      [
        'an action outside the known union',
        { Cardano: { nightDesignation: { action: 'future-action' } } },
      ],
    ])(
      'formats a NightDesignation activity with %s using the generic fallback label',
      (_shape, blockchainSpecific) => {
        const activity: Activity = {
          accountId,
          activityId: 'night-designation-activity',
          timestamp: Timestamp(fakeNowTimestamp),
          tokenBalanceChanges: [
            { tokenId: tokenId1, amount: BigNumber(-2000000n) },
          ],
          type: ActivityType.NightDesignation,
          ...(blockchainSpecific === undefined ? {} : { blockchainSpecific }),
        };

        const result = formatAndGroupActivitiesByDate({
          activities: [activity],
          t: mockT,
          tokensMetadataByTokenId,
        });

        expect(result[0].items[0]).toMatchObject({
          id: activity.activityId,
          rowKey: activityListRowKey(activity),
          iconBackground: 'secondary',
          iconName: 'Moon',
          status: 'nightDesignation',
          info: {
            title: 'DUST designation',
          },
        });
      },
    );

    describe('Hydra metadata', () => {
      const buildHydraActivity = (
        type: ActivityType.Receive | ActivityType.Send,
        blockchainSpecific?: unknown,
      ): Activity => ({
        accountId,
        activityId: 'hydra-activity',
        timestamp: Timestamp(fakeNowTimestamp),
        tokenBalanceChanges: [
          { tokenId: tokenId1, amount: BigNumber(-2000000n) },
        ],
        type,
        ...(blockchainSpecific === undefined ? {} : { blockchainSpecific }),
      });

      const taggingEnabled: ActivityStates = {
        byActivityId: {},
        isTaggingEnabled: true,
      };

      it.each([
        ['DepositTx', 'Hydra deposit', 'hydraDeposit'],
        ['RecoverTx', 'Hydra recover', 'hydraRecover'],
        ['InitTx', 'Hydra init', 'hydra'],
        ['AbortTx', 'Hydra abort', 'hydra'],
        ['CommitTx', 'Hydra commit', 'hydra'],
        ['CollectComTx', 'Hydra collect', 'hydra'],
        ['IncrementTx', 'Hydra increment', 'hydra'],
        ['CloseTx', 'Hydra close', 'hydra'],
        ['ContestTx', 'Hydra contest', 'hydra'],
        ['FanoutTx', 'Hydra fanout', 'hydra'],
        ['PartialFanoutTx', 'Hydra fanout', 'hydra'],
        ['FinalPartialFanoutTx', 'Hydra fanout', 'hydra'],
        ['DecrementTx', 'Hydra decommit', 'hydra'],
        ['HeadTx', 'Hydra', 'hydra'],
        ['FutureTx', 'Hydra', 'hydra'],
      ] as const)(
        'keeps the hash title and amount and tags a %s row as "%s"',
        (txName, label, tone) => {
          const activity = buildHydraActivity(ActivityType.Send, {
            Cardano: { hydra: { txName } },
          });

          const result = formatAndGroupActivitiesByDate({
            activities: [activity],
            t: mockT,
            tokensMetadataByTokenId,
            activityStates: taggingEnabled,
          });

          expect(result[0].items[0]).toMatchObject({
            id: activity.activityId,
            status: 'sent',
            iconName: 'FlowConnection',
            iconBackground: 'positive',
            info: {
              title: activity.activityId,
              subtitle: formatTime({
                date: activity.timestamp,
                type: 'local',
              }),
              tags: [{ label, tone }],
            },
            value: { title: { amount: '-2.00' } },
          });
        },
      );

      it('tags a received Hydra row', () => {
        const activity = buildHydraActivity(ActivityType.Receive, {
          Cardano: { hydra: { protocol: 'HydraV2', txName: 'RecoverTx' } },
        });

        const result = formatAndGroupActivitiesByDate({
          activities: [activity],
          t: mockT,
          tokensMetadataByTokenId,
          activityStates: taggingEnabled,
        });

        expect(result[0].items[0]).toMatchObject({
          status: 'received',
          iconName: 'FlowConnection',
          info: { tags: [{ label: 'Hydra recover', tone: 'hydraRecover' }] },
        });
      });

      it('tags a non-transfer row that carries Hydra metadata', () => {
        const activity: Activity = {
          ...buildHydraActivity(ActivityType.Send, {
            Cardano: { hydra: { txName: 'CommitTx' } },
          }),
          type: ActivityType.Withdrawal,
        };

        const result = formatAndGroupActivitiesByDate({
          activities: [activity],
          t: mockT,
          tokensMetadataByTokenId,
          activityStates: taggingEnabled,
        });

        expect(result[0].items[0]).toMatchObject({
          status: 'withdrawal',
          iconName: 'FlowConnection',
          iconBackground: 'secondary',
          info: {
            title: 'Withdrawal',
            tags: [{ label: 'Hydra commit', tone: 'hydra' }],
          },
        });
      });

      it.each([
        ['no blockchainSpecific at all', undefined],
        ['Cardano metadata without a hydra entry', { Cardano: {} }],
      ])('adds no tag with %s', (_shape, blockchainSpecific) => {
        const activity = buildHydraActivity(
          ActivityType.Send,
          blockchainSpecific,
        );

        const result = formatAndGroupActivitiesByDate({
          activities: [activity],
          t: mockT,
          tokensMetadataByTokenId,
          activityStates: taggingEnabled,
        });

        expect(result[0].items[0]).toMatchObject({ iconName: 'ArrowUp03' });
        expect(result[0].items[0].info).not.toHaveProperty('tags');
      });

      describe('while tagging is not enabled', () => {
        const depositActivity = buildHydraActivity(ActivityType.Send, {
          Cardano: { hydra: { txName: 'DepositTx' } },
        });

        it.each([
          ['no activity states', undefined],
          ['activity states without tagging', { byActivityId: {} }],
          [
            'a pending deposit state without tagging',
            {
              byActivityId: {
                [depositActivity.activityId]: {
                  status: 'pending',
                  deadline: '2026-09-01T13:10:29.599Z',
                },
              },
            },
          ],
        ] as const)(
          'renders stored Hydra metadata as a plain row with %s',
          (_case, activityStates) => {
            const [item] = formatAndGroupActivitiesByDate({
              activities: [depositActivity],
              t: mockT,
              tokensMetadataByTokenId,
              activityStates,
            })[0].items;

            expect(item).toMatchObject({
              iconName: 'ArrowUp03',
              value: { title: { amount: '-2.00' } },
            });
            expect(item.info).not.toHaveProperty('tags');
          },
        );
      });

      describe('deposit states', () => {
        const deadline = '2026-09-01T13:10:29.599Z';
        const depositActivity = buildHydraActivity(ActivityType.Send, {
          Cardano: { hydra: { txName: 'DepositTx' } },
        });
        const format = (activity: Activity, activityStates?: unknown) =>
          formatAndGroupActivitiesByDate({
            activities: [activity],
            t: mockT,
            tokensMetadataByTokenId,
            activityStates: {
              byActivityId:
                activityStates === undefined
                  ? {}
                  : { [activity.activityId]: activityStates },
              isTaggingEnabled: true,
            },
          })[0].items[0];

        it('replaces the amount of a pending deposit with "Entering head..."', () => {
          expect(
            format(depositActivity, { status: 'pending', deadline }),
          ).toMatchObject({
            status: 'sent',
            info: {
              title: depositActivity.activityId,
              tags: [{ label: 'Hydra deposit', tone: 'hydraDeposit' }],
            },
            value: { subtitle: 'Entering head...' },
          });
          expect(
            format(depositActivity, { status: 'pending', deadline }).value,
          ).not.toHaveProperty('title');
        });

        it('adds a warning pill to a recoverable deposit and keeps the amount', () => {
          expect(
            format(depositActivity, { status: 'recoverable', deadline }),
          ).toMatchObject({
            info: {
              tags: [
                { label: 'Hydra deposit', tone: 'hydraDeposit' },
                { label: 'Recoverable', tone: 'warning' },
              ],
            },
            value: { title: { amount: '-2.00' } },
          });
        });

        it('renders a settled deposit as a plain Hydra deposit row', () => {
          expect(format(depositActivity)).toMatchObject({
            info: {
              tags: [{ label: 'Hydra deposit', tone: 'hydraDeposit' }],
            },
            value: { title: { amount: '-2.00' } },
          });
        });

        it.each([
          [
            'a Hydra row that is not a deposit',
            buildHydraActivity(ActivityType.Receive, {
              Cardano: { hydra: { txName: 'RecoverTx' } },
            }),
          ],
          [
            'a row without Hydra metadata',
            buildHydraActivity(ActivityType.Send),
          ],
        ])('ignores a state given for %s', (_shape, activity) => {
          expect(
            format(activity, { status: 'pending', deadline }),
          ).toStrictEqual(format(activity));
        });
      });
    });

    it('formats Withdrawal activity correctly', () => {
      const activity: Activity = {
        accountId,
        activityId: 'withdrawal-activity',
        timestamp: Timestamp(fakeNowTimestamp),
        tokenBalanceChanges: [
          { tokenId: tokenId1, amount: BigNumber(5000000n) },
        ],
        type: ActivityType.Withdrawal,
      };

      const result = formatAndGroupActivitiesByDate({
        activities: [activity],
        t: mockT,
        tokensMetadataByTokenId,
      });

      expect(result[0].items[0]).toMatchObject({
        id: activity.activityId,
        rowKey: activityListRowKey(activity),
        iconBackground: 'secondary',
        iconName: 'ArrowDown03',
        status: 'withdrawal',
        info: {
          title: 'Withdrawal',
        },
      });
    });
  });

  describe('ui customizations', () => {
    it('takes an optional customization to get the main token balance change', () => {
      const activity: Activity = {
        accountId,
        activityId: 'send-activity',
        timestamp: Timestamp(fakeNowTimestamp),
        tokenBalanceChanges: [
          { tokenId: tokenId1, amount: BigNumber(1000000n) },
          { tokenId: tokenId2, amount: BigNumber(200n) },
        ],
        type: ActivityType.Send,
      };

      const result = formatAndGroupActivitiesByDate({
        activities: [activity],
        t: mockT,
        tokensMetadataByTokenId,
        // Return the second token of that activity as the main token
        getMainTokenBalanceChange: tokenBalanceChanges => ({
          ...tokenBalanceChanges[1],
        }),
      });

      expect(result).toEqual([
        {
          date: 'Today',
          dateIcon: 'Calendar03',
          items: [
            {
              id: activity.activityId,
              rowKey: activityListRowKey(activity),
              iconBackground: 'positive',
              iconName: 'ArrowUp03',
              info: {
                subtitle: formatTime({
                  date: activity.timestamp,
                  type: 'local',
                }),
                title: 'send-activity',
              },
              status: 'sent',
              timestamp: activity.timestamp,
              value: {
                title: {
                  // Should be the second token of that activity
                  amount: '2.00',
                  label: 'tDust',
                },
              },
            },
          ],
        },
      ]);
    });

    it('takes an optional customization for the tokens info summary', () => {
      const activity: Activity = {
        accountId,
        activityId: 'send-activity',
        timestamp: Timestamp(fakeNowTimestamp),
        tokenBalanceChanges: [
          { tokenId: tokenId1, amount: BigNumber(1000000n) },
        ],
        type: ActivityType.Send,
      };

      const expectedItemValue = {
        title: {
          amount: 'custom',
          label: '[TOKEN]',
        },
      };

      const result = formatAndGroupActivitiesByDate({
        activities: [activity],
        t: mockT,
        tokensMetadataByTokenId,
        // Provide customization for the token info summary
        getTokensInfoSummary: () => expectedItemValue,
      });

      expect(result).toEqual([
        {
          date: 'Today',
          dateIcon: 'Calendar03',
          items: [
            {
              id: activity.activityId,
              rowKey: activityListRowKey(activity),
              iconBackground: 'positive',
              iconName: 'ArrowUp03',
              info: {
                subtitle: formatTime({
                  date: activity.timestamp,
                  type: 'local',
                }),
                title: 'send-activity',
              },
              status: 'sent',
              timestamp: activity.timestamp,
              // should be the custom value returned by the customization
              value: expectedItemValue,
            },
          ],
        },
      ]);
    });
  });

  describe('edge cases', () => {
    it('should show no value for activities with empty token balance changes', () => {
      const activity: Activity = {
        accountId,
        activityId: 'empty-tokens-activity',
        timestamp: Timestamp(fakeNowTimestamp),
        tokenBalanceChanges: [],
        type: ActivityType.Send,
      };

      const result = formatAndGroupActivitiesByDate({
        activities: [activity],
        t: mockT,
        tokensMetadataByTokenId,
      });

      const item = result[0].items[0];
      expect(item.rowKey).toBe(activityListRowKey(activity));
      expect('title' in item.value && item.value.title).toBeFalsy();
    });

    it('should preserve original activities array (immutability)', () => {
      const originalActivities: Activity[] = [
        {
          accountId,
          activityId: 'activity1',
          timestamp: Timestamp(fakeNowTimestamp),
          tokenBalanceChanges: [
            { tokenId: tokenId1, amount: BigNumber(1000000n) },
          ],
          type: ActivityType.Send,
        },
      ];

      const activitiesCopy = [...originalActivities];

      formatAndGroupActivitiesByDate({
        activities: originalActivities,
        t: mockT,
        tokensMetadataByTokenId,
      });

      // Original array should be unchanged
      expect(originalActivities).toEqual(activitiesCopy);
    });
  });

  describe('dateIcon property', () => {
    it('should include dateIcon property in all sections', () => {
      const activity: Activity = {
        accountId,
        activityId: 'test-activity',
        timestamp: Timestamp(fakeNowTimestamp),
        tokenBalanceChanges: [
          { tokenId: tokenId1, amount: BigNumber(1000000n) },
        ],
        type: ActivityType.Send,
      };

      const result = formatAndGroupActivitiesByDate({
        activities: [activity],
        t: mockT,
        tokensMetadataByTokenId,
      });

      expect(result[0].dateIcon).toBe('Calendar03');
    });
  });
});
