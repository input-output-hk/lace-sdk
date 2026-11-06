import type { LayoutChangeEvent } from 'react-native';

import React from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useSheetFooter } from '../src/design-system/organisms/sheet/useSheetFooter';

import type { ReactTestRenderer } from 'react-test-renderer';

vi.mock('react-native', () => ({ Platform: { OS: 'web' } }));

describe('measured floating sheet footer', () => {
  let renderer: ReactTestRenderer;
  let footer: ReturnType<typeof useSheetFooter>;
  const button = { label: 'Confirm', onPress: vi.fn() };
  const props = { primaryButton: button };
  const Probe = () => {
    footer = useSheetFooter(props);
    return null;
  };
  const measure = (height: number) => {
    act(() => {
      footer.footerProps.onLayout({
        nativeEvent: { layout: { x: 0, y: 0, width: 320, height } },
      } as LayoutChangeEvent);
    });
  };

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    act(() => {
      renderer = create(<Probe />);
    });
  });
  afterEach(() => {
    act(() => {
      renderer.unmount();
    });
    vi.unstubAllGlobals();
  });

  it('reserves the rendered footer height and updates after font or safe-area changes', () => {
    measure(72);
    expect(footer.footerInset).toBe(72);
    expect(footer.sheetOptions.scrollableOptions.keyboardScrollOffset).toBe(72);
    measure(104);
    expect(footer.footerInset).toBe(104);
    expect(footer.sheetOptions.scrollableOptions.keyboardScrollOffset).toBe(
      104,
    );
    expect(footer.sheetOptions.insetAdjustment).toBe('never');
    expect(footer.footerProps.primaryButton).toBe(button);
  });

  it('does not replace sheet options when an unchanged footer is measured again', () => {
    measure(72);
    const options = footer.sheetOptions;
    measure(72);
    expect(footer.sheetOptions).toBe(options);
  });
});
