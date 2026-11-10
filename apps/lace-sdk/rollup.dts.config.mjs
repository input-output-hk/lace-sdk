import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import dts from 'rollup-plugin-dts';
import ts from 'typescript';

import {
  assertDeclarationLayout,
  DECLARATION_OUTPUT,
  declarationFiles,
  namespaceMembersFromOtherChunks,
  placeModuleAugmentations,
  redirectSdkBarrelReferences,
} from './scripts/declaration-chunks.mjs';
import { channelEntryNames, entrySource } from './scripts/entries.mjs';
import {
  cardanoSubpathOf,
  useLaceioCardano,
} from './scripts/laceio-cardano.mjs';
import { reachedWorkspaceFiles, compilerOptions } from './scripts/reach.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// The build channel (ADR 66): canary rolls up the entry twins that add
// canary.ts; stable resolves each workspace file's `.stable` variant first.
const CHANNEL = process.env.SDK_CHANNEL === 'canary' ? 'canary' : 'stable';
const MODULE_SUFFIXES = CHANNEL === 'stable' ? ['.stable', ''] : [''];
const repoRoot = path.resolve(__dirname, '../..');
const dtsWork = path.resolve(__dirname, 'dist/.dts-work');

// Map @lace-{kind}/name → packages/{kindDir}/name/src
const PACKAGE_KIND_MAP = {
  contract: 'contract',
  lib: 'lib',
  sdk: 'sdk',
  module: 'module',
};

/**
 * Resolve a @lace-* bare specifier to a file path inside .dts-work/.
 * Returns null if not a @lace-* import.
 */
const resolveInternalSpecifier = specifier => {
  // @lace-module/NAME/sdk → packages/module/NAME/src/sdk
  const subpathMatch = specifier.match(
    /^@lace-(contract|lib|sdk|module)\/([^/]+)\/(.+)$/,
  );
  if (subpathMatch) {
    const [, kind, name, subpath] = subpathMatch;
    return path.join(
      dtsWork,
      'packages',
      PACKAGE_KIND_MAP[kind],
      name,
      'src',
      subpath,
    );
  }
  // @lace-contract/NAME → packages/contract/NAME/src
  const bareMatch = specifier.match(
    /^@lace-(contract|lib|sdk|module)\/([^/]+)$/,
  );
  if (bareMatch) {
    const [, kind, name] = bareMatch;
    return path.join(dtsWork, 'packages', PACKAGE_KIND_MAP[kind], name, 'src');
  }
  return null;
};

/**
 * Resolve a path to a .d.ts file: try directory/index.d.ts, then .d.ts extension.
 */
const resolveDtsFile = filePath => {
  const withSuffix = base =>
    MODULE_SUFFIXES.map(suffix => `${base}${suffix}.d.ts`).find(file =>
      fs.existsSync(file),
    );
  try {
    if (fs.statSync(filePath).isDirectory()) {
      return withSuffix(filePath + '/index') ?? filePath + '/index.d.ts';
    }
  } catch {
    // not found as-is
  }
  if (!fs.existsSync(filePath)) {
    return withSuffix(filePath) ?? filePath;
  }
  return filePath;
};

/**
 * Compute a relative path from `fromFile` to `targetPath` within .dts-work,
 * stripping .d.ts / index.d.ts extensions (TypeScript resolves without them).
 */
const toRelative = (fromFile, targetPath) => {
  const resolved = resolveDtsFile(targetPath);
  let relative = path.relative(path.dirname(fromFile), resolved);
  if (!relative.startsWith('.')) relative = './' + relative;
  return relative.replace(/\/index\.d\.ts$/, '').replace(/\.d\.ts$/, '');
};

/**
 * Rewrite internal specifiers to relative paths in all generated .d.ts files.
 *
 * tsc emits three kinds of internal references that block rollup-plugin-dts
 * from inlining types:
 *
 * 1. @lace-* package specifiers  (from tsconfig paths)
 *    e.g. import("@lace-contract/module").State
 *    The packages @laceio/cardano publishes keep their specifier, which
 *    useLaceioCardano resolves to its subpath (scripts/laceio-cardano.mjs).
 *
 * 2. Repo-relative paths         (tsc expands complex inferred types)
 *    e.g. import("packages/contract/views/src").ViewsSliceState
 *    e.g. import("apps/lace-sdk/src").HexBytes
 *    A path into a package @laceio/cardano publishes becomes its specifier,
 *    the way pattern 3 rewrites a deep path, and stays external:
 *    import("packages/lib/cardano-core/src/Cardano").PartialBlockHeader
 *    → import("@lace-lib/cardano-core").Cardano.PartialBlockHeader
 *
 * 3. node_modules deep paths     (tsc resolves through real file paths)
 *    e.g. import("node_modules/@scope/pkg/dist/esm/Namespace").Type
 *    → rewritten to import("@scope/pkg").Namespace.Type
 *    Works for any scoped or unscoped package; the last non-"index" path
 *    segment becomes a namespace accessor (e.g. .Cardano, .Serialization).
 *
 * After rewriting, all internal references use relative paths and rollup-plugin-dts
 * treats them as local project files → they get inlined.
 */
const rewriteInternalImportsOnDisk = () => {
  const allDtsFiles = declarationFiles(dtsWork);

  // --- Pattern 1: @lace-* specifiers in `from '...'` and `import('...')` ---
  const laceFromPattern =
    /(from\s+['"])(@lace-(?:contract|lib|sdk|module)\/[^'"]+)(['"])/g;
  const laceDynamicPattern =
    /(import\(\s*['"])(@lace-(?:contract|lib|sdk|module)\/[^'"]+)(['"]\s*\))/g;

  // --- Pattern 2: repo-relative paths in `import("packages/...")` and `import("apps/...")` ---
  const repoRelativeDynamicPattern =
    /(import\(\s*["'])((?:packages|apps)\/[^"']+)(["']\s*\))/g;
  const cardanoRepoRelativePattern =
    /import\(\s*["']packages\/lib\/(cardano-[a-z-]+)\/src(\/[^"']+)?["']\s*\)/g;

  // --- Pattern 3: node_modules deep paths ---
  // tsc resolves through real file paths for packages that use namespace re-exports.
  // e.g. import("node_modules/@scope/pkg/dist/esm/Namespace").Type
  // → import("@scope/pkg").Namespace.Type
  // Handles both scoped (@scope/pkg) and unscoped (pkg) packages.
  // The last non-"index" path segment becomes a namespace accessor.
  const nodeModulesDeepPattern =
    /import\(\s*["']node_modules\/((?:@[^/]+\/)?[^/"']+)(\/[^"']+)?["']\s*\)/g;

  let totalRewrites = 0;
  for (const file of allDtsFiles) {
    let code = fs.readFileSync(file, 'utf8');
    let changed = false;

    // Shared rewriter: resolves a specifier to a relative path, returns null if unresolvable
    const rewriteMatch = (groups, resolve) => {
      const target = resolve(groups[2]);
      if (!target) return null;
      changed = true;
      return groups[1] + toRelative(file, target) + groups[3];
    };

    // Rewrite @lace-* specifiers to relative paths, except the Cardano packages
    // @laceio/cardano publishes, which stay external
    const rewriteLace = (...groups) =>
      cardanoSubpathOf(groups[2])
        ? groups[0]
        : rewriteMatch(groups, resolveInternalSpecifier) ?? groups[0];

    // Rewrite repo-relative paths (packages/..., apps/...) to relative paths in .dts-work
    const rewriteRepoRelative = (...groups) =>
      rewriteMatch(groups, specifier => {
        const target = path.join(dtsWork, specifier);
        if (
          !fs.existsSync(target) &&
          !fs.existsSync(target + '.d.ts') &&
          !fs.existsSync(path.join(target, 'index.d.ts'))
        ) {
          return null;
        }
        return target;
      }) ?? groups[0];

    // Rewrite node_modules deep paths → bare specifier with optional namespace accessor
    const rewriteNodeModulesDeep = (_match, packageName, deepPath) => {
      changed = true;
      if (!deepPath) return `import("${packageName}")`;
      const lastSegment = path.basename(deepPath);
      if (lastSegment === 'index') return `import("${packageName}")`;
      return `import("${packageName}").${lastSegment}`;
    };

    // Rewrite paths into the packages @laceio/cardano publishes the same way
    const rewriteCardanoRepoRelative = (match, name, deepPath) =>
      cardanoSubpathOf(`@lace-lib/${name}`)
        ? rewriteNodeModulesDeep(match, `@lace-lib/${name}`, deepPath)
        : match;

    code = code
      // Inferred brands expose type-fest's private Tag through an extensionless
      // path. Tagged<unknown, ...> is the public equivalent and resolves in Node16.
      .replace(
        /import\(\s*["'](?:node_modules\/)?type-fest\/source\/tagged(?:\.js)?["']\s*\)\.Tag</g,
        () => {
          changed = true;
          return 'import("type-fest").Tagged<unknown, ';
        },
      )
      .replace(laceFromPattern, rewriteLace)
      .replace(laceDynamicPattern, rewriteLace)
      .replace(cardanoRepoRelativePattern, rewriteCardanoRepoRelative)
      .replace(repoRelativeDynamicPattern, rewriteRepoRelative)
      .replace(nodeModulesDeepPattern, rewriteNodeModulesDeep);

    if (changed) {
      fs.writeFileSync(file, code);
      totalRewrites++;
    }
  }
  // eslint-disable-next-line no-console
  console.log(`[rewrite-imports] Rewrote specifiers in ${totalRewrites} files`);
};

/**
 * The contract packages whose augmentations the declarations keep: every
 * one on canary; on stable, those whose contract the runtime bundles
 * (tsdown.config.ts, record-bundled-contracts), so the stable types describe
 * the state, dependencies, config and addons of the contracts the SDK loads.
 * A contract the stable SDK names a type from but never loads, such as the
 * authentication prompt's or the onboarding flow's, adds nothing to them.
 */
const keepsAugmentationsOf = (() => {
  if (CHANNEL !== 'stable') return () => true;
  const recorded = path.join(dtsWork, 'bundled-contracts.json');
  if (!fs.existsSync(recorded)) {
    throw new Error(
      `${recorded} is missing: run tsdown before the declaration rollup`,
    );
  }
  const bundled = new Set(JSON.parse(fs.readFileSync(recorded, 'utf8')));
  return packageDirectory =>
    !packageDirectory.startsWith('packages/contract/') ||
    bundled.has(packageDirectory);
})();

const AUGMENTATIONS_FILE =
  /[/\\]\.dts-work[/\\](packages[/\\][^/\\]+[/\\][^/\\]+)[/\\]src[/\\]augmentations(?:\.stable)?\.d\.ts$/;

/** Drops the augmentations of the contracts the build does not load. */
const dropUnloadedAugmentations = {
  name: 'drop-unloaded-augmentations',
  load: id => {
    const match = AUGMENTATIONS_FILE.exec(id);
    return match && !keepsAugmentationsOf(match[1].replaceAll('\\', '/'))
      ? 'export {};'
      : null;
  },
};

const entries = channelEntryNames(CHANNEL);
const entryFileOf = entry =>
  path.join(
    dtsWork,
    `apps/lace-sdk/${entrySource(entry, CHANNEL).replace(/\.ts$/, '.d.ts')}`,
  );

/** Inferred state needs explicit imports of the augmentations this entry reaches. */
const injectAugmentationImports = entry => {
  const entryFile = entryFileOf(entry);
  const realRepoRoot = fs.realpathSync(repoRoot);
  const reached = reachedWorkspaceFiles(
    [path.join(__dirname, entrySource(entry, CHANNEL))],
    compilerOptions(CHANNEL),
  )
    .filter(file => /[/\\]augmentations(?:\.stable)?\.ts$/.test(file))
    .map(file =>
      path
        .join(dtsWork, path.relative(realRepoRoot, file))
        .replace(/\.ts$/, '.d.ts'),
    )
    .sort();
  const imports = [];

  for (const augFile of reached) {
    const packageDirectory = path
      .relative(dtsWork, augFile)
      .split(path.sep)
      .slice(0, 3)
      .join('/');
    if (!keepsAugmentationsOf(packageDirectory) || !fs.existsSync(augFile))
      continue;
    const content = fs.readFileSync(augFile, 'utf8');
    if (!content.includes('declare module')) continue;

    let relative = path.relative(path.dirname(entryFile), augFile);
    if (!relative.startsWith('.')) relative = './' + relative;
    relative = relative.replace(/\.d\.ts$/, '');
    imports.push(`import '${relative}';`);
  }

  const code = fs.readFileSync(entryFile, 'utf8');
  if (imports.length > 0 && !code.startsWith(imports[0])) {
    fs.writeFileSync(entryFile, imports.join('\n') + '\n' + code);
    // eslint-disable-next-line no-console
    console.log(
      `[inject-augmentations] Added ${imports.length} augmentation imports to ${entry}`,
    );
  }
};

// Rewrite the specifiers before rollup processes files, and point the types
// named through the SDK's own modules at their declarations. Then inject
// augmentation imports so rollup-plugin-dts includes them: after the redirect
// no file but an entry imports an entry.
rewriteInternalImportsOnDisk();
redirectSdkBarrelReferences({
  dtsWork,
  resolveDtsFile,
  toRelative,
  moduleSuffixes: MODULE_SUFFIXES,
});
for (const entry of entries) injectAugmentationImports(entry);

// The declarations carry the types they take from these packages, so the SDK
// does not depend on them.
const INLINED_TYPE_PACKAGES = ['@midnight-ntwrk/dapp-connector-api'];

const isInlinedTypePackage = source =>
  INLINED_TYPE_PACKAGES.some(
    name => source === name || source.startsWith(`${name}/`),
  );

// Every other npm package (rxjs, @reduxjs/toolkit, @laceio/cardano, etc.) is
// external; the @lace-lib/cardano-* packages the domain layer publishes import
// its subpaths (scripts/laceio-cardano.mjs).
// All .dts-work/ files have been rewritten to relative paths, so no internal
// specifiers remain but those Cardano packages.
const external = source => {
  // Relative and absolute paths are always internal
  if (source.startsWith('.') || source.startsWith('/')) return false;
  // dts() resolves the inlined packages only when they are not external here,
  // and useLaceioCardano redirects the Cardano packages, which rollup asks
  // only for a source this does not already mark external.
  return !isInlinedTypePackage(source) && !cardanoSubpathOf(source);
};

/**
 * Handle JSON imports (tsc doesn't copy .json to outDir) by resolving
 * them from the original repo root.
 */
const resolveJsonImports = {
  name: 'resolve-json-imports',
  resolveId: (source, importer) => {
    if (source.endsWith('.json') && importer?.includes('.dts-work/')) {
      const relativeFromDtsWork = path.relative(
        dtsWork,
        path.dirname(importer),
      );
      return path.resolve(repoRoot, relativeFromDtsWork, source);
    }
    return null;
  },
};

/**
 * The names an entry exports as types only, by the compiler's own rule: a
 * probe uses every value-like export of the entry as a value, and the names it
 * refuses are the ones an `export type` brought in, directly or through
 * `export type *`.
 */
const typeOnlyExports = entryFile => {
  const options = {
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ES2022,
    noEmit: true,
    skipLibCheck: true,
    types: [],
    moduleSuffixes: MODULE_SUFFIXES,
  };
  const entryProgram = ts.createProgram([entryFile], options);
  const checker = entryProgram.getTypeChecker();
  const names = checker
    .getExportsOfModule(
      checker.getSymbolAtLocation(entryProgram.getSourceFile(entryFile)),
    )
    .filter(symbol => {
      const target =
        symbol.flags & ts.SymbolFlags.Alias
          ? checker.getAliasedSymbol(symbol)
          : symbol;
      return target.flags & ts.SymbolFlags.Value;
    })
    .map(symbol => symbol.name);
  const probeFile = path.join(path.dirname(entryFile), '__type-only-probe.ts');
  fs.writeFileSync(
    probeFile,
    [
      `import { ${names
        .map((name, index) => `${name} as probe${index}`)
        .join(', ')} } from './${path.basename(entryFile, '.d.ts')}';`,
      ...names.map((_name, index) => `void probe${index};`),
    ].join('\n'),
  );
  try {
    const probeProgram = ts.createProgram([probeFile], options);
    const probeSource = probeProgram.getSourceFile(probeFile);
    const exportedAsType = new Set([1361, 1362]);
    return new Set(
      probeProgram
        .getSemanticDiagnostics(probeSource)
        .filter(({ code }) => exportedAsType.has(code))
        .map(
          ({ start }) =>
            names[probeSource.getLineAndCharacterOfPosition(start).line - 1],
        ),
    );
  } finally {
    fs.rmSync(probeFile);
  }
};

/**
 * Keeps the type-only exports of each entry type-only in the bundle.
 * rollup-plugin-dts lists a re-exported declaration that also declares a
 * value, such as a class or a value object, among the value exports even when
 * the entry exported it with `export type`. The declarations would then
 * promise a value the runtime build does not export, which type-checks and
 * fails when the module links. Shared chunks need none: the package exports
 * the entries alone.
 */
const keepTypeOnlyExports = typeOnlyByEntry => ({
  name: 'keep-type-only-exports',
  renderChunk: (code, chunk) => {
    if (!chunk.isEntry) return null;
    const typeOnly = typeOnlyByEntry[chunk.name];
    return {
      code: code.replace(
        /^export \{ ([^}]*) \}( from '[^']+')?;$/gm,
        (statement, specifiers, from = '') => {
          const all = specifiers.split(', ');
          const types = all.filter(specifier =>
            typeOnly.has(specifier.split(' as ').at(-1)),
          );
          if (types.length === 0) return statement;
          const values = all.filter(specifier => !types.includes(specifier));
          return [
            ...(values.length > 0
              ? [`export { ${values.join(', ')} }${from};`]
              : []),
            `export type { ${types.join(', ')} }${from};`,
          ].join('\n');
        },
      ),
      map: null,
    };
  },
});

/**
 * One rollup of all the entries of the channel, so that each declaration is in
 * one file (see scripts/declaration-chunks.mjs).
 */
export default {
  input: Object.fromEntries(
    entries.map(entry => [entry, path.relative(__dirname, entryFileOf(entry))]),
  ),
  output: { dir: 'dist', ...DECLARATION_OUTPUT },
  // Declarations have no execution order, so a re-export through a barrel in
  // another chunk is harmless.
  onwarn: (warning, warn) => {
    if (warning.code !== 'CYCLIC_CROSS_CHUNK_REEXPORT') warn(warning);
  },
  plugins: [
    useLaceioCardano,
    dropUnloadedAugmentations,
    resolveJsonImports,
    dts({
      tsconfig: './tsconfig.dts-bundle.json',
      compilerOptions: { moduleSuffixes: MODULE_SUFFIXES },
      includeExternal: INLINED_TYPE_PACKAGES,
    }),
    namespaceMembersFromOtherChunks,
    keepTypeOnlyExports(
      // The probes share a file, so the entries are probed one after another.
      Object.fromEntries(
        entries.map(entry => [entry, typeOnlyExports(entryFileOf(entry))]),
      ),
    ),
    placeModuleAugmentations({ resolveInternalSpecifier }),
    {
      name: 'stable-cardano-public-type-paths',
      generateBundle: (_options, bundle) => {
        if (CHANNEL !== 'stable') return;
        // Loading the root declarations lets TypeScript name shared types via
        // @laceio/sdk when a library imports only /cardano and emits declarations.
        const cardano = bundle['cardano.d.ts'];
        cardano.code = `import type {} from './index.js';\n${cardano.code}`;
        cardano.imports.push('index.d.ts');
      },
    },
    assertDeclarationLayout({
      entries,
      // Canary must not load the root's Bitcoin types or its optional peers.
      allowedEntryImports: CHANNEL === 'stable' ? { cardano: ['index'] } : {},
    }),
  ],
  external,
};
