import { useTranslation } from '@lace-contract/i18n';
import React, { useCallback, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';

import { radius, spacing, useTheme } from '../../design-tokens';
import { Button, Icon, Row, Text } from '../atoms';
import {
  EmptyStateMessage,
  GovernanceCard,
  GovernanceStatusCard,
  PageHeaderSection,
  SearchBar,
} from '../molecules';
import { GenericFlashList, TabBarMetrics } from '../organisms';
import { usePageHeaderCollapseScroll } from '../util';

import { PageContainerTemplate } from './pageContainerTemplate/pageContainerTemplate';

import type { GovernanceCardProps } from '../molecules/governanceCard/governanceCard';
import type { GovernanceStatusCardProps } from '../molecules/governanceStatusCard/governanceStatusCard';

/**
 * Shown when the DRep list could not be fetched, so delegation health cannot be
 * verified. Keeps the account cards visible; the banner warns that the health
 * shown is unverified and offers a manual retry.
 */
export interface GovernanceDRepDataError {
  message: string;
  retryLabel: string;
  onRetry: () => void;
}

interface GovernanceCenterMainProps {
  searchValue?: string;
  debouncedSearchValue?: string;
  onSearchChange?: (value: string) => void;
  searchPlaceholder?: string;
  showSearchBar?: boolean;
  collapseTitleOnScroll?: boolean;
  governanceStatusCard: GovernanceStatusCardProps;
  governanceCards: GovernanceCardProps[];
  dRepDataError?: GovernanceDRepDataError;
}

export const GovernanceCenterMain = ({
  searchValue,
  debouncedSearchValue,
  onSearchChange,
  searchPlaceholder,
  showSearchBar,
  collapseTitleOnScroll = false,
  governanceStatusCard,
  governanceCards,
  dRepDataError,
}: GovernanceCenterMainProps) => {
  const { t } = useTranslation();
  const { theme } = useTheme();
  const shouldShowSearch = showSearchBar ?? governanceCards.length > 1;
  const shouldCollapseSearchHeader = collapseTitleOnScroll && shouldShowSearch;

  const ListHeaderComponent = useMemo(
    () => (
      <View style={styles.listHeader}>
        {dRepDataError && (
          <Row
            alignItems="center"
            gap={spacing.S}
            style={[
              styles.errorBanner,
              { backgroundColor: theme.background.primary },
            ]}
            testID="governance-center-drep-data-error">
            <Icon name="AlertTriangle" size={20} color={theme.data.negative} />
            <Text.XS style={styles.errorBannerText}>
              {dRepDataError.message}
            </Text.XS>
            <Button.Secondary
              size="small"
              label={dRepDataError.retryLabel}
              onPress={dRepDataError.onRetry}
              testID="governance-center-drep-data-retry-button"
            />
          </Row>
        )}
        <GovernanceStatusCard {...governanceStatusCard} />
      </View>
    ),
    [governanceStatusCard, dRepDataError, theme],
  );

  const keyExtractor = useCallback(
    (item: GovernanceCardProps, index: number) =>
      item.testID ?? `governance-card-${index}`,
    [],
  );

  const renderItem = useCallback(
    ({ item }: { item: GovernanceCardProps }) => <GovernanceCard {...item} />,
    [],
  );

  const ListEmptyComponent = useMemo(
    () =>
      debouncedSearchValue ? (
        <EmptyStateMessage
          message={t('v2.governance.center.empty-state.no-accounts-found')}
          style={styles.emptyStateContainer}
        />
      ) : null,
    [debouncedSearchValue, t],
  );

  const { collapseScrollY, onScroll } = usePageHeaderCollapseScroll();

  const searchBar = shouldShowSearch ? (
    <SearchBar
      value={searchValue}
      onChangeText={onSearchChange}
      placeholder={searchPlaceholder}
      testID="governance-center-search-bar"
    />
  ) : null;

  const list = (
    <GenericFlashList<GovernanceCardProps>
      testID="governance-center-list"
      style={shouldCollapseSearchHeader ? styles.fillSpace : styles.list}
      data={governanceCards}
      renderItem={renderItem}
      keyExtractor={keyExtractor}
      ListHeaderComponent={ListHeaderComponent}
      ListEmptyComponent={ListEmptyComponent}
      ItemSeparatorComponent={() => <View style={styles.itemSeparator} />}
      contentContainerStyle={[
        styles.listContent,
        !shouldCollapseSearchHeader && styles.listTopInset,
      ]}
      onScroll={onScroll}
      scrollEventThrottle={16}
      maintainVisibleContentPosition={{ disabled: true }}
    />
  );

  return (
    <PageContainerTemplate>
      <View style={styles.fillSpace}>
        <PageHeaderSection
          title={t('v2.governance.center.title')}
          reserveSubtitleSpace={!shouldCollapseSearchHeader}
          collapseTitleOnScroll={shouldCollapseSearchHeader}
          testID="governance-center-header-section"
          collapseScrollY={collapseScrollY}
          stickyInScrollParent
          contentStyle={
            shouldShowSearch ? undefined : styles.headerSectionContent
          }>
          {shouldCollapseSearchHeader ? null : searchBar}
        </PageHeaderSection>
        {shouldCollapseSearchHeader ? (
          <View collapsable={false} style={styles.searchAndResults}>
            {searchBar}
            <View style={styles.clippedList}>{list}</View>
          </View>
        ) : (
          list
        )}
      </View>
    </PageContainerTemplate>
  );
};

const styles = StyleSheet.create({
  searchAndResults: {
    flex: 1,
    paddingTop: spacing.S,
    gap: spacing.M,
  },
  clippedList: {
    flex: 1,
    marginHorizontal: -spacing.M,
    overflow: 'hidden',
  },
  fillSpace: {
    flex: 1,
  },
  list: {
    flex: 1,
    marginHorizontal: -spacing.M,
  },
  headerSectionContent: {
    paddingBottom: 0,
  },
  listContent: {
    paddingHorizontal: spacing.M,
    paddingBottom: TabBarMetrics.horizontal.height + spacing.XL,
  },
  listTopInset: {
    paddingTop: spacing.M,
  },
  itemSeparator: {
    height: spacing.L,
  },
  listHeader: {
    paddingBottom: spacing.L,
    gap: spacing.M,
  },
  errorBanner: {
    borderRadius: radius.M,
    padding: spacing.M,
  },
  errorBannerText: {
    flex: 1,
  },
  emptyStateContainer: {
    paddingVertical: spacing.XL,
  },
});
