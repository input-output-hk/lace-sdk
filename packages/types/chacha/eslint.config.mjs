import { defineConfig } from 'eslint/config';

import rootConfig from '../../../eslint.config.mjs';

// Ambient declarations for a dependency that ships none: members of a
// declared class carry no accessibility modifiers.
export default defineConfig(...rootConfig, {
  files: ['**/*.d.ts'],
  rules: {
    '@typescript-eslint/explicit-member-accessibility': 'off',
  },
});
