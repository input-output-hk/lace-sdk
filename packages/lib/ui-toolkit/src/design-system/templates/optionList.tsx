import type { ImageSourcePropType } from 'react-native';

import React, { useCallback, useMemo } from 'react';
import {
  Platform,
  StyleSheet,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
} from 'react-native-reanimated';

import { spacing, useTheme } from '../../design-tokens';
import { Column, Icon, SettingsCard } from '../atoms';
import { PageHeaderSection } from '../molecules';
import { getPageHeaderBackgroundHeights } from '../molecules/pageHeader/pageHeader';
import { GenericFlashList } from '../organisms';
import { usePageHeaderCollapseScroll } from '../util';

import { PageContainerTemplate } from './pageContainerTemplate/pageContainerTemplate';

import type { IconName } from '../atoms';

type ListOptionType = {
  id: string;
  titleKey: string;
  subtitleKey?: string;
  icon: IconName;
  onPress: () => void;
};

interface OptionListProps {
  options: ListOptionType[];
  title: string;
  subtitle: string;
  backgroundImage?: ImageSourcePropType;
  showSearch?: boolean;
  searchValue?: string;
  onSearchChange?: (value: string) => void;
  searchPlaceholder?: string;
  onBackPress?: () => void;
  onClosePress?: () => void;
}

const ItemSeparator = () => <View style={styles.itemSeparator} />;

export const OptionList = ({
  options,
  title,
  subtitle,
  backgroundImage,
  showSearch = false,
  searchValue,
  onSearchChange,
  searchPlaceholder,
  onBackPress,
  onClosePress,
}: OptionListProps) => {
  const isTitleCollapseEnabled = !showSearch;
  const { theme } = useTheme();
  const { collapseScrollY, onScroll } = usePageHeaderCollapseScroll();
  const initialHeaderHeight = getPageHeaderBackgroundHeights(
    Boolean(subtitle),
  ).fullBackground;
  const collapseLayout = useSharedValue({
    expandedHeight: initialHeaderHeight,
    height: initialHeaderHeight,
  });
  const pageHeight = useSharedValue(0);
  const measurePage = useCallback(
    (event: LayoutChangeEvent) => {
      const { height } = event.nativeEvent.layout;
      if (height > 0) pageHeight.value = height;
    },
    [pageHeight],
  );
  // Counter the clip's layout origin so Android receives touch coordinates in
  // a stable native viewport throughout the gesture.
  const scrollFrameStyle = useAnimatedStyle(() => ({
    top: -collapseLayout.value.height,
    height: pageHeight.value,
  }));
  const contentStyle = useAnimatedStyle(() => ({
    paddingTop: collapseLayout.value.expandedHeight,
    transform: [
      {
        translateY:
          collapseLayout.value.height - collapseLayout.value.expandedHeight,
      },
    ],
  }));

  const headerSection = useMemo(
    () => (
      <PageHeaderSection
        title={title}
        subtitle={subtitle}
        backgroundImage={backgroundImage}
        showSearch={showSearch}
        searchValue={searchValue}
        onSearchChange={onSearchChange}
        searchPlaceholder={searchPlaceholder}
        onBackPress={onBackPress}
        onClosePress={onClosePress}
        testID="option-list-header-section"
        pageHeaderTestID="option-list-page-header"
        collapseScrollY={collapseScrollY}
        collapseTitleOnScroll={isTitleCollapseEnabled}
        collapseLayout={collapseLayout}
        stickyInScrollParent></PageHeaderSection>
    ),
    [
      title,
      subtitle,
      backgroundImage,
      onBackPress,
      onClosePress,
      collapseScrollY,
      searchValue,
      onSearchChange,
      searchPlaceholder,
      showSearch,
      isTitleCollapseEnabled,
      collapseLayout,
    ],
  );

  const renderItem = useCallback(
    ({ item }: { item: ListOptionType }) => {
      const { titleKey, subtitleKey, icon, onPress } = item;

      return (
        <Column
          style={styles.cardContainer}
          alignItems="center"
          gap={spacing.M}>
          <SettingsCard
            iconWrapperStyle={{}}
            title={titleKey}
            description={subtitleKey}
            iconName={icon}
            rightNode={
              <Icon name="CaretRight" size={20} color={theme.text.primary} />
            }
            quickActions={{
              onCardPress: onPress,
            }}
            testID={`option-list-item-${item.id}`}
          />
        </Column>
      );
    },
    [theme.text.primary],
  );

  return (
    <PageContainerTemplate>
      <View
        style={styles.fillSpace}
        onLayout={isTitleCollapseEnabled ? measurePage : undefined}>
        {headerSection}
        {isTitleCollapseEnabled ? (
          <View testID="option-list-scroll-clip" style={styles.scrollClip}>
            <Animated.ScrollView
              testID="option-list-scroll-view"
              style={[styles.scrollFrame, scrollFrameStyle]}
              contentContainerStyle={styles.listContent}
              removeClippedSubviews={false}
              onScroll={onScroll}
              scrollEventThrottle={16}>
              <Animated.View
                testID="option-list-scroll-content"
                style={contentStyle}>
                {options.map((item, index) => (
                  <React.Fragment key={item.id}>
                    {index > 0 && <ItemSeparator />}
                    {renderItem({ item })}
                  </React.Fragment>
                ))}
              </Animated.View>
            </Animated.ScrollView>
          </View>
        ) : (
          <GenericFlashList
            style={styles.fillSpace}
            data={options}
            renderItem={renderItem}
            keyExtractor={item => item.id}
            ItemSeparatorComponent={ItemSeparator}
            contentContainerStyle={styles.listContent}
            onScroll={onScroll}
            scrollEventThrottle={16}
          />
        )}
      </View>
    </PageContainerTemplate>
  );
};

const styles = StyleSheet.create({
  fillSpace: {
    flex: 1,
  },
  scrollClip: { flex: 1, overflow: 'hidden' },
  scrollFrame: {
    position: 'absolute',
    left: 0,
    right: 0,
    // Match the header's center when a web scrollbar consumes layout width.
    ...Platform.select({ web: { scrollbarGutter: 'stable both-edges' } }),
  },
  listContent: {
    paddingBottom: spacing.XXXXL,
  },
  itemSeparator: {
    height: spacing.S,
  },
  cardContainer: {
    width: '100%',
  },
});
