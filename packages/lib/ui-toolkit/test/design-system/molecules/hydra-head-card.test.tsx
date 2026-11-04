import type { ElementType } from 'react';

import React from 'react';
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import {
  HydraHeadCard,
  HydraHeadsSection,
} from '../../../src/design-system/molecules/hydraHeadCard/hydraHeadCard';
import { darkTheme as dark } from '../../../src/design-tokens/theme/dark';
import { lightTheme as light } from '../../../src/design-tokens/theme/light';

import type { HydraHeadCardProps } from '../../../src/design-system/molecules/hydraHeadCard/hydraHeadCard';
import type { Theme } from '../../../src/design-tokens';
import type { ReactTestRenderer } from 'react-test-renderer';

const asHost = (type: string): ElementType => type as unknown as ElementType;

const { currentTheme } = vi.hoisted(() => ({
  currentTheme: { value: undefined as unknown },
}));

vi.mock('react-native', () => ({
  StyleSheet: { create: <T,>(styles: T): T => styles },
  View: 'View',
}));

vi.mock('../../../src/design-tokens', () => ({
  radius: { S: 16, XS: 8 },
  spacing: { XS: 4, S: 8, M: 16 },
  useTheme: () => ({ theme: currentTheme.value }),
}));

vi.mock('../../../src/design-system/atoms', () => ({
  Icon: 'Icon',
  Text: { S: 'Text', XS: 'Text' },
}));

const baseProps: HydraHeadCardProps = {
  title: 'Head 324c8b81...5bdc',
  stateLabel: 'Open',
  stateTone: 'open',
  amount: 'Deposited 10 tADA',
  amountDetail: 'Head total 12 tADA',
  footnote: 'Your current balance inside the head is not visible on-chain.',
  testID: 'head',
};

const render = (
  props: Partial<HydraHeadCardProps>,
  theme: Theme,
): ReactTestRenderer => {
  currentTheme.value = theme;
  let renderer: ReactTestRenderer | undefined;
  act(() => {
    renderer = create(<HydraHeadCard {...baseProps} {...props} />);
  });
  if (!renderer) throw new Error('HydraHeadCard did not render');
  return renderer;
};

const textOf = (renderer: ReactTestRenderer, testID: string): string =>
  [renderer.root.findByProps({ testID }).props.children].flat().join('');

const dotColorOf = (renderer: ReactTestRenderer): string | undefined =>
  (
    [renderer.root.findByProps({ testID: 'head-state-dot' }).props.style]
      .flat()
      .find(
        style => (style as { backgroundColor?: string }).backgroundColor,
      ) as { backgroundColor: string } | undefined
  )?.backgroundColor;

describe('HydraHeadCard', () => {
  it.each([
    ['light', light],
    ['dark', dark],
  ])('shows an open head with a teal dot in the %s theme', (_, theme) => {
    const renderer = render({}, theme);

    expect(textOf(renderer, 'head-title')).toBe('Head 324c8b81...5bdc');
    expect(textOf(renderer, 'head-state')).toBe('Open');
    expect(dotColorOf(renderer)).toBe(theme.extra.tagHydraRecoverText);
  });

  it.each([
    ['light', light],
    ['dark', dark],
  ])('shows a closing head with an amber dot in the %s theme', (_, theme) => {
    const renderer = render(
      { stateLabel: 'Closing - ends in 42m', stateTone: 'closing' },
      theme,
    );

    expect(textOf(renderer, 'head-state')).toBe('Closing - ends in 42m');
    expect(dotColorOf(renderer)).toBe(theme.extra.tagWarningText);
    expect(
      renderer.root.findByProps({ testID: 'head-state' }).props.style,
    ).toEqual({ color: theme.extra.tagWarningText });
  });

  it('shows the amounts and the footnote', () => {
    const renderer = render(
      {
        amount: 'Deposited 10 tADA · Withdrawn 4 tADA',
        amountDetail: 'Head total 12 tADA · Shared with 2 other participants',
      },
      light,
    );

    expect(textOf(renderer, 'head-amount')).toBe(
      'Deposited 10 tADA · Withdrawn 4 tADA',
    );
    expect(textOf(renderer, 'head-amount-detail')).toBe(
      'Head total 12 tADA · Shared with 2 other participants',
    );
    expect(textOf(renderer, 'head-footnote')).toBe(baseProps.footnote);
  });

  it.each([
    ['light', light],
    ['dark', dark],
  ])(
    'lists waiting deposits between the amounts in the %s theme',
    (_, theme) => {
      const renderer = render(
        {
          deposits: [
            {
              label: 'Your deposit, not yet in the head: 4.63 tADA',
              tone: 'pending',
            },
            { label: 'Your deposit, recoverable: 2 tADA', tone: 'recoverable' },
          ],
        },
        theme,
      );

      const pending = renderer.root.findByProps({ testID: 'head-deposit-0' });
      expect(textOf(renderer, 'head-deposit-0')).toBe(
        'Your deposit, not yet in the head: 4.63 tADA',
      );
      expect(pending.props.variant).toBe('secondary');
      const recoverable = renderer.root.findByProps({
        testID: 'head-deposit-1',
      });
      expect(textOf(renderer, 'head-deposit-1')).toBe(
        'Your deposit, recoverable: 2 tADA',
      );
      expect(recoverable.props.variant).toBeUndefined();
      expect([recoverable.props.style].flat()).toContainEqual({
        color: theme.extra.tagWarningText,
      });
      const amountsOrder = renderer.root
        .findAll(node => typeof node.props.testID === 'string')
        .map(node => node.props.testID as string)
        .filter(id => id.startsWith('head-amount') || id.includes('deposit'));
      expect(amountsOrder).toEqual([
        'head-amount',
        'head-deposit-0',
        'head-deposit-1',
        'head-amount-detail',
      ]);
    },
  );

  it('leaves out the primary amount when there is none', () => {
    const renderer = render(
      {
        amount: undefined,
        deposits: [
          {
            label: 'Your deposit, not yet in the head: 4.63 tADA',
            tone: 'pending',
          },
        ],
      },
      light,
    );

    expect(renderer.root.findAllByProps({ testID: 'head-amount' })).toEqual([]);
    expect(textOf(renderer, 'head-deposit-0')).toBe(
      'Your deposit, not yet in the head: 4.63 tADA',
    );
    expect(textOf(renderer, 'head-amount-detail')).toBe('Head total 12 tADA');
  });
});

describe('HydraHeadsSection', () => {
  it('renders the caption above its cards', () => {
    currentTheme.value = light;
    let renderer: ReactTestRenderer | undefined;
    act(() => {
      renderer = create(
        <HydraHeadsSection title="Locked in Hydra heads" testID="section">
          <HydraHeadCard {...baseProps} />
        </HydraHeadsSection>,
      );
    });

    expect(textOf(renderer as ReactTestRenderer, 'section-title')).toBe(
      'Locked in Hydra heads',
    );
    expect(
      (renderer as ReactTestRenderer).root.findAllByType(asHost('View')).length,
    ).toBeGreaterThan(1);
  });
});
