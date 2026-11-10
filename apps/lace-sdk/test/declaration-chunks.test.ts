import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { rollup } from 'rollup';
import dts from 'rollup-plugin-dts';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import {
  assertDeclarationLayout,
  DECLARATION_OUTPUT,
  extractLaceAugmentations,
  namespaceMembersFromOtherChunks,
  placeModuleAugmentations,
  redirectSdkBarrelReferences,
} from '../scripts/declaration-chunks.mjs';
import { SHARED_DECLARATIONS } from '../scripts/entries.mjs';

import type {
  NormalizedOutputOptions,
  OutputBundle,
  Plugin,
  PluginContext,
  RenderedChunk,
} from 'rollup';

/** Writes `files` under a fresh directory and returns it. */
const fixture = (files: Record<string, string>) => {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'declaration-chunks-')),
  );
  for (const [name, source] of Object.entries(files)) {
    const file = path.join(directory, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, source);
  }
  return directory;
};

/** Where the fixtures keep a workspace package's declarations, as the build's .dts-work does. */
const packageSources =
  (directory: string) =>
  (specifier: string): string | null => {
    const match = /^@lace-(contract|lib)\/([^/]+)$/.exec(specifier);
    return match && path.join(directory, 'packages', match[1], match[2], 'src');
  };

/** Rolls up the fixture's entries as the declaration build does, and returns each output file's code. */
const rollUp = async (directory: string, entries: string[]) => {
  const bundle = await rollup({
    input: Object.fromEntries(
      entries.map(entry => [entry, path.join(directory, `${entry}.d.ts`)]),
    ),
    plugins: [
      dts(),
      namespaceMembersFromOtherChunks,
      placeModuleAugmentations({
        resolveInternalSpecifier: packageSources(directory),
      }),
      assertDeclarationLayout({ entries }),
    ],
  });
  const { output } = await bundle.generate(DECLARATION_OUTPUT);
  return Object.fromEntries(
    output.flatMap(file =>
      file.type === 'chunk' ? [[file.fileName, file.code] as const] : [],
    ),
  );
};

/** Runs a plugin's generateBundle hook on a bundle. */
const generateBundle = async (plugin: Plugin, bundle: OutputBundle) => {
  const hook = plugin.generateBundle;
  const handler = typeof hook === 'function' ? hook : hook?.handler;
  await handler?.call(
    {} as PluginContext,
    {} as NormalizedOutputOptions,
    bundle,
    false,
  );
};

/** Runs a plugin's renderChunk hook on a chunk's code, and returns the code it renders. */
const renderChunk = async (plugin: Plugin, code: string) => {
  const hook = plugin.renderChunk;
  const handler = typeof hook === 'function' ? hook : hook?.handler;
  const rendered = await handler?.call(
    {} as PluginContext,
    code,
    {} as RenderedChunk,
    {} as NormalizedOutputOptions,
    { chunks: {} },
  );
  return typeof rendered === 'string' ? rendered : rendered?.code ?? code;
};

/** A bundle of chunks, each holding the fields the passes read. */
const chunks = (
  files: Record<
    string,
    {
      code: string;
      isEntry?: boolean;
      moduleIds?: string[];
      modules?: Record<string, { code: string }>;
      imports?: string[];
    }
  >,
) =>
  Object.fromEntries(
    Object.entries(files).map(([fileName, chunk]) => [
      fileName,
      {
        type: 'chunk',
        fileName,
        isEntry: false,
        moduleIds: [],
        imports: [],
        exports: [],
        ...chunk,
      },
    ]),
  ) as unknown as OutputBundle;

/**
 * Two entries share a contract's State and Settings. Both load an augmentation
 * of State; the second alone loads one of State and of the unexported Config.
 * The first exports a namespace whose member the shared file declares.
 */
const ENTRIES = {
  'package.json': '{ "type": "module" }',
  'packages/contract/base/src/index.d.ts': `
export interface State { base: string }
interface Config { url: string }
export interface Settings { config: Config }
`,
  'packages/contract/both/src/augmentations.d.ts': `
declare module '@lace-contract/base' {
    interface State { shared: number }
}
export {};
`,
  'packages/contract/second/src/augmentations.d.ts': `
import type { Extra } from './extra';
declare module '@lace-contract/base' {
    /** Only the second entry's programs have this member. */
    interface State { second: Extra }
    interface Config { timeout: number }
}
export {};
`,
  'packages/contract/second/src/extra.d.ts':
    'export interface Extra { flag: boolean }\n',
  'members.d.ts': 'export interface Member { name: string }\n',
  'modules.d.ts': `
export type { Member } from './members';
export declare const make: () => void;
`,
  'first.d.ts': `
import './packages/contract/both/src/augmentations';
export type { State, Settings } from './packages/contract/base/src/index';
export * as m from './modules';
`,
  'second.d.ts': `
import './packages/contract/both/src/augmentations';
import './packages/contract/second/src/augmentations';
export type { State } from './packages/contract/base/src/index';
export type { Member } from './members';
`,
};

describe('declaration chunks', () => {
  it('allows only the explicitly shared entry surface', async () => {
    const bundle = chunks({
      'index.d.ts': { code: 'export interface Network { magic: number }' },
      'cardano.d.ts': {
        code: "export type * from './index.js';",
        imports: ['index.d.ts'],
      },
    });
    const entries = ['index', 'cardano', 'midnight'];
    await expect(
      generateBundle(assertDeclarationLayout({ entries }), bundle),
    ).rejects.toThrow('cardano.d.ts imports the entry declarations index.d.ts');
    const allowed = assertDeclarationLayout({
      entries,
      allowedEntryImports: { cardano: ['index'] },
    });
    await expect(generateBundle(allowed, bundle)).resolves.toBeUndefined();
    await expect(
      generateBundle(
        allowed,
        chunks({
          'cardano.d.ts': { code: '', imports: ['midnight.d.ts'] },
        }),
      ),
    ).rejects.toThrow(
      'cardano.d.ts imports the entry declarations midnight.d.ts',
    );
  });

  it('flattens an augmentation in the chunk that declares its interface and attaches an entry-only one to that chunk', async () => {
    const directory = fixture(ENTRIES);
    const output = await rollUp(directory, ['first', 'second']);

    const [shared, ...others] = Object.keys(output).filter(file =>
      SHARED_DECLARATIONS.test(file),
    );
    expect(others).toEqual([]);
    expect(output[shared]).toMatch(
      /\/\/ --- Flattened module augmentations ---\ninterface State \{ shared: number \}/,
    );
    expect(output[shared]).toMatch(/^export type \{ Config \};$/m);
    expect(output['second.d.ts']).toContain(
      `declare module './${shared.replace(/\.d\.ts$/, '.js')}' {
    /** Only the second entry's programs have this member. */
    interface State { second: Extra }
    interface Config { timeout: number }
}`,
    );
    expect(output['first.d.ts']).not.toContain('declare module');
    expect(Object.values(output).join('\n')).not.toContain(
      "declare module '@lace-",
    );
  });

  it('exports a namespace member another chunk declares as its imported binding', async () => {
    const directory = fixture(ENTRIES);
    const output = await rollUp(directory, ['first', 'second']);

    expect(output['first.d.ts']).not.toMatch(/typeof Member\b/);
    expect(output['first.d.ts']).toMatch(/\bMember as Member\b/);
  });

  it('keeps a value typed by an imported binding that no namespace of the chunk declares', async () => {
    const code = `import { config } from './shared-0123abcd.js';
declare const default_config: typeof config;
export { config, default_config };
`;

    expect(await renderChunk(namespaceMembersFromOtherChunks, code)).toBe(code);
  });

  it('types a program that loads both entries with every augmentation and namespace member', async () => {
    const directory = fixture(ENTRIES);
    const output = await rollUp(directory, ['first', 'second']);
    const distribution = path.join(directory, 'dist');
    fs.mkdirSync(distribution);
    for (const [file, code] of Object.entries(output)) {
      fs.writeFileSync(path.join(distribution, file), code);
    }
    fs.writeFileSync(
      path.join(distribution, 'package.json'),
      '{ "type": "module" }',
    );
    const consumer = path.join(distribution, 'consumer.ts');
    fs.writeFileSync(
      consumer,
      `
import type { m, Settings, State } from './first.js';
import type {} from './second.js';
export const member: m.Member = { name: 'member' };
export const state: State = { base: '', shared: 1, second: { flag: true } };
export const settings: Settings = { config: { url: '', timeout: 1 } };
`,
    );
    const program = ts.createProgram([consumer], {
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      noEmit: true,
      skipLibCheck: false,
      strict: true,
      types: [],
    });

    expect(
      ts
        .getPreEmitDiagnostics(program)
        .map(({ messageText }) =>
          ts.flattenDiagnosticMessageText(messageText, '\n'),
        ),
    ).toEqual([]);
  });

  it('refuses an entry whose declarations import another entry', async () => {
    const directory = fixture({
      'first.d.ts': 'export interface First { first: string }\n',
      'second.d.ts': "export type { First } from './first';\n",
    });

    await expect(rollUp(directory, ['first', 'second'])).rejects.toThrow(
      'second.d.ts imports the entry declarations first.d.ts',
    );
  });

  it('refuses an augmentation of an interface its target exports under another name', async () => {
    await expect(
      generateBundle(
        assertDeclarationLayout({ entries: ['first'] }),
        chunks({
          'first.d.ts': {
            isEntry: true,
            imports: ['shared-0123abcd.d.ts'],
            code: `declare module './shared-0123abcd.js' {
    interface State { first: string }
}
export {};
`,
          },
          'shared-0123abcd.d.ts': {
            code: 'interface State$1 { base: string }\nexport type { State$1 as State };\n',
          },
        }),
      ),
    ).rejects.toThrow(
      'first.d.ts augments State of ./shared-0123abcd.js, which does not declare and export an interface of that name',
    );
  });

  it('refuses an augmentation whose interface the declaring chunk renamed for another module of the same name', async () => {
    const directory = fixture({
      'package.json': '{ "type": "module" }',
      'packages/lib/ui/src/index.d.ts':
        'export interface State { ui: boolean }\nexport declare const ui: State;\n',
      'packages/contract/base/src/index.d.ts':
        'export interface State { base: string }\n',
      'packages/contract/both/src/augmentations.d.ts': `
declare module '@lace-contract/base' {
    interface State { shared: number }
}
export {};
`,
      ...Object.fromEntries(
        ['first', 'second'].map(entry => [
          `${entry}.d.ts`,
          `
export type { State } from './packages/contract/base/src/index';
import './packages/contract/both/src/augmentations';
export { ui, type State as UiState } from './packages/lib/ui/src/index';
export interface Own { ${entry}: true }
`,
        ]),
      ),
    });

    await expect(rollUp(directory, ['first', 'second'])).rejects.toThrow(
      /augments State, which shared-[\da-f]{8}\.d\.ts declares under another name/,
    );
  });

  it('refuses an augmentation whose interface the declaring chunk renamed', async () => {
    const directory = fixture({
      'packages/contract/base/src/index.d.ts':
        'export interface State { base: string }\n',
    });
    const base = path.join(directory, 'packages/contract/base/src/index.d.ts');

    await expect(
      generateBundle(
        placeModuleAugmentations({
          resolveInternalSpecifier: packageSources(directory),
        }),
        chunks({
          'first.d.ts': {
            isEntry: true,
            code: `declare module '@lace-contract/base' {
    interface State { first: string }
}
export {};
`,
          },
          'shared-0123abcd.d.ts': {
            moduleIds: [base],
            modules: { [base]: { code: 'interface State$1 { base: string }' } },
            code: 'interface State$1 { base: string }\nexport type { State$1 as State };\n',
          },
        }),
      ),
    ).rejects.toThrow(
      'first.d.ts augments State, which shared-0123abcd.d.ts declares under another name',
    );
  });
});

describe('extractLaceAugmentations', () => {
  it('takes nested blocks out as blocks of their own and counts braces outside comments and strings', () => {
    const { kept, blocks } = extractLaceAugmentations(
      `interface Kept {}
declare module '@lace-contract/a' {
    /** An unbalanced \`{\` in prose, and a URL: 'https://example.com/{' */
    interface A { url: 'https://example.com/{' }
    declare module '@lace-lib/b' {
        interface B {}
    }
}
export {};`.split('\n'),
    );

    expect(kept).toEqual(['interface Kept {}', 'export {};']);
    expect(blocks).toEqual([
      {
        specifier: '@lace-contract/a',
        lines: [
          "/** An unbalanced `{` in prose, and a URL: 'https://example.com/{' */",
          "interface A { url: 'https://example.com/{' }",
        ],
      },
      { specifier: '@lace-lib/b', lines: ['interface B {}'] },
    ]);
  });

  it('reads an empty block on one line and refuses declarations on the opening line', () => {
    expect(
      extractLaceAugmentations([
        "declare module '@lace-contract/a' { }",
        'export {};',
      ]),
    ).toEqual({
      kept: ['export {};'],
      blocks: [{ specifier: '@lace-contract/a', lines: [] }],
    });
    expect(() =>
      extractLaceAugmentations([
        "declare module '@lace-contract/a' { interface A { x: 1 } }",
      ]),
    ).toThrow(
      'An augmentation of @lace-contract/a has declarations on its opening line',
    );
  });
});

describe('redirectSdkBarrelReferences', () => {
  /** The build's resolution of a relative specifier's path, without module suffixes. */
  const resolveDtsFile = (file: string) =>
    [`${file}.d.ts`, path.join(file, 'index.d.ts')].find(candidate =>
      fs.existsSync(candidate),
    ) ?? file;
  const toRelative = (fromFile: string, target: string) => {
    const relative = path
      .relative(path.dirname(fromFile), resolveDtsFile(target))
      .replace(/(\/index)?\.d\.ts$/, '');
    return relative.startsWith('.') ? relative : `./${relative}`;
  };
  const redirect = (dtsWork: string) => {
    redirectSdkBarrelReferences({
      dtsWork,
      resolveDtsFile,
      toRelative,
      moduleSuffixes: [''],
    });
  };
  const SDK = {
    'apps/lace-sdk/src/index.d.ts': `
export type { Foo } from '../../../packages/lib/foo/src/foo';
export * as m from './modules';
export interface Own { own: string }
`,
    'apps/lace-sdk/src/modules.d.ts': 'export interface Bar { bar: string }\n',
    'packages/lib/foo/src/foo.d.ts':
      'interface Foo { foo: string }\nexport type { Foo };\n',
  };

  it('points a type named through an SDK barrel at the module that declares it', () => {
    const dtsWork = fixture({
      ...SDK,
      'packages/contract/user/src/index.d.ts':
        'export declare const foo: import("../../../../apps/lace-sdk/src").Foo;\n',
      'apps/lace-sdk/src/user/index.d.ts':
        'export declare const bar: import("../index").m.Bar;\n',
    });
    redirect(dtsWork);

    expect(
      fs.readFileSync(
        path.join(dtsWork, 'packages/contract/user/src/index.d.ts'),
        'utf8',
      ),
    ).toBe(
      'export declare const foo: import("../../../lib/foo/src/foo").Foo;\n',
    );
    expect(
      fs.readFileSync(
        path.join(dtsWork, 'apps/lace-sdk/src/user/index.d.ts'),
        'utf8',
      ),
    ).toBe('export declare const bar: import("../modules").Bar;\n');
  });

  it('throws on a type no module declares', () => {
    const dtsWork = fixture({
      ...SDK,
      'packages/contract/user/src/index.d.ts':
        'export declare const missing: import("../../../../apps/lace-sdk/src").Missing;\n',
    });

    expect(() => {
      redirect(dtsWork);
    }).toThrow(
      'packages/contract/user/src/index.d.ts: import("../../../../apps/lace-sdk/src").Missing',
    );
  });

  it('throws when a file outside the SDK still imports one of its modules', () => {
    const dtsWork = fixture({
      ...SDK,
      'packages/contract/user/src/index.d.ts':
        'export declare const own: import("../../../../apps/lace-sdk/src").Own;\n',
    });

    expect(() => {
      redirect(dtsWork);
    }).toThrow(
      'packages/contract/user/src/index.d.ts imports ../../../../apps/lace-sdk/src',
    );
  });
});
