import React from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { darkTheme } from '../src/design-tokens/theme/dark';
import { lightTheme } from '../src/design-tokens/theme/light';
import { ThemeProvider } from '../src/design-tokens/theme/provider';

import type { ReactTestRenderer } from 'react-test-renderer';

const platform = vi.hoisted(() => ({ OS: 'web' }));

vi.mock('react-native', () => ({
  Platform: platform,
  Appearance: {
    getColorScheme: () => 'light',
    addChangeListener: () => ({ remove: vi.fn() }),
  },
  useWindowDimensions: () => ({ width: 400, height: 800 }),
}));

vi.mock('../src/design-system', () => ({
  isCompactWidth: () => true,
  isMediumWidth: () => false,
}));

describe('document scrollbar theme ownership', () => {
  let renderer: ReactTestRenderer;

  beforeEach(() => {
    platform.OS = 'web';
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  });

  afterEach(() => {
    act(() => {
      renderer.unmount();
    });
    vi.unstubAllGlobals();
  });

  it('keeps the document theme when a nested provider has a different theme', () => {
    act(() => {
      renderer = create(
        <ThemeProvider defaultTheme="light">
          <ThemeProvider defaultTheme="dark">
            <span>Content</span>
          </ThemeProvider>
        </ThemeProvider>,
      );
    });

    const styles = renderer.root.findAllByType('style');
    expect(styles).toHaveLength(1);
    expect(styles[0].props).toMatchObject({
      'data-lace-scrollbars': 'light',
    });
    expect(styles[0].props.children).toContain(lightTheme.text.tertiary);
  });

  it('updates the scrollbar color when the document theme changes', () => {
    act(() => {
      renderer = create(
        <ThemeProvider defaultTheme="light">Content</ThemeProvider>,
      );
    });
    act(() => {
      renderer.update(
        <ThemeProvider defaultTheme="dark">Content</ThemeProvider>,
      );
    });

    expect(renderer.root.findByType('style').props).toMatchObject({
      'data-lace-scrollbars': 'dark',
    });
    expect(renderer.root.findByType('style').props.children).toContain(
      darkTheme.text.tertiary,
    );
  });

  it.each(['ios', 'android'])('leaves %s indicators to the platform', os => {
    platform.OS = os;
    act(() => {
      renderer = create(
        <ThemeProvider defaultTheme="dark">Content</ThemeProvider>,
      );
    });

    expect(renderer.root.findAllByType('style')).toHaveLength(0);
    expect(renderer.toJSON()).toBe('Content');
  });
});
