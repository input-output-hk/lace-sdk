import { describe, expect, it } from 'vitest';

import { getEnabledExtensionActivities } from '../../src/extensions';
import { FEATURE_FLAG_HYDRA_HEADS } from '../../src/hydra-heads-feature-flag';
import { FEATURE_FLAG_CNIGHT_DESIGNATION } from '../../src/night-designation-feature-flag';

describe('getEnabledExtensionActivities', () => {
  it.each([
    { keys: [], nightDesignation: false, hydra: false },
    {
      keys: [FEATURE_FLAG_CNIGHT_DESIGNATION],
      nightDesignation: true,
      hydra: false,
    },
    { keys: [FEATURE_FLAG_HYDRA_HEADS], nightDesignation: false, hydra: true },
    {
      keys: [FEATURE_FLAG_CNIGHT_DESIGNATION, FEATURE_FLAG_HYDRA_HEADS],
      nightDesignation: true,
      hydra: true,
    },
  ])(
    'turns each classification on by its own flag: $keys',
    ({ keys, nightDesignation, hydra }) => {
      expect(getEnabledExtensionActivities(keys.map(key => ({ key })))).toEqual(
        { nightDesignation, hydra },
      );
    },
  );
});
