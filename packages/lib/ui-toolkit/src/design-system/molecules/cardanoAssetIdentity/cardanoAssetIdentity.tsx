import { CARDANO_TOKEN_METADATA_SCHEMA_VERSION } from '@lace-contract/cardano-context';
import { useTranslation } from '@lace-contract/i18n';
import React, { useCallback, useMemo, useState } from 'react';
import { Pressable, StyleSheet } from 'react-native';

import { spacing } from '../../../design-tokens';
import { Column, Row, Text } from '../../atoms';
import { truncateText } from '../../util/text-utils';
import { Accordion } from '../accordion/accordion';

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

export const CardanoAssetIdentity = ({
  assetId,
  quantity,
  metadata,
  testID,
}: CardanoAssetIdentityProps) => {
  const { t } = useTranslation();
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
      <Text.XS selectable testID={testID && `${testID}-quantity`}>
        {t('dapp-connector.cardano.sign-tx.asset-identity.quantity')}:{' '}
        {quantity.toString()}
      </Text.XS>
      <Text.XS selectable testID={testID && `${testID}-name-hex`}>
        {t('dapp-connector.cardano.sign-tx.asset-identity.name-hex')}:{' '}
        {identity.assetNameHex || '∅'}
      </Text.XS>
      <Accordion.Root
        title={t('v2.generic.label.details')}
        testID={testID && `${testID}-details`}>
        <Column gap={spacing.S}>
          <Text.XS testID={testID && `${testID}-metadata-source`}>
            {t('dapp-connector.cardano.sign-tx.asset-identity.source')}:{' '}
            {metadataSource}
          </Text.XS>
          <Text.XS testID={testID && `${testID}-verification`}>
            {t('dapp-connector.cardano.sign-tx.asset-identity.verification')}:{' '}
            {t('dapp-connector.cardano.sign-tx.asset-identity.unverified')}
          </Text.XS>
          <Text.XS variant="secondary">
            {t('dapp-connector.cardano.sign-tx.asset-identity.metadata-hint')}
          </Text.XS>
        </Column>
      </Accordion.Root>
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
});
