import React, { useCallback, useMemo } from 'react';
import { View, StyleSheet, Pressable } from 'react-native';

import { isWeb, truncateText, type ColorType } from '../..';
import { radius, spacing, useTheme } from '../../../design-tokens';
import { BlurView, CustomTag, getLabelColor, Icon, Text } from '../../atoms';

import type { Theme } from '../../../design-tokens';
import type { IconName } from '../../atoms';

/** Colour family of an activity tag pill and of the row icon beside it. */
export type ActivityTagTone =
  | 'hydra'
  | 'hydraDeposit'
  | 'hydraRecover'
  | 'warning';

/** Small pill rendered beside the subtitle of an activity row. */
export type ActivityTag = {
  label: string;
  tone: ActivityTagTone;
};

export type FlexibleInfo = {
  /** Pills shown in order beside the subtitle; the first one tints the row icon. */
  tags?: ActivityTag[];
} & (
  | { title: string; subtitle: string }
  | { title: string; subtitle?: string }
  | { title?: string; subtitle: string }
);

export type FlexibleValue =
  | { primaryText: string; secondaryText: string; subtitle?: string }
  | { title: { amount: string; label: string }; subtitle: string }
  | { title: { amount: string; label: string }; subtitle?: string }
  | { title?: { amount: string; label: string }; subtitle: string };

export type ActivityCardProps =
  | {
      id: string;
      status: 'failed' | 'pending';
      info: FlexibleInfo;
      value: { subtitle: string };
      iconName: IconName;
      iconBackground?: ColorType;
    }
  | {
      id: string;
      status: 'received' | 'sent';
      info: FlexibleInfo;
      value: FlexibleValue;
      iconName: IconName;
      iconBackground?: ColorType;
    }
  | {
      id: string;
      status: 'rewards';
      info: FlexibleInfo;
      value: { title: { amount: string; label: string } };
      iconName: IconName;
      iconBackground?: ColorType;
    };

export const ActivityCard: React.FC<
  ActivityCardProps & { onActivityPress?: (id: string) => void }
> = ({ onActivityPress, ...props }) => {
  const { theme } = useTheme();
  const styles = getStyles(theme);

  const { status, info, value, iconName, iconBackground } = props;
  const tags = info.tags;
  const coloredTags = useMemo(
    () => tags?.map(tag => ({ ...tag, colors: getTagColors(theme, tag.tone) })),
    [tags, theme],
  );
  const firstTagColors = coloredTags?.[0]?.colors;
  const tagIconColor =
    firstTagColors?.text ??
    getLabelColor(theme, iconBackground, 'semiTransparent');

  // Left tag
  const renderTag = useCallback(
    () => (
      <View style={styles.tagContainer}>
        <CustomTag
          size="S"
          backgroundType="semiTransparent"
          color={iconBackground}
          backgroundColor={firstTagColors?.background}
          icon={<Icon name={iconName} size={12} color={tagIconColor} />}
        />
      </View>
    ),
    [
      iconBackground,
      iconName,
      firstTagColors?.background,
      styles.tagContainer,
      tagIconColor,
    ],
  );

  // Info section (left side with flex)
  const renderInfo = useCallback(
    () => (
      <View style={styles.infoSection}>
        {!!info.title && (
          <Text.XS numberOfLines={1} ellipsizeMode="middle" variant="primary">
            {info.title}
          </Text.XS>
        )}
        {'subtitle' in info && !!info.subtitle && !coloredTags?.length && (
          <Text.XS variant="secondary" numberOfLines={1}>
            {info.subtitle}
          </Text.XS>
        )}
        {!!coloredTags?.length && (
          <View style={styles.subtitleRow}>
            {'subtitle' in info && !!info.subtitle && (
              <Text.XS variant="secondary" numberOfLines={1}>
                {info.subtitle}
              </Text.XS>
            )}
            {coloredTags.map((tag, index) => (
              <View
                key={`${tag.tone}-${tag.label}`}
                testID={`activity-${props.id}-tag-${index}`}
                style={[
                  styles.pill,
                  { backgroundColor: tag.colors.background },
                ]}>
                <Text.XS
                  weight="600"
                  numberOfLines={1}
                  style={{ color: tag.colors.text }}>
                  {tag.label}
                </Text.XS>
              </View>
            ))}
          </View>
        )}
      </View>
    ),
    [info, coloredTags, props.id, styles.subtitleRow, styles.pill],
  );

  // Value section (right side)
  const renderValue = useCallback(() => {
    const isFailedOrPending = status === 'pending' || status === 'failed';

    const amountVariant = isFailedOrPending ? 'secondary' : 'primary';
    const formattedValue =
      'title' in value && value.title
        ? truncateText(value.title.label, isWeb ? 30 : 20)
        : '';
    return (
      <View style={styles.valueSection}>
        {/* Render amount with label (e.g., "-100.00 ADA") */}
        {'title' in value && !!value.title && (
          <View style={styles.amountRow}>
            <Text.S variant={amountVariant}>{value.title.amount}</Text.S>
            <Text.XS variant="secondary" style={styles.label}>
              {formattedValue}
            </Text.XS>
          </View>
        )}

        {/* Render primary and secondary text (e.g., "5 Assets" with "2 Tokens, 3 NFTs") */}
        {'primaryText' in value && !!value.primaryText && (
          <View style={styles.amountRow}>
            <Text.M variant="primary">{value.primaryText}</Text.M>
            <Text.XS variant="secondary" style={styles.label}>
              {value.secondaryText}
            </Text.XS>
          </View>
        )}

        {/* Render subtitle below if exists */}
        {'subtitle' in value && !!value.subtitle && (
          <Text.XS variant="secondary" style={styles.valueSubtitle}>
            {value.subtitle}
          </Text.XS>
        )}
      </View>
    );
  }, [
    value,
    status,
    theme.text.secondary,
    theme.text.primary,
    theme.text.tertiary,
  ]);

  return (
    <Pressable
      testID={`activity-${props.id}`}
      onPress={() => {
        onActivityPress?.(props.id);
      }}>
      <BlurView testID="activity-list-item" style={styles.container}>
        {renderTag()}
        {renderInfo()}
        {renderValue()}
      </BlurView>
    </Pressable>
  );
};

/** Resolves the pill background and text colours of a tag tone. */
const getTagColors = (theme: Theme, tone: ActivityTagTone) => {
  switch (tone) {
    case 'hydraRecover':
      return {
        background: theme.extra.tagHydraRecoverBackground,
        text: theme.extra.tagHydraRecoverText,
      };
    case 'warning':
      return {
        background: theme.extra.tagWarningBackground,
        text: theme.extra.tagWarningText,
      };
    case 'hydra':
    case 'hydraDeposit':
      return {
        background: theme.extra.tagHydraBackground,
        text: theme.extra.tagHydraText,
      };
  }
};

const getStyles = (theme: Theme) =>
  StyleSheet.create({
    container: {
      flexDirection: 'row',
      alignItems: 'center',
      borderRadius: radius.M,
      padding: spacing.M,
      marginVertical: spacing.XS,
      minHeight: 64,
      backgroundColor: theme.background.primary,
      overflow: 'hidden',
    },
    tagContainer: {
      marginRight: spacing.S,
    },
    infoSection: {
      flex: 1,
      flexBasis: '25%',
      marginRight: spacing.M,
      justifyContent: 'center',
    },
    subtitleRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      alignItems: 'center',
      columnGap: spacing.S,
      rowGap: spacing.XS,
    },
    pill: {
      flexShrink: 1,
      borderRadius: radius.rounded,
      paddingHorizontal: spacing.S,
      paddingVertical: 1,
    },
    valueSection: {
      alignItems: 'flex-end',
      justifyContent: 'center',
    },
    amountRow: {
      flexDirection: 'row',
      alignItems: 'baseline',
    },
    label: {
      marginLeft: spacing.XS,
    },
    valueSubtitle: {
      marginTop: spacing.XS,
    },
  });
