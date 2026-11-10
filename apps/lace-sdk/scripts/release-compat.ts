/**
 * The compatibility rules a stable release of the SDK must meet (ADR 66,
 * "Versioning before and after 1.0"): what changed between two releases'
 * declarations, and which version bump and deprecations that requires.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import ts from 'typescript';

import { channelEntryNames } from './entries.mjs';
import { compareVersions, parseVersion, type Version } from './releases.mjs';

/** One export of one package entry, as its published declarations state it. */
export interface DeclaredExport {
  /** `<entry>:<name>`, e.g. `cardano:createLaceWallet`. */
  key: string;
  /**
   * The declaration text without comments, normalised so only a change in
   * meaning differs: the export's own declarations, then those of the
   * unexported types it references, one per line.
   */
  signature: string;
  /** The export's own declarations, as `signature` prints them, sorted. */
  own: string[];
  /**
   * Each unexported type the export references, directly or through another:
   * its declarations as `signature` prints them, sorted.
   */
  locals: string[][];
  /** Resolved references, shared across the exports of this entry. */
  graph: DeclarationGraph;
  deprecated: boolean;
}

export type ExportMap = Map<string, DeclaredExport>;

interface DeclarationNode {
  declarations: string[];
  references: number[];
  exports: string[];
  typeOwner?: boolean;
  nominal?: boolean;
}

interface DeclarationGraph {
  root: number;
  nodes: DeclarationNode[];
}

/**
 * Declaration bundlers rename a colliding internal name `Name$1`, and the
 * suffix can shift between builds without any change to the API, so it is
 * dropped along with whitespace differences.
 */
const normalise = (text: string): string =>
  text
    .replaceAll(/([A-Za-z_]\w*)\$\d+\b/g, '$1')
    .replaceAll(/\s+/g, ' ')
    .trim();

// Comments are documentation, not meaning: a reworded doc comment on a stable
// type must not count as a breaking change. Deprecation is read from the JSDoc
// tags separately.
const printer = ts.createPrinter({ removeComments: true });

const memberName = (
  member: ts.TypeElement,
  sourceFile: ts.SourceFile,
): string => {
  if (!member.name) return '';
  return ts.isComputedPropertyName(member.name)
    ? normalise(
        printer.printNode(ts.EmitHint.Unspecified, member.name, sourceFile),
      )
    : member.name.text;
};

const byKey = <T>([a]: readonly [string, T], [b]: readonly [string, T]) =>
  a < b ? -1 : a > b ? 1 : 0;

// tsc writes an inferred object type's members, and a union's, in the order it
// created their types, which follows the program's files, so an unchanged type
// can read reordered. Type-literal members sort by name (stable: overloads keep
// their order) and union members by text; any other order is the source's or
// carries meaning, so it stays. A symbol's declarations are sorted by text
// where an export's signature joins them, so the order of top-level overloads,
// and of a local's overloads an export reaches through `typeof`, is not
// compared; only the order of type-literal and interface overloads is.
const canonicalOrder =
  (sourceFile: ts.SourceFile): ts.TransformerFactory<ts.Node> =>
  context => {
    const visit = (node: ts.Node): ts.Node => {
      const visited = ts.visitEachChild(node, visit, context);
      if (ts.isTypeLiteralNode(visited)) {
        const members = visited.members
          .map(member => [memberName(member, sourceFile), member] as const)
          .sort(byKey)
          .map(([, member]) => member);
        return context.factory.updateTypeLiteralNode(
          visited,
          context.factory.createNodeArray(members),
        );
      }
      if (ts.isUnionTypeNode(visited)) {
        const types = visited.types
          .map(
            type =>
              [
                normalise(
                  printer.printNode(ts.EmitHint.Unspecified, type, sourceFile),
                ),
                type,
              ] as const,
          )
          .sort(byKey)
          .map(([, type]) => type);
        return context.factory.updateUnionTypeNode(
          visited,
          context.factory.createNodeArray(types),
        );
      }
      return visited;
    };
    return visit;
  };

const declarationText = (
  declaration: ts.Declaration,
  referenceName?: (node: ts.Identifier) => string | undefined,
): string => {
  const sourceFile = declaration.getSourceFile();
  const result = ts.transform<ts.Node>(declaration, [
    canonicalOrder(sourceFile),
    context => {
      const visit = (node: ts.Node): ts.Node => {
        if (ts.isExportSpecifier(node) && referenceName) {
          const target = node.propertyName ?? node.name;
          const name = ts.isIdentifier(target) && referenceName(target);
          // A shorthand export names both a binding and a public member.
          return context.factory.updateExportSpecifier(
            node,
            node.isTypeOnly,
            name ? context.factory.createIdentifier(name) : node.propertyName,
            node.name,
          );
        }
        const name = ts.isIdentifier(node) && referenceName?.(node);
        return name
          ? context.factory.createIdentifier(name)
          : ts.visitEachChild(node, visit, context);
      };
      return visit;
    },
  ]);
  try {
    return normalise(
      printer.printNode(
        ts.EmitHint.Unspecified,
        result.transformed[0],
        sourceFile,
      ),
    );
  } finally {
    result.dispose();
  }
};

const isTopLevel = (declaration: ts.Declaration): boolean => {
  // A variable sits in a declaration list inside its statement.
  const statement = ts.isVariableDeclaration(declaration)
    ? declaration.parent.parent
    : declaration;
  return (
    ts.isSourceFile(statement.parent) || ts.isModuleBlock(statement.parent)
  );
};

/** Records actual symbol references before printed names lose their collision suffixes. */
const declarationGraphs = ({
  checker,
  packageFiles,
  exports,
}: {
  checker: ts.TypeChecker;
  packageFiles: ReadonlySet<ts.SourceFile>;
  exports: ReadonlyMap<ts.Symbol, string[]>;
}) => {
  const indices = new Map<ts.Symbol, number>();
  const nodes: DeclarationNode[] = [];
  const add = (
    symbol: ts.Symbol,
    declarations: readonly ts.Declaration[],
  ): number => {
    const existing = indices.get(symbol);
    if (existing !== undefined) return existing;
    const index = nodes.length;
    const node: DeclarationNode = {
      declarations: [],
      references: [],
      exports: exports.get(symbol) ?? [],
      typeOwner: declarations.some(
        declaration =>
          ts.isInterfaceDeclaration(declaration) ||
          ts.isTypeAliasDeclaration(declaration) ||
          ts.isClassDeclaration(declaration),
      ),
      nominal: declarations.some(
        declaration =>
          (ts.isVariableDeclaration(declaration) &&
            declaration.type &&
            ts.isTypeOperatorNode(declaration.type) &&
            declaration.type.operator === ts.SyntaxKind.UniqueKeyword) ||
          (ts.isClassDeclaration(declaration) &&
            declaration.members.some(
              member =>
                (member.name && ts.isPrivateIdentifier(member.name)) ||
                (ts.getCombinedModifierFlags(member) &
                  (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) !==
                  0,
            )),
      ),
    };
    indices.set(symbol, index);
    nodes.push(node);
    const referenceName = (identifier: ts.Identifier): string | undefined => {
      const original = ts.getOriginalNode(identifier);
      const atNode = checker.getSymbolAtLocation(original);
      const parent = original.parent;
      if (
        atNode &&
        (ts.isDeclarationStatement(parent) ||
          ts.isVariableDeclaration(parent)) &&
        parent.name === original
      ) {
        const statement = ts.isVariableDeclaration(parent)
          ? parent.parent.parent
          : parent;
        if (ts.isModuleBlock(statement.parent)) {
          const namespace = checker.getSymbolAtLocation(
            statement.parent.parent.name,
          );
          if (
            namespace &&
            checker.getExportsOfModule(namespace).includes(atNode)
          )
            return undefined;
        }
      }
      const target =
        atNode && atNode.flags & ts.SymbolFlags.Alias
          ? checker.getAliasedSymbol(atNode)
          : atNode;
      const local = target?.declarations?.filter(
        declaration =>
          packageFiles.has(declaration.getSourceFile()) &&
          isTopLevel(declaration),
      );
      if (!target || !local?.length) return undefined;
      const slot = node.references.length;
      node.references.push(add(target, local));
      return `__reference_${slot}`;
    };
    node.declarations = declarations
      .map(declaration => [declarationText(declaration), declaration] as const)
      .sort(byKey)
      .map(([, declaration]) => declarationText(declaration, referenceName));
    return index;
  };
  return (
    symbol: ts.Symbol,
    declarations: readonly ts.Declaration[],
  ): DeclarationGraph => ({
    root: add(symbol, declarations),
    nodes,
  });
};

/** Nominal declarations retain their relationships to public types and values, even when their printed names collide. */
const nominalOwners = (
  nodes: DeclarationNode[],
  commonExports: ReadonlySet<string>,
) => {
  const owners = new Map<number, { types: Set<string>; values: Set<string> }>();
  for (const [root, node] of nodes.entries()) {
    const names = node.exports.filter(name => commonExports.has(name));
    if (names.length === 0) continue;
    const seen = new Set<number>();
    const visit = (index: number) => {
      if (seen.has(index)) return;
      seen.add(index);
      const target = nodes[index];
      if (
        index !== root &&
        target.exports.some(name => commonExports.has(name))
      )
        return;
      if (target.nominal) {
        const entry = owners.get(index) ?? {
          types: new Set<string>(),
          values: new Set<string>(),
        };
        for (const name of names)
          (node.typeOwner ? entry.types : entry.values).add(name);
        owners.set(index, entry);
      }
      for (const reference of target.references) visit(reference);
    };
    visit(root);
  }
  return new Map(
    [...owners].map(([index, { types, values }]) => [
      index,
      [...(types.size ? types : values)].sort(),
    ]),
  );
};

/** Existing public types are compared separately; newly exported locals still expand on both sides. */
const referenceSignatures = (
  nodes: DeclarationNode[],
  commonExports: ReadonlySet<string>,
): ((root: number) => string) => {
  const owners = nominalOwners(nodes, commonExports);
  return root => {
    const indices = new Map<number, number>([[root, 0]]);
    const pending = [root];
    const hash = createHash('sha256');
    for (let index = 0; index < pending.length; index++) {
      const node = nodes[pending[index]];
      const references = node.references.map(target => {
        const names = nodes[target].exports
          .filter(name => commonExports.has(name))
          .sort();
        if (target !== root && names.length > 0) return ['export', names];
        let local = indices.get(target);
        if (local === undefined) {
          local = pending.length;
          indices.set(target, local);
          pending.push(target);
        }
        // Nominal identity supplements structure: a private class can also change its public members.
        return ['local', local, owners.get(target)];
      });
      hash.update(JSON.stringify([node.declarations, references]));
    }
    return hash.digest('hex');
  };
};

/**
 * The unexported types in `packageFiles` that `roots` reference, directly or
 * through each other, each as its declarations. Exported types are left out:
 * each is compared as an export of its own.
 */
const referencedLocals = ({
  roots,
  checker,
  packageFiles,
  exported,
}: {
  roots: readonly ts.Declaration[];
  checker: ts.TypeChecker;
  packageFiles: ReadonlySet<ts.SourceFile>;
  exported: ReadonlySet<ts.Symbol>;
}): ts.Declaration[][] => {
  const seen = new Set<ts.Symbol>();
  const found: ts.Declaration[][] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      const atNode = checker.getSymbolAtLocation(node);
      // A namespace's `export { _default as name }` names its member through
      // an alias; the member's declaration is what the export means.
      const symbol =
        atNode && atNode.flags & ts.SymbolFlags.Alias
          ? checker.getAliasedSymbol(atNode)
          : atNode;
      const local = symbol?.declarations?.filter(
        declaration =>
          packageFiles.has(declaration.getSourceFile()) &&
          isTopLevel(declaration) &&
          !roots.includes(declaration),
      );
      if (
        symbol &&
        local?.length &&
        !seen.has(symbol) &&
        !exported.has(symbol)
      ) {
        seen.add(symbol);
        found.push(local);
        for (const declaration of local) ts.forEachChild(declaration, visit);
      }
    }
    ts.forEachChild(node, visit);
  };
  for (const root of roots) ts.forEachChild(root, visit);
  return found;
};

/**
 * The `<module>:<name>` a declaration imports or re-exports from a third-party
 * module: `default` for a default import, `*` for a namespace.
 */
const thirdPartyImport = (declaration: ts.Declaration): string | undefined => {
  const [specifier, name] = ts.isImportSpecifier(declaration)
    ? [
        declaration.parent.parent.parent.moduleSpecifier,
        (declaration.propertyName ?? declaration.name).text,
      ]
    : ts.isExportSpecifier(declaration)
    ? [
        declaration.parent.parent.moduleSpecifier,
        (declaration.propertyName ?? declaration.name).text,
      ]
    : ts.isImportClause(declaration)
    ? [declaration.parent.moduleSpecifier, 'default']
    : ts.isNamespaceImport(declaration)
    ? [declaration.parent.parent.moduleSpecifier, '*']
    : ts.isNamespaceExport(declaration)
    ? [declaration.parent.moduleSpecifier, '*']
    : [];
  return specifier &&
    ts.isStringLiteral(specifier) &&
    !specifier.text.startsWith('.')
    ? `${specifier.text}:${name}`
    : undefined;
};

/**
 * The third-party type an unresolved export names, as `<module>:<name>` (e.g.
 * `ts-log:Logger`): an entry re-exports it directly, or through a shared file
 * under a name that file gives it, and both read as the same type.
 */
const thirdPartyOrigin = (
  exported: ts.Symbol,
  checker: ts.TypeChecker,
): string | undefined => {
  for (
    let alias: ts.Symbol | undefined = exported;
    alias && alias.flags & ts.SymbolFlags.Alias;
    alias = checker.getImmediateAliasedSymbol(alias)
  ) {
    const declaration = alias.declarations?.[0];
    const origin = declaration && thirdPartyImport(declaration);
    if (origin) return origin;
  }
  return undefined;
};

// A relative import names a file of the same package, which counts only as
// declarations: TypeScript resolves it to the file's code when they are
// missing, and the exports behind it would read as bare names.
const DECLARATION_EXTENSIONS: readonly string[] = [
  ts.Extension.Dts,
  ts.Extension.Dmts,
  ts.Extension.Dcts,
];

/**
 * Reads every export of each entry's declaration file. Each entry is read in a
 * program of its own, holding the package's declaration files it reaches
 * through relative imports, as a consumer importing that entry alone sees
 * them: a declaration in a file several entries share is part of each one's
 * API, and another entry's augmentation of it is not. An export's signature
 * covers the unexported types it references, so a change behind it counts; a
 * type another entry exports still counts in this entry's. Third-party
 * imports are not resolved, so a release's own declarations are compared, not
 * the types they reference, and a third-party export reads as its module and
 * name. A relative import that reaches no declaration file throws.
 */
export const readExports = (entries: Record<string, string>): ExportMap => {
  const options: ts.CompilerOptions = {
    noEmit: true,
    skipLibCheck: true,
    types: [],
  };
  const host = ts.createCompilerHost(options);
  // The entries' programs parse a file they share once.
  const parsed = new Map<string, ts.SourceFile | undefined>();
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, ...rest) => {
    if (!parsed.has(fileName)) {
      parsed.set(fileName, getSourceFile(fileName, ...rest));
    }
    return parsed.get(fileName);
  };
  const missing = new Set<string>();
  host.resolveModuleNameLiterals = (literals, containingFile) =>
    literals.map(literal => {
      if (!literal.text.startsWith('.')) return { resolvedModule: undefined };
      const { resolvedModule } = ts.resolveModuleName(
        literal.text,
        containingFile,
        options,
        host,
      );
      if (
        resolvedModule &&
        DECLARATION_EXTENSIONS.includes(resolvedModule.extension)
      ) {
        return { resolvedModule };
      }
      missing.add(`${containingFile} imports ${literal.text}`);
      return { resolvedModule: undefined };
    });
  const exports: ExportMap = new Map();
  for (const [entry, file] of Object.entries(entries)) {
    const program = ts.createProgram([file], options, host);
    if (missing.size > 0) {
      throw new Error(
        `Declaration files are missing: ${[...missing].join(', ')}`,
      );
    }
    const checker = program.getTypeChecker();
    const source = program.getSourceFile(file);
    const module = source && checker.getSymbolAtLocation(source);
    if (!source || !module) throw new Error(`No module symbol for ${file}`);
    const symbols = checker.getExportsOfModule(module).map(exported => ({
      exported,
      target:
        exported.flags & ts.SymbolFlags.Alias
          ? checker.getAliasedSymbol(exported)
          : exported,
    }));
    const packageFiles = new Set(
      program
        .getSourceFiles()
        .filter(
          packageFile => !program.isSourceFileDefaultLibrary(packageFile),
        ),
    );
    const exportedSymbols = new Set(symbols.map(({ target }) => target));
    const names = new Map<ts.Symbol, string[]>();
    for (const { exported, target } of symbols) {
      names.set(target, [...(names.get(target) ?? []), exported.name]);
    }
    const graphOf = declarationGraphs({
      checker,
      packageFiles,
      exports: names,
    });
    for (const { exported, target } of symbols) {
      const origin = target.declarations?.length
        ? undefined
        : thirdPartyOrigin(exported, checker);
      const declarations =
        origin !== undefined
          ? []
          : target.declarations?.length
          ? target.declarations
          : exported.declarations ?? [];
      const own =
        origin === undefined
          ? declarations.map(declaration => declarationText(declaration)).sort()
          : [origin];
      const locals = referencedLocals({
        roots: declarations,
        checker,
        packageFiles,
        exported: exportedSymbols,
      }).map(type =>
        type.map(declaration => declarationText(declaration)).sort(),
      );
      const key = `${entry}:${exported.name}`;
      exports.set(key, {
        key,
        signature: [...own, ...locals.flat().sort()].join('\n'),
        own,
        locals,
        graph:
          origin === undefined
            ? graphOf(target, declarations)
            : {
                root: 0,
                nodes: [
                  { declarations: [origin], references: [], exports: [] },
                ],
              },
        deprecated: [exported, target].some(symbol =>
          symbol.getJsDocTags(checker).some(tag => tag.name === 'deprecated'),
        ),
      });
    }
  }
  return exports;
};

export interface ExportChanges {
  added: string[];
  removed: string[];
  changed: string[];
}

/**
 * The entry a key names: `index`, or `@laceio/cardano/core` where
 * next-version prefixes a family member's keys with its package.
 */
const entryOf = (key: string): string => key.slice(0, key.lastIndexOf(':'));

/**
 * The exports `next` adds, removes and changes against `previous`, comparing
 * resolved references rather than collision-prone printed names. A reference
 * to an existing public type keeps that export's identity; local types and
 * newly added exports are compared through their declarations on both sides.
 */
export const compareExports = (
  previous: ExportMap,
  next: ExportMap,
): ExportChanges => {
  const commonByEntry = new Map<string, Set<string>>();
  for (const key of next.keys()) {
    if (previous.has(key)) {
      const entry = entryOf(key);
      const names = commonByEntry.get(entry) ?? new Set<string>();
      names.add(key.slice(key.lastIndexOf(':') + 1));
      commonByEntry.set(entry, names);
    }
  }
  const signatures = new Map<DeclarationNode[], (root: number) => string>();
  const signatureOf = (exported: DeclaredExport) => {
    let signature = signatures.get(exported.graph.nodes);
    if (!signature) {
      signature = referenceSignatures(
        exported.graph.nodes,
        commonByEntry.get(entryOf(exported.key)) ?? new Set(),
      );
      signatures.set(exported.graph.nodes, signature);
    }
    return signature(exported.graph.root);
  };
  return {
    added: [...next.keys()].filter(key => !previous.has(key)).sort(),
    removed: [...previous.keys()].filter(key => !next.has(key)).sort(),
    changed: [...next.keys()]
      .filter(key => {
        const previousExport = previous.get(key);
        const nextExport = next.get(key);
        return (
          previousExport !== undefined &&
          nextExport !== undefined &&
          signatureOf(previousExport) !== signatureOf(nextExport)
        );
      })
      .sort(),
  };
};

// The SDK's versions and their order are its releases' (releases.mjs),
// so the rules here and the tags never disagree about which version is newer.
export { compareVersions, parseVersion } from './releases.mjs';
export type { Version } from './releases.mjs';

/**
 * Whether going from `previous` to `next` permits an incompatible change:
 * before 1.0 a minor release, from 1.0 a major release.
 */
export const allowsBreakingChange = (previous: Version, next: Version) =>
  previous.major === 0
    ? next.major > 0 || next.minor > previous.minor
    : next.major > previous.major;

/**
 * Whether a release at `next` may break an export only when the release
 * before it marked the export `@deprecated`: from 1.0. Before 1.0 the
 * breaking bump, a minor release, is the notice a consumer gets, since a
 * caret range does not cross it.
 */
export const requiresDeprecation = (next: Version) => next.major > 0;

/** A change the release declares compatible, recorded in release-overrides.json. */
export interface ReleaseOverride {
  version: string;
  export: string;
  reason: string;
}

/** The SDK's release overrides (`release-overrides.json` in `packageDirectory`). */
export const readOverrides = (packageDirectory: string): ReleaseOverride[] => {
  const file = path.join(packageDirectory, 'release-overrides.json');
  return fs.existsSync(file)
    ? (JSON.parse(fs.readFileSync(file, 'utf8')) as ReleaseOverride[])
    : [];
};

// Every entry either build has: a stable build holds only the stable ones,
// and declarationsIn skips an entry a build does not hold.
const ENTRIES = channelEntryNames('canary');

/**
 * The declaration file of each SDK entry a build directory (a package, or
 * the directory holding a build's `dist/`) holds. A release from before an
 * entry was added has no file for it, and so no exports there to compare.
 */
export const declarationsIn = (directory: string): Record<string, string> =>
  Object.fromEntries(
    ENTRIES.map((entry): [string, string] => [
      entry,
      path.join(directory, 'dist', `${entry}.d.ts`),
    ]).filter(([, file]) => fs.existsSync(file)),
  );

/** Every file under `directory`, relative to it, sorted. */
const filesIn = (directory: string): string[] =>
  fs
    .readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry =>
      path.relative(directory, path.join(entry.parentPath, entry.name)),
    )
    .sort();

/** The files two unpacked packages do not hold byte for byte alike. */
const differingFiles = (a: string, b: string): string[] =>
  [...new Set([...filesIn(a), ...filesIn(b)])].sort().filter(file => {
    const left = path.join(a, file);
    const right = path.join(b, file);
    return (
      !fs.existsSync(left) ||
      !fs.existsSync(right) ||
      !fs.readFileSync(left).equals(fs.readFileSync(right))
    );
  });

/**
 * The problem with this build of a version a registry already has, or none:
 * a published version is final, so a re-run may only complete a partial
 * publish with the files already published. Each registry skips a version it
 * has, so a different build under that version would leave npm and GitHub
 * Packages serving different contents. `published` and `built` are the
 * unpacked `package/` directories of the published tarball and of this
 * build's.
 */
export const republishProblems = ({
  name,
  version,
  published,
  built,
}: {
  name: string;
  version: string;
  published: string;
  built: string;
}): string[] => {
  const differing = differingFiles(published, built);
  if (differing.length === 0) return [];
  return [
    `${name}@${version} is already published and this build differs from it (${differing
      .slice(0, 5)
      .join(', ')}${
      differing.length > 5 ? ', …' : ''
    }): a published version is final, so cut a new release`,
  ];
};

/**
 * The problems that stop a stable release, or none. `overrides` marks a
 * changed signature compatible for this release (a reworded type, not a
 * change in meaning); a removal cannot be overridden. A breaking change needs
 * the bump that permits it and, from 1.0, the export marked `@deprecated` in
 * the release before.
 */
export const stableReleaseProblems = ({
  previousVersion,
  nextVersion,
  previous,
  next,
  overrides,
}: {
  previousVersion: string;
  nextVersion: string;
  previous: ExportMap;
  next: ExportMap;
  overrides: ReleaseOverride[];
}): string[] => {
  const from = parseVersion(previousVersion);
  const to = parseVersion(nextVersion);
  if (compareVersions(to, from) <= 0) {
    return [`${nextVersion} is not above the latest stable ${previousVersion}`];
  }
  const declaredCompatible = new Set(
    overrides
      .filter(override => override.version === nextVersion)
      .map(override => override.export),
  );
  const { removed, changed } = compareExports(previous, next);
  const breaking = [
    ...removed,
    ...changed.filter(key => !declaredCompatible.has(key)),
  ];
  const problems: string[] = [];
  if (breaking.length > 0 && !allowsBreakingChange(from, to)) {
    problems.push(
      `${nextVersion} changes or removes ${breaking.join(
        ', ',
      )} after ${previousVersion}; ${
        from.major === 0 ? 'a minor' : 'a major'
      } release is required, or a release-overrides.json entry for a change that is compatible`,
    );
  }
  for (const key of requiresDeprecation(to) ? breaking : []) {
    if (!previous.get(key)?.deprecated) {
      problems.push(
        `${key} changes or is removed without being @deprecated in ${previousVersion}`,
      );
    }
  }
  return problems;
};

/** The highest released version, ignoring prereleases, or undefined if none. */
export const latestStableOf = (
  versions: readonly string[],
): string | undefined =>
  versions
    .map(parseVersion)
    .filter(version => version.prerelease === undefined)
    .sort(compareVersions)
    .map(({ major, minor, patch }) => `${major}.${minor}.${patch}`)
    .at(-1);

/**
 * The highest canary published since the latest stable release: the highest
 * canary whose stable version is above it, or undefined if none. Canaries
 * below the latest stable are history, so a canary is compared with these
 * alone, and a stable release with stable releases alone.
 */
export const latestCanarySinceOf = (
  versions: readonly string[],
): string | undefined => {
  const stable = latestStableOf(versions);
  return versions
    .map(parseVersion)
    .filter(
      version =>
        version.prerelease?.startsWith('canary.') &&
        (stable === undefined ||
          compareVersions(
            {
              major: version.major,
              minor: version.minor,
              patch: version.patch,
            },
            parseVersion(stable),
          ) > 0),
    )
    .sort(compareVersions)
    .map(
      ({ major, minor, patch, prerelease }) =>
        `${major}.${minor}.${patch}-${prerelease}`,
    )
    .at(-1);
};

/**
 * A canary previews the next stable release, so it sorts above the latest.
 * npm makes a package's first version its `latest`, whatever dist-tag it
 * publishes with, so the first release must be stable. A canary below a
 * canary published since the latest stable would move the `canary` dist-tag,
 * and the public repository's main, back to older code, as a late re-run of
 * a failed canary would; the same version again is a re-run completing its
 * own publish. A canary is held to canaries alone: a stable release below a
 * canary's version is the stable release that canary previewed past.
 */
export const canaryReleaseProblems = ({
  latestStable,
  latestCanary,
  canaryVersion,
}: {
  latestStable: string | undefined;
  latestCanary?: string;
  canaryVersion: string;
}): string[] => {
  if (latestStable === undefined) {
    return [
      `${canaryVersion} would be the package's first version, which npm makes its latest: release a stable version first`,
    ];
  }
  const canary = parseVersion(canaryVersion);
  const base = {
    major: canary.major,
    minor: canary.minor,
    patch: canary.patch,
  };
  if (compareVersions(base, parseVersion(latestStable)) <= 0) {
    return [
      `${canaryVersion} previews ${base.major}.${base.minor}.${base.patch}, which is not above the latest stable ${latestStable}`,
    ];
  }
  return latestCanary !== undefined &&
    compareVersions(canary, parseVersion(latestCanary)) < 0
    ? [
        `${canaryVersion} is below ${latestCanary}, which is already published: releasing it would move the canary dist-tag back, so cut a newer canary`,
      ]
    : [];
};
