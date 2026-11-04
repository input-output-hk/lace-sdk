import React, { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';

import { radius, spacing, useTheme } from '../../../design-tokens';
import { Icon, Text } from '../../atoms';

import type { Theme } from '../../../design-tokens';

/** Colour family of the state dot: a running head or one that is winding down. */
export type HydraHeadStateTone = 'closing' | 'open';

/**
 * Colour family of a deposit line: waiting for the head to absorb it, or past
 * its deadline and only recoverable.
 */
export type HydraHeadDepositTone = 'pending' | 'recoverable';

/** One line summing the account's deposits that wait outside the head. */
export type HydraHeadDeposit = {
  /** The summed amount with what it is waiting for. */
  label: string;
  /** Colour family of the line. */
  tone: HydraHeadDepositTone;
};

/** Props of a card for one Hydra head the account has funds in. */
export type HydraHeadCardProps = {
  /** Short head identifier, for example "Head 324c8b81...5bdc". */
  title: string;
  /** What the head is doing, shown beside a coloured dot. */
  stateLabel: string;
  /** Colour family of the state dot and text. */
  stateTone: HydraHeadStateTone;
  /** What went into the head for the account, when there is a figure. */
  amount?: string;
  /** Deposits of the account still waiting outside the head. */
  deposits?: readonly HydraHeadDeposit[];
  /** The head's total and how many participants share it. */
  amountDetail?: string;
  /** Reminds that the account's current share inside the head is not on-chain. */
  footnote: string;
  /** Test identifier of the root view; child elements append a suffix. */
  testID?: string;
};

/** Props of the captioned group of Hydra head cards. */
export type HydraHeadsSectionProps = {
  /** Caption above the cards. */
  title: string;
  /** The head cards. */
  children: React.ReactNode;
  /** Test identifier of the root view; child elements append a suffix. */
  testID?: string;
};

/**
 * One Hydra head the account has funds in: the head, its state, and the
 * amounts the layer 1 records can vouch for. Deposits still waiting outside
 * the head are listed apart, a recoverable one in the warning colour. It
 * never shows a balance, since the account's current share inside a head is
 * not visible on-chain.
 */
export const HydraHeadCard = ({
  title,
  stateLabel,
  stateTone,
  amount,
  deposits,
  amountDetail,
  footnote,
  testID,
}: HydraHeadCardProps) => {
  const { theme } = useTheme();
  const styles = useMemo(() => getStyles(theme), [theme]);
  const stateColor =
    stateTone === 'open'
      ? theme.extra.tagHydraRecoverText
      : theme.extra.tagWarningText;

  return (
    <View accessible style={styles.card} testID={testID}>
      <View style={styles.row}>
        <View style={styles.identity}>
          <View style={styles.iconTag}>
            <Icon
              color={theme.extra.tagHydraText}
              name="FlowConnection"
              size={12}
            />
          </View>
          <View style={styles.titleColumn}>
            <Text.S weight="600" testID={testID && `${testID}-title`}>
              {title}
            </Text.S>
            <View style={styles.state}>
              <View
                style={[styles.dot, { backgroundColor: stateColor }]}
                testID={testID && `${testID}-state-dot`}
              />
              <Text.XS
                variant={stateTone === 'open' ? 'secondary' : undefined}
                style={stateTone === 'closing' ? { color: stateColor } : null}
                testID={testID && `${testID}-state`}>
                {stateLabel}
              </Text.XS>
            </View>
          </View>
        </View>
        <View style={styles.amounts}>
          {amount ? (
            <Text.S
              weight="600"
              style={styles.alignEnd}
              testID={testID && `${testID}-amount`}>
              {amount}
            </Text.S>
          ) : null}
          {deposits?.map(({ label, tone }, index) => (
            <Text.XS
              key={`${tone}-${index}`}
              variant={tone === 'pending' ? 'secondary' : undefined}
              style={
                tone === 'recoverable'
                  ? [styles.alignEnd, { color: theme.extra.tagWarningText }]
                  : styles.alignEnd
              }
              testID={testID && `${testID}-deposit-${index}`}>
              {label}
            </Text.XS>
          ))}
          {amountDetail ? (
            <Text.XS
              variant="secondary"
              style={styles.alignEnd}
              testID={testID && `${testID}-amount-detail`}>
              {amountDetail}
            </Text.XS>
          ) : null}
        </View>
      </View>
      <Text.XS variant="tertiary" testID={testID && `${testID}-footnote`}>
        {footnote}
      </Text.XS>
    </View>
  );
};

/**
 * Groups the Hydra head cards under a small uppercase caption. It sits
 * apart from the token list because the funds it lists are not part of any
 * balance.
 */
export const HydraHeadsSection = ({
  title,
  children,
  testID,
}: HydraHeadsSectionProps) => {
  return (
    <View style={sectionStyles.section} testID={testID}>
      <Text.XS
        weight="600"
        variant="secondary"
        style={sectionStyles.caption}
        testID={testID && `${testID}-title`}>
        {title}
      </Text.XS>
      {children}
    </View>
  );
};

const sectionStyles = StyleSheet.create({
  section: {
    gap: spacing.S,
    paddingVertical: spacing.S,
  },
  caption: {
    letterSpacing: 1,
    paddingHorizontal: spacing.XS,
    textTransform: 'uppercase',
  },
});

const getStyles = (theme: Theme) =>
  StyleSheet.create({
    card: {
      backgroundColor: theme.background.primary,
      borderRadius: radius.S,
      gap: spacing.S,
      minHeight: 64,
      padding: 12,
    },
    row: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: spacing.S,
      justifyContent: 'space-between',
    },
    identity: {
      alignItems: 'center',
      flexDirection: 'row',
      flexShrink: 1,
      gap: spacing.S,
    },
    iconTag: {
      alignItems: 'center',
      backgroundColor: theme.extra.tagHydraBackground,
      borderRadius: radius.XS,
      height: 24,
      justifyContent: 'center',
      width: 24,
    },
    titleColumn: {
      flexShrink: 1,
      gap: 2,
    },
    state: {
      alignItems: 'center',
      alignSelf: 'flex-start',
      flexDirection: 'row',
      gap: 5,
    },
    dot: {
      borderRadius: 3,
      height: 6,
      width: 6,
    },
    amounts: {
      alignItems: 'flex-end',
      flexShrink: 1,
      gap: 2,
    },
    alignEnd: {
      textAlign: 'right',
    },
  });
