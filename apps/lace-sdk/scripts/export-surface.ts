/**
 * What a built entry promises and what it delivers: the names its bundled
 * declarations export as values and as types, the names its runtime module
 * exports, and the declaration files its declarations reach. A name declared
 * as a value that the runtime lacks passes type-checking and fails when the
 * module links; a runtime name the declarations lack ships undocumented and
 * untyped; a declaration file or name that a relative import misses reads as
 * `any` wherever a consumer skips checking libraries.
 */
import path from 'node:path';

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
 * Compiles `declarationFile`, resolving the packages it imports from the
 * directory it sits in, the way a consumer's compiler does.
 */
const compileDeclarations = (declarationFile: string) => {
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
  return { checker, source, moduleSymbol };
};

/** Reads the exports of `declarationFile`. */
export const readDeclaredExports = (
  declarationFile: string,
): DeclaredExports => {
  const { checker, source, moduleSymbol } =
    compileDeclarations(declarationFile);

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

/** A type an export's declaration names that its entry does not export. */
export interface UnexportedTypeReference {
  /** The export, a namespace member as `<namespace>.<member>`. */
  owner: string;
  /** The type's name in the bundled declarations. */
  type: string;
}

const resolveAlias = (checker: ts.TypeChecker, symbol: ts.Symbol) =>
  symbol.flags & ts.SymbolFlags.Alias
    ? checker.getAliasedSymbol(symbol)
    : symbol;

const MEANINGS =
  ts.SymbolFlags.Value | ts.SymbolFlags.Type | ts.SymbolFlags.Namespace;

/** The meanings a declaration gives its name: value, type, namespace. */
const declarationMeaning = (declaration: ts.Declaration): ts.SymbolFlags => {
  if (
    ts.isInterfaceDeclaration(declaration) ||
    ts.isTypeAliasDeclaration(declaration)
  ) {
    return ts.SymbolFlags.Type;
  }
  if (ts.isClassDeclaration(declaration)) {
    return ts.SymbolFlags.Value | ts.SymbolFlags.Type;
  }
  if (
    ts.isEnumDeclaration(declaration) ||
    ts.isModuleDeclaration(declaration)
  ) {
    return MEANINGS;
  }
  return ts.SymbolFlags.Value;
};

/**
 * The name a reference node refers to, the leftmost identifier an app
 * writes, with the meaning the reference uses it in: a qualifier is a
 * namespace or, under `typeof`, a value.
 */
const referencedName = (
  node: ts.Node,
): { name: ts.Node; meaning: ts.SymbolFlags } | undefined => {
  const name = ts.isTypeReferenceNode(node)
    ? node.typeName
    : ts.isExpressionWithTypeArguments(node)
    ? node.expression
    : ts.isTypeQueryNode(node)
    ? node.exprName
    : undefined;
  if (!name) return undefined;
  const isValue =
    ts.isTypeQueryNode(node) ||
    (ts.isExpressionWithTypeArguments(node) &&
      ts.isHeritageClause(node.parent) &&
      node.parent.token === ts.SyntaxKind.ExtendsKeyword &&
      ts.isClassLike(node.parent.parent));
  let leftmost: ts.Node = name;
  while (
    ts.isQualifiedName(leftmost) ||
    ts.isPropertyAccessExpression(leftmost)
  ) {
    leftmost = ts.isQualifiedName(leftmost)
      ? leftmost.left
      : leftmost.expression;
  }
  const meaning = isValue
    ? ts.SymbolFlags.Value
    : leftmost === name
    ? ts.SymbolFlags.Type
    : ts.SymbolFlags.Namespace;
  return { name: leftmost, meaning };
};

/**
 * The symbol a bundled declaration renames, if it is only a rename, with the
 * meaning it renames: the bundler declares a namespace member as
 * `type m_X = X` or `declare const m_x: typeof x`.
 */
const renamedSymbol = (
  checker: ts.TypeChecker,
  declaration: ts.Declaration,
): { symbol: ts.Symbol; meaning: ts.SymbolFlags } | undefined => {
  const target =
    ts.isTypeAliasDeclaration(declaration) &&
    !declaration.typeParameters &&
    ts.isTypeReferenceNode(declaration.type) &&
    !declaration.type.typeArguments
      ? declaration.type
      : ts.isVariableDeclaration(declaration) &&
        declaration.type &&
        ts.isTypeQueryNode(declaration.type) &&
        !declaration.type.typeArguments
      ? declaration.type
      : undefined;
  const reference = target && referencedName(target);
  if (!reference || !ts.isIdentifier(reference.name)) return undefined;
  const symbol = checker.getSymbolAtLocation(reference.name);
  return (
    symbol && {
      symbol: resolveAlias(checker, symbol),
      meaning: reference.meaning,
    }
  );
};

/**
 * The types the declarations of `owners` name that the package's declaration
 * files declare and `declarationFile` does not export: an app cannot write
 * such a type, and the docs cannot link it. The package's declaration files
 * are those in the directory of `declarationFile`: the entry's own and any it
 * shares with other entries. A name counts as exported when the entry exports
 * it under any name, a namespace's members included, in the meaning the
 * reference uses: exporting a value does not export a type of the same name.
 * Only the owners' own declarations are read, not those of the types they
 * name.
 *
 * @param owners - Export names, a namespace member as `<namespace>.<member>`.
 */
export const readUnexportedTypeReferences = (
  declarationFile: string,
  owners: readonly string[],
): UnexportedTypeReference[] => {
  const { checker, source, moduleSymbol } =
    compileDeclarations(declarationFile);
  const directory = path.dirname(source.fileName);
  const inPackage = (declaration: ts.Declaration) =>
    path.dirname(declaration.getSourceFile().fileName) === directory;
  const isLocal = (symbol: ts.Symbol) =>
    symbol.declarations?.some(inPackage) ?? false;
  /** The package's declarations of `symbol` that give it one of `meaning`. */
  const declarationsOf = (symbol: ts.Symbol, meaning: ts.SymbolFlags) =>
    (symbol.declarations ?? []).filter(
      declaration =>
        inPackage(declaration) && declarationMeaning(declaration) & meaning,
    );

  /** The meanings of each symbol the entry exports, through renames. */
  const exported = new Map<ts.Symbol, ts.SymbolFlags>();
  const reach = (symbol: ts.Symbol, meaning: ts.SymbolFlags) => {
    const known = exported.get(symbol) ?? 0;
    const added = meaning & symbol.flags & MEANINGS & ~known;
    if (!added) return;
    exported.set(symbol, known | added);
    for (const declaration of declarationsOf(symbol, added)) {
      const renamed = renamedSymbol(checker, declaration);
      if (renamed && isLocal(renamed.symbol)) {
        reach(renamed.symbol, renamed.meaning);
      }
    }
  };
  const byName = new Map<string, ts.Symbol>();
  const namespaces = new Set<ts.Symbol>();
  const addExports = (moduleOrNamespace: ts.Symbol, prefix: string) => {
    for (const member of checker.getExportsOfModule(moduleOrNamespace)) {
      const target = resolveAlias(checker, member);
      byName.set(`${prefix}${member.name}`, target);
      reach(target, MEANINGS);
      if (
        !namespaces.has(target) &&
        target.flags &
          (ts.SymbolFlags.ValueModule | ts.SymbolFlags.NamespaceModule)
      ) {
        namespaces.add(target);
        addExports(target, `${prefix}${member.name}.`);
      }
    }
  };
  addExports(moduleSymbol, '');

  /** The declarations `symbol` has in `meaning`, its renames followed. */
  const ownDeclarations = (
    symbol: ts.Symbol,
    meaning: ts.SymbolFlags,
    seen = new Set<ts.Symbol>(),
  ): ts.Declaration[] => {
    seen.add(symbol);
    return declarationsOf(symbol, meaning).flatMap(declaration => {
      const renamed = renamedSymbol(checker, declaration);
      return renamed && isLocal(renamed.symbol) && !seen.has(renamed.symbol)
        ? ownDeclarations(renamed.symbol, renamed.meaning, seen)
        : [declaration];
    });
  };

  const references: UnexportedTypeReference[] = [];
  for (const owner of owners) {
    const symbol = byName.get(owner);
    if (!symbol) {
      throw new Error(`${declarationFile} does not export '${owner}'`);
    }
    const named = new Set<string>();
    const visit = (node: ts.Node) => {
      const reference = referencedName(node);
      const referenced =
        reference && checker.getSymbolAtLocation(reference.name);
      const target = referenced && resolveAlias(checker, referenced);
      if (
        reference &&
        target &&
        !(target.flags & ts.SymbolFlags.TypeParameter) &&
        isLocal(target) &&
        !((exported.get(target) ?? 0) & reference.meaning)
      ) {
        named.add(target.name);
      }
      ts.forEachChild(node, visit);
    };
    for (const declaration of ownDeclarations(symbol, MEANINGS)) {
      visit(declaration);
    }
    references.push(...[...named].sort().map(type => ({ owner, type })));
  }
  return references;
};

/** The declaration files an entry reaches, and what they import. */
export interface DeclarationClosure {
  /** The package's declaration files the entry reaches, itself included. */
  files: string[];
  /** The packages the files import, augment or reference, by name, sorted. */
  packages: string[];
  /**
   * Each relative specifier that reaches no file, a file outside the
   * package's declarations or a file that does not export a name it imports,
   * and each augmentation of a package file that names an interface the file
   * does not export.
   */
  problems: string[];
}

/** The package a bare specifier names: its scope and name, or its name. */
export const packageName = (specifier: string) =>
  specifier
    .split('/')
    .slice(0, specifier.startsWith('@') ? 2 : 1)
    .join('/');

/** Whether a declaration sits in a `declare module '…'` block. */
const inModuleBlock = (declaration: ts.Node) =>
  ts.findAncestor(
    declaration.parent,
    node => ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name),
  ) !== undefined;

/**
 * Compiles `entryFile` and the declaration files it reaches through relative
 * specifiers, with no package resolved. A specifier resolves as Node.js
 * resolves it, so in an ES module package a relative specifier names its
 * file's extension. `files` are those in the entry's directory, the package's
 * own.
 */
const compilePackageDeclarations = (entryFile: string) => {
  const options: ts.CompilerOptions = {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022,
    noEmit: true,
    noLib: true,
    skipLibCheck: true,
    types: [],
  };
  const host = ts.createCompilerHost(options);
  const resolutions = new Map<
    ts.StringLiteralLike,
    ts.ResolvedModuleFull | undefined
  >();
  // Only a relative specifier resolves: a declaration file of the same
  // package.
  const resolve = (literal: ts.StringLiteralLike, file: ts.SourceFile) => {
    if (!resolutions.has(literal)) {
      resolutions.set(
        literal,
        literal.text.startsWith('.')
          ? ts.resolveModuleName(
              literal.text,
              file.fileName,
              options,
              host,
              undefined,
              undefined,
              ts.getModeForUsageLocation(file, literal, options),
            ).resolvedModule
          : undefined,
      );
    }
    return resolutions.get(literal);
  };
  /* eslint-disable max-params -- the compiler host's signature */
  host.resolveModuleNameLiterals = (
    literals,
    _containingFile,
    _redirectedReference,
    _options,
    containingSourceFile,
  ) =>
    literals.map(literal => ({
      resolvedModule: resolve(literal, containingSourceFile),
    }));
  /* eslint-enable max-params */
  host.resolveTypeReferenceDirectiveReferences = references =>
    references.map(() => ({ resolvedTypeReferenceDirective: undefined }));
  const program = ts.createProgram([entryFile], options, host);
  const directory = path.dirname(path.resolve(entryFile));
  const files = program
    .getSourceFiles()
    .filter(
      file =>
        !program.isSourceFileDefaultLibrary(file) &&
        path.dirname(file.fileName) === directory,
    );
  return {
    program,
    checker: program.getTypeChecker(),
    resolve,
    directory,
    files,
  };
};

/**
 * Reads the declaration files `entryFile` reaches through relative
 * specifiers: the package's own files, with no package resolved. A consumer
 * compiles them with `skipLibCheck`, so a file a specifier misses, or a name
 * the file does not export, reads as `any` and reports nothing, and an
 * augmentation of an interface the file does not export merges into nothing.
 * A specifier that leaves the entry's directory names a file the published
 * package does not hold.
 */
export const readDeclarationClosure = (
  entryFile: string,
): DeclarationClosure => {
  const { program, checker, resolve, directory, files } =
    compilePackageDeclarations(entryFile);

  const exportsByFile = new Map<ts.SourceFile, Map<string, ts.Symbol>>();
  const exportsOf = (file: ts.SourceFile) => {
    let exports = exportsByFile.get(file);
    if (!exports) {
      const moduleSymbol = checker.getSymbolAtLocation(file);
      exports = new Map(
        (moduleSymbol ? checker.getExportsOfModule(moduleSymbol) : []).map(
          symbol => [symbol.name, symbol],
        ),
      );
      exportsByFile.set(file, exports);
    }
    return exports;
  };
  /**
   * Whether `file` itself exports `name`: an augmentation merges its own
   * declarations into the file's exports, so an export only augmentations
   * declare is not one.
   */
  const declaresExport = (file: ts.SourceFile, name: string) => {
    const exported = exportsOf(file).get(name);
    return (
      exported !== undefined &&
      (resolveAlias(checker, exported).declarations ?? []).some(
        declaration => !inModuleBlock(declaration),
      )
    );
  };

  const packages = new Set<string>();
  const problems = new Set<string>();
  for (const file of files) {
    const where = path.relative(directory, file.fileName);
    for (const { fileName } of file.typeReferenceDirectives) {
      packages.add(fileName === 'node' ? '@types/node' : packageName(fileName));
    }
    /** The package file `literal` reaches; a package is recorded instead. */
    const reach = (literal: ts.StringLiteralLike) => {
      if (!literal.text.startsWith('.')) {
        packages.add(packageName(literal.text));
        return undefined;
      }
      const resolved = resolve(literal, file);
      if (resolved && path.dirname(resolved.resolvedFileName) !== directory) {
        problems.add(
          `${where}: '${literal.text}' reaches ${path.relative(
            directory,
            resolved.resolvedFileName,
          )}, outside the package's declarations`,
        );
        return undefined;
      }
      const reached =
        resolved && program.getSourceFile(resolved.resolvedFileName);
      if (!reached) {
        problems.add(`${where}: '${literal.text}' reaches no declaration file`);
      }
      return reached;
    };
    const importNames = (literal: ts.StringLiteralLike, names: string[]) => {
      const reached = reach(literal);
      if (!reached) return;
      for (const name of names.filter(name => !exportsOf(reached).has(name))) {
        problems.add(`${where}: '${literal.text}' does not export '${name}'`);
      }
    };
    const augmentNames = (literal: ts.StringLiteralLike, names: string[]) => {
      const reached = reach(literal);
      if (!reached) return;
      for (const name of names.filter(name => !declaresExport(reached, name))) {
        problems.add(
          `${where}: the augmentation of '${literal.text}' names '${name}', which that file does not export`,
        );
      }
    };
    const visit = (node: ts.Node) => {
      if (
        ts.isImportDeclaration(node) &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        const clause = node.importClause;
        importNames(node.moduleSpecifier, [
          ...(clause?.name ? ['default'] : []),
          ...(clause?.namedBindings && ts.isNamedImports(clause.namedBindings)
            ? clause.namedBindings.elements.map(
                element => (element.propertyName ?? element.name).text,
              )
            : []),
        ]);
      } else if (
        ts.isExportDeclaration(node) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        importNames(
          node.moduleSpecifier,
          node.exportClause && ts.isNamedExports(node.exportClause)
            ? node.exportClause.elements.map(
                element => (element.propertyName ?? element.name).text,
              )
            : [],
        );
      } else if (
        ts.isImportTypeNode(node) &&
        ts.isLiteralTypeNode(node.argument) &&
        ts.isStringLiteral(node.argument.literal)
      ) {
        let qualifier: ts.EntityName | undefined = node.qualifier;
        while (qualifier && ts.isQualifiedName(qualifier)) {
          qualifier = qualifier.left;
        }
        importNames(node.argument.literal, qualifier ? [qualifier.text] : []);
      } else if (
        ts.isImportEqualsDeclaration(node) &&
        ts.isExternalModuleReference(node.moduleReference) &&
        ts.isStringLiteral(node.moduleReference.expression)
      ) {
        reach(node.moduleReference.expression);
      } else if (
        ts.isModuleDeclaration(node) &&
        ts.isStringLiteral(node.name)
      ) {
        augmentNames(
          node.name,
          node.body && ts.isModuleBlock(node.body)
            ? node.body.statements
                .filter(ts.isInterfaceDeclaration)
                .map(({ name }) => name.text)
            : [],
        );
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return {
    files: files.map(({ fileName }) => fileName),
    packages: [...packages].sort(),
    problems: [...problems],
  };
};

/** A name that a declaration file an entry reaches exports and the entry does not. */
export interface UnnameableExport {
  /** The name the file exports. */
  name: string;
  /** The file, relative to the entry's directory. */
  file: string;
}

/**
 * The names that the other declaration files `entryFile` reaches export and
 * the entry does not export under any name. A declaration file shared between
 * entries exports every name another file imports from it, so TypeScript
 * names such a type in the declarations a consumer library emits through an
 * entry that exports it, and reports TS2742 when no entry the library's
 * program loads does.
 */
export const readUnnameableExports = (
  entryFile: string,
): UnnameableExport[] => {
  const { program, checker, directory, files } =
    compilePackageDeclarations(entryFile);
  const exportsOf = (file: ts.SourceFile) => {
    const moduleSymbol = checker.getSymbolAtLocation(file);
    return moduleSymbol ? checker.getExportsOfModule(moduleSymbol) : [];
  };
  const entry = program.getSourceFile(path.resolve(entryFile));
  // An entry's export of the symbol under another name names it too, as the
  // root's `m` names the namespace a shared file exports under its own name.
  const exported = new Set(
    (entry ? exportsOf(entry) : []).map(symbol =>
      resolveAlias(checker, symbol),
    ),
  );
  return files
    .filter(file => file !== entry)
    .flatMap(file =>
      exportsOf(file)
        .filter(symbol => !exported.has(resolveAlias(checker, symbol)))
        .map(({ name }) => ({
          name,
          file: path.relative(directory, file.fileName),
        })),
    );
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
