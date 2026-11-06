import type { ComponentProps } from 'react';
import type { LayoutChangeEvent } from 'react-native';

import { useCallback, useMemo, useState } from 'react';
import { Platform } from 'react-native';

import type { Sheet } from './sheet';

/**
 * Reserves the floating footer's measured space, including its safe area.
 * Apply `sheetOptions` to the sheet so TrueSheet owns keyboard avoidance while
 * the footer remains the only owner of the bottom safe area.
 */
export const useSheetFooter = (props: ComponentProps<typeof Sheet.Footer>) => {
  const [footerInset, setFooterInset] = useState(0);
  const onLayout = useCallback((event: LayoutChangeEvent) => {
    setFooterInset(event.nativeEvent.layout.height);
  }, []);

  const footerProps = useMemo(
    () => ({ ...props, onLayout }),
    [props, onLayout],
  );
  const sheetOptions = useMemo(
    () => ({
      insetAdjustment: 'never' as const,
      // Web's native scrollable wrapper needs a bounded content root.
      style: Platform.OS === 'web' ? { height: '100%' as const } : undefined,
      scrollableOptions: { keyboardScrollOffset: footerInset },
    }),
    [footerInset],
  );

  return { footerProps, footerInset, sheetOptions };
};
