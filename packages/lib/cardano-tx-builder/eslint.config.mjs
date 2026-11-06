import { defineConfig } from 'eslint/config';
import tsdocPlugin from 'eslint-plugin-tsdoc';

import rootConfig from '../../../eslint.config.mjs';

export default defineConfig(
  rootConfig,
  {
    files: ['**/*.{js,jsx,ts,tsx,mts,cts,mjs,cjs}'],
    languageOptions: {
      parserOptions: {
        project: './tsconfig.eslint.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  // Ported from cardano-js-sdk, which was written to its own conventions:
  // loops, mutation and reassignment. The rules below encode the platform's
  // style rather than correctness, so they stay off for the ported fee rules
  // instead of rewriting them.
  {
    files: ['src/fees.ts', 'test/fees.test.ts', 'test/fees-test-data.ts'],
    rules: {
      'functional/immutable-data': 'off',
      'functional/no-let': 'off',
      'functional/no-loop-statements': 'off',
      'max-params': 'off',
    },
  },
  {
    files: ['src/**/*.ts'],
    plugins: { tsdoc: tsdocPlugin },
    rules: {
      'tsdoc/syntax': 'error',
    },
  },
);
