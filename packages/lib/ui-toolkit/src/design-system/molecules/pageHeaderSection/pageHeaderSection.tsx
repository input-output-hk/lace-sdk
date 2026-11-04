import type { StyleProp, ViewStyle } from 'react-native';

import React, { useCallback, useState } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import Animated, {
  Extrapolation,
  interpolate,
  useAnimatedStyle,
  useDerivedValue,
  useReducedMotion,
  type SharedValue,
} from 'react-native-reanimated';

import { PAGE_HEADER_COLLAPSE_SCROLL_RANGE } from '../..';
import { spacing } from '../../../design-tokens';
import {
  getPageHeaderBackgroundHeights,
  PageHeader,
  type PageHeaderProps,
} from '../pageHeader/pageHeader';
import { SearchBar } from '../searchBar/searchBar';

type PageHeaderSectionProps = Omit<PageHeaderProps, 'stickyInScrollParent'> & {
  children?: React.ReactNode;
  contentStyle?: StyleProp<ViewStyle>;
  pageHeaderTestID?: string;
  collapseScrollY?: SharedValue<number>;
  stickyInScrollParent?: boolean;
};

export const PageHeaderSection = ({
  children,
  contentStyle,
  pageHeaderTestID,
  collapseScrollY,
  stickyInScrollParent = false,
  collapseTitleOnScroll: shouldCollapseTitleOnScroll = false,
  testID = 'page-header-section',
  ...pageHeaderProps
}: PageHeaderSectionProps) => {
  const hasCollapsibleContent = !!children;
  const hasSearchAccessory =
    React.isValidElement(children) && children.type === SearchBar;
  const gapReduction = hasSearchAccessory ? spacing.XS : 0;
  const isMotionReduced = useReducedMotion();
  const progress = useDerivedValue(() =>
    isMotionReduced
      ? 0
      : interpolate(
          collapseScrollY?.value ?? 0,
          [0, PAGE_HEADER_COLLAPSE_SCROLL_RANGE],
          [0, 1],
          Extrapolation.CLAMP,
        ),
  );
  const accessoryGapStyle = useAnimatedStyle(() => ({
    gap: spacing.S - progress.value * gapReduction,
  }));
  const isTitleCollapseEnabled =
    shouldCollapseTitleOnScroll &&
    !children &&
    !pageHeaderProps.showSearch &&
    !pageHeaderProps.compact;
  const hasSubtitleSpace =
    Boolean(pageHeaderProps.subtitle) ||
    Boolean(pageHeaderProps.reserveSubtitleSpace);
  const { fullBackground, collapsedBackground } =
    getPageHeaderBackgroundHeights(hasSubtitleSpace);
  const childPullUpDistance = fullBackground - collapsedBackground;
  const [stickyMeasuredHeight, setStickyMeasuredHeight] = useState<
    number | null
  >(null);

  const handleStickyLayout = useCallback((event: LayoutChangeEvent) => {
    const nextHeight = event.nativeEvent.layout.height;
    // Ignore zero/invalid measurements: React Navigation can lay the screen
    // out while it is still hidden/transitioning (e.g. tapping the tab right
    // after a network switch), reporting height 0. Locking that value would
    // collapse the sticky header to 0 with no re-measure path, leaving the
    // page without a header. Keep measuring until a real height arrives.
    if (nextHeight <= 0) return;
    setStickyMeasuredHeight(currentHeight =>
      currentHeight === nextHeight ? currentHeight : nextHeight,
    );
  }, []);

  const contentAnimatedStyle = useAnimatedStyle(
    () => ({
      transform: [
        {
          translateY:
            stickyInScrollParent && hasCollapsibleContent && collapseScrollY
              ? -progress.value * childPullUpDistance
              : 0,
        },
      ],
    }),
    [
      childPullUpDistance,
      progress,
      collapseScrollY,
      hasCollapsibleContent,
      stickyInScrollParent,
    ],
  );

  const stickyHeightAnimatedStyle = useAnimatedStyle(
    () => ({
      height:
        stickyInScrollParent &&
        hasCollapsibleContent &&
        collapseScrollY &&
        stickyMeasuredHeight !== null
          ? interpolate(
              progress.value,
              [0, 1],
              [
                stickyMeasuredHeight,
                stickyMeasuredHeight - childPullUpDistance - gapReduction,
              ],
              Extrapolation.CLAMP,
            )
          : stickyMeasuredHeight ?? undefined,
    }),
    [
      childPullUpDistance,
      progress,
      gapReduction,
      collapseScrollY,
      hasCollapsibleContent,
      stickyInScrollParent,
      stickyMeasuredHeight,
    ],
  );

  const content = (
    <Animated.View style={[styles.content, accessoryGapStyle]}>
      <PageHeader
        {...pageHeaderProps}
        collapseScrollYProp={collapseScrollY}
        stableCollapseLayout={stickyInScrollParent}
        collapseTitleOnScroll={isTitleCollapseEnabled}
        testID={pageHeaderTestID ?? `${testID}-page-header`}
      />
      {children && (
        <Animated.View
          style={[styles.container, contentStyle, contentAnimatedStyle]}>
          {children}
        </Animated.View>
      )}
    </Animated.View>
  );

  return (
    <View testID={testID}>
      {stickyInScrollParent && !isTitleCollapseEnabled ? (
        stickyMeasuredHeight === null ? (
          <View onLayout={handleStickyLayout}>{content}</View>
        ) : (
          <>
            <Animated.View style={stickyHeightAnimatedStyle} />
            <Animated.View
              style={[styles.stickyWrapper, stickyHeightAnimatedStyle]}>
              {content}
            </Animated.View>
          </>
        )
      ) : (
        content
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  content: {
    gap: spacing.S,
  },
  stickyWrapper: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 2,
    overflow: 'hidden',
  },
  container: {
    paddingBottom: spacing.M,
  },
});
