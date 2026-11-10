// The output options and passes that let one declaration rollup serve all the
// entries of a build channel (ADR 66), so that each type has one declaration:
// rollup puts each module in the chunk of the set of entries that reaches it,
// and each entry re-exports what it shares from those chunks.
// rollup.dts.config.mjs runs the passes around rollup-plugin-dts.
import fs from 'node:fs';
import path from 'node:path';

import ts from 'typescript';

import { SHARED_DECLARATIONS } from './entries.mjs';

/**
 * How the declaration rollup names and writes its files: `<entry>.d.ts` for
 * each entry and `shared-<hash>.d.ts` (SHARED_DECLARATIONS) for each set of
 * entries that shares declarations.
 */
export const DECLARATION_OUTPUT = {
  format: 'es',
  entryFileNames: '[name].d.ts',
  chunkFileNames: 'shared-[hash:8].d.ts',
  // Hexadecimal names cannot spell a word the stable build must not mention
  // (test/check-export-surface.mjs).
  hashCharacters: 'hex',
  // An augmentation merges only with an interface its chunk exports under
  // the interface's own name.
  minifyInternalExports: false,
  // A hoisted import would load a chunk's packages, Midnight's among them,
  // in every entry that imports the chunk.
  hoistTransitiveImports: false,
};

/** The declaration files under `directory`, at any depth. */
export const declarationFiles = directory =>
  fs
    .readdirSync(directory, { recursive: true })
    .filter(file => file.endsWith('.d.ts'))
    .map(file => path.join(directory, file));

/** A type that a declaration names through a relative specifier: `import("./x").Name`. */
const TYPE_QUERY =
  /import\(\s*(["'])(\.{1,2}\/[^"']*)\1\s*\)\.([A-Za-z_$][\w$]*)/g;

const inModuleBlock = node =>
  ts.findAncestor(
    node.parent,
    parent => ts.isModuleDeclaration(parent) && ts.isStringLiteral(parent.name),
  ) !== undefined;

/**
 * Where each name a module exports is declared: the declaring file and the name
 * that file exports it under, or the module itself, without a name, for an
 * `export * as` namespace. The program resolves relative specifiers alone, as
 * the build's own files are all the answer may name.
 */
const declarationsOf = (modules, moduleSuffixes) => {
  const options = {
    noEmit: true,
    noLib: true,
    types: [],
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    moduleSuffixes,
  };
  const host = ts.createCompilerHost(options);
  host.resolveModuleNameLiterals = (literals, containingFile) =>
    literals.map(({ text }) => ({
      resolvedModule: text.startsWith('.')
        ? ts.resolveModuleName(text, containingFile, options, host)
            .resolvedModule
        : undefined,
    }));
  const program = ts.createProgram(modules, options, host);
  const checker = program.getTypeChecker();
  const targetOf = symbol =>
    symbol.flags & ts.SymbolFlags.Alias
      ? checker.getAliasedSymbol(symbol)
      : symbol;
  const exportsByFile = new Map();
  /** A file's exports by name, and the first name it exports each symbol under. */
  const exportsOf = file => {
    if (!exportsByFile.has(file)) {
      const source = program.getSourceFile(file);
      const moduleSymbol = source && checker.getSymbolAtLocation(source);
      const symbols = moduleSymbol
        ? checker.getExportsOfModule(moduleSymbol)
        : [];
      const names = new Map();
      for (const symbol of symbols) {
        const target = targetOf(symbol);
        if (!names.has(target)) names.set(target, symbol.name);
      }
      exportsByFile.set(file, {
        byName: new Map(symbols.map(symbol => [symbol.name, symbol])),
        names,
      });
    }
    return exportsByFile.get(file);
  };
  return (module, name) => {
    const exported = exportsOf(module).byName.get(name);
    if (!exported) return undefined;
    const target = targetOf(exported);
    const declaration = target.declarations?.find(node => !inModuleBlock(node));
    if (!declaration) return undefined;
    if (ts.isSourceFile(declaration)) return { file: declaration.fileName };
    const file = declaration.getSourceFile().fileName;
    const exportedName = exportsOf(file).names.get(target);
    return exportedName === undefined
      ? undefined
      : { file, name: exportedName };
  };
};

/**
 * Points each type that the declaration build names through a module of the
 * SDK's own `src` at the module that declares it. One compiler program over all
 * of a channel's entries names an inferred type through whichever module it saw
 * export it, often an SDK entry or barrel: a contract that names
 * `import("…/apps/lace-sdk/src/midnight").BlockchainNetworkId` would link every
 * entry that reaches the contract to the Midnight entry, its peers and its
 * `declare global`. Throws on a type no module declares, and on any file
 * outside the SDK's `src` that still imports one of its modules afterwards.
 *
 * @param {{
 *   dtsWork: string;
 *   resolveDtsFile: (file: string) => string;
 *   toRelative: (fromFile: string, target: string) => string;
 *   moduleSuffixes: string[];
 * }} build The declaration build's working directory, how it resolves a
 *   relative specifier's path to a file and writes a specifier for a file, and
 *   the module suffixes of its channel.
 */
export const redirectSdkBarrelReferences = ({
  dtsWork,
  resolveDtsFile,
  toRelative,
  moduleSuffixes,
}) => {
  const sdkSource = path.join(dtsWork, 'apps', 'lace-sdk', 'src') + path.sep;
  const sdkModule = (file, specifier) => {
    const target = resolveDtsFile(path.resolve(path.dirname(file), specifier));
    return target.startsWith(sdkSource) ? target : undefined;
  };
  const files = declarationFiles(dtsWork);
  const referring = new Map();
  const modules = new Set();
  for (const file of files) {
    const code = fs.readFileSync(file, 'utf8');
    for (const [, , specifier] of code.matchAll(TYPE_QUERY)) {
      const module = sdkModule(file, specifier);
      if (!module) continue;
      modules.add(module);
      referring.set(file, code);
    }
  }

  const declarationOf = declarationsOf([...modules], moduleSuffixes);
  const unresolved = [];
  let redirected = 0;
  for (const [file, code] of referring) {
    const next = code.replace(
      TYPE_QUERY,
      (...[reference, quote, specifier, name]) => {
        const module = sdkModule(file, specifier);
        if (!module) return reference;
        const declaring = declarationOf(module, name);
        if (!declaring) {
          unresolved.push(`${path.relative(dtsWork, file)}: ${reference}`);
          return reference;
        }
        if (
          path.resolve(declaring.file) === module &&
          declaring.name === name
        ) {
          return reference;
        }
        redirected++;
        const query = `import(${quote}${toRelative(
          file,
          declaring.file,
        )}${quote})`;
        return declaring.name === undefined
          ? query
          : `${query}.${declaring.name}`;
      },
    );
    if (next !== code) fs.writeFileSync(file, next);
  }
  if (unresolved.length > 0) {
    throw new Error(
      `No module declares these types, which declarations name through an SDK module:\n  ${unresolved.join(
        '\n  ',
      )}`,
    );
  }

  const remaining = files
    .filter(file => !file.startsWith(sdkSource))
    .flatMap(file =>
      ts
        .preProcessFile(fs.readFileSync(file, 'utf8'), true, true)
        .importedFiles.filter(
          ({ fileName }) =>
            fileName.startsWith('.') && sdkModule(file, fileName),
        )
        .map(
          ({ fileName }) =>
            `${path.relative(dtsWork, file)} imports ${fileName}`,
        ),
    );
  if (remaining.length > 0) {
    throw new Error(
      `Declarations outside the SDK's src still import its modules:\n  ${remaining.join(
        '\n  ',
      )}`,
    );
  }
  // eslint-disable-next-line no-console -- concise build proof
  console.log(
    `[redirect-sdk-barrels] Redirected ${redirected} references in ${referring.size} files`,
  );
};

/**
 * Exports each member of an `export * as` namespace that the chunk imports from
 * another chunk as that imported binding. rollup-plugin-dts knows the kinds of
 * its own chunk's declarations alone, so it declares such a member as
 * `declare const <namespace>_<name>: typeof <name>`, a value: a type,
 * interface or class member loses its type meaning (TS2693), which a consumer's
 * `skipLibCheck` reads as `any`. Only that shape is a member: `<namespace>` is
 * a `declare namespace` of the chunk and `<name>` an imported binding; any
 * other `declare const` is a declaration of its own. Runs after
 * rollup-plugin-dts, which writes each namespace's export list on one line.
 */
export const namespaceMembersFromOtherChunks = {
  name: 'namespace-members-from-other-chunks',
  renderChunk: code => {
    const imported = new Set(
      [...code.matchAll(/^import (?:type )?\{ ([^}]*) \} from '[^']+';$/gm)]
        .flatMap(([, specifiers]) => specifiers.split(','))
        .map(specifier =>
          specifier
            .trim()
            .replace(/^type /, '')
            .split(' as ')
            .at(-1),
        ),
    );
    const namespaces = [
      ...code.matchAll(/^declare namespace ([\w$]+) \{/gm),
    ].map(([, namespace]) => namespace);
    const aliases = new Map();
    const withoutValues = code.replace(
      /^declare const ([\w$]+): typeof ([\w$]+);\n/gm,
      (line, alias, local) => {
        if (
          !imported.has(local) ||
          !namespaces.some(namespace => alias === `${namespace}_${local}`)
        ) {
          return line;
        }
        aliases.set(alias, local);
        return '';
      },
    );
    if (aliases.size === 0) return null;
    // eslint-disable-next-line no-console -- concise build proof
    console.log(
      `[namespace-members] ${
        aliases.size
      } members re-export their imported binding: ${[...aliases.values()].join(
        ', ',
      )}`,
    );
    return {
      code: withoutValues.replace(
        /(?<![\w$])[\w$]+(?![\w$])/g,
        identifier => aliases.get(identifier) ?? identifier,
      ),
      map: null,
    };
  },
};

const LACE_AUGMENTATION =
  /^declare module\s+['"](@lace-(?:contract|lib|sdk|module)\/[^'"]+)['"]\s*\{/;

/**
 * Removes the `declare module '@lace-*'` blocks from a chunk's lines, and
 * returns the lines kept and each block's specifier and de-indented lines,
 * a block nested in another as a block of its own: rollup-plugin-dts can emit
 * one module's augmentation inside another's. Counts braces outside comments
 * and string literals: the declarations keep their doc comments, whose prose
 * and code spans may hold unbalanced braces, and a string such as a URL holds
 * `//` that must not end the line's count.
 *
 * @param {string[]} lines
 * @returns {{ kept: string[]; blocks: { specifier: string; lines: string[] }[] }}
 */
export const extractLaceAugmentations = lines => {
  let inComment = false;
  const braceDelta = line => {
    let delta = 0;
    for (let index = 0; index < line.length; index++) {
      const pair = line.slice(index, index + 2);
      if (inComment) {
        if (pair === '*/') {
          inComment = false;
          index++;
        }
      } else if (pair === '/*') {
        inComment = true;
        index++;
      } else if (pair === '//') {
        break;
      } else if (`'"\``.includes(line[index])) {
        const quote = line[index];
        index++;
        while (index < line.length && line[index] !== quote) {
          if (line[index] === '\\') index++;
          index++;
        }
      } else if (line[index] === '{') {
        delta++;
      } else if (line[index] === '}') {
        delta--;
      }
    }
    return delta;
  };

  const kept = [];
  const blocks = [];
  let index = 0;
  while (index < lines.length) {
    const match = LACE_AUGMENTATION.exec(lines[index]);
    if (!match) {
      kept.push(lines[index]);
      index++;
      continue;
    }
    // The extraction reads tsc's emit, which opens a block on a line of its
    // own or writes an empty one as `{ }`, and refuses any other shape rather
    // than drop the declarations on the opening line.
    if (!/^\s*(?:\}\s*)?$/.test(lines[index].slice(match[0].length))) {
      throw new Error(
        `An augmentation of ${match[1]} has declarations on its opening line: ${lines[index]}`,
      );
    }
    let depth = braceDelta(lines[index]);
    index++;
    const inner = [];
    while (index < lines.length && depth > 0) {
      depth += braceDelta(lines[index]);
      if (depth > 0) inner.push(lines[index].replace(/^ {4}/, ''));
      index++;
    }
    const nested = extractLaceAugmentations(inner);
    blocks.push({ specifier: match[1], lines: nested.kept }, ...nested.blocks);
  }
  return { kept, blocks };
};

/** Each interface an augmentation block declares, with its doc comment. */
const augmentedInterfaces = ({ specifier, lines }) => {
  const text = lines.join('\n');
  const source = ts.createSourceFile(
    'augmentation.d.ts',
    text,
    ts.ScriptTarget.Latest,
    true,
  );
  return source.statements.map(statement => {
    if (!ts.isInterfaceDeclaration(statement)) {
      throw new Error(
        `An augmentation of ${specifier} holds a ${
          ts.SyntaxKind[statement.kind]
        }: only interfaces merge with the declarations they augment`,
      );
    }
    return {
      specifier,
      name: statement.name.text,
      text: text
        .slice(statement.getFullStart(), statement.end)
        .replace(/^\n+/, ''),
    };
  });
};

const TOP_LEVEL_INTERFACE = /^(?:export )?(?:declare )?interface ([\w$]+)/gm;

const topLevelInterfaces = code =>
  new Set([...code.matchAll(TOP_LEVEL_INTERFACE)].map(([, name]) => name));

const escapeRegExp = text => text.replace(/[$\\^.*+?()[\]{}|]/g, '\\$&');

/** Whether `code` declares a top-level interface of exactly `name`, not a `$N` rename of it. */
const declaresInterface = (code, name) =>
  new RegExp(
    `^(?:export )?(?:declare )?interface ${escapeRegExp(name)}(?![\\w$])`,
    'm',
  ).test(code);

/**
 * Places each `declare module '@lace-*'` augmentation where a consumer's
 * compiler applies it: no consumer has the workspace package it names. The
 * chunk that declares the augmented interface takes the augmentation as a
 * top-level declaration, which merges within the file. Any other chunk keeps
 * it as an augmentation of that chunk by relative specifier, so a program
 * applies it when it loads any entry that reaches the file holding it, and the
 * declaring chunk exports the interface for it. An entry's declarations are
 * never the target: an augmentation through an entry's re-export applies only
 * to a program that loads that entry.
 *
 * @param {{ resolveInternalSpecifier: (specifier: string) => string | null }} build
 *   Where the declaration build writes a workspace package's declarations.
 */
export const placeModuleAugmentations = ({ resolveInternalSpecifier }) => {
  const interfacesByFile = new Map();
  const interfacesOf = file => {
    if (!interfacesByFile.has(file)) {
      interfacesByFile.set(
        file,
        topLevelInterfaces(fs.readFileSync(file, 'utf8')),
      );
    }
    return interfacesByFile.get(file);
  };
  /** The file of the specifier's package that declares the interface outside any module block. */
  const declaringFile = (specifier, name) => {
    const packageSource = resolveInternalSpecifier(
      specifier.split('/').slice(0, 2).join('/'),
    );
    const candidates = declarationFiles(packageSource).filter(file =>
      interfacesOf(file).has(name),
    );
    if (candidates.length !== 1) {
      throw new Error(
        `${specifier} augments ${name}, which ${
          candidates.length
        } files of its package declare: ${candidates.join(', ')}`,
      );
    }
    return candidates[0];
  };

  return {
    name: 'place-module-augmentations',
    generateBundle: (_options, bundle) => {
      const chunks = Object.values(bundle).filter(
        ({ type }) => type === 'chunk',
      );
      const extracted = new Map(
        chunks.map(chunk => [
          chunk,
          extractLaceAugmentations(chunk.code.split('\n')),
        ]),
      );
      const chunkOfModule = new Map(
        chunks.flatMap(chunk => chunk.moduleIds.map(id => [id, chunk])),
      );
      const exportsToAdd = new Map();
      const placed = [];
      for (const chunk of chunks) {
        const { kept, blocks } = extracted.get(chunk);
        if (blocks.length === 0) continue;
        const flattened = [];
        const retargeted = new Map();
        for (const { specifier, name, text } of blocks.flatMap(
          augmentedInterfaces,
        )) {
          const file = declaringFile(specifier, name);
          const target = chunkOfModule.get(file);
          if (!target) {
            throw new Error(
              `${chunk.fileName} augments ${name}, but no chunk holds its declaring file ${file}`,
            );
          }
          // Rollup renames a declaration only on a collision, so another
          // module's interface of the same name may hold the name in the
          // chunk: the declaring module's own code must declare it.
          if (!declaresInterface(target.modules?.[file]?.code ?? '', name)) {
            throw new Error(
              `${chunk.fileName} augments ${name}, which ${target.fileName} declares under another name`,
            );
          }
          if (target === chunk) {
            flattened.push(text);
            continue;
          }
          if (target.isEntry) {
            throw new Error(
              `${chunk.fileName} augments ${name}, which the entry ${target.fileName} alone declares`,
            );
          }
          retargeted.set(target, [...(retargeted.get(target) ?? []), text]);
          if (!target.exports.includes(name)) {
            exportsToAdd.set(
              target,
              new Set([...(exportsToAdd.get(target) ?? []), name]),
            );
          }
        }

        const added =
          flattened.length > 0
            ? ['// --- Flattened module augmentations ---', ...flattened]
            : [];
        for (const [target, texts] of retargeted) {
          added.push(
            `declare module './${target.fileName.replace(
              /\.d\.ts$/,
              '.js',
            )}' {`,
            ...texts.map(text => text.replace(/^(?=.)/gm, '    ')),
            '}',
          );
        }
        const exportIndex = kept.findLastIndex(line =>
          line.startsWith('export '),
        );
        kept.splice(
          exportIndex >= 0 ? exportIndex : kept.length,
          0,
          '',
          ...added,
          '',
        );
        chunk.code = kept.join('\n');
        placed.push(
          `${chunk.fileName}: ${flattened.length} flattened, ${
            [...retargeted.values()].flat().length
          } retargeted${
            retargeted.size > 0
              ? ` to ${[...retargeted.keys()]
                  .map(({ fileName }) => fileName)
                  .join(', ')}`
              : ''
          }`,
        );
      }
      for (const [target, names] of exportsToAdd) {
        const list = [...names].sort().join(', ');
        target.code = target.code.replace(
          /\n*$/,
          `\nexport type { ${list} };\n`,
        );
        placed.push(`${target.fileName}: exports ${list} for augmentations`);
      }
      // eslint-disable-next-line no-console -- concise build proof
      console.log(`[place-augmentations]\n  ${placed.join('\n  ')}`);
    },
  };
};

/** A chunk's top-level interfaces, its own exports under their own names, and the interfaces it augments in other chunks. */
const chunkDeclarations = code => {
  const source = ts.createSourceFile(
    'chunk.d.ts',
    code,
    ts.ScriptTarget.Latest,
    false,
  );
  const interfaces = new Set();
  const ownExports = new Set();
  const augmented = [];
  for (const statement of source.statements) {
    if (ts.isInterfaceDeclaration(statement)) {
      interfaces.add(statement.name.text);
    } else if (
      ts.isExportDeclaration(statement) &&
      !statement.moduleSpecifier &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      for (const { propertyName, name } of statement.exportClause.elements) {
        if (!propertyName || propertyName.text === name.text) {
          ownExports.add(name.text);
        }
      }
    } else if (
      ts.isModuleDeclaration(statement) &&
      ts.isStringLiteral(statement.name) &&
      statement.name.text.startsWith('.') &&
      statement.body &&
      ts.isModuleBlock(statement.body)
    ) {
      for (const inner of statement.body.statements) {
        if (ts.isInterfaceDeclaration(inner)) {
          augmented.push({
            target: statement.name.text,
            name: inner.name.text,
          });
        }
      }
    }
  }
  return { interfaces, ownExports, augmented };
};

/**
 * Refuses declarations the published package cannot serve as each entry's
 * consumers need: a file that is neither an entry's nor a shared one (the
 * checks and the release workflow read the top of dist/ by these names), a
 * chunk that imports an entry's declarations without an explicit allowance (a consumer of one entry would
 * load another's), an augmentation of a workspace package (no consumer has
 * it), a `declare global` outside an entry's declarations (every program that
 * loads the shared file would see it), and an augmentation of another chunk
 * whose interface that chunk does not declare and export under the same name
 * (the augmentation would merge into nothing).
 *
 * @param {{ entries: string[]; allowedEntryImports?: Record<string, string[]> }} build The entries of the channel and deliberate entry-to-entry imports.
 */
export const assertDeclarationLayout = ({
  entries,
  allowedEntryImports = {},
}) => ({
  name: 'assert-declaration-layout',
  generateBundle: (_options, bundle) => {
    const entryFiles = new Set(entries.map(entry => `${entry}.d.ts`));
    const parsed = new Map();
    const parsedChunk = output => {
      if (!parsed.has(output))
        parsed.set(output, chunkDeclarations(output.code));
      return parsed.get(output);
    };
    const problems = [];
    for (const output of Object.values(bundle)) {
      const { fileName } = output;
      const isEntry = entryFiles.has(fileName);
      if (!isEntry && !SHARED_DECLARATIONS.test(fileName)) {
        problems.push(
          `${fileName}: neither an entry's declarations nor a shared declaration file`,
        );
      }
      if (output.type !== 'chunk') continue;
      for (const imported of output.imports) {
        if (
          entryFiles.has(imported) &&
          !allowedEntryImports[fileName.replace(/\.d\.ts$/, '')]?.includes(
            imported.replace(/\.d\.ts$/, ''),
          )
        ) {
          problems.push(
            `${fileName} imports the entry declarations ${imported}`,
          );
        }
      }
      if (/^\s*declare module\s+['"]@lace-/m.test(output.code)) {
        problems.push(`${fileName}: augments a workspace package`);
      }
      if (!isEntry && /^declare global\b/m.test(output.code)) {
        problems.push(
          `${fileName}: declares globals outside an entry's declarations`,
        );
      }
      if (!/^declare module\s+['"]\./m.test(output.code)) continue;
      for (const { target, name } of parsedChunk(output).augmented) {
        const declaring =
          bundle[target.replace(/^\.\//, '').replace(/\.js$/, '.d.ts')];
        const declarations =
          declaring?.type === 'chunk' && parsedChunk(declaring);
        if (
          !declarations ||
          !declarations.interfaces.has(name) ||
          !declarations.ownExports.has(name)
        ) {
          problems.push(
            `${fileName} augments ${name} of ${target}, which does not declare and export an interface of that name`,
          );
        }
      }
    }
    if (problems.length > 0) {
      throw new Error(`Declaration chunks:\n  ${problems.join('\n  ')}`);
    }
  },
});
