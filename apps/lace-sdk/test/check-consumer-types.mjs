// Installed-package fixtures expose missing dependencies that the monorepo masks.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import ts from 'typescript';

import { CANARY_ONLY_ENTRIES, channelEntryNames } from '../scripts/entries.mjs';
import { packageName } from '../scripts/export-surface.ts';

import { CHANNEL } from './channel.mjs';
import {
  findInstalledDependency,
  manifest,
  packageDirectory,
  withInstalledPackage,
} from './install-package.mjs';

// The canary build type-checks a fixture's .canary twin where one exists. A
// canary-only entry's fixture has none: only the canary build has the entry
// (scripts/entries.mjs). The cross-entry fixture uses several entries in one
// program.
const FIXTURES = [
  'cardano',
  'bitcoin',
  ...(CHANNEL === 'canary' ? CANARY_ONLY_ENTRIES.map(({ name }) => name) : []),
  'cross-entry',
].map(entry =>
  CHANNEL === 'canary' &&
  fs.existsSync(
    path.join(packageDirectory, 'test', `${entry}-consumer-types.canary.mts`),
  )
    ? `${entry}-consumer-types.canary.mts`
    : `${entry}-consumer-types.mts`,
);
const RESOLUTIONS = {
  node16: { module: 'Node16', moduleResolution: 'Node16' },
  bundler: { module: 'ESNext', moduleResolution: 'Bundler' },
};

// A missing external declaration can silently turn a public alias into any
// under skipLibCheck. Probe every explicit public type export from the source.
const source = ts.createSourceFile(
  'midnight.ts',
  fs.readFileSync(path.join(packageDirectory, 'src/midnight.ts'), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
);
const publicTypes = source.statements.flatMap(statement => {
  if (
    !ts.isExportDeclaration(statement) ||
    !statement.exportClause ||
    !ts.isNamedExports(statement.exportClause)
  )
    return [];
  return statement.exportClause.elements
    .filter(element => statement.isTypeOnly || element.isTypeOnly)
    .map(element => element.name.text);
});
const aliasProbe = [
  "import type * as Midnight from '@laceio/sdk/midnight';",
  'type IsAny<T> = 0 extends (1 & T) ? true : false;',
  'type Concrete<T extends false> = T;',
  ...publicTypes.map(
    name =>
      `type Probe_${name} = Concrete<IsAny<Midnight.${name}${
        name === 'Result' ? '<unknown, Error>' : ''
      }>>;`,
  ),
].join('\n');

// Compile every TypeScript sample of the Midnight guide, supplying only the
// application context the samples leave to the host. Imports remain at
// module scope. The guide documents the canary build and is not published.
const guide = fs.readFileSync(
  path.join(packageDirectory, 'docs/midnight.md'),
  'utf8',
);
const guideExamples = [];
for (const [, snippet] of guide.matchAll(
  /^```(?:typescript|ts)\n([\s\S]*?)^```/gm,
)) {
  const parsed = ts.createSourceFile(
    'example.mts',
    snippet,
    ts.ScriptTarget.Latest,
    true,
  );
  const imports = parsed.statements.filter(ts.isImportDeclaration);
  const body = parsed.statements.filter(
    statement => !ts.isImportDeclaration(statement),
  );
  guideExamples.push(
    [
      "import * as sdk from '@laceio/sdk/midnight';",
      ...imports.map(statement => statement.getFullText(parsed)),
      'declare const words: string[];',
      'declare const password: Uint8Array;',
      'declare const entity: sdk.InMemoryWallet;',
      'declare const accountId: sdk.MidnightAccountId;',
      "const exampleWallet = () => sdk.createLaceWallet({ modules: [sdk.m.featureDev, sdk.m.storageInMemory, sdk.createMidnightModule({ password })] as const, environment: 'development', config: { defaultMidnightTestnetNetworkId: sdk.MidnightSDKNetworkIds.Preview } });",
      'declare const wallet: Awaited<ReturnType<typeof exampleWallet>>;',
      'export const example = async () => {',
      ...body.map(statement => statement.getFullText(parsed)),
      '};',
    ].join('\n'),
  );
}
if (CHANNEL === 'canary')
  assert(guideExamples.length > 0, 'No Midnight guide examples found');

// The fixtures compile with `skipLibCheck`, as apps do, so an error inside
// the declarations reads as `any` there and reports nothing. Compiling the
// entries with library checks reports it, each entry alone and all of them
// together: a program sees only the augmentations of the entries it loads, so
// a shared declaration that needs another entry's augmentation fails only in
// a program without that entry. The one error allowed is a package the
// install lacks: one package.json leaves undeclared, or an optional peer only
// the published manifest declares, which install-package.mjs leaves out. A
// subpath of an installed package that does not resolve is an error. Bundler
// resolution only: under node16 the declarations hold errors that
// `skipLibCheck` hides from every consumer, such as the default import of
// bignumber.js.
const libraryProblems = installDirectory => {
  const root = fs.realpathSync(installDirectory);
  const installed = path.join(root, 'node_modules', manifest.name);
  const absent = specifier =>
    !fs.existsSync(
      path.join(root, 'node_modules', packageName(specifier), 'package.json'),
    );
  const unresolvedPackage = diagnostic => {
    if (diagnostic.code !== 2307) return false;
    const specifier = diagnostic.file.text
      .slice(diagnostic.start, diagnostic.start + diagnostic.length)
      .replace(/^["']|["']$/g, '');
    return !specifier.startsWith('.') && absent(specifier);
  };
  const entries = channelEntryNames(CHANNEL);
  const problems = new Set();
  for (const loaded of [entries, ...entries.map(entry => [entry])]) {
    const importer = path.join(root, `entries-${loaded.join('-')}.mts`);
    fs.writeFileSync(
      importer,
      [
        ...loaded.map(
          entry =>
            `import type * as Entry_${entry} from '${
              entry === 'index' ? manifest.name : `${manifest.name}/${entry}`
            }';`,
        ),
        'export {};',
      ].join('\n'),
    );
    const program = ts.createProgram([importer], {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      strict: true,
      noEmit: true,
      skipLibCheck: false,
      types: [],
    });
    const diagnosticsOf = source => [
      ...program.getSyntacticDiagnostics(source),
      ...program.getSemanticDiagnostics(source),
    ];
    for (const diagnostic of [
      ...diagnosticsOf(program.getSourceFile(importer)),
      ...program
        .getSourceFiles()
        .filter(source => source.fileName.startsWith(`${installed}${path.sep}`))
        .flatMap(diagnosticsOf)
        .filter(diagnostic => !unresolvedPackage(diagnostic)),
    ]) {
      const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(
        diagnostic.start,
      );
      problems.add(
        `${loaded.join(', ')}: ${path.relative(
          root,
          diagnostic.file.fileName,
        )}(${line + 1},${character + 1}): TS${
          diagnostic.code
        } ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`,
      );
    }
  }
  return [...problems];
};

const tsc = path.join(findInstalledDependency('typescript'), 'bin/tsc');
const distribution = path.join(packageDirectory, 'dist');
for (const file of fs
  .readdirSync(distribution)
  .filter(name => name.endsWith('.d.ts'))) {
  assert.doesNotMatch(
    fs.readFileSync(path.join(distribution, file), 'utf8'),
    /["']type-fest\/source\/tagged(?:\.js)?["']/,
    `${file} must use public type-fest branding types`,
  );
}
await withInstalledPackage('lace-sdk-consumer-types-', installDirectory => {
  const problems = libraryProblems(installDirectory);
  assert.equal(
    problems.length,
    0,
    `The declarations do not type-check with library checks:\n  ${problems.join(
      '\n  ',
    )}`,
  );
  const exampleFixtures = (CHANNEL === 'canary' ? guideExamples : []).map(
    (source, index) => {
      const name = `midnight-guide-${index}.mts`;
      fs.writeFileSync(path.join(installDirectory, name), source);
      return name;
    },
  );
  const aliasFixture = 'midnight-public-aliases.mts';
  if (CHANNEL === 'canary')
    fs.writeFileSync(path.join(installDirectory, aliasFixture), aliasProbe);
  for (const FIXTURE of FIXTURES) {
    fs.copyFileSync(
      path.join(packageDirectory, 'test', FIXTURE),
      path.join(installDirectory, FIXTURE),
    );
    for (const [resolution, moduleOptions] of Object.entries(RESOLUTIONS)) {
      const project = path.join(
        installDirectory,
        `tsconfig.${resolution}.json`,
      );
      fs.writeFileSync(
        project,
        JSON.stringify({
          compilerOptions: {
            target: 'ES2022',
            ...moduleOptions,
            strict: true,
            noEmit: true,
            // The SDK and @cardano-sdk declarations do not pass a full check.
            skipLibCheck: true,
            types: [],
          },
          files:
            FIXTURE === 'midnight-consumer-types.mts'
              ? [FIXTURE, aliasFixture, ...exampleFixtures]
              : [FIXTURE],
        }),
      );
      const run = spawnSync(process.execPath, [tsc, '-p', project], {
        encoding: 'utf8',
      });
      assert.equal(
        run.status,
        0,
        `${FIXTURE} does not type-check with ${resolution} module resolution:\n${run.stdout}${run.stderr}`,
      );
    }
  }
  if (CHANNEL === 'stable') {
    const source = fs.readFileSync(
      path.join(packageDirectory, 'test/declaration-consumer-types.mts'),
      'utf8',
    );
    // Each entry compiles alone: loading the root alongside Cardano would hide
    // missing public names in Cardano's declaration emit.
    for (const entry of ['index', 'cardano']) {
      const fixture = path.join(installDirectory, `declaration-${entry}.mts`);
      fs.writeFileSync(
        fixture,
        entry === 'index'
          ? source.replaceAll('@laceio/sdk/cardano', '@laceio/sdk')
          : source,
      );
      for (const [resolution, moduleOptions] of Object.entries(RESOLUTIONS)) {
        const project = path.join(installDirectory, 'tsconfig.emit.json');
        const output = path.join(
          installDirectory,
          `emit-${entry}-${resolution}`,
        );
        fs.writeFileSync(
          project,
          JSON.stringify({
            compilerOptions: {
              target: 'ES2022',
              ...moduleOptions,
              strict: true,
              declaration: true,
              emitDeclarationOnly: true,
              skipLibCheck: true,
              types: [],
              outDir: output,
            },
            files: [fixture],
          }),
        );
        const run = spawnSync(process.execPath, [tsc, '-p', project], {
          encoding: 'utf8',
        });
        assert.equal(
          run.status,
          0,
          `${entry} consumer cannot emit declarations with ${resolution}:\n${run.stdout}${run.stderr}`,
        );
        assert.doesNotMatch(
          fs.readFileSync(
            path.join(output, `declaration-${entry}.d.mts`),
            'utf8',
          ),
          /shared-[a-f0-9]+|@laceio\/sdk\/dist\//,
          `${entry} consumer declarations must not depend on private chunk paths`,
        );
      }
    }
  }
});
// eslint-disable-next-line no-console -- concise build proof
console.log(
  `${FIXTURES.join(
    ' and ',
  )} type-check against the installed package with ${Object.keys(
    RESOLUTIONS,
  ).join(
    ' and ',
  )} module resolution, and each entry's declarations, alone and with every other entry, with library checks`,
);
