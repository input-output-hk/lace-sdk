import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import {
  allowsBreakingChange,
  canaryReleaseProblems,
  compareExports,
  compareVersions,
  declarationsIn,
  latestCanarySinceOf,
  latestStableOf,
  parseVersion,
  readExports,
  republishProblems,
  requiresDeprecation,
  stableReleaseProblems,
} from '../scripts/release-compat';

const declarations = (source: string) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'release-compat-'));
  const file = path.join(directory, 'index.d.ts');
  fs.writeFileSync(file, source);
  return readExports({ index: file });
};

const consumerErrors = (source: string, consumer: string) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'release-consumer-'));
  fs.writeFileSync(path.join(directory, 'index.d.ts'), source);
  const file = path.join(directory, 'consumer.ts');
  fs.writeFileSync(file, consumer);
  const program = ts.createProgram([file], {
    noEmit: true,
    strict: true,
    target: ts.ScriptTarget.ES2022,
    types: [],
  });
  return ts.getPreEmitDiagnostics(program).map(diagnostic => diagnostic.code);
};

/** The exports of a build directory holding `files` in its `dist/`. */
const build = (files: Record<string, string>) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'release-compat-'));
  fs.mkdirSync(path.join(directory, 'dist'));
  for (const [file, text] of Object.entries(files)) {
    fs.writeFileSync(path.join(directory, 'dist', file), text);
  }
  return readExports(declarationsIn(directory));
};

const PREVIOUS = `
declare function createWallet(name: string): Promise<void>;
/** @deprecated Use createWallet. */
declare function openWallet(name: string): Promise<void>;
type Result$1<T> = { ok: T };
interface Account { id: string }
export { createWallet, openWallet, type Result$1 as Result, type Account };
`;

describe('readExports', () => {
  it('records each export with its declaration and deprecation', () => {
    const exports = declarations(PREVIOUS);
    expect([...exports.keys()].sort()).toEqual([
      'index:Account',
      'index:Result',
      'index:createWallet',
      'index:openWallet',
    ]);
    expect(exports.get('index:openWallet')?.deprecated).toBe(true);
    expect(exports.get('index:createWallet')?.deprecated).toBe(false);
  });

  it('ignores a renamed collision suffix and whitespace', () => {
    const renamed = declarations(
      PREVIOUS.replaceAll('Result$1', 'Result$2').replace(
        'interface Account { id: string }',
        'interface Account {\n  id: string\n}',
      ),
    );
    expect(compareExports(declarations(PREVIOUS), renamed)).toEqual({
      added: [],
      removed: [],
      changed: [],
    });
  });
  it('ignores a change to doc comments only', () => {
    const documented = (summary: string) =>
      declarations(`
/** ${summary} */
interface Options$1 {
  /** ${summary} */
  retries: number; // ${summary}
}
/**
 * ${summary}
 * @param options - ${summary}
 */
declare function createWallet(options: Options$1): Promise<void>;
/** ${summary} */
declare const VERSION: string;
export { createWallet, VERSION };
`);
    expect(
      compareExports(
        documented('Creates a wallet.'),
        documented('Creates a wallet; see the guide.'),
      ),
    ).toEqual({ added: [], removed: [], changed: [] });
  });

  it('reads @deprecated from documented declarations, as the published types carry them', () => {
    const exports = declarations(`
/**
 * The wallet's options.
 */
interface Options {
  /** How many times to retry. */
  retries: number;
}
/**
 * Opens a wallet.
 *
 * @param options - How to open it.
 * @deprecated Use createWallet.
 */
declare function openWallet(options: Options): Promise<void>;
/**
 * The SDK's version.
 *
 * @deprecated Read it from package.json.
 */
declare const VERSION: string;
/** The default retries. */
declare const RETRIES = 3;
declare const _default$1: Options;
declare namespace modules_d {
  export { _default$1 as storage };
}
export { openWallet, VERSION, RETRIES, type Options, modules_d as m };
`);
    expect(
      Object.fromEntries(
        [...exports.values()].map(({ key, deprecated }) => [key, deprecated]),
      ),
    ).toEqual({
      'index:Options': false,
      'index:RETRIES': false,
      'index:VERSION': true,
      'index:m': false,
      'index:openWallet': true,
    });
  });

  it('counts a change to an unexported type an export references', () => {
    const withOptions = (field: string) =>
      declarations(`
interface Options$1 { ${field} }
interface Network { magic: Options$1 }
declare function createWallet(network: Network): Promise<void>;
export { createWallet };
`);
    expect(
      compareExports(
        withOptions('retries: number'),
        withOptions('retries: string'),
      ).changed,
    ).toEqual(['index:createWallet']);
  });

  it('counts a change to a namespace member declared as a constant', () => {
    const withModule = (type: string) =>
      declarations(`
declare const _default$1: ${type};
declare namespace modules_d {
  export { _default$1 as storageInMemory };
}
export { modules_d as m };
`);
    expect(
      compareExports(withModule('Module<string>'), withModule('Module<number>'))
        .changed,
    ).toEqual(['index:m']);
  });

  it.each([
    'export { _default as storageInMemory };',
    'export const storageInMemory: typeof _default;',
    'export function storageInMemory(): void;',
  ])('refuses a renamed public namespace member: %s', member => {
    const source = `declare function _default(): void;
declare namespace modules_d {
  ${member}
}
export { modules_d as m };
`;
    const renamed = source.replace('storageInMemory', 'renamedStorage');
    const consumer = `import { m } from './index'; m.storageInMemory();`;
    expect(consumerErrors(source, consumer)).toEqual([]);
    expect(consumerErrors(renamed, consumer)).toEqual([2339]);
    const previous = declarations(source);
    const next = declarations(renamed);
    expect(compareExports(previous, next).changed).toEqual(['index:m']);
    expect(
      stableReleaseProblems({
        previousVersion: '0.1.0',
        nextVersion: '0.1.1',
        previous,
        next,
        overrides: [],
      }),
    ).toEqual([
      '0.1.1 changes or removes index:m after 0.1.0; a minor release is required, or a release-overrides.json entry for a change that is compatible',
    ]);
  });

  it('keeps a shorthand namespace export tied to its declaration', () => {
    const source = `declare const storageInMemory: string;
declare namespace modules_d {
  export { storageInMemory };
}
export { modules_d as m };
`;
    expect(
      compareExports(
        declarations(source),
        declarations(source.replace(': string', ': number')),
      ).changed,
    ).toEqual(['index:m']);
    expect(
      compareExports(
        declarations(source),
        declarations(
          source
            .replace('const storageInMemory', 'const _default$2')
            .replace(
              '{ storageInMemory }',
              '{ _default$2 as storageInMemory }',
            ),
        ),
      ).changed,
    ).toEqual([]);
  });

  it('compares an exported type on its own, not through its users', () => {
    const usingAccount = PREVIOUS.replace(
      'createWallet(name: string)',
      'createWallet(name: string, account?: Account)',
    );
    expect(
      compareExports(
        declarations(usingAccount),
        declarations(
          usingAccount.replace(
            'interface Account { id: string }',
            'interface Account { id: number }',
          ),
        ),
      ).changed,
    ).toEqual(['index:Account']);
  });

  it("reads an inferred type's members and a union's in any order alike", () => {
    const signatureOf = (type: string) =>
      declarations(`declare const flow: ${type};\nexport { flow };\n`).get(
        'index:flow',
      )?.signature;
    const flow =
      "flow: { cancel(): void; cancel(reason: string): void; delete(): void; kind: 'a' | 'b'; }";
    expect(
      signatureOf(
        "{ delete(): void; cancel(): void; kind: 'b' | 'a'; cancel(reason: string): void }",
      ),
    ).toBe(flow);
    expect(
      signatureOf(
        "{ cancel(reason: string): void; cancel(): void; delete(): void; kind: 'a' | 'b' }",
      ),
    ).not.toBe(flow);
    const brands = (brand: string) =>
      `declare const ${brand}: unique symbol;\ndeclare const brandX: unique symbol;\n`;
    const branded = (brand: string, type: string) =>
      declarations(
        `${brands(brand)}declare const flow: ${type};\nexport { flow };\n`,
      );
    expect(
      compareExports(
        branded('brand', '{ [brand]: 1; [brandX]: 2 }'),
        branded('brand$1', '{ [brandX]: 2; [brand$1]: 1 }'),
      ).changed,
    ).toEqual([]);
    expect(signatureOf('[string, number]')).not.toBe(
      signatureOf('[number, string]'),
    );
    expect(signatureOf('(a: string, b: number) => void')).not.toBe(
      signatureOf('(b: number, a: string) => void'),
    );
  });
});

describe('readExports across declaration files', () => {
  // A bundler that splits shared declarations into chunks leaves each entry a
  // re-export of names declared in a chunk.
  const chunkedPackage = (chunk: string) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'release-compat-'));
    fs.writeFileSync(path.join(directory, 'index-abc.d.ts'), chunk);
    const entry = path.join(directory, 'util.d.ts');
    fs.writeFileSync(
      entry,
      'import { y, z } from "./index-abc.js";\nexport { y, z };\n',
    );
    return entry;
  };
  const chunk = `/** @deprecated use y */
declare const z: number;
interface Shape { a: string }
declare const y: Shape;
export { y, z };
`;

  it('reads declarations and deprecation through a chunk', () => {
    const exports = readExports({ util: chunkedPackage(chunk) });
    expect(exports.get('util:z')).toMatchObject({
      key: 'util:z',
      signature: 'z: number',
      own: ['z: number'],
      locals: [],
      deprecated: true,
    });
    expect(exports.get('util:y')).toMatchObject({
      key: 'util:y',
      signature: 'y: Shape\ninterface Shape { a: string; }',
      own: ['y: Shape'],
      locals: [['interface Shape { a: string; }']],
      deprecated: false,
    });
  });

  it('throws when a chunk an entry imports has no declarations, even with its code beside it', () => {
    const entry = chunkedPackage(chunk);
    const declarationsFile = path.join(path.dirname(entry), 'index-abc.d.ts');
    const missing = `Declaration files are missing: ${entry} imports ./index-abc.js`;
    fs.rmSync(declarationsFile);
    expect(() => readExports({ util: entry })).toThrow(missing);
    fs.writeFileSync(declarationsFile.replace(/\.d\.ts$/, '.js'), '');
    expect(() => readExports({ util: entry })).toThrow(missing);
  });

  it('counts a change behind a chunk', () => {
    const read = (source: string) =>
      readExports({ util: chunkedPackage(source) });
    expect(
      compareExports(read(chunk), read(chunk.replace('a: string', 'a: number')))
        .changed,
    ).toEqual(['util:y']);
  });

  it('leaves a third-party import unresolved', () => {
    const entry = chunkedPackage(
      'import type { Logger } from "pino";\ndeclare const y: Logger;\ndeclare const z: number;\nexport { y, z };\n',
    );
    expect(readExports({ util: entry }).get('util:y')?.signature).toBe(
      'y: Logger',
    );
  });
});

describe('readExports of a build whose entries share declaration files', () => {
  // The same API as one bundle per entry, each with its own copy of the
  // shared types, and as entries re-exporting them from one shared file.
  const ONE_FILE_EACH = {
    'index.d.ts': `import { Observable } from 'rxjs';
import { Logger as Logger$1 } from 'ts-log';
declare const serializableBrand: unique symbol;
type Serializable<T> = T & { readonly [serializableBrand]: true };
interface State$1 { wallets: string[] }
interface State$1 { network: Serializable<number> }
interface Options$1 { retries: number }
interface Network { magic: Options$1 }
interface LaceModule { name: string; state?: State$1 }
/** @deprecated Use createLaceWallet. */
declare function openWallet(network: Network): void;
declare function createLaceWallet(network: Network, modules: LaceModule[]): Observable<State$1>;
export { createLaceWallet, openWallet, type LaceModule, type Network, type Logger$1 as Logger };
`,
    'bitcoin.d.ts': `import { Observable } from 'rxjs';
import { Logger as Logger$1 } from 'ts-log';
declare const serializableBrand: unique symbol;
type Serializable<T> = T & { readonly [serializableBrand]: true };
interface State$2 { wallets: string[] }
interface State$2 { network: Serializable<number> }
interface Options { retries: number }
interface Network$1 { magic: Options }
interface LaceModule$1 { name: string; state?: State$2 }
declare function createLaceWallet(network: Network$1, modules: LaceModule$1[]): Observable<State$2>;
declare const bitcoinModule: LaceModule$1;
export { bitcoinModule, createLaceWallet, type LaceModule$1 as LaceModule, type Logger$1 as Logger };
`,
  };
  const SHARED = `import { Observable } from 'rxjs';
import { Logger } from 'ts-log';
declare const serializableBrand: unique symbol;
type Serializable<T> = T & { readonly [serializableBrand]: true };
interface State { wallets: string[] }
interface State { network: Serializable<number> }
interface Options$3 { retries: number }
interface Network { magic: Options$3 }
interface LaceModule { name: string; state?: State }
/** @deprecated Use createLaceWallet. */
declare function openWallet(network: Network): void;
declare function createLaceWallet(network: Network, modules: LaceModule[]): Observable<State>;
export { createLaceWallet as a, openWallet as b, LaceModule as L, Logger as c, Network as N, State as S };
`;
  const sharedBuild = ({
    shared = SHARED,
    bitcoin = '',
  }: { shared?: string; bitcoin?: string } = {}) =>
    build({
      'shared-0a1b2c3d.d.ts': shared,
      'index.d.ts':
        "export { a as createLaceWallet, b as openWallet, L as LaceModule, N as Network, c as Logger } from './shared-0a1b2c3d.js';\n",
      'bitcoin.d.ts': `import { L as LaceModule } from './shared-0a1b2c3d.js';
export { a as createLaceWallet, L as LaceModule, c as Logger } from './shared-0a1b2c3d.js';
declare const bitcoinModule: LaceModule;
export { bitcoinModule };
${bitcoin}`,
    });

  it('reads the same API alike, one file per entry or shared files', () => {
    const oneFileEach = build(ONE_FILE_EACH);
    const shared = sharedBuild();
    expect(compareExports(oneFileEach, shared)).toEqual({
      added: [],
      removed: [],
      changed: [],
    });
    expect(shared.get('index:openWallet')?.deprecated).toBe(true);
  });

  it("counts a type another entry exports in this entry's signatures", () => {
    expect(sharedBuild().get('bitcoin:createLaceWallet')?.signature).toContain(
      'interface Network { magic: Options; }',
    );
  });

  it('reads a third-party export alike, re-exported directly or through a shared file', () => {
    expect(build(ONE_FILE_EACH).get('index:Logger')?.signature).toBe(
      'ts-log:Logger',
    );
    expect(sharedBuild().get('index:Logger')?.signature).toBe('ts-log:Logger');
  });

  it("keeps an entry's augmentation of a shared interface out of the other entries", () => {
    expect(
      compareExports(
        sharedBuild(),
        sharedBuild({
          bitcoin:
            "declare module './shared-0a1b2c3d.js' { interface S { bitcoin: boolean } }\n",
        }),
      ).changed,
    ).toEqual(['bitcoin:LaceModule', 'bitcoin:createLaceWallet']);
  });

  it('counts a change behind a shared file in every entry that references it', () => {
    // The root exports Network, so its change counts there and not through
    // the root's users of it; Bitcoin's createLaceWallet carries it.
    expect(
      compareExports(
        sharedBuild(),
        sharedBuild({
          shared: SHARED.replace('retries: number', 'retries: string'),
        }),
      ).changed,
    ).toEqual(['bitcoin:createLaceWallet', 'index:Network']);
  });
});

describe('compareExports', () => {
  const BASE = `interface Options$1 { retries: number }
interface Network { magic: Options$1 }
declare function createWallet(network: Network): Promise<void>;
export { createWallet };
`;
  const exportingNetwork = (source: string) =>
    source.replace(
      'export { createWallet };',
      'export { createWallet, type Network };',
    );

  it('reads an export unchanged when a type it named becomes an export of its entry', () => {
    const before = declarations(BASE);
    const after = declarations(exportingNetwork(BASE));
    // Options moves with Network, which is the only type that names it.
    expect(after.get('index:createWallet')?.signature).not.toBe(
      before.get('index:createWallet')?.signature,
    );
    expect(compareExports(before, after)).toEqual({
      added: ['index:Network'],
      removed: [],
      changed: [],
    });
  });

  it('refuses a changed reference to a colliding exported type when an added export carries the old type', () => {
    const source = `interface Network { magic: number }
interface Network$1 { magic: string }
declare function createWallet(network: Network): void;
export { createWallet, type Network$1 as NewNetwork };
`;
    const previous = declarations(source);
    const next = declarations(
      source
        .replace('network: Network)', 'network: Network$1)')
        .replace(
          'type Network$1 as NewNetwork',
          'type Network$1 as NewNetwork, type Network as LegacyNetwork',
        ),
    );
    expect(compareExports(previous, next)).toEqual({
      added: ['index:LegacyNetwork'],
      removed: [],
      changed: ['index:createWallet'],
    });
    expect(
      stableReleaseProblems({
        previousVersion: '0.1.0',
        nextVersion: '0.1.1',
        previous,
        next,
        overrides: [],
      }),
    ).toEqual([
      '0.1.1 changes or removes index:createWallet after 0.1.0; a minor release is required, or a release-overrides.json entry for a change that is compatible',
    ]);
  });

  it('counts swapped references even when both colliding types become exports', () => {
    const source = `interface Network { magic: number }
interface Network$1 { magic: string }
declare function createWallet(first: Network, second: Network$1): void;
export { createWallet };
`;
    expect(
      compareExports(
        declarations(source),
        declarations(
          source
            .replace(
              'first: Network, second: Network$1',
              'first: Network$1, second: Network',
            )
            .replace(
              'export { createWallet }',
              'export { createWallet, type Network, type Network$1 as OtherNetwork }',
            ),
        ),
      ).changed,
    ).toEqual(['index:createWallet']);
  });

  it('follows cyclic types and collision renumbering when they become exports', () => {
    const source = `interface Network { options: Options$1 }
interface Options$1 { network?: Network; magic: number }
declare function createWallet(network: Network): void;
export { createWallet };
`;
    expect(
      compareExports(
        declarations(source),
        declarations(
          source
            .replaceAll('Options$1', 'Options$2')
            .replace(
              'export { createWallet }',
              'export { createWallet, type Network }',
            ),
        ),
      ).changed,
    ).toEqual([]);
  });

  it('counts an interface reference changing from a local string alias to an exported number alias', () => {
    const source = `type Foo = string;
type Foo$1 = number;
interface X { a: Foo }
export { type X };
`;
    const next = source
      .replace('a: Foo', 'a: Foo$1')
      .replace(
        'type X }',
        'type X, type Foo as PreviousFoo, type Foo$1 as NextFoo }',
      );
    expect(compareExports(declarations(source), declarations(next))).toEqual({
      added: ['index:NextFoo', 'index:PreviousFoo'],
      removed: [],
      changed: ['index:X'],
    });
  });

  it('counts a swap between distinct exported unique symbols with colliding declared names', () => {
    const source = `declare const brand: unique symbol;
declare const brand$1: unique symbol;
interface X { readonly [brand]: true }
export { brand as FirstBrand, brand$1 as SecondBrand, type X };
`;
    const before = declarations(source);
    const after = declarations(source.replace('[brand]', '[brand$1]'));
    expect(before.get('index:X')?.signature).toBe(
      after.get('index:X')?.signature,
    );
    expect(compareExports(before, after).changed).toEqual(['index:X']);
    expect(
      compareExports(
        before,
        declarations(
          source
            .replaceAll('brand$1', 'brand$8')
            .replaceAll(/\bbrand\b(?!\$)/g, 'brand$5'),
        ),
      ).changed,
    ).toEqual([]);
  });

  it('compares an existing public type separately when a referenced local becomes public', () => {
    const source = `interface State { loaded: boolean }
interface Local { value: string; state: State }
interface Holder { local: Local }
export { type State, type Holder };
`;
    const next = source
      .replace('loaded: boolean', 'loaded: boolean; optional?: string')
      .replace('type Holder }', 'type Holder, type Local }');
    expect(compareExports(declarations(source), declarations(next))).toEqual({
      added: ['index:Local'],
      removed: [],
      changed: ['index:State'],
    });
  });

  it('keeps private unique symbols tied to the public types that expose them', () => {
    const source = `declare const brand: unique symbol;
declare const brand$1: unique symbol;
interface First { readonly [brand]: true }
interface Second { readonly [brand$1]: true }
declare function accept(value: { readonly [brand]: true }): void;
export { type First, type Second, accept };
`;
    expect(
      compareExports(
        declarations(source),
        declarations(
          source.replace(
            'accept(value: { readonly [brand]',
            'accept(value: { readonly [brand$1]',
          ),
        ),
      ).changed,
    ).toEqual(['index:accept']);
  });

  it.each(['private value: string;', 'protected value: string;', '#private;'])(
    'refuses a factory switching between classes with %s',
    member => {
      const source = `declare class First { ${member} }
declare class Second { ${member} }
declare function makeFirst(): First;
declare function acceptFirst(value: First): void;
export { makeFirst, acceptFirst };
`;
      const changed = source.replace(
        'makeFirst(): First',
        'makeFirst(): Second',
      );
      const consumer = `import { makeFirst, acceptFirst } from './index'; acceptFirst(makeFirst());`;
      expect(consumerErrors(source, consumer)).toEqual([]);
      expect(consumerErrors(changed, consumer)).toEqual([2345]);
      const previous = declarations(source);
      const next = declarations(changed);
      expect(compareExports(previous, next).changed).toEqual([
        'index:acceptFirst',
        'index:makeFirst',
      ]);
      expect(
        stableReleaseProblems({
          previousVersion: '0.1.0',
          nextVersion: '0.1.1',
          previous,
          next,
          overrides: [],
        }),
      ).toContain(
        '0.1.1 changes or removes index:acceptFirst, index:makeFirst after 0.1.0; a minor release is required, or a release-overrides.json entry for a change that is compatible',
      );
    },
  );

  it('still compares the structure of unexported nominal classes', () => {
    const source = `declare class First { private value; name: string; }
declare function makeFirst(): First;
export { makeFirst };
`;
    expect(
      compareExports(
        declarations(source),
        declarations(source.replace('name: string', 'name: number')),
      ).changed,
    ).toEqual(['index:makeFirst']);
  });

  it('keeps nominal class identity through chunk moves, renaming and new exports', () => {
    const source = `declare class First { private value; }
declare class Second { private value; }
declare function makeFirst(): First;
declare function acceptFirst(value: First): void;
declare function makeSecond(): Second;
export { makeFirst, acceptFirst, makeSecond };
`;
    const next = build({
      'index.d.ts': `export { makeFirst, acceptFirst, makeSecond, First$2 as First, Second$3 as Second } from './shared.js';`,
      'shared.d.ts': source
        .replaceAll(/\bFirst\b/g, 'First$2')
        .replaceAll(/\bSecond\b/g, 'Second$3')
        .replace('export {', 'export { First$2, Second$3,'),
    });
    expect(compareExports(declarations(source), next)).toEqual({
      added: ['index:First', 'index:Second'],
      removed: [],
      changed: [],
    });
  });

  it('counts the change when the type that becomes an export changed', () => {
    expect(
      compareExports(
        declarations(BASE),
        declarations(
          exportingNetwork(BASE).replace(
            'interface Network { magic: Options$1 }',
            'interface Network { magic: Options$1; name: string }',
          ),
        ),
      ),
    ).toEqual({
      added: ['index:Network'],
      removed: [],
      changed: ['index:createWallet'],
    });
  });

  it('counts a declaration an export loses that no added export carries', () => {
    const withFee = BASE.replace(
      'declare function createWallet(network: Network)',
      'interface Fee { base: number }\ninterface Fee { tip: number }\ndeclare function createWallet(network: Network, fee: Fee)',
    );
    expect(
      compareExports(
        declarations(withFee),
        declarations(
          exportingNetwork(withFee).replace(
            'interface Fee { tip: number }\n',
            '',
          ),
        ),
      ).changed,
    ).toEqual(['index:createWallet']);
  });

  it('counts what an export gains beside a type that becomes an export', () => {
    expect(
      compareExports(
        declarations(BASE),
        declarations(
          exportingNetwork(BASE).replace(
            'createWallet(network: Network)',
            'createWallet(network: Network, retries?: number)',
          ),
        ),
      ).changed,
    ).toEqual(['index:createWallet']);
  });

  it('does not read an export unchanged through an export another entry adds', () => {
    const before = build({
      'index.d.ts': `interface Network { magic: number }
interface Network { name: string }
declare function createWallet(network: Network): void;
export { createWallet };
`,
      'bitcoin.d.ts': `declare const bitcoinModule: string;
export { bitcoinModule };
`,
    });
    const after = build({
      'index.d.ts': `interface Network { magic: number }
declare function createWallet(network: Network): void;
export { createWallet };
`,
      'bitcoin.d.ts': `interface Network { name: string }
declare const bitcoinModule: string;
export { bitcoinModule, type Network };
`,
    });
    expect(compareExports(before, after)).toEqual({
      added: ['bitcoin:Network'],
      removed: [],
      changed: ['index:createWallet'],
    });
  });

  it('reads an export unchanged when it keeps a type the moved type also references', () => {
    const keepingOptions = BASE.replace(
      'createWallet(network: Network)',
      'createWallet(network: Network, options: Options$1)',
    );
    expect(
      compareExports(
        declarations(keepingOptions),
        declarations(exportingNetwork(keepingOptions)),
      ),
    ).toEqual({
      added: ['index:Network'],
      removed: [],
      changed: [],
    });
  });

  it('reads an export unchanged when two types it referenced, one through the other, become exports', () => {
    expect(
      compareExports(
        declarations(BASE),
        declarations(
          BASE.replace(
            'export { createWallet };',
            'export { createWallet, type Network, type Options$1 as Options };',
          ),
        ),
      ),
    ).toEqual({
      added: ['index:Network', 'index:Options'],
      removed: [],
      changed: [],
    });
  });

  it('counts the change to a type that becomes an export although an added export references an older copy', () => {
    const before = build({
      'index.d.ts': `interface Options { retries: number }
interface Network { magic: Options }
declare function createWallet(network: Network): Promise<void>;
export { createWallet };
`,
    });
    const after = build({
      'index.d.ts': `import { LegacyNetwork } from './shared-a.js';
interface Options { retries: string }
interface Network { magic: Options }
declare function createWallet(network: Network): Promise<void>;
export { createWallet, type Network, type LegacyNetwork };
`,
      'shared-a.d.ts': `interface Options { retries: number }
interface LegacyNetwork { magic: Options }
export { LegacyNetwork };
`,
    });
    expect(compareExports(before, after)).toEqual({
      added: ['index:LegacyNetwork', 'index:Network'],
      removed: [],
      changed: ['index:createWallet'],
    });
  });

  it('counts the change to a type that becomes an export although an added export is an older copy', () => {
    const before = build({
      'index.d.ts': `interface Options { retries: number }
interface Network { magic: Options }
declare function createWallet(network: Network): Promise<void>;
export { createWallet };
`,
    });
    const after = build({
      'index.d.ts': `import { LegacyOptions } from './shared-a.js';
interface Options { retries: string }
interface Network { magic: Options }
declare function createWallet(network: Network): Promise<void>;
export { createWallet, type Network, type LegacyOptions };
`,
      'shared-a.d.ts': `interface Options { retries: number }
export { Options as LegacyOptions };
`,
    });
    expect(compareExports(before, after)).toEqual({
      added: ['index:LegacyOptions', 'index:Network'],
      removed: [],
      changed: ['index:createWallet'],
    });
  });

  it('counts a type that becomes an export and now references another type of the same name', () => {
    const before = build({
      'index.d.ts': `type Magic = number;
interface Network { magic: Magic }
declare function createWallet(network: Network): Promise<void>;
export { createWallet, type Magic };
`,
    });
    const after = build({
      'index.d.ts': `import { Network } from './shared-a.js';
type Magic = number;
declare function createWallet(network: Network): Promise<void>;
export { createWallet, type Magic, type Network };
`,
      'shared-a.d.ts': `type Magic = string;
interface Network { magic: Magic }
export { Network };
`,
    });
    expect(compareExports(before, after)).toEqual({
      added: ['index:Network'],
      removed: [],
      changed: ['index:createWallet'],
    });
  });

  it('counts an overload an export drops although an added export carries it', () => {
    expect(
      compareExports(
        declarations(`declare function createWallet(name: string): Promise<void>;
declare function createWallet(magic: number): Promise<void>;
export { createWallet };
`),
        declarations(`declare function createWallet(name: string): Promise<void>;
declare function createWallet$1(magic: number): Promise<void>;
export { createWallet, createWallet$1 as createWalletByMagic };
`),
      ),
    ).toEqual({
      added: ['index:createWalletByMagic'],
      removed: [],
      changed: ['index:createWallet'],
    });
  });

  it('counts a merged declaration a type loses as it becomes an export although another added export carries it', () => {
    expect(
      compareExports(
        declarations(`interface Fee { base: number }
interface Fee { tip: number }
declare function createWallet(fee: Fee): Promise<void>;
export { createWallet };
`),
        declarations(`interface Fee { base: number }
interface Fee$1 { tip: number }
declare function createWallet(fee: Fee): Promise<void>;
export { createWallet, type Fee, type Fee$1 as Tip };
`),
      ),
    ).toEqual({
      added: ['index:Fee', 'index:Tip'],
      removed: [],
      changed: ['index:createWallet'],
    });
  });
});

describe('stableReleaseProblems', () => {
  const previous = declarations(PREVIOUS);

  it('accepts an addition in a patch release', () => {
    const next = declarations(
      `${PREVIOUS}\ndeclare const VERSION: string;\nexport { VERSION };`,
    );
    expect(
      stableReleaseProblems({
        previousVersion: '0.1.0',
        nextVersion: '0.1.1',
        previous,
        next,
        overrides: [],
      }),
    ).toEqual([]);
  });

  it('refuses a removal in a patch release before 1.0', () => {
    const next = declarations(PREVIOUS.replace('openWallet, ', ''));
    expect(
      stableReleaseProblems({
        previousVersion: '0.1.0',
        nextVersion: '0.1.1',
        previous,
        next,
        overrides: [],
      }),
    ).toEqual([
      '0.1.1 changes or removes index:openWallet after 0.1.0; a minor release is required, or a release-overrides.json entry for a change that is compatible',
    ]);
  });

  it('accepts removing a deprecated export in a minor release before 1.0', () => {
    const next = declarations(PREVIOUS.replace('openWallet, ', ''));
    expect(
      stableReleaseProblems({
        previousVersion: '0.1.0',
        nextVersion: '0.2.0',
        previous,
        next,
        overrides: [],
      }),
    ).toEqual([]);
  });

  it('accepts removing an export that was not deprecated in a minor release before 1.0', () => {
    const next = declarations(PREVIOUS.replace('createWallet, ', ''));
    expect(
      stableReleaseProblems({
        previousVersion: '0.1.0',
        nextVersion: '0.2.0',
        previous,
        next,
        overrides: [],
      }),
    ).toEqual([]);
  });

  it('refuses removing an export that was not deprecated in a patch release before 1.0', () => {
    const next = declarations(PREVIOUS.replace('createWallet, ', ''));
    expect(
      stableReleaseProblems({
        previousVersion: '0.1.0',
        nextVersion: '0.1.1',
        previous,
        next,
        overrides: [],
      }),
    ).toEqual([
      '0.1.1 changes or removes index:createWallet after 0.1.0; a minor release is required, or a release-overrides.json entry for a change that is compatible',
    ]);
  });

  it('accepts changing an export that was not deprecated in a minor release before 1.0, and refuses it in a patch', () => {
    const next = declarations(
      PREVIOUS.replace(
        'createWallet(name: string)',
        'createWallet(name: string, network: string)',
      ),
    );
    const release = (nextVersion: string) =>
      stableReleaseProblems({
        previousVersion: '0.1.0',
        nextVersion,
        previous,
        next,
        overrides: [],
      });
    expect(release('0.2.0')).toEqual([]);
    expect(release('0.1.1')).toEqual([
      '0.1.1 changes or removes index:createWallet after 0.1.0; a minor release is required, or a release-overrides.json entry for a change that is compatible',
    ]);
  });

  it('from 1.0, refuses removing or changing an export that was not deprecated, even in a major release', () => {
    const removed = declarations(PREVIOUS.replace('createWallet, ', ''));
    const changed = declarations(
      PREVIOUS.replace(
        'createWallet(name: string)',
        'createWallet(name: string, network: string)',
      ),
    );
    for (const next of [removed, changed]) {
      expect(
        stableReleaseProblems({
          previousVersion: '1.2.0',
          nextVersion: '2.0.0',
          previous,
          next,
          overrides: [],
        }),
      ).toEqual([
        'index:createWallet changes or is removed without being @deprecated in 1.2.0',
      ]);
    }
  });

  it('holds the release that promotes to 1.0 to the deprecation rule', () => {
    const next = declarations(PREVIOUS.replace('createWallet, ', ''));
    expect(
      stableReleaseProblems({
        previousVersion: '0.4.2',
        nextVersion: '1.0.0',
        previous,
        next,
        overrides: [],
      }),
    ).toEqual([
      'index:createWallet changes or is removed without being @deprecated in 0.4.2',
    ]);
  });

  it('accepts removing a deprecated export in a major release from 1.0', () => {
    const next = declarations(PREVIOUS.replace('openWallet, ', ''));
    expect(
      stableReleaseProblems({
        previousVersion: '1.2.0',
        nextVersion: '2.0.0',
        previous,
        next,
        overrides: [],
      }),
    ).toEqual([]);
  });

  it('accepts a change the release declares compatible', () => {
    const next = declarations(
      PREVIOUS.replace(
        'interface Account { id: string }',
        'interface Account { readonly id: string }',
      ),
    );
    expect(
      stableReleaseProblems({
        previousVersion: '0.1.0',
        nextVersion: '0.1.1',
        previous,
        next,
        overrides: [
          {
            version: '0.1.1',
            export: 'index:Account',
            reason: 'readonly field',
          },
        ],
      }),
    ).toEqual([]);
  });

  it('from 1.0, accepts a change declared compatible in a patch, and never excuses a removal', () => {
    const changed = declarations(
      PREVIOUS.replace(
        'interface Account { id: string }',
        'interface Account { readonly id: string }',
      ),
    );
    expect(
      stableReleaseProblems({
        previousVersion: '1.2.0',
        nextVersion: '1.2.1',
        previous,
        next: changed,
        overrides: [
          {
            version: '1.2.1',
            export: 'index:Account',
            reason: 'readonly field',
          },
        ],
      }),
    ).toEqual([]);

    const removed = declarations(PREVIOUS.replace('createWallet, ', ''));
    expect(
      stableReleaseProblems({
        previousVersion: '1.2.0',
        nextVersion: '2.0.0',
        previous,
        next: removed,
        overrides: [
          {
            version: '2.0.0',
            export: 'index:createWallet',
            reason: 'replaced',
          },
        ],
      }),
    ).toEqual([
      'index:createWallet changes or is removed without being @deprecated in 1.2.0',
    ]);
  });

  it('requires a major release for a breaking change from 1.0', () => {
    const v1 = declarations(PREVIOUS);
    const next = declarations(PREVIOUS.replace('openWallet, ', ''));
    expect(
      stableReleaseProblems({
        previousVersion: '1.2.0',
        nextVersion: '1.3.0',
        previous: v1,
        next,
        overrides: [],
      }),
    ).toEqual([
      '1.3.0 changes or removes index:openWallet after 1.2.0; a major release is required, or a release-overrides.json entry for a change that is compatible',
    ]);
  });

  it('refuses a version that is not above the latest stable', () => {
    expect(
      stableReleaseProblems({
        previousVersion: '0.2.0',
        nextVersion: '0.1.5',
        previous,
        next: previous,
        overrides: [],
      }),
    ).toEqual(['0.1.5 is not above the latest stable 0.2.0']);
  });
});

describe('canaryReleaseProblems', () => {
  it('refuses a canary before the first stable release', () => {
    expect(
      canaryReleaseProblems({
        latestStable: undefined,
        canaryVersion: '0.1.0-canary.1',
      }),
    ).toEqual([
      "0.1.0-canary.1 would be the package's first version, which npm makes its latest: release a stable version first",
    ]);
  });

  it('accepts a canary of the next version', () => {
    expect(
      canaryReleaseProblems({
        latestStable: '0.1.0',
        canaryVersion: '0.2.0-canary.1',
      }),
    ).toEqual([]);
  });

  it('refuses a canary of a version already released', () => {
    expect(
      canaryReleaseProblems({
        latestStable: '0.1.0',
        canaryVersion: '0.1.0-canary.5',
      }),
    ).toEqual([
      '0.1.0-canary.5 previews 0.1.0, which is not above the latest stable 0.1.0',
    ]);
  });

  it('refuses a canary below a canary already published', () => {
    expect(
      canaryReleaseProblems({
        latestStable: '0.1.0',
        latestCanary: '0.2.0-canary.2',
        canaryVersion: '0.2.0-canary.1',
      }),
    ).toEqual([
      '0.2.0-canary.1 is below 0.2.0-canary.2, which is already published: releasing it would move the canary dist-tag back, so cut a newer canary',
    ]);
  });

  it('holds a canary to canaries alone: a stable release below one does not count', () => {
    // 0.3.0-canary.0 was published, then 0.2.1 shipped below it.
    expect(
      canaryReleaseProblems({
        latestStable: '0.2.1',
        latestCanary: latestCanarySinceOf(['0.2.0', '0.3.0-canary.0', '0.2.1']),
        canaryVersion: '0.3.0-canary.1',
      }),
    ).toEqual([]);
  });

  it('accepts a re-run of the latest canary and a newer canary', () => {
    for (const canaryVersion of ['0.2.0-canary.2', '0.2.0-canary.10']) {
      expect(
        canaryReleaseProblems({
          latestStable: '0.1.0',
          latestCanary: '0.2.0-canary.2',
          canaryVersion,
        }),
      ).toEqual([]);
    }
  });
});

describe('versions', () => {
  it('finds the latest stable among prereleases', () => {
    expect(latestStableOf(['0.1.0', '0.2.0-canary.1', '0.1.10', '0.1.2'])).toBe(
      '0.1.10',
    );
    expect(latestStableOf(['0.1.0-canary.1'])).toBeUndefined();
  });

  it('finds the latest canary since the latest stable release', () => {
    expect(
      latestCanarySinceOf(['0.1.0', '0.2.0-canary.10', '0.2.0-canary.2']),
    ).toBe('0.2.0-canary.10');
    // 0.2.0-canary.3 is history once 0.2.1 is out; 0.3.0-canary.0 is not.
    expect(
      latestCanarySinceOf(['0.2.0-canary.3', '0.3.0-canary.0', '0.2.1']),
    ).toBe('0.3.0-canary.0');
    expect(latestCanarySinceOf(['0.2.0-canary.3', '0.2.1'])).toBeUndefined();
    expect(latestCanarySinceOf([])).toBeUndefined();
  });

  it('orders a prerelease below its release and canaries numerically', () => {
    const order = ['0.1.0-canary.2', '0.1.0-canary.10', '0.1.0', '0.2.0'].map(
      parseVersion,
    );
    for (let index = 1; index < order.length; index += 1) {
      expect(compareVersions(order[index - 1], order[index])).toBeLessThan(0);
    }
  });

  it('requires a prior deprecation from 1.0 only', () => {
    expect(requiresDeprecation(parseVersion('0.2.0'))).toBe(false);
    expect(requiresDeprecation(parseVersion('0.99.0'))).toBe(false);
    expect(requiresDeprecation(parseVersion('1.0.0'))).toBe(true);
    expect(requiresDeprecation(parseVersion('2.0.0'))).toBe(true);
  });

  it('allows a breaking change in a minor release only before 1.0', () => {
    expect(
      allowsBreakingChange(parseVersion('0.1.0'), parseVersion('0.2.0')),
    ).toBe(true);
    expect(
      allowsBreakingChange(parseVersion('1.1.0'), parseVersion('1.2.0')),
    ).toBe(false);
    expect(
      allowsBreakingChange(parseVersion('1.1.0'), parseVersion('2.0.0')),
    ).toBe(true);
  });
});

describe('republishProblems', () => {
  /** An unpacked package/ directory holding `files`. */
  const unpacked = (files: Record<string, string>) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'republish-'));
    for (const [file, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(directory, file)), {
        recursive: true,
      });
      fs.writeFileSync(path.join(directory, file), text);
    }
    return directory;
  };
  const PACKAGE = {
    'package.json': '{ "name": "@laceio/sdk", "version": "0.2.0" }\n',
    'dist/index.js': 'export const a = 1;\n',
    'dist/index.d.ts': 'export declare const a: number;\n',
  };

  it('passes the version npm has when this build holds the same files', () => {
    expect(
      republishProblems({
        name: '@laceio/sdk',
        version: '0.2.0',
        published: unpacked(PACKAGE),
        built: unpacked(PACKAGE),
      }),
    ).toEqual([]);
  });

  it('refuses the version npm has when a file differs, naming it', () => {
    expect(
      republishProblems({
        name: '@laceio/sdk',
        version: '0.2.0',
        published: unpacked(PACKAGE),
        built: unpacked({
          ...PACKAGE,
          'dist/index.js': 'export const a = 2;\n',
        }),
      }),
    ).toEqual([
      '@laceio/sdk@0.2.0 is already published and this build differs from it (dist/index.js): a published version is final, so cut a new release',
    ]);
  });

  it('refuses a build that adds or drops a file', () => {
    const { 'dist/index.d.ts': _dropped, ...withoutTypes } = PACKAGE;
    expect(
      republishProblems({
        name: '@laceio/sdk',
        version: '0.2.0-canary.1',
        published: unpacked(PACKAGE),
        built: unpacked({ ...withoutTypes, 'dist/extra.js': '' }),
      }),
    ).toEqual([
      '@laceio/sdk@0.2.0-canary.1 is already published and this build differs from it (dist/extra.js, dist/index.d.ts): a published version is final, so cut a new release',
    ]);
  });
});
