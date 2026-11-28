import type { ImageSourcePropType } from 'react-native';

import React, { useCallback, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated from 'react-native-reanimated';

import { spacing, useTheme } from '../../design-tokens';
import { Column, Icon, SettingsCard } from '../atoms';
import { PageHeaderSection, usePageHeaderScrollLayout } from '../molecules';
import { GenericFlashList } from '../organisms';

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
  const {
    collapseLayout,
    collapseScrollY,
    measurePage,
    onScroll,
    scrollClipStyle,
    scrollFrameStyle,
    scrollViewportStyle,
    scrollContentSpacing,
    scrollContentOffset,
  } = usePageHeaderScrollLayout(Boolean(subtitle));

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
          <View testID="option-list-scroll-clip" style={scrollClipStyle}>
            <Animated.ScrollView
              testID="option-list-scroll-view"
              style={[scrollFrameStyle, scrollViewportStyle]}
              contentContainerStyle={styles.listContent}
              removeClippedSubviews={false}
              onScroll={onScroll}
              scrollEventThrottle={16}>
              <Animated.View
                testID="option-list-scroll-content"
                style={[scrollContentSpacing, scrollContentOffset]}>
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
