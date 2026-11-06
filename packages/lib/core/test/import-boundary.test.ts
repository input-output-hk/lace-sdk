import path from 'node:path';

import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';

import type { Linter } from 'eslint';

const PACKAGE_ROOT = path.resolve(__dirname, '..');
const WORKSPACE_ROOT = path.resolve(PACKAGE_ROOT, '..', '..', '..');
const PROBE_PATH = path.join(PACKAGE_ROOT, 'src/__boundary-probe.ts');

type FlatConfigEntry = {
  files?: string[];
  rules?: Record<string, unknown>;
};

/**
 * The live `no-restricted-imports` options the package config applies to
 * `src`, read from the config file itself so the probes below exercise
 * whatever the rule currently says rather than a copy of it.
 */
const sourceRuleOptions = (async (): Promise<unknown> => {
  const { default: config } = (await import(
    path.join(PACKAGE_ROOT, 'eslint.config.mjs')
  )) as { default: FlatConfigEntry[] };
  const sourceEntry = config.find(
    entry =>
      entry.files?.includes('src/**/*.ts') &&
      entry.rules?.['no-restricted-imports'] !== undefined,
  );
  if (!sourceEntry) {
    throw new Error(
      'core import boundary probe: no src no-restricted-imports entry in packages/lib/core/eslint.config.mjs',
    );
  }
  return sourceEntry.rules!['no-restricted-imports'];
})();

/**
 * Lints `code` as if it were a core source file, without writing it to disk.
 * The rule needs no type information, so a bare parser sidesteps the tsconfig
 * membership check a virtual path would fail.
 */
const lintAsSource = async (code: string): Promise<string[]> => {
  const eslint = new ESLint({
    cwd: WORKSPACE_ROOT,
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ['**/*.ts'],
        languageOptions: { parser: tseslint.parser },
        rules: {
          'no-restricted-imports':
            (await sourceRuleOptions) as Linter.RuleEntry,
        },
      },
    ],
  });
  const [result] = await eslint.lintText(code, { filePath: PROBE_PATH });
  return result.messages.map(message => message.ruleId ?? '<parse-error>');
};

describe('core import boundary', () => {
  it.each([
    '@lace-lib/cardano-core',
    '@lace-lib/cardano-crypto',
    '@lace-lib/cardano-key-management',
    '@lace-lib/cardano-tx-builder',
    '@cardano-sdk/core',
  ])(
    'rejects the Cardano SDK at %s, which only the vendor seam may import',
    async specifier => {
      const code = `import * as banned from '${specifier}';\nexport const probe = banned;\n`;
      await expect(lintAsSource(code)).resolves.toEqual([
        'no-restricted-imports',
      ]);
    },
  );

  it('admits the vendor seam', async () => {
    const code = `import * as vendor from '@lace-lib/vendor';\nexport const probe = vendor;\n`;
    await expect(lintAsSource(code)).resolves.toEqual([]);
  });
});
