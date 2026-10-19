/**
 * What a built entry promises and what it delivers: the names its bundled
 * declarations export as values and as types, and the names its runtime
 * module exports. A name declared as a value that the runtime lacks passes
 * type-checking and fails when the module links; a runtime name the
 * declarations lack ships undocumented and untyped.
 */
import ts from 'typescript';

/** The export names of a module, by whether a name is usable as a value. */
export interface ModuleExports {
  /** Names usable as values: an import of one type-checks in value position. */
  values: string[];
  /** Names usable as types only. */
  types: string[];
}

/** The exports of one bundled declaration file. */
export interface DeclaredExports extends ModuleExports {
  /**
   * Module specifiers of `export *` statements the compiler cannot resolve:
   * their names are unknown, so neither list can be complete.
   */
  unresolvedStars: string[];
}

/** Whether an alias, or any alias it re-exports through, is type-only. */
const isTypeOnlyAlias = (checker: ts.TypeChecker, symbol: ts.Symbol) => {
  for (
    let current: ts.Symbol | undefined = symbol;
    current && current.flags & ts.SymbolFlags.Alias;
    current = checker.getImmediateAliasedSymbol(current)
  ) {
    if (
      current.declarations?.some(declaration =>
        ts.isTypeOnlyImportOrExportDeclaration(declaration),
      )
    ) {
      return true;
    }
  }
  return false;
};

/** The exports of `moduleSymbol`, sorted, with type-only re-exports as types. */
export const exportsOfModule = (
  checker: ts.TypeChecker,
  moduleSymbol: ts.Symbol,
): ModuleExports => {
  const values: string[] = [];
  const types: string[] = [];
  for (const symbol of checker.getExportsOfModule(moduleSymbol)) {
    const target =
      symbol.flags & ts.SymbolFlags.Alias
        ? checker.getAliasedSymbol(symbol)
        : symbol;
    const isValue =
      Boolean(target.flags & ts.SymbolFlags.Value) &&
      !isTypeOnlyAlias(checker, symbol);
    (isValue ? values : types).push(symbol.name);
  }
  return { values: values.sort(), types: types.sort() };
};

/**
 * Reads the exports of `declarationFile`, resolving the packages it imports
 * from the directory it sits in, the way a consumer's compiler does.
 */
export const readDeclaredExports = (
  declarationFile: string,
): DeclaredExports => {
  const program = ts.createProgram([declarationFile], {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022,
    noEmit: true,
    skipLibCheck: true,
    types: [],
  });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(declarationFile);
  const moduleSymbol = source && checker.getSymbolAtLocation(source);
  if (!source || !moduleSymbol) {
    throw new Error(`${declarationFile} is not a module`);
  }

  const unresolvedStars = source.statements.flatMap(statement =>
    ts.isExportDeclaration(statement) &&
    !statement.exportClause &&
    statement.moduleSpecifier &&
    ts.isStringLiteral(statement.moduleSpecifier) &&
    !checker.getSymbolAtLocation(statement.moduleSpecifier)
      ? [statement.moduleSpecifier.text]
      : [],
  );

  return {
    ...exportsOfModule(checker, moduleSymbol),
    unresolvedStars: unresolvedStars.sort(),
  };
};

export interface ExportSurfaceProblemsProps {
  /** The entry, as the problems name it. */
  entry: string;
  declared: DeclaredExports;
  /** The runtime export names of each output format, such as ESM and CJS. */
  runtime: Record<string, readonly string[]>;
}

/**
 * Every mismatch between an entry's declarations and its runtime outputs: a
 * value the declarations promise that an output lacks, an output name the
 * declarations lack, and a star re-export the declarations cannot resolve.
 */
export const exportSurfaceProblems = ({
  entry,
  declared,
  runtime,
}: ExportSurfaceProblemsProps): string[] => {
  const declaredNames = new Set([...declared.values, ...declared.types]);
  return [
    ...declared.unresolvedStars.map(
      specifier =>
        `${entry}: the declarations re-export everything from '${specifier}', which does not resolve`,
    ),
    ...Object.entries(runtime).flatMap(([format, names]) => {
      const present = new Set(names);
      return [
        ...declared.values
          .filter(name => !present.has(name))
          .map(
            name =>
              `${entry}: '${name}' is declared as a value but the ${format} output does not export it`,
          ),
        ...names
          .filter(name => name !== 'default' && !declaredNames.has(name))
          .map(
            name =>
              `${entry}: the ${format} output exports '${name}', which the declarations do not`,
          ),
      ];
    }),
  ];
};

/**
 * The places `text` matches `pattern`: each match with its line number and the
 * line it is on, except on a line one of `allowedLines` matches whole.
 */
export const findMarkers = (
  text: string,
  pattern: RegExp,
  allowedLines: readonly RegExp[] = [],
): string[] =>
  text.split('\n').flatMap((line, index) => {
    if (allowedLines.some(allowed => allowed.test(line))) return [];
    const flags = pattern.flags.includes('g')
      ? pattern.flags
      : `${pattern.flags}g`;
    return [...line.matchAll(new RegExp(pattern.source, flags))].map(
      match => `${index + 1}: ${match[0]} in ${line.trim().slice(0, 160)}`,
    );
  });

/**
 * A pattern matching any of `names` as a whole identifier, or undefined for
 * no name.
 */
export const identifierPattern = (
  names: Iterable<string>,
): RegExp | undefined => {
  const alternatives = [...names]
    .sort()
    .map(name => name.replaceAll(/[$]/g, String.raw`\$`));
  return alternatives.length > 0
    ? new RegExp(String.raw`(?<![\w$])(?:${alternatives.join('|')})(?![\w$])`)
    : undefined;
};

/**
 * The identifiers of the exports only the canary build has: a top-level name,
 * or the member name of a namespace member such as `m.createPasskeyAuthoriser`
 * whose namespace the stable build also exports. An identifier the stable
 * build exports under any name, and the `allowed` ones, are left out: stable
 * output names them for its own exports.
 */
export const canaryOnlyIdentifiers = ({
  stable,
  canary,
  allowed = new Set(),
}: {
  stable: Iterable<string>;
  canary: Iterable<string>;
  allowed?: ReadonlySet<string>;
}): string[] => {
  const stableNames = new Set(stable);
  const stableIdentifiers = new Set(
    [...stableNames].flatMap(name => name.split('.')),
  );
  return [
    ...new Set(
      [...canary]
        .filter(name => !stableNames.has(name))
        .map(name => name.split('.').at(-1) ?? name)
        .filter(
          identifier =>
            !stableIdentifiers.has(identifier) && !allowed.has(identifier),
        ),
    ),
  ].sort();
};
