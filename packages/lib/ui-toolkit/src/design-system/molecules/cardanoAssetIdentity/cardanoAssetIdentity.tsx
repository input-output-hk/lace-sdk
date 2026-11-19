import { CARDANO_TOKEN_METADATA_SCHEMA_VERSION } from '@lace-contract/cardano-context';
import { useTranslation } from '@lace-contract/i18n';
import React, {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Platform, Pressable, StyleSheet, View } from 'react-native';

import { radius, spacing, useTheme } from '../../../design-tokens';
import { Column, Icon, Row, Text } from '../../atoms';
import { truncateText } from '../../util/text-utils';

import { getCardanoAssetIdentity } from './assetIdentity';

import type { CardanoTokenMetadata } from '@lace-contract/cardano-context';
import type { StoredTokenMetadata } from '@lace-contract/tokens';

interface CardanoAssetIdentityProps {
  assetId: string;
  quantity: bigint;
  metadata?: StoredTokenMetadata;
  testID?: string;
}

interface IdentityValueProps {
  label: string;
  value: string;
  testID?: string;
}

const IdentityValue = ({ label, value, testID }: IdentityValueProps) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const toggleExpanded = useCallback(() => {
    setIsExpanded(previous => !previous);
  }, []);

  return (
    <Row alignItems="flex-start" gap={spacing.S}>
      <Text.XS style={styles.label}>{label}:</Text.XS>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label}: ${value}`}
        aria-expanded={isExpanded}
        onPress={toggleExpanded}
        style={styles.valueButton}
        testID={testID && `${testID}-toggle`}>
        <Text.XS
          align="right"
          selectable={isExpanded}
          style={styles.value}
          testID={testID}>
          {isExpanded ? value : truncateText(value, 24)}
        </Text.XS>
      </Pressable>
    </Row>
  );
};

interface MetadataVerificationProps {
  testID?: string;
}

const MetadataVerification = ({ testID }: MetadataVerificationProps) => {
  const { t } = useTranslation();
  const { theme } = useTheme();
  const hintId = useId();
  const [isHintVisible, setIsHintVisible] = useState(false);
  const isPinned = useRef(false);
  const isFocused = useRef(false);
  const showHint = useCallback(() => {
    setIsHintVisible(true);
  }, []);
  const dismissHint = useCallback(() => {
    isPinned.current = false;
    setIsHintVisible(false);
  }, []);
  const handlePointerLeave = useCallback(() => {
    if (!isPinned.current && !isFocused.current) setIsHintVisible(false);
  }, []);
  const handleFocus = useCallback(() => {
    isFocused.current = true;
    showHint();
  }, [showHint]);
  const handleBlur = useCallback(() => {
    isFocused.current = false;
    dismissHint();
  }, [dismissHint]);
  const togglePinnedHint = useCallback(() => {
    // A pointer press follows focus; pin the hint instead of toggling it closed.
    isPinned.current = !isPinned.current;
    setIsHintVisible(isPinned.current);
  }, []);
  useEffect(() => {
    if (Platform.OS !== 'web' || !isHintVisible) return;
    // Window capture precedes the sheet's document listener, including when
    // hover opens the hint while focus remains outside this component.
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        dismissHint();
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [dismissHint, isHintVisible]);
  const hintStyle = useMemo(
    () => [
      styles.hint,
      {
        backgroundColor: theme.background.page,
        borderColor: theme.border.middle,
      },
    ],
    [theme],
  );

  return (
    <View style={styles.verification} onPointerLeave={handlePointerLeave}>
      <Row gap={spacing.XS} alignItems="center">
        <Text.XS
          style={styles.verificationText}
          testID={testID && `${testID}-verification`}>
          {t('dapp-connector.cardano.sign-tx.asset-identity.verification')}:{' '}
          {t('dapp-connector.cardano.sign-tx.asset-identity.unverified')}
        </Text.XS>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t(
            'dapp-connector.cardano.sign-tx.asset-identity.verification',
          )}
          accessibilityState={{ expanded: isHintVisible }}
          accessibilityHint={t(
            'dapp-connector.cardano.sign-tx.asset-identity.metadata-hint',
          )}
          aria-describedby={isHintVisible ? hintId : undefined}
          onHoverIn={showHint}
          onFocus={handleFocus}
          onBlur={handleBlur}
          onPress={togglePinnedHint}
          onAccessibilityEscape={dismissHint}
          style={styles.infoButton}
          testID={testID && `${testID}-metadata-info`}>
          <Icon
            name="InformationCircle"
            size={16}
            color={theme.text.secondary}
          />
        </Pressable>
      </Row>
      {isHintVisible && (
        <View nativeID={hintId} role="tooltip" style={hintStyle}>
          <Text.XS>
            {t('dapp-connector.cardano.sign-tx.asset-identity.metadata-hint')}
          </Text.XS>
        </View>
      )}
    </View>
  );
};

export const CardanoAssetIdentity = ({
  assetId,
  quantity,
  metadata,
  testID,
}: CardanoAssetIdentityProps) => {
  const { t } = useTranslation();
  const { theme } = useTheme();
  const [isDetailsExpanded, setIsDetailsExpanded] = useState(false);
  const toggleDetails = useCallback(() => {
    setIsDetailsExpanded(previous => !previous);
  }, []);
  const identity = useMemo(() => getCardanoAssetIdentity(assetId), [assetId]);
  const cardanoMetadata = metadata?.blockchainSpecific as
    | CardanoTokenMetadata
    | undefined;
  // Older caches inferred sources from presentation fields and can misidentify them.
  const sources =
    cardanoMetadata?.metadataSchemaVersion ===
    CARDANO_TOKEN_METADATA_SCHEMA_VERSION
      ? cardanoMetadata.metadataSources
      : undefined;
  const metadataSource = Array.isArray(sources)
    ? sources.length === 0
      ? t('dapp-connector.cardano.sign-tx.asset-identity.no-metadata')
      : sources
          .map(source =>
            source === 'on-chain'
              ? t('dapp-connector.cardano.sign-tx.asset-identity.on-chain')
              : source === 'token-registry'
              ? t('dapp-connector.cardano.sign-tx.asset-identity.registry')
              : t('v2.generic.unknown'),
          )
          .join(' / ')
    : t('v2.generic.unknown');

  return (
    <Column gap={spacing.XS} style={styles.container} testID={testID}>
      <IdentityValue
        key={identity.fingerprint}
        label={`${t('v2.token-detail.fingerprint')} (CIP-14)`}
        value={identity.fingerprint}
        testID={testID && `${testID}-fingerprint`}
      />
      <IdentityValue
        key={identity.policyId}
        label={t('v2.token-detail.policyId')}
        value={identity.policyId}
        testID={testID && `${testID}-policy`}
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('v2.generic.label.details')}
        accessibilityState={{ expanded: isDetailsExpanded }}
        onPress={toggleDetails}
        style={styles.detailsButton}
        testID={testID && `${testID}-details`}>
        <Text.XS variant="secondary">{t('v2.generic.label.details')}</Text.XS>
        <Icon
          name={isDetailsExpanded ? 'CaretUp' : 'CaretDown'}
          size={16}
          color={theme.text.secondary}
        />
      </Pressable>
      {isDetailsExpanded && (
        <Column gap={spacing.S} style={styles.details}>
          <Text.XS selectable testID={testID && `${testID}-quantity`}>
            {t('dapp-connector.cardano.sign-tx.asset-identity.quantity')}:{' '}
            {quantity.toString()}
          </Text.XS>
          <Text.XS selectable testID={testID && `${testID}-name-hex`}>
            {t('dapp-connector.cardano.sign-tx.asset-identity.name-hex')}:{' '}
            {identity.assetNameHex || '∅'}
          </Text.XS>
          <Text.XS testID={testID && `${testID}-metadata-source`}>
            {t('dapp-connector.cardano.sign-tx.asset-identity.source')}:{' '}
            {metadataSource}
          </Text.XS>
          <MetadataVerification testID={testID} />
        </Column>
      )}
    </Column>
  );
};

const styles = StyleSheet.create({
  container: { width: '100%', minWidth: 0 },
  label: { maxWidth: '48%', paddingVertical: spacing.XS },
  valueButton: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: spacing.XS,
  },
  value: { flex: 1, minWidth: 0 },
  detailsButton: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.XS,
    paddingVertical: spacing.S,
  },
  details: { paddingLeft: spacing.S },
  verification: { zIndex: 1 },
  verificationText: { flexShrink: 1 },
  infoButton: { padding: spacing.XS },
  hint: {
    position: 'absolute',
    bottom: '100%',
    left: 0,
    right: 0,
    borderWidth: 1,
    borderRadius: radius.S,
    padding: spacing.S,
    zIndex: 1,
  },
});
