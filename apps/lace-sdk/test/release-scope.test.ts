import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  binaryOwners,
  buildCommands,
  buildTargetOf,
  buildTargetSeeds,
  importsOf,
  lockSignature,
  packageOfSpecifier,
  resolveIn,
  signatureChanges,
  type Lockfile,
} from '../scripts/dependency-scope';
import { internalTermFindings } from '../scripts/release-notes-check';
import {
  cleanTitle,
  renderNotes,
  renderPublicNotes,
  workspaceManifestChanges,
} from '../scripts/release-scope';

const lock = (packages: Lockfile['packages']): Lockfile => ({ packages });

const BASE = lock({
  'node_modules/rxjs': { version: '7.8.1', dependencies: { tslib: '^2.1.0' } },
  'node_modules/tslib': { version: '2.6.0' },
  'node_modules/react': { version: '18.2.0' },
  'node_modules/@lace-lib/core': { link: true },
  'packages/lib/core/node_modules/bignumber.js': { version: '9.0.1' },
  'node_modules/bignumber.js': { version: '9.3.1' },
});

describe('the dependencies the family reaches', () => {
  it('reads the package a bare specifier names', () => {
    expect(packageOfSpecifier('rxjs/operators')).toBe('rxjs');
    expect(packageOfSpecifier('@cardano-sdk/core/dist/x')).toBe(
      '@cardano-sdk/core',
    );
    expect(packageOfSpecifier('./local')).toBeUndefined();
    expect(packageOfSpecifier('node:fs')).toBeUndefined();
    expect(
      importsOf("import { a } from 'rxjs';\nexport * from './b';"),
    ).toEqual(['rxjs', './b']);
  });

  it('resolves as npm does, from the importing package up', () => {
    expect(resolveIn(BASE, 'packages/lib/core', 'bignumber.js')).toBe(
      'packages/lib/core/node_modules/bignumber.js',
    );
    expect(resolveIn(BASE, 'apps/lace-sdk', 'bignumber.js')).toBe(
      'node_modules/bignumber.js',
    );
    expect(resolveIn(BASE, '', 'missing')).toBeUndefined();
  });

  it('closes over dependencies, skips workspace links and the packages nothing reaches', () => {
    const signature = lockSignature(BASE, [
      { from: 'apps/lace-sdk', name: 'rxjs' },
      { from: 'apps/lace-sdk', name: '@lace-lib/core' },
    ]);
    expect([...signature.keys()].sort()).toEqual([
      'node_modules/rxjs',
      'node_modules/tslib',
    ]);
  });

  it('counts a lockfile change only where a reached entry differs', () => {
    const seeds = [{ from: 'apps/lace-sdk', name: 'rxjs' }];
    const reactBump = lock({
      ...BASE.packages,
      'node_modules/react': { version: '19.0.0' },
    });
    expect(
      signatureChanges(
        lockSignature(BASE, seeds),
        lockSignature(reactBump, seeds),
      ),
    ).toEqual([]);
    const tslibBump = lock({
      ...BASE.packages,
      'node_modules/tslib': { version: '2.8.1' },
    });
    expect(
      signatureChanges(
        lockSignature(BASE, seeds),
        lockSignature(tslibBump, seeds),
      ),
    ).toEqual(['node_modules/tslib']);
  });

  it('counts a root override only when it names a package reached', () => {
    const seeds = [{ from: '', name: 'rxjs' }];
    expect(
      signatureChanges(
        lockSignature(BASE, seeds, { react: '18.3.0' }),
        lockSignature(BASE, seeds, { react: '19.0.0' }),
      ),
    ).toEqual([]);
    expect(
      signatureChanges(
        lockSignature(BASE, seeds, { 'tslib@2': '2.6.0' }),
        lockSignature(BASE, seeds, { 'tslib@2': '2.8.1' }),
      ),
    ).toEqual(['overrides:tslib@2']);
  });
});

describe('the manifests of reached workspace packages', () => {
  const VENDOR = 'packages/lib/vendor/package.json';
  const reached = new Set(['packages/lib/vendor/src/index.ts']);
  const before = {
    name: '@lace-lib/vendor',
    version: '0.0.0',
    description: 'Vendored modules',
    scripts: { build: 'tsc' },
    main: './src/index.ts',
    exports: { '.': './src/index.ts', './bip39': './src/bip39.ts' },
    sideEffects: false,
  };
  const changes = (after: Record<string, unknown>, files = [VENDOR]) =>
    workspaceManifestChanges({
      files,
      reached,
      before: () => before,
      after: () => after,
    });

  it('counts a change to a field that decides what bundles, with the third-party dependencies unchanged', () => {
    // The lockfile links a workspace package, so its signature cannot see this.
    expect(
      signatureChanges(
        lockSignature(BASE, [{ from: '', name: '@lace-lib/core' }]),
        lockSignature(BASE, [{ from: '', name: '@lace-lib/core' }]),
      ),
    ).toEqual([]);
    expect(
      changes({
        ...before,
        exports: { ...before.exports, './bip39': './src/bip39-legacy.ts' },
      }),
    ).toEqual([`${VENDOR} (exports)`]);
    expect(changes({ ...before, sideEffects: true })).toEqual([
      `${VENDOR} (sideEffects)`,
    ]);
    expect(
      changes({ ...before, main: './dist/index.js', type: 'module' }),
    ).toEqual([`${VENDOR} (main, type)`]);
  });

  it('skips a change to the version, description or scripts alone', () => {
    expect(
      changes({
        ...before,
        version: '0.0.1',
        description: 'Modules vendored for the SDK',
        scripts: { build: 'tsc -b' },
      }),
    ).toEqual([]);
  });

  it('skips the manifests of packages the builds do not reach', () => {
    expect(
      changes({ ...before, sideEffects: true }, [
        'packages/lib/other/package.json',
      ]),
    ).toEqual([]);
  });
});

describe('the tools the build targets run', () => {
  it('reads the programs, npx targets and node scripts of a build script', () => {
    expect(
      buildCommands(
        [
          '#!/usr/bin/env bash',
          'set -euo pipefail',
          'node scripts/check.mjs',
          'SDK_CHANNEL=stable npx tsdown --config x',
          '  tsc -p tsconfig.json && npx rollup -c r.mjs # bundle',
        ].join('\n'),
      ),
    ).toEqual({
      binaries: ['rollup', 'set', 'tsc', 'tsdown'],
      packages: [],
      scripts: ['scripts/check.mjs'],
      shellScripts: [],
      configs: ['r.mjs', 'x'],
    });
  });

  it.each([
    ['npm exec', 'npm exec -- tsdown --watch', { binaries: ['tsdown'] }],
    [
      'npm exec with options',
      'npm exec --yes rollup -c',
      { binaries: ['rollup'] },
    ],
    ['npm x', 'npm x tsc', { binaries: ['tsc'] }],
    [
      'npx -p',
      'npx -p typescript@5.9.3 tsc -p .',
      { binaries: ['tsc'], packages: ['typescript'] },
    ],
    [
      'npx --package=',
      'npx --package=@scope/tool@1 run',
      { binaries: ['run'], packages: ['@scope/tool'] },
    ],
    ['env', 'env NODE_ENV=production tsdown', { binaries: ['tsdown'] }],
    ['exec and time', 'exec time tsc', { binaries: ['tsc'] }],
    [
      'a .bin path',
      '../../node_modules/.bin/tsdown --config x',
      { binaries: ['tsdown'], configs: ['x'] },
    ],
    ['sh', 'sh scripts/build.sh', { shellScripts: ['scripts/build.sh'] }],
    [
      './',
      './scripts/build.sh && ./scripts/pack.mjs',
      {
        shellScripts: ['./scripts/build.sh'],
        scripts: ['./scripts/pack.mjs'],
      },
    ],
  ])('reads %s', (_form, script, expected) => {
    expect(buildCommands(script)).toEqual({
      binaries: [],
      packages: [],
      scripts: [],
      shellScripts: [],
      configs: [],
      ...expected,
    });
  });

  const owners = new Map([
    ['tsdown', 'tsdown'],
    ['tsc', 'typescript'],
  ]);
  const files: Record<string, string> = {
    'apps/x/project.json': '',
    'apps/x/scripts/build.sh':
      'cd "$(dirname "$0")/.."\nnode scripts/check.mjs\nsh scripts/inner.sh',
    'apps/x/scripts/inner.sh': 'npx tsdown',
    'apps/x/scripts/check.mjs':
      "import ts from 'typescript';\nimport './lib.mjs';",
    'apps/x/scripts/lib.mjs': "import { x } from 'rollup';",
    'apps/x/tsdown.config.ts':
      "import polyfills from '@rolldown/plugin-node-polyfills';",
  };
  const seedsOf = (commands: string[], extra: Record<string, string> = {}) =>
    buildTargetSeeds({
      target: { app: 'apps/x', commands, cwd: 'apps/x' },
      read: file => ({ ...files, ...extra }[file]),
      configs: ['tsdown.config.ts'],
      owners,
      hasPackage: name => name === 'typescript',
    });

  it('follows the scripts a target runs, and their imports, to the tools', () => {
    expect(
      seedsOf(['bash scripts/build.sh'])
        .map(({ from, name }) => `${from || '(root)'} ${name}`)
        .sort(),
    ).toEqual([
      '(root) tsdown',
      'apps/x @rolldown/plugin-node-polyfills',
      'apps/x rollup',
      'apps/x typescript',
    ]);
  });

  it("seeds only the build tools' configuration, not a test runner's or a linter's", () => {
    const seeds = buildTargetSeeds({
      target: {
        app: 'apps/x',
        commands: ['npx tsdown && npx rollup -c rollup.dts.config.mjs'],
        cwd: 'apps/x',
      },
      read: file =>
        ({
          'apps/x/tsdown.config.ts': "import a from 'tsdown-plugin';",
          'apps/x/rollup.dts.config.mjs':
            "import dts from 'rollup-plugin-dts';",
          'apps/x/vitest.config.ts':
            "import { defineConfig } from 'vitest/config';",
          'apps/x/eslint.config.mjs': "import lint from 'eslint-plugin-x';",
        }[file]),
      configs: ['eslint.config.mjs', 'tsdown.config.ts', 'vitest.config.ts'],
      owners: new Map([
        ['tsdown', 'tsdown'],
        ['rollup', 'rollup'],
      ]),
      hasPackage: () => false,
    }).map(({ name }) => name);
    expect(seeds.sort()).toEqual([
      'rollup',
      'rollup-plugin-dts',
      'tsdown',
      'tsdown-plugin',
    ]);
  });

  it('refuses a script the target runs that does not exist', () => {
    expect(() => seedsOf(['bash scripts/missing.sh'])).toThrow(
      /runs scripts\/missing\.sh, which does not exist/,
    );
    expect(() => seedsOf(['npx tsdown && node scripts/gone.mjs'])).toThrow(
      /runs scripts\/gone\.mjs, which does not exist/,
    );
  });

  it('refuses a target that runs no tool of the lockfile', () => {
    expect(() => seedsOf(['echo building'])).toThrow(
      /runs no tool the lockfile provides/,
    );
    expect(seedsOf(['npx -p typescript tsc'])).toContainEqual({
      from: '',
      name: 'typescript',
    });
  });

  it('reads options.command or options.commands, and refuses neither', () => {
    expect(
      buildTargetOf('apps/x', {
        targets: { build: { options: { command: 'bash scripts/build.sh' } } },
      }),
    ).toEqual({
      app: 'apps/x',
      commands: ['bash scripts/build.sh'],
      cwd: 'apps/x',
    });
    expect(
      buildTargetOf('apps/x', {
        targets: {
          build: {
            options: {
              commands: ['npx tsdown', { command: 'tsc -p .' }],
              cwd: 'apps/x/sub',
            },
          },
        },
      }),
    ).toEqual({
      app: 'apps/x',
      commands: ['npx tsdown', 'tsc -p .'],
      cwd: 'apps/x/sub',
    });
    expect(() => buildTargetOf('apps/x', { targets: {} })).toThrow(
      /runs no command/,
    );
  });

  it('maps a binary to the root package whose bin provides it', () => {
    const owners = binaryOwners({
      packages: {
        'node_modules/typescript': {
          version: '5.9.3',
          bin: { tsc: 'bin/tsc', tsserver: 'bin/tsserver' },
        },
        'node_modules/tsdown': { version: '0.15.0', bin: 'dist/run.js' },
        'node_modules/a/node_modules/tsc-shadow': { bin: { tsc: 'x' } },
      } as Lockfile['packages'],
    });
    expect(owners.get('tsc')).toBe('typescript');
    expect(owners.get('tsdown')).toBe('tsdown');
    expect(owners.get('set')).toBeUndefined();
  });

  it('counts a lockfile-only bump of a build tool', () => {
    const seeds = [{ from: '', name: 'tsdown' }];
    const before = lock({ 'node_modules/tsdown': { version: '0.15.0' } });
    const after = lock({ 'node_modules/tsdown': { version: '0.15.1' } });
    expect(
      signatureChanges(
        lockSignature(before, seeds),
        lockSignature(after, seeds),
      ),
    ).toEqual(['node_modules/tsdown']);
  });
});

describe('ticket references and internal terms', () => {
  it('drops ticket references from titles', () => {
    expect(cleanTitle('fix: deploy the prover [LW-123]')).toBe(
      'fix: deploy the prover',
    );
    expect(cleanTitle('fix(lw-456): keep the form in view [LW-456]')).toBe(
      'fix: keep the form in view',
    );
    expect(cleanTitle('LW-123: wallet sync')).toBe('wallet sync');
    // Unhyphenated and branch-name forms.
    expect(cleanTitle('feat: show the balance [LW 789]')).toBe(
      'feat: show the balance',
    );
    expect(cleanTitle('[LW1001] add a contact list')).toBe(
      'add a contact list',
    );
    expect(cleanTitle('Lw 2002/the address book view')).toBe(
      'the address book view',
    );
    expect(cleanTitle('Feat/lw 3003 tidy the summary')).toBe(
      'tidy the summary',
    );
    expect(cleanTitle('Feat/lw 4004 rename a setting')).toBe(
      'rename a setting',
    );
    expect(cleanTitle('feat(sdk)!: an entry (LW-9001)')).toBe(
      'feat(sdk)!: an entry',
    );
  });

  it('finds every form of a ticket reference', () => {
    for (const reference of [
      'LW-123',
      'LW 789',
      'LW1001',
      'lw_2002',
      'lace-1234',
    ]) {
      expect(internalTermFindings(`- fix: ${reference}`)).toHaveLength(1);
    }
    expect(
      internalTermFindings('- feat: lace next, 3 wallets, Lace 2.4.1'),
    ).toEqual([]);
  });

  it('finds internal terms in text', () => {
    const notes = renderNotes({
      ref: 'lace-sdk@0.1.0',
      changes: [
        { sha: 'a'.repeat(40), number: 1, title: 'feat: follow ADR 66' },
        { sha: 'b'.repeat(40), number: 2, title: 'fix: as discussed on Slack' },
        { sha: 'c'.repeat(40), number: 3, title: 'feat: a wallet' },
      ],
    });
    expect(internalTermFindings(notes)).toEqual([
      expect.stringContaining('ADR'),
      expect.stringContaining('slack'),
    ]);
    expect(
      internalTermFindings('## Changes\n\n- feat: a wallet (#3)\n'),
    ).toEqual([]);
  });
});

describe('the public release notes', () => {
  const api = {
    tag: 'lace-sdk@0.2.0',
    version: '0.2.0',
    channel: 'stable',
    previous: 'lace-sdk@0.1.4',
    bump: 'breaking',
    added: ['cardano:openWallet'],
    removed: ['cardano:legacyWallet'],
    changed: ['index:createWallet'],
    compatible: ['index:Options'],
  };

  it('carry the version, the API, the docs and the packages', () => {
    const notes = renderPublicNotes(api);
    expect(notes).toContain('## lace-sdk@0.2.0');
    expect(notes).toContain(
      'Compared with `lace-sdk@0.1.4`: a breaking change.',
    );
    expect(notes).toContain('- Removed: `cardano:legacyWallet`');
    expect(notes).toContain('- Declared compatible: `index:Options`');
    expect(notes).toContain('https://sdk.lace.io/v/0.2.0/');
    expect(notes).toContain(
      'https://www.npmjs.com/package/@laceio/cardano-trezor/v/0.2.0',
    );
    expect(
      renderPublicNotes({
        ...api,
        tag: 'lace-sdk@0.2.0-canary.3',
        version: '0.2.0-canary.3',
        channel: 'canary',
      }),
    ).toContain('https://sdk.lace.io/canary/');
    expect(
      renderPublicNotes({
        ...api,
        previous: null,
        added: ['index:a', 'index:b'],
      }),
    ).toContain('The first release, with 2 stable exports.');
  });

  it('never name a pull request, a commit or a SHA', () => {
    // Whatever the private notes would list, the public renderer is given
    // the API diff alone and has nowhere to put a change.
    const notes = renderPublicNotes(api);
    expect(notes).not.toMatch(/#\d+/);
    expect(notes).not.toMatch(/\b[0-9a-f]{12,40}\b/);
    expect(notes).not.toMatch(/pull request|merge|commit/i);
    expect(notes).not.toContain('## Changes');
    expect(notes).not.toContain('Dependency updates');
    expect(internalTermFindings(notes)).toEqual([]);
  });
});

// The release workflow lives in lace-platform alone; the generated public
// repository carries its own, so this reads it only where it exists.
const RELEASE_WORKFLOW = path.resolve(
  import.meta.dirname,
  '../../../.github/workflows/sdk-release.yml',
);

describe.skipIf(!fs.existsSync(RELEASE_WORKFLOW))(
  "the public draft's seed",
  () => {
    const workflow = fs.existsSync(RELEASE_WORKFLOW)
      ? fs.readFileSync(RELEASE_WORKFLOW, 'utf8')
      : '';
    const publish = workflow.slice(
      workflow.indexOf('\n  publish:\n'),
      workflow.indexOf('\n  build-sdk-site:\n'),
    );

    it('is the public notes check-sdk wrote and hashed, and nothing else', () => {
      expect(publish).toContain(
        'name: sdk-public-notes-check-${{ github.run_id }}',
      );
      expect(publish).toContain(
        'EXPECTED_SHA256: ${{ needs.check-sdk.outputs.public_notes_sha256 }}',
      );
      expect(publish).toContain(
        'body_file="$RUNNER_TEMP/notes-artifact/public-release-notes.md"',
      );
      // The private release's body, with its pull requests, is never read.
      expect(publish).not.toMatch(/gh release view[^\n]*--json body/);
      expect(publish).not.toContain('private-release-notes');
    });
  },
);

const VERSION_WORKFLOW = path.resolve(
  import.meta.dirname,
  '../../../.github/workflows/sdk-release-version.yml',
);

describe.skipIf(!fs.existsSync(VERSION_WORKFLOW))(
  "the release job's environment",
  () => {
    const workflow = fs.existsSync(VERSION_WORKFLOW)
      ? fs.readFileSync(VERSION_WORKFLOW, 'utf8')
      : '';
    const job = workflow.slice(workflow.indexOf('\n  release:\n'));
    const expression =
      /\n {4}environment: \$\{\{(.*)\}\}\n/.exec(job)?.[1]?.trim() ?? '';

    /**
     * The environment the expression picks for a run. The expression has
     * GitHub's `(a == b && …) && 'x' || 'y'` form, which picks 'x' when every
     * comparison holds and 'y' otherwise.
     */
    const environmentFor = (context: Record<string, string>): string => {
      const form = /^\((.*)\) && '([^']+)' \|\| '([^']+)'$/.exec(expression);
      if (!form)
        throw new Error(`unexpected environment expression: ${expression}`);
      const [, condition = '', chosen, otherwise] = form;
      const value = (operand: string) =>
        /^'.*'$/.test(operand) ? operand.slice(1, -1) : context[operand];
      const isMet = condition.split(' && ').every(comparison => {
        const [left = '', right = ''] = comparison.split(' == ');
        return value(left.trim()) === value(right.trim());
      });
      return (isMet ? chosen : otherwise) ?? '';
    };

    const nightly = {
      'inputs.channel': 'canary',
      'github.event_name': 'schedule',
      'github.run_attempt': '1',
      'github.actor': 'scheduler',
      'github.triggering_actor': 'scheduler',
    };

    it('tags unattended only on the first attempt of the nightly schedule', () => {
      expect(environmentFor(nightly)).toBe('sdk-canary-tag');
    });

    it.each([
      [
        'a stable release',
        {
          ...nightly,
          'inputs.channel': 'stable',
          'github.event_name': 'workflow_dispatch',
        },
      ],
      [
        'a canary dispatched by hand',
        { ...nightly, 'github.event_name': 'workflow_dispatch' },
      ],
      [
        'a re-run of the nightly schedule',
        { ...nightly, 'github.run_attempt': '2' },
      ],
      [
        'a nightly attempt someone else started',
        { ...nightly, 'github.triggering_actor': 'someone' },
      ],
    ])('waits for a release manager on %s', (_case, context) => {
      expect(environmentFor(context)).toBe('sdk-release-tag');
    });

    it('mints one token, for this repository’s contents, and reads no team', () => {
      expect(job.match(/create-github-app-token@/g)).toHaveLength(1);
      expect(job).toContain('permission-contents: write');
      expect(job).not.toMatch(/permission-members|teams\/|memberships/);
    });
  },
);

describe.skipIf(!fs.existsSync(VERSION_WORKFLOW))(
  'the release a canary follows',
  () => {
    const workflow = fs.existsSync(VERSION_WORKFLOW)
      ? fs.readFileSync(VERSION_WORKFLOW, 'utf8')
      : '';
    // The previous job's `Read the releases` step, as bash runs it.
    const step = workflow.slice(workflow.indexOf('- name: Read the releases'));
    const lines = step.slice(step.indexOf('run: |\n') + 'run: |\n'.length);
    const script = lines
      .split('\n')
      .slice(
        0,
        lines.split('\n').findIndex(line => /^ {0,9}\S/.test(line)),
      )
      .map(line => line.slice(10))
      .join('\n');

    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

    /**
     * A repository whose main has `releases` (by default a stable release and
     * two canaries), each on its own commit and published a day apart in
     * that order, with GitHub's records of them served by a stand-in `gh`;
     * the step runs at `checkout` (a release, or `main` for its tip) for
     * `expect`.
     */
    const runStep = ({
      checkout,
      expect,
      releases = [
        'lace-sdk@0.1.0',
        'lace-sdk@0.2.0-canary.1',
        'lace-sdk@0.2.0-canary.2',
      ],
    }: {
      checkout: string;
      expect: string;
      releases?: readonly string[];
    }) => {
      const root = fs.mkdtempSync(
        path.join(os.tmpdir(), 'sdk-canary-follows-'),
      );
      try {
        const repository = path.join(root, 'repository');
        const scripts = path.join(repository, 'apps/lace-sdk/scripts');
        fs.mkdirSync(scripts, { recursive: true });
        fs.mkdirSync(path.join(repository, '.github/workflows'), {
          recursive: true,
        });
        fs.copyFileSync(
          path.resolve(import.meta.dirname, '../scripts/releases.mjs'),
          path.join(scripts, 'releases.mjs'),
        );
        fs.writeFileSync(
          path.join(repository, '.github/workflows/sdk-release-version.yml'),
          workflow,
        );
        git(repository, 'init', '-q', '-b', 'main');
        git(repository, 'config', 'user.email', 'test@example.invalid');
        git(repository, 'config', 'user.name', 'test');
        git(repository, 'config', 'commit.gpgsign', 'false');
        git(repository, 'config', 'tag.gpgsign', 'false');
        const shas: Record<string, string> = {};
        for (const tag of releases) {
          git(repository, 'add', '-A');
          git(repository, 'commit', '-q', '--allow-empty', '-m', tag);
          git(repository, 'tag', tag);
          shas[tag] = git(repository, 'rev-parse', 'HEAD');
        }
        git(repository, 'commit', '-q', '--allow-empty', '-m', 'a change');
        const bin = path.join(root, 'bin');
        fs.mkdirSync(bin);
        fs.writeFileSync(
          path.join(bin, 'gh'),
          `#!/usr/bin/env bash\ncat <<'EOF'\n${releases
            .map((tagName, day) =>
              JSON.stringify({
                tagName,
                isDraft: false,
                isPrerelease: tagName.includes('-canary.'),
                publishedAt: `2026-10-0${day + 1}T02:00:00Z`,
              }),
            )
            .join('\n')}\nEOF\n`,
          { mode: 0o755 },
        );
        git(repository, 'checkout', '-q', shas[checkout] ?? checkout);
        const output = path.join(root, 'output');
        fs.writeFileSync(output, '');
        try {
          execFileSync('bash', ['-c', script], {
            cwd: repository,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            env: {
              ...process.env,
              PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
              CHANNEL: 'canary',
              EXPECT: expect,
              REQUIRE_MAIN: 'false',
              CREATE_RELEASE: 'false',
              GH_TOKEN: '',
              GITHUB_REPOSITORY: 'example/lace-platform',
              GITHUB_OUTPUT: output,
              RUNNER_TEMP: root,
            },
          });
          return { passed: true, output: fs.readFileSync(output, 'utf8') };
        } catch (error) {
          const { stdout = '', stderr = '' } = error as {
            stdout?: string;
            stderr?: string;
          };
          return { passed: false, output: stdout + stderr };
        }
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    };

    it("passes a canary's own release event when it is the newest release", () => {
      const result = runStep({
        checkout: 'lace-sdk@0.2.0-canary.2',
        expect: 'lace-sdk@0.2.0-canary.2',
      });
      expect(result.output).toContain('previous_tag=lace-sdk@0.1.0');
      expect(result.passed).toBe(true);
    });

    it('refuses a re-run of an earlier canary once a newer release is tagged', () => {
      const result = runStep({
        checkout: 'lace-sdk@0.2.0-canary.1',
        expect: 'lace-sdk@0.2.0-canary.1',
      });
      expect(result.passed).toBe(false);
      expect(result.output).toContain(
        'does not contain lace-sdk@0.2.0-canary.2',
      );
      expect(result.output).toContain(
        'lace-sdk@0.2.0-canary.2 supersedes lace-sdk@0.2.0-canary.1',
      );
    });

    it('refuses a new canary from a commit before the newest release', () => {
      const result = runStep({
        checkout: 'lace-sdk@0.2.0-canary.1',
        expect: '',
      });

      expect(result.passed).toBe(false);
      expect(result.output).toContain(
        'does not contain lace-sdk@0.2.0-canary.2',
      );
    });

    const outputOf = (output: string, key: string) =>
      new RegExp(`^${key}=(.*)$`, 'm').exec(output)?.[1];

    it('counts a first canary from nothing, so it ships, with notes since the latest stable release', () => {
      const result = runStep({
        checkout: 'main',
        expect: '',
        releases: ['lace-sdk@0.1.0'],
      });
      expect(result.passed).toBe(true);
      expect(outputOf(result.output, 'scope_ref')).toBe('');
      expect(outputOf(result.output, 'first_canary')).toBe('true');
      expect(outputOf(result.output, 'notes_ref')).toBe('lace-sdk@0.1.0');
    });

    it('counts a canary from the latest canary, at its commit or after it', () => {
      for (const checkout of ['lace-sdk@0.2.0-canary.2', 'main']) {
        const result = runStep({ checkout, expect: '' });
        expect(result.passed).toBe(true);
        expect(outputOf(result.output, 'scope_ref')).toBe(
          'lace-sdk@0.2.0-canary.2',
        );
        expect(outputOf(result.output, 'notes_ref')).toBe(
          'lace-sdk@0.2.0-canary.2',
        );
        expect(outputOf(result.output, 'first_canary')).toBe('false');
      }
    });

    it('counts a canary from the latest canary when a stable release came since', () => {
      const result = runStep({
        checkout: 'main',
        expect: '',
        releases: [
          'lace-sdk@0.1.0',
          'lace-sdk@0.1.1-canary.0',
          'lace-sdk@0.1.1',
        ],
      });
      expect(result.passed).toBe(true);
      expect(outputOf(result.output, 'previous_tag')).toBe('lace-sdk@0.1.1');
      expect(outputOf(result.output, 'scope_ref')).toBe(
        'lace-sdk@0.1.1-canary.0',
      );
    });

    it("checks a canary's own release against the canary before it", () => {
      const result = runStep({
        checkout: 'lace-sdk@0.2.0-canary.2',
        expect: 'lace-sdk@0.2.0-canary.2',
      });
      expect(outputOf(result.output, 'scope_ref')).toBe(
        'lace-sdk@0.2.0-canary.1',
      );
    });
  },
);
