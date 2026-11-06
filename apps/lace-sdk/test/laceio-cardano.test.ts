import { describe, expect, it } from 'vitest';

import {
  cardanoSubpathOf,
  isLaceioCardanoFile,
} from '../scripts/laceio-cardano.mjs';

describe('cardanoSubpathOf', () => {
  it('maps a workspace package @laceio/cardano publishes to its subpath', () => {
    expect(cardanoSubpathOf('@lace-lib/cardano-core')).toBe('core');
    expect(cardanoSubpathOf('@lace-lib/cardano-tx-builder')).toBe('tx-builder');
  });

  it('maps no package to a subpath @laceio/cardano no longer publishes', () => {
    expect(
      cardanoSubpathOf('@lace-lib/cardano-input-selection'),
    ).toBeUndefined();
    expect(
      cardanoSubpathOf('@lace-lib/cardano-tx-construction'),
    ).toBeUndefined();
  });

  it('leaves other packages, deep imports and npm names to the bundle', () => {
    expect(cardanoSubpathOf('@lace-lib/cardano-custody')).toBeUndefined();
    expect(cardanoSubpathOf('@lace-lib/cardano-util-rxjs')).toBeUndefined();
    expect(cardanoSubpathOf('@lace-lib/cardano-core/src/x')).toBeUndefined();
    expect(cardanoSubpathOf('@cardano-sdk/core')).toBeUndefined();
  });
});

describe('isLaceioCardanoFile', () => {
  it('holds for the files of a package @laceio/cardano publishes', () => {
    expect(
      isLaceioCardanoFile('/repo/packages/lib/cardano-core/src/index.ts'),
    ).toBe(true);
    expect(
      isLaceioCardanoFile('/repo/packages/lib/cardano-util/src/types.ts'),
    ).toBe(true);
    expect(
      isLaceioCardanoFile(
        '/repo/packages/lib/cardano-tx-builder/src/TransactionBuilder.ts',
      ),
    ).toBe(true);
  });

  it('does not hold for the workspace packages the SDK bundles', () => {
    expect(
      isLaceioCardanoFile('/repo/packages/lib/cardano-util-rxjs/src/index.ts'),
    ).toBe(false);
    expect(
      isLaceioCardanoFile('/repo/packages/lib/cardano-custody/src/index.ts'),
    ).toBe(false);
    expect(isLaceioCardanoFile('/repo/packages/lib/util/src/index.ts')).toBe(
      false,
    );
  });
});
