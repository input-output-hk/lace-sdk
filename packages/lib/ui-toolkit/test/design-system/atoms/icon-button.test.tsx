import type { ElementType } from 'react';

import React from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IconButton } from '../../../src/design-system/atoms/iconButton/iconButton';

import type { ReactTestRenderer } from 'react-test-renderer';

const asHost = (type: string): ElementType => type as unknown as ElementType;

vi.mock('react-native', () => ({
  StyleSheet: {
    create: <T,>(styles: T): T => styles,
    flatten: (
      styles: Record<string, unknown> | Record<string, unknown>[] | undefined,
    ) =>
      Array.isArray(styles)
        ? styles.reduce<Record<string, unknown>>(
            (merged, style) => ({ ...merged, ...style }),
            {},
          )
        : styles,
  },
  View: 'View',
}));

vi.mock('react-native-gesture-handler', () => ({ Pressable: 'Pressable' }));

vi.mock('react-native-reanimated', () => ({
  default: { View: 'Animated.View' },
  interpolate: vi.fn(),
  useAnimatedStyle: vi.fn(),
  useSharedValue: vi.fn(),
  withTiming: vi.fn(),
}));

vi.mock('../../../src/design-system/atoms', () => ({
  Text: { XS: 'Text.XS' },
}));

vi.mock('../../../src/design-tokens', () => ({
  radius: { squareRounded: 8, rounded: 999 },
  spacing: { M: 16, S: 8 },
  useTheme: () => ({
    theme: {
      background: {
        secondary: 'secondary',
        tertiary: 'tertiary',
        overlay: 'overlay',
      },
      border: { top: 'border-top' },
    },
  }),
}));

const renderButton = (
  props: React.ComponentProps<typeof IconButton.Static>,
): ReactTestRenderer => {
  let renderer: ReactTestRenderer | undefined;
  act(() => {
    renderer = create(<IconButton.Static {...props} />);
  });
  if (!renderer) throw new Error('IconButton did not render');
  return renderer;
};

describe('IconButton.Static native control identifier', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([false, true])(
    'keeps the pressable as the only action owner with extraContrast=%s',
    extraContrast => {
      const onPress = vi.fn();
      const renderer = renderButton({
        onPress,
        testID: 'send-icon-button',
        extraContrast,
      });
      try {
        const button = renderer.root.findByType(asHost('Pressable'));
        const props = button.props as { testID?: string; onPress: () => void };
        expect(props.testID).toBe('send-icon-button');
        expect(button.props).not.toHaveProperty('extraContrast');
        expect(
          renderer.root.findAll(
            node =>
              typeof node.type === 'string' &&
              (node.props as { testID?: string }).testID === 'send-icon-button',
          ),
        ).toEqual([button]);
        expect(props.onPress).toBe(onPress);
        act(() => {
          props.onPress();
        });
        expect(onPress).toHaveBeenCalledTimes(1);
      } finally {
        act(() => {
          renderer.unmount();
        });
      }
    },
  );

  it('preserves disabled state and ordinary content on the same control', () => {
    const renderer = renderButton({
      disabled: true,
      icon: React.createElement('SendIcon'),
      label: { content: 'Send', position: 'left' },
      testID: 'send-icon-button',
    });
    try {
      const button = renderer.root.findByType(asHost('Pressable'));
      const props = button.props as { disabled?: boolean; testID?: string };
      expect(props.disabled).toBe(true);
      expect(props.testID).toBe('send-icon-button');
      expect(renderer.root.findAllByType(asHost('SendIcon'))).toHaveLength(1);
      const label = renderer.root.findByType(asHost('Text.XS'));
      expect((label.props as { children: string }).children).toBe('Send');
    } finally {
      act(() => {
        renderer.unmount();
      });
    }
  });
});
