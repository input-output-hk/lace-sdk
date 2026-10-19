import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  canaryOnlyIdentifiers,
  exportSurfaceProblems,
  findMarkers,
  identifierPattern,
  readDeclaredExports,
} from '../scripts/export-surface';

import type { DeclaredExports } from '../scripts/export-surface';

/** Writes `files` under a fresh directory and returns the path of `entry` in it. */
const fixture = (files: Record<string, string>, entry = 'index.d.ts') => {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'export-surface-')),
  );
  for (const [name, source] of Object.entries(files)) {
    const file = path.join(directory, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, source);
  }
  return path.join(directory, entry);
};

const declared = (overrides: Partial<DeclaredExports>): DeclaredExports => ({
  values: [],
  types: [],
  unresolvedStars: [],
  ...overrides,
});

describe('readDeclaredExports', () => {
  it('tells value exports from type-only ones', () => {
    const file = fixture({
      'index.d.ts': `
declare class Thrown extends Error {}
declare class Shape {}
declare const make: () => Shape;
type Alias = string;
interface Props { name: string }
export { Thrown, make };
export type { Shape, Alias, Props };
`,
    });

    expect(readDeclaredExports(file)).toEqual({
      values: ['Thrown', 'make'],
      types: ['Alias', 'Props', 'Shape'],
      unresolvedStars: [],
    });
  });

  it('treats a value re-exported through a type-only re-export as a type', () => {
    const file = fixture({
      'index.d.ts': `
export type { Thrown } from './errors';
export { Other } from './errors';
`,
      'errors.d.ts': `
export declare class Thrown extends Error {}
export declare class Other extends Error {}
`,
    });

    expect(readDeclaredExports(file)).toMatchObject({
      values: ['Other'],
      types: ['Thrown'],
    });
  });

  it('counts the names of a star re-export it resolves and reports one it cannot', () => {
    const file = fixture({
      'index.d.ts': `
export * from './local';
export * from 'not-installed-anywhere';
`,
      'local.d.ts': `
export declare const local: number;
export type Local = number;
`,
    });

    expect(readDeclaredExports(file)).toEqual({
      values: ['local'],
      types: ['Local'],
      unresolvedStars: ['not-installed-anywhere'],
    });
  });
});

describe('exportSurfaceProblems', () => {
  it('accepts declarations and outputs that agree, types needing no runtime name', () => {
    expect(
      exportSurfaceProblems({
        entry: 'index',
        declared: declared({ values: ['make'], types: ['Shape'] }),
        runtime: { ESM: ['make'], CommonJS: ['make', 'default'] },
      }),
    ).toEqual([]);
  });

  it('refuses a declared value an output does not export', () => {
    expect(
      exportSurfaceProblems({
        entry: 'index',
        declared: declared({ values: ['make', 'Thrown'] }),
        runtime: { ESM: ['make', 'Thrown'], CommonJS: ['make'] },
      }),
    ).toEqual([
      "index: 'Thrown' is declared as a value but the CommonJS output does not export it",
    ]);
  });

  it('refuses an output name the declarations do not export', () => {
    expect(
      exportSurfaceProblems({
        entry: 'cardano',
        declared: declared({ values: ['make'] }),
        runtime: { ESM: ['make', 'map'] },
      }),
    ).toEqual([
      "cardano: the ESM output exports 'map', which the declarations do not",
    ]);
  });

  it('refuses a star re-export the declarations cannot resolve', () => {
    expect(
      exportSurfaceProblems({
        entry: 'index',
        declared: declared({ unresolvedStars: ['rxjs/operators'] }),
        runtime: { ESM: [] },
      }),
    ).toEqual([
      "index: the declarations re-export everything from 'rxjs/operators', which does not resolve",
    ]);
  });
});

describe('findMarkers', () => {
  it('finds every match in any case, with its line', () => {
    expect(
      findMarkers(
        'const a = 1;\n/** Passport seams */\npassport();',
        /passport/i,
      ),
    ).toEqual([
      '2: Passport in /** Passport seams */',
      '3: passport in passport();',
    ]);
  });

  it('finds nothing in text without the marker', () => {
    expect(findMarkers('createLaceWallet()', /passport/i)).toEqual([]);
  });

  it('skips a line an allowed pattern matches', () => {
    expect(
      findMarkers(
        '  "carbon",\nconst app = "lace-extension-carbon";',
        /carbon/i,
        [/^\s*"carbon",?\s*$/],
      ),
    ).toEqual(['2: carbon in const app = "lace-extension-carbon";']);
  });
});

describe('identifierPattern', () => {
  it('matches the names as whole identifiers only', () => {
    const pattern = identifierPattern(['createCardanoCustodyAccount', '$name']);
    expect(pattern?.test('export { createCardanoCustodyAccount };')).toBe(true);
    expect(pattern?.test('const x = $name;')).toBe(true);
    expect(pattern?.test('createCardanoCustodyAccountEntity()')).toBe(false);
    expect(pattern?.test('my$name')).toBe(false);
  });

  it('is undefined for no name', () => {
    expect(identifierPattern([])).toBeUndefined();
  });
});

describe('canaryOnlyIdentifiers', () => {
  const stable = ['createLaceWallet', 'm', 'm.blockchainCardano'];
  const canary = [
    ...stable,
    'deriveSymmetricSecret',
    'm.createPasskeySessionKeySource',
  ];

  it('names a canary-only namespace member by its member identifier', () => {
    expect(canaryOnlyIdentifiers({ stable, canary })).toEqual([
      'createPasskeySessionKeySource',
      'deriveSymmetricSecret',
    ]);
  });

  it('finds a canary-only namespace member in stable output', () => {
    const pattern = identifierPattern(
      canaryOnlyIdentifiers({ stable, canary }),
    );

    expect(
      findMarkers(
        'const source = m.createPasskeySessionKeySource();',
        pattern!,
      ),
    ).toEqual([
      '1: createPasskeySessionKeySource in const source = m.createPasskeySessionKeySource();',
    ]);
  });

  it('leaves out identifiers the stable build exports and the allowed ones', () => {
    expect(
      canaryOnlyIdentifiers({
        stable: ['createLaceWallet', 'm', 'm.blockchainCardano'],
        canary: [
          'createLaceWallet',
          'm',
          'm.blockchainCardano',
          'passport.createLaceWallet',
          'Selectors',
        ],
        allowed: new Set(['Selectors']),
      }),
    ).toEqual([]);
  });
});
