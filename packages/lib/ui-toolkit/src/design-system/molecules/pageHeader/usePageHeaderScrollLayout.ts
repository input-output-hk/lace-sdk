import { useCallback } from 'react';
import { Platform, StyleSheet, type LayoutChangeEvent } from 'react-native';
import {
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
} from 'react-native-reanimated';

import { usePageHeaderCollapseScroll } from '../../util/hooks/usePageHeaderCollapseScroll';

import { getPageHeaderBackgroundHeights } from './pageHeader';

export const usePageHeaderScrollLayout = (hasSubtitle: boolean) => {
  const { collapseScrollY, onScroll } = usePageHeaderCollapseScroll();
  const initialHeaderHeight =
    getPageHeaderBackgroundHeights(hasSubtitle).fullBackground;
  const collapseLayout = useSharedValue({
    expandedHeight: initialHeaderHeight,
    height: initialHeaderHeight,
  });
  const pageHeight = useSharedValue(0);
  const accessoryHeight = useSharedValue(0);
  const measurePage = useCallback(
    (event: LayoutChangeEvent) => {
      const { height } = event.nativeEvent.layout;
      if (height > 0) pageHeight.value = height;
    },
    [pageHeight],
  );
  const measureAccessory = useCallback(
    (event: LayoutChangeEvent) => {
      const { height } = event.nativeEvent.layout;
      if (height > 0) accessoryHeight.value = height;
    },
    [accessoryHeight],
  );
  const headerHeight = useDerivedValue(
    () => collapseLayout.value.height + accessoryHeight.value,
  );
  // Counter the clip's layout origin so Android receives touch coordinates in
  // a stable native viewport throughout the gesture.
  const scrollFrameStyle = useAnimatedStyle(() => ({
    top: -headerHeight.value,
    height: pageHeight.value,
  }));
  // Keep the content's layout height fixed during collapse so list offsets
  // and virtualized cell measurements stay stable.
  const scrollContentSpacing = useAnimatedStyle(() => ({
    paddingTop: collapseLayout.value.expandedHeight + accessoryHeight.value,
  }));
  const scrollContentOffset = useAnimatedStyle(() => ({
    transform: [
      {
        translateY:
          collapseLayout.value.height - collapseLayout.value.expandedHeight,
      },
    ],
  }));

  return {
    collapseLayout,
    collapseScrollY,
    measureAccessory,
    measurePage,
    onScroll,
    scrollClipStyle: styles.scrollClip,
    scrollFrameStyle: [styles.scrollFrame, scrollFrameStyle],
    scrollViewportStyle: styles.scrollViewport,
    scrollContentSpacing,
    scrollContentOffset,
  };
};

const styles = StyleSheet.create({
  scrollClip: { flex: 1, overflow: 'hidden' },
  scrollFrame: {
    position: 'absolute',
    left: 0,
    right: 0,
  },
  scrollViewport: {
    flex: 1,
    // Match the header's center when a web scrollbar consumes layout width.
    ...Platform.select({ web: { scrollbarGutter: 'stable both-edges' } }),
  },
});
