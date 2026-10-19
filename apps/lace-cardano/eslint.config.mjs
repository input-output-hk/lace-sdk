import { defineConfig } from 'eslint/config';

import rootConfig from '../../eslint.config.mjs';

export default defineConfig(
  ...rootConfig,
  {
    files: ['**/*.{js,jsx,ts,tsx,mts,cts,mjs,cjs}'],
    languageOptions: {
      parserOptions: {
        project: './tsconfig.eslint.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // The consumer fixture imports the published package, whose declarations
    // exist only after a build; the build's gate type-checks it against them.
    ignores: ['tsdown.config.ts', 'dist/**', 'test/consumer-types.mts'],
  },
);
