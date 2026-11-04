import React, { useCallback, useMemo, useState } from 'react';
import {
  View,
  StyleSheet,
  type LayoutChangeEvent,
  type ImageSourcePropType,
} from 'react-native';
import Animated, {
  Extrapolation,
  interpolate,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  useReducedMotion,
  useAnimatedReaction,
  type SharedValue,
} from 'react-native-reanimated';

import { SearchBar, type SearchBarAction } from '..';
import { radius, spacing, useTheme } from '../../../design-tokens';
import { Text, Column, Row, Icon, Button } from '../../atoms';
import { IconButton } from '../../atoms/iconButton/iconButton';
import { isWeb, PAGE_HEADER_COLLAPSE_SCROLL_RANGE } from '../../util';

import type { Theme } from '../../../design-tokens';

const BACKGROUND_HEIGHT_WEB = {
  WITH_SUBTITLE: 200,
  WITHOUT_SUBTITLE: 168,
};
const BACKGROUND_HEIGHT_NATIVE = {
  WITH_SUBTITLE: 120,
  WITHOUT_SUBTITLE: 88,
};
const HEADER_CONTENT_MIN_HEIGHT = 40;
const INLINE_COMPACT_TITLE_SCALE = 20 / 24;

export const getPageHeaderBackgroundHeights = (hasSubtitleSpace: boolean) => {
  const backgroundHeights = isWeb
    ? BACKGROUND_HEIGHT_WEB
    : BACKGROUND_HEIGHT_NATIVE;

  const fullBackground = hasSubtitleSpace
    ? backgroundHeights.WITH_SUBTITLE
    : backgroundHeights.WITHOUT_SUBTITLE;

  return {
    fullBackground,
    collapsedBackground: fullBackground * 0.62,
  };
};

export interface PageHeaderProps {
  title: string;
  subtitle?: string;
  backgroundImage?: ImageSourcePropType;
  reserveSubtitleSpace?: boolean;
  showSearch?: boolean;
  searchValue?: string;
  onSearchChange?: (value: string) => void;
  searchPlaceholder?: string;
  onBackPress?: () => void;
  onClosePress?: () => void;
  testID?: string;
  isDark?: boolean;
  compact?: boolean;
  searchBarActions?: SearchBarAction[];
  collapseScrollYProp?: SharedValue<number>;
  stickyInScrollParent?: boolean;
  stableCollapseLayout?: boolean;
  /** Scales a title/subtitle-only header in layout; compact/search headers retain their existing behavior. */
  collapseTitleOnScroll?: boolean;
  /** Shares one inline layout snapshot with a stable scroll viewport. */
  collapseLayout?: SharedValue<{ expandedHeight: number; height: number }>;
}

const SubtitleComponent = ({
  testID,
  subtitle,
}: {
  testID: string;
  subtitle: string;
}) => <Text.XS testID={`${testID}-subtitle`}>{subtitle}</Text.XS>;

export const PageHeader = ({
  title,
  subtitle,
  showSearch = false,
  reserveSubtitleSpace = false,
  searchValue = '',
  onSearchChange,
  searchPlaceholder,
  onBackPress,
  onClosePress,
  testID = 'page-header',
  compact = false,
  searchBarActions,
  collapseScrollYProp,
  stickyInScrollParent = false,
  stableCollapseLayout = false,
  collapseTitleOnScroll: shouldCollapseTitleOnScroll = false,
  collapseLayout,
}: PageHeaderProps) => {
  const isTitleCollapseEnabled =
    shouldCollapseTitleOnScroll && !showSearch && !compact;
  const { theme } = useTheme();
  const styles = useMemo(() => getStyles(theme), [theme]);
  const hasSubtitleSpace = Boolean(subtitle) || reserveSubtitleSpace;
  const fallbackScrollY = useSharedValue(0);
  const collapseScrollY = collapseScrollYProp ?? fallbackScrollY;
  const isMotionReduced = useReducedMotion();
  const contentHeight = useSharedValue(52);
  const titleHeight = useSharedValue(29);
  const measureContent = useCallback(
    (event: LayoutChangeEvent) => {
      const { height } = event.nativeEvent.layout;
      if (height > 0) contentHeight.value = height;
    },
    [contentHeight],
  );
  const measureTitle = useCallback(
    (event: LayoutChangeEvent) => {
      const { height } = event.nativeEvent.layout;
      if (height > 0) titleHeight.value = height;
    },
    [titleHeight],
  );

  const { fullBackground, collapsedBackground } =
    getPageHeaderBackgroundHeights(hasSubtitleSpace);
  const shouldUseStableCollapseLayout =
    !isTitleCollapseEnabled && (stableCollapseLayout || stickyInScrollParent);
  const [stickyMeasuredHeight, setStickyMeasuredHeight] = useState<
    number | null
  >(null);

  const handleStickyLayout = useCallback((event: LayoutChangeEvent) => {
    const nextHeight = event.nativeEvent.layout.height;
    // Ignore zero/invalid measurements: a hidden/transitioning screen can
    // report height 0, which would lock the sticky header collapsed with no
    // re-measure path. Keep measuring until a real height arrives.
    if (nextHeight <= 0) return;
    setStickyMeasuredHeight(currentHeight =>
      currentHeight === nextHeight ? currentHeight : nextHeight,
    );
  }, []);

  const collapseProgress = useDerivedValue(() =>
    isMotionReduced
      ? 0
      : interpolate(
          collapseScrollY.value,
          [0, PAGE_HEADER_COLLAPSE_SCROLL_RANGE],
          [0, 1],
          Extrapolation.CLAMP,
        ),
  );

  const expandedHeight = useDerivedValue(() =>
    isTitleCollapseEnabled
      ? Math.max(fullBackground, contentHeight.value + spacing.M * 2)
      : fullBackground,
  );
  const referenceCollapsedHeight =
    getPageHeaderBackgroundHeights(true).collapsedBackground;
  const compactTitleTop = useDerivedValue(() => {
    // Match the title-only, reserved-subtitle legacy header used by DApp
    // Explorer. Clamp its visual top so large text cannot move above the block.
    const legacyScale = isWeb ? 1 : 0.94;
    return Math.max(
      0,
      (referenceCollapsedHeight -
        Math.max(HEADER_CONTENT_MIN_HEIGHT, titleHeight.value)) /
        2 -
        spacing.M +
        (titleHeight.value * (1 - legacyScale)) / 2,
    );
  });
  const compactTitleTranslation = useDerivedValue(
    () =>
      compactTitleTop.value -
      (titleHeight.value * (1 - INLINE_COMPACT_TITLE_SCALE)) / 2 -
      (expandedHeight.value - contentHeight.value) / 2,
  );
  const fixedOverlayStyle = useAnimatedStyle(() => ({
    height: expandedHeight.value,
    bottom: undefined,
  }));
  const subtitleFadeStyle = useAnimatedStyle(() => ({
    opacity: 1 - collapseProgress.value,
  }));

  const compactBgAnimated = useAnimatedStyle(() => {
    const progress = collapseProgress.value;
    return {
      paddingVertical: interpolate(
        progress,
        [0, 1],
        [spacing.M, spacing.S],
        Extrapolation.CLAMP,
      ),
    };
  }, [collapseProgress]);

  const compactSearchMarginStyle = useAnimatedStyle(() => {
    const progress = collapseProgress.value;
    return {
      marginTop: interpolate(
        progress,
        [0, 1],
        [spacing.M, spacing.S],
        Extrapolation.CLAMP,
      ),
    };
  }, [collapseProgress]);

  const frameHeight = useDerivedValue(() => {
    const compactHeight =
      compactTitleTop.value +
      titleHeight.value * INLINE_COMPACT_TITLE_SCALE +
      spacing.M;
    return interpolate(
      collapseProgress.value,
      [0, 1],
      isTitleCollapseEnabled
        ? [expandedHeight.value, compactHeight]
        : [fullBackground, collapsedBackground],
      Extrapolation.CLAMP,
    );
  });
  useAnimatedReaction(
    () =>
      isTitleCollapseEnabled
        ? { expandedHeight: expandedHeight.value, height: frameHeight.value }
        : null,
    value => {
      if (collapseLayout && value) collapseLayout.value = value;
    },
  );
  const headerFrameAnimated = useAnimatedStyle(() => ({
    height:
      isTitleCollapseEnabled && collapseLayout
        ? collapseLayout.value.height
        : frameHeight.value,
  }));

  const controlsAnimated = useAnimatedStyle(() => {
    const progress = collapseProgress.value;
    return {
      transform: [
        {
          translateY: interpolate(
            progress,
            [0, 1],
            [0, spacing.S - spacing.L],
            Extrapolation.CLAMP,
          ),
        },
      ],
    };
  }, [collapseProgress]);

  const titleScaleStyle = useAnimatedStyle(() => {
    const progress = collapseProgress.value;
    return {
      transform: [
        {
          scale: interpolate(
            progress,
            [0, 1],
            [1, INLINE_COMPACT_TITLE_SCALE],
            Extrapolation.CLAMP,
          ),
        },
      ],
    };
  }, [collapseProgress]);

  const headerContentAnimated = useAnimatedStyle(() => {
    const progress = collapseProgress.value;

    // Preserve the legacy title-only anchor when changing its center-based scale.
    const legacyScale = isWeb ? 1 : 0.94;
    const scaleInset =
      (titleHeight.value * (legacyScale - INLINE_COMPACT_TITLE_SCALE)) / 2;
    const subtitleSpace =
      !showSearch && hasSubtitleSpace
        ? (contentHeight.value -
            Math.max(HEADER_CONTENT_MIN_HEIGHT, titleHeight.value)) /
          2
        : 0;
    const collapsedTranslateY = isTitleCollapseEnabled
      ? compactTitleTranslation.value
      : (!showSearch && hasSubtitleSpace ? -spacing.M : -spacing.S) -
        scaleInset +
        subtitleSpace;

    return {
      transform: [
        {
          translateY: interpolate(
            progress,
            [0, 1],
            [0, collapsedTranslateY],
            Extrapolation.CLAMP,
          ),
        },
      ],
    };
  }, [
    collapseProgress,
    hasSubtitleSpace,
    showSearch,
    isTitleCollapseEnabled,
    compactTitleTranslation,
    contentHeight,
    titleHeight,
  ]);

  const searchBarAnimated = useAnimatedStyle(() => {
    const progress = collapseProgress.value;
    return {
      transform: [
        {
          translateY: interpolate(
            progress,
            [0, 1],
            [0, -spacing.XS],
            Extrapolation.CLAMP,
          ),
        },
      ],
    };
  }, [collapseProgress]);

  const wrapSticky = (node: React.ReactElement) => {
    if (!stickyInScrollParent || isTitleCollapseEnabled) {
      return node;
    }

    if (stickyMeasuredHeight === null) {
      return <View onLayout={handleStickyLayout}>{node}</View>;
    }

    return (
      <View style={styles.stickyContainer}>
        <View style={{ height: stickyMeasuredHeight }} />
        <Animated.View style={styles.stickyWrapper}>{node}</Animated.View>
      </View>
    );
  };

  if (compact) {
    return wrapSticky(
      <Animated.View
        style={[styles.compactContainer, compactBgAnimated]}
        testID={testID}>
        <Row style={styles.compactHeaderRow}>
          {onBackPress && (
            <Button.Secondary
              preIconName="CaretLeft"
              size="small"
              onPress={onBackPress}
              testID={`${testID}-back-button`}
            />
          )}
          <Animated.View style={styles.compactTextContainer}>
            <Column style={styles.compactTextInner}>
              <Animated.View
                style={[styles.compactTitleOrigin, titleScaleStyle]}>
                <Text.M numberOfLines={2} testID={`${testID}-title`}>
                  {title}
                </Text.M>
              </Animated.View>
              {!!subtitle && (
                <Animated.View style={subtitleFadeStyle}>
                  <SubtitleComponent testID={testID} subtitle={subtitle} />
                </Animated.View>
              )}
            </Column>
          </Animated.View>
          {onClosePress && (
            <Button.Secondary
              preIconName="Cancel"
              size="small"
              onPress={onClosePress}
              testID={`${testID}-close-button`}
            />
          )}
        </Row>
        {showSearch && (
          <Animated.View
            style={[styles.compactSearchContainer, compactSearchMarginStyle]}>
            <SearchBar
              value={searchValue}
              onChangeText={onSearchChange}
              placeholder={searchPlaceholder}
              testID={`${testID}-search`}
              extraStyle={styles.searchBar}
              actions={searchBarActions}
            />
          </Animated.View>
        )}
      </Animated.View>,
    );
  }

  const renderBackground = () => <View style={styles.headerBackground} />;

  return wrapSticky(
    <View
      style={[
        styles.headerContainer,
        shouldUseStableCollapseLayout ? { height: fullBackground } : undefined,
      ]}
      testID={testID}>
      <Animated.View style={[styles.headerFrame, headerFrameAnimated]}>
        {renderBackground()}
        <Animated.View
          style={[
            styles.overlay,
            !hasSubtitleSpace ? styles.overlayWithoutSubtitle : undefined,
            showSearch ? styles.overlayWithSearch : undefined,
            isTitleCollapseEnabled ? fixedOverlayStyle : undefined,
          ]}>
          {isTitleCollapseEnabled && (
            <Column
              pointerEvents="none"
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
              aria-hidden
              onLayout={measureContent}
              style={[styles.headerContent, styles.motionMeasurement]}>
              <Text.L onLayout={measureTitle}>{title}</Text.L>
              {!!subtitle && <Text.M align="center">{subtitle}</Text.M>}
            </Column>
          )}
          <Animated.View style={[styles.controlsRow, controlsAnimated]}>
            {onBackPress ? (
              <IconButton.Static
                icon={<Icon name="CaretLeft" />}
                onPress={onBackPress}
                testID={`${testID}-back-button`}
                containerStyle={styles.iconButton}
              />
            ) : (
              <View style={styles.iconButtonPlaceholder} />
            )}
            {onClosePress ? (
              <IconButton.Static
                icon={<Icon name="Cancel" />}
                onPress={onClosePress}
                testID={`${testID}-close-button`}
                containerStyle={styles.iconButton}
              />
            ) : (
              <View style={styles.iconButtonPlaceholder} />
            )}
          </Animated.View>
          <Animated.View
            pointerEvents="none"
            style={[
              styles.headerContentWrapper,
              showSearch ? styles.headerContentWrapperWithSearch : undefined,
              headerContentAnimated,
            ]}>
            <Column
              onLayout={isTitleCollapseEnabled ? undefined : measureContent}
              style={[
                styles.headerContent,
                !subtitle ? styles.headerContentWithoutSubtitle : undefined,
              ]}>
              <Animated.View style={titleScaleStyle}>
                <Text.L
                  onLayout={isTitleCollapseEnabled ? undefined : measureTitle}
                  testID={`${testID}-title`}>
                  {title}
                </Text.L>
              </Animated.View>
              {!!subtitle && (
                <Animated.View style={subtitleFadeStyle}>
                  <Text.M align="center" testID={`${testID}-subtitle`}>
                    {subtitle}
                  </Text.M>
                </Animated.View>
              )}
            </Column>
          </Animated.View>
          {showSearch && (
            <Animated.View
              style={[styles.searchBarContainer, searchBarAnimated]}>
              <SearchBar
                value={searchValue}
                onChangeText={onSearchChange}
                placeholder={searchPlaceholder}
                testID={`${testID}-search`}
                extraStyle={styles.searchBar}
                actions={searchBarActions}
              />
            </Animated.View>
          )}
        </Animated.View>
      </Animated.View>
    </View>,
  );
};

const getStyles = (theme: Theme) =>
  StyleSheet.create({
    motionMeasurement: { position: 'absolute', left: 0, right: 0, opacity: 0 },
    stickyContainer: {
      position: 'relative',
    },
    stickyWrapper: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      zIndex: 2,
    },
    headerContainer: {
      position: 'relative',
    },
    headerFrame: {
      position: 'relative',
      overflow: 'hidden',
    },
    compactContainer: {
      position: 'relative',
      gap: spacing.M,
    },
    compactHeaderRow: {
      alignItems: 'center',
      gap: spacing.XS,
    },
    compactTitleOrigin: { transformOrigin: 'left top' },
    compactTextContainer: {
      flex: 1,
      paddingStart: spacing.S,
    },
    compactTextInner: {
      alignItems: 'flex-start',
    },
    compactSearchContainer: {
      width: '100%',
    },
    headerBackground: {
      ...StyleSheet.absoluteFill,
    },
    overlay: {
      ...StyleSheet.absoluteFill,
      paddingTop: spacing.L,
      paddingBottom: spacing.L,
      justifyContent: 'center',
      alignItems: 'center',
      gap: spacing.L,
    },
    overlayWithoutSubtitle: {
      paddingVertical: spacing.S,
    },
    overlayWithSearch: {
      paddingBottom: spacing.S,
      gap: spacing.S,
    },
    headerContentWrapper: {
      width: '100%',
      alignItems: 'center',
    },
    headerContentWrapperWithSearch: {
      flexGrow: 1,
      justifyContent: 'center',
      alignItems: 'center',
    },
    headerContent: {
      alignItems: 'center',
      gap: spacing.XS,
      minHeight: HEADER_CONTENT_MIN_HEIGHT,
    },
    headerContentWithoutSubtitle: {
      paddingBottom: 0,
    },
    searchBarContainer: {
      width: '100%',
      alignSelf: 'stretch',
    },
    searchBar: {
      flex: 1,
    },
    controlsRow: {
      position: 'absolute',
      top: spacing.L,
      left: spacing.L,
      right: spacing.L,
      zIndex: 1,
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
    },
    iconButton: {
      backgroundColor: theme.background.secondary,
      borderRadius: radius.rounded,
    },
    iconButtonPlaceholder: {
      width: 40,
      height: 40,
    },
  });
