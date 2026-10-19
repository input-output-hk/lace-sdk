import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  nextRelease,
  nextStableVersion,
  readFamilyExports,
} from '../scripts/next-version';
import {
  readExports,
  type DeclaredExport,
  type ReleaseOverride,
  stableReleaseProblems,
} from '../scripts/release-compat';
import {
  isDependencyFile,
  isShipped,
  pullRequestOf,
  renderNotes,
} from '../scripts/release-scope';
import {
  bumpVersion,
  canaryBaseFloor,
  DEVELOPMENT_VERSION,
  latestRelease,
  nextCanaryNumber,
  parseReleaseTag,
  previousStable,
  promotedVersion,
  readReleaseConfig,
  releaseRecordProblems,
  releasesOf,
  stampVersion,
} from '../scripts/releases.mjs';

const declarations = (source: string) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'next-version-'));
  const file = path.join(directory, 'index.d.ts');
  fs.writeFileSync(file, source);
  return readExports({ index: file });
};

const PREVIOUS = declarations(`
declare function createWallet(name: string): Promise<void>;
/** @deprecated Use createWallet. */
declare function openWallet(name: string): Promise<void>;
export { createWallet, openWallet };
`);

const stableAfter = (previousVersion: string | undefined, next: string) =>
  nextStableVersion({
    previousVersion,
    previous: previousVersion ? PREVIOUS : new Map<string, DeclaredExport>(),
    next: declarations(next),
    overrides: [],
  });

const UNCHANGED = `
declare function createWallet(name: string): Promise<void>;
/** @deprecated Use createWallet. */
declare function openWallet(name: string): Promise<void>;
export { createWallet, openWallet };
`;
const ADDED = `${UNCHANGED}
declare function closeWallet(): void;
export { closeWallet };
`;
const REMOVED_DEPRECATED = `
declare function createWallet(name: string): Promise<void>;
export { createWallet };
`;
const CHANGED = `
declare function createWallet(name: string, network: string): Promise<void>;
/** @deprecated Use createWallet. */
declare function openWallet(name: string): Promise<void>;
export { createWallet, openWallet };
`;

/** Published releases of `names`, each a prerelease when it is a canary. */
const tags = (...names: string[]) =>
  releasesOf(
    names.map(tagName => ({
      tagName,
      isDraft: false,
      isPrerelease: tagName.includes('-canary.'),
    })),
  );

describe('bumpVersion', () => {
  it('starts at 0.1.0', () => {
    expect(bumpVersion(undefined, 'breaking')).toBe('0.1.0');
    expect(bumpVersion(undefined, 'patch')).toBe('0.1.0');
  });

  it('before 1.0, takes the next minor for a breaking change and the next patch otherwise', () => {
    expect(bumpVersion('0.1.3', 'breaking')).toBe('0.2.0');
    expect(bumpVersion('0.1.3', 'feature')).toBe('0.1.4');
    expect(bumpVersion('0.1.3', 'patch')).toBe('0.1.4');
  });

  it('from 1.0, takes the next major, minor or patch', () => {
    expect(bumpVersion('1.4.2', 'breaking')).toBe('2.0.0');
    expect(bumpVersion('1.4.2', 'feature')).toBe('1.5.0');
    expect(bumpVersion('1.4.2', 'patch')).toBe('1.4.3');
  });
});

describe('nextStableVersion', () => {
  it('makes the first release 0.1.0, with every export added', () => {
    const first = stableAfter(undefined, UNCHANGED);
    expect(first).toMatchObject({ version: '0.1.0', bump: 'first' });
    expect(first.added).toEqual(['index:createWallet', 'index:openWallet']);
  });

  it('takes a patch when no export changes', () => {
    expect(stableAfter('0.1.0', UNCHANGED)).toMatchObject({
      version: '0.1.1',
      bump: 'patch',
      breaking: [],
    });
    expect(stableAfter('1.2.0', UNCHANGED).version).toBe('1.2.1');
  });

  it('takes a feature bump for an added export', () => {
    const before = stableAfter('0.1.0', ADDED);
    expect(before).toMatchObject({ version: '0.1.1', bump: 'feature' });
    expect(before.added).toEqual(['index:closeWallet']);
    expect(stableAfter('1.2.3', ADDED).version).toBe('1.3.0');
  });

  it('takes a breaking bump for a removed export', () => {
    const before = stableAfter('0.1.4', REMOVED_DEPRECATED);
    expect(before).toMatchObject({
      version: '0.2.0',
      bump: 'breaking',
      removed: ['index:openWallet'],
      undeprecated: [],
    });
    expect(stableAfter('1.2.3', REMOVED_DEPRECATED).version).toBe('2.0.0');
  });

  it('takes a breaking bump for a changed export, and names it undeprecated', () => {
    const before = stableAfter('0.1.4', CHANGED);
    expect(before).toMatchObject({
      version: '0.2.0',
      bump: 'breaking',
      changed: ['index:createWallet'],
      undeprecated: ['index:createWallet'],
    });
  });

  it('counts a changed export as compatible when an override names the compatible version', () => {
    const declared = nextStableVersion({
      previousVersion: '0.1.4',
      previous: PREVIOUS,
      next: declarations(CHANGED),
      overrides: [
        { version: '0.1.5', export: 'index:createWallet', reason: 'reworded' },
      ],
    });
    expect(declared).toMatchObject({
      version: '0.1.5',
      bump: 'patch',
      compatible: ['index:createWallet'],
      breaking: [],
    });
  });

  it('ignores an override for another version', () => {
    const stale = nextStableVersion({
      previousVersion: '0.1.4',
      previous: PREVIOUS,
      next: declarations(CHANGED),
      overrides: [
        { version: '0.1.2', export: 'index:createWallet', reason: 'reworded' },
      ],
    });
    expect(stale.version).toBe('0.2.0');
  });
});

describe('releases', () => {
  const all = tags(
    'lace-sdk@0.1.0',
    'lace-sdk@0.1.1-canary.0',
    'lace-sdk@0.1.1-canary.1',
    'lace-sdk@0.1.1',
    'lace-sdk@0.2.0-canary.0',
    'lace-extension@2.4.0',
    'lace-sdk@0.10.0',
  );

  it('counts published releases, and refuses one whose prerelease flag disagrees with its tag', () => {
    expect(
      releasesOf([
        { tagName: 'lace-sdk@0.1.0', isDraft: false, isPrerelease: false },
        // A draft is no release, whatever its tag.
        { tagName: 'lace-sdk@0.2.0', isDraft: true, isPrerelease: false },
        {
          tagName: 'lace-sdk@0.1.1-canary.1',
          isDraft: false,
          isPrerelease: true,
        },
        {
          tagName: 'lace-extension@2.4.0',
          isDraft: false,
          isPrerelease: false,
        },
      ]).map(({ tag }) => tag),
    ).toEqual(['lace-sdk@0.1.0', 'lace-sdk@0.1.1-canary.1']);
    // A canary must be a prerelease, and a stable release must not be.
    for (const record of [
      {
        tagName: 'lace-sdk@0.1.1-canary.0',
        isDraft: false,
        isPrerelease: false,
      },
      { tagName: 'lace-sdk@0.1.1', isDraft: false, isPrerelease: true },
    ]) {
      expect(() => releasesOf([record])).toThrow(/disagree with their tags/);
    }
  });

  it('refuses releases and tags that disagree', () => {
    const records = [
      { tagName: 'lace-sdk@0.2.0', isDraft: false, isPrerelease: false },
      {
        tagName: 'lace-sdk@0.3.0-canary.0',
        isDraft: false,
        isPrerelease: true,
      },
      { tagName: 'lace-sdk@0.3.0', isDraft: false, isPrerelease: false },
    ];
    const tags = records.map(({ tagName }) => tagName);
    expect(releaseRecordProblems(records, tags)).toEqual([]);
    const flipped = records.map(record =>
      record.tagName === 'lace-sdk@0.3.0'
        ? { ...record, isPrerelease: true }
        : record,
    );
    expect(releaseRecordProblems(flipped, tags)).toEqual([
      expect.stringContaining(
        "lace-sdk@0.3.0's release is marked as a prerelease",
      ),
    ]);
    const drafted = records.map(record =>
      record.tagName === 'lace-sdk@0.3.0'
        ? { ...record, isDraft: true }
        : record,
    );
    expect(releaseRecordProblems(drafted, tags)).toEqual([
      expect.stringContaining(
        'lace-sdk@0.3.0 is tagged but has no published release',
      ),
    ]);
    expect(releaseRecordProblems(records.slice(0, 2), tags)).toEqual([
      expect.stringContaining('delete the tag'),
    ]);
    expect(releaseRecordProblems(records, tags.slice(0, 2))).toEqual([
      'lace-sdk@0.3.0 has a published release but no tag: restore the tag, or delete the release',
    ]);
    // Other tags, and a draft that was never tagged, are no concern of it.
    expect(
      releaseRecordProblems(
        [
          ...records,
          { tagName: 'lace-sdk@0.4.0', isDraft: true, isPrerelease: false },
        ],
        [...tags, 'lace-extension@2.4.0'],
      ),
    ).toEqual([]);
  });

  it('ignores a tag with no release: only release records count', () => {
    // releasesOf reads the records alone; loadReleases refuses to go on
    // while a tag lacks its release (releaseRecordProblems, below).
    const records = tags('lace-sdk@0.2.0', 'lace-sdk@0.2.1-canary.0');
    expect(previousStable(records)?.tag).toBe('lace-sdk@0.2.0');
    expect(nextCanaryNumber(records, '0.3.0')).toBe(0);
  });

  it('reads only lace-sdk releases, in version order', () => {
    expect(all.map(({ tag }) => tag)).toEqual([
      'lace-sdk@0.1.0',
      'lace-sdk@0.1.1-canary.0',
      'lace-sdk@0.1.1-canary.1',
      'lace-sdk@0.1.1',
      'lace-sdk@0.2.0-canary.0',
      'lace-sdk@0.10.0',
    ]);
    expect(parseReleaseTag('lace-sdk@1.0.0-rc.1')).toBeUndefined();
  });

  it('finds the previous stable release, below a version when given', () => {
    expect(previousStable(all)?.tag).toBe('lace-sdk@0.10.0');
    expect(previousStable(all, { below: '0.2.0' })?.tag).toBe('lace-sdk@0.1.1');
    expect(previousStable(all, { below: '0.1.0' })).toBeUndefined();
    expect(previousStable([])).toBeUndefined();
  });

  it('finds the latest release, canary or stable', () => {
    expect(latestRelease(all)?.tag).toBe('lace-sdk@0.10.0');
    expect(
      latestRelease(tags('lace-sdk@0.1.0', 'lace-sdk@0.1.1-canary.3'))?.tag,
    ).toBe('lace-sdk@0.1.1-canary.3');
  });

  it('numbers the next canary one past the highest of its version', () => {
    expect(nextCanaryNumber(all, '0.1.1')).toBe(2);
    expect(nextCanaryNumber(all, '0.2.0')).toBe(1);
    expect(nextCanaryNumber(all, '0.10.1')).toBe(0);
    expect(
      nextCanaryNumber(
        tags('lace-sdk@0.3.0-canary.9', 'lace-sdk@0.3.0-canary.10'),
        '0.3.0',
      ),
    ).toBe(11);
  });

  it('names a development version main carries', () => {
    expect(DEVELOPMENT_VERSION).toBe('0.0.0-development');
  });
});

describe('nextRelease', () => {
  const history = tags('lace-sdk@0.1.0', 'lace-sdk@0.1.1-canary.0');
  const previous = previousStable(history);

  it('tags a stable release with its version', () => {
    const release = nextRelease({
      channel: 'stable',
      releases: history,
      previous,
      stable: stableAfter('0.1.0', ADDED),
    });
    expect(release).toMatchObject({
      tag: 'lace-sdk@0.1.1',
      previous: 'lace-sdk@0.1.0',
      problems: [],
    });
  });

  it('numbers a canary of the next stable version', () => {
    const release = nextRelease({
      channel: 'canary',
      releases: history,
      previous,
      stable: stableAfter('0.1.0', ADDED),
    });
    expect(release).toMatchObject({
      tag: 'lace-sdk@0.1.1-canary.1',
      base: '0.1.1',
      problems: [],
    });
  });

  it('refuses a version already tagged', () => {
    const release = nextRelease({
      channel: 'stable',
      releases: tags('lace-sdk@0.1.0', 'lace-sdk@0.1.1'),
      previous,
      stable: stableAfter('0.1.0', UNCHANGED),
    });
    expect(release.problems).toEqual([
      expect.stringContaining('lace-sdk@0.1.1 is already released'),
    ]);
  });

  it('refuses a canary before the first stable release', () => {
    const release = nextRelease({
      channel: 'canary',
      releases: [],
      previous: undefined,
      stable: stableAfter(undefined, UNCHANGED),
    });
    expect(release.tag).toBe('lace-sdk@0.1.0-canary.0');
    expect(release.problems).toEqual([
      expect.stringContaining('release a stable version first'),
    ]);
  });

  it('refuses an undeprecated breaking change in stable, and warns in a canary', () => {
    const stable = stableAfter('0.1.0', CHANGED);
    expect(
      nextRelease({ channel: 'stable', releases: history, previous, stable })
        .problems,
    ).toEqual([
      'index:createWallet changes or is removed without being @deprecated in lace-sdk@0.1.0',
    ]);
    const canary = nextRelease({
      channel: 'canary',
      releases: history,
      previous,
      stable,
    });
    expect(canary.problems).toEqual([]);
    expect(canary.warnings).toHaveLength(1);
  });

  it('accepts an expected tag the API diff gives, and refuses another', () => {
    const stable = stableAfter('0.1.0', REMOVED_DEPRECATED);
    const expected = parseReleaseTag('lace-sdk@0.2.0');
    expect(
      nextRelease({
        channel: 'stable',
        releases: [...history, ...tags('lace-sdk@0.2.0')],
        previous,
        stable,
        expect: expected,
      }).problems,
    ).toEqual([]);
    expect(
      nextRelease({
        channel: 'stable',
        releases: history,
        previous,
        stable,
        expect: parseReleaseTag('lace-sdk@0.1.1'),
      }).problems,
    ).toEqual([
      'lace-sdk@0.1.1 is not the version this commit takes: its API diff with lace-sdk@0.1.0 makes it lace-sdk@0.2.0',
    ]);
  });

  it("keeps an expected canary's own number", () => {
    const release = nextRelease({
      channel: 'canary',
      releases: tags(
        'lace-sdk@0.1.0',
        'lace-sdk@0.1.1-canary.0',
        'lace-sdk@0.1.1-canary.1',
      ),
      previous,
      stable: stableAfter('0.1.0', UNCHANGED),
      expect: parseReleaseTag('lace-sdk@0.1.1-canary.0'),
    });
    expect(release).toMatchObject({
      tag: 'lace-sdk@0.1.1-canary.0',
      problems: [],
    });
  });
});

describe('release scope', () => {
  it('reads the pull request of a merge commit or a squash merge', () => {
    expect(
      pullRequestOf({
        subject: 'Merge pull request #1234 from example-org/feat/a-branch',
        body: '\nfeat: add a wallet entry\n',
      }),
    ).toEqual({ number: 1234, title: 'feat: add a wallet entry' });
    expect(
      pullRequestOf({ subject: 'feat: add a wallet (#12)', body: '' }),
    ).toEqual({ number: 12, title: 'feat: add a wallet' });
    expect(pullRequestOf({ subject: 'chore: direct push', body: '' })).toBe(
      undefined,
    );
  });

  it('counts the reached source and the files that decide the output', () => {
    const reached = new Set(['packages/lib/core/src/index.ts']);
    expect(isShipped('packages/lib/core/src/index.ts', reached)).toBe(true);
    expect(isShipped('apps/lace-sdk/src/cardano.ts', reached)).toBe(true);
    expect(isShipped('apps/lace-sdk/package.json', reached)).toBe(true);
    // A build target's command decides what the build runs.
    expect(isShipped('apps/lace-sdk/project.json', reached)).toBe(true);
    expect(isShipped('apps/lace-cardano-ledger/project.json', reached)).toBe(
      true,
    );
    expect(isShipped('apps/lace-sdk/test/channel.mjs', reached)).toBe(false);
    expect(isShipped('apps/lace-sdk/MAINTAINING.md', reached)).toBe(false);
    expect(isShipped('packages/lib/ui/src/button.tsx', reached)).toBe(false);
  });

  it('renders the changes and the API diff', () => {
    expect(
      renderNotes({
        ref: 'lace-sdk@0.1.0',
        changes: [
          { sha: 'a'.repeat(40), number: 12, title: 'feat: add a wallet' },
          { sha: 'b'.repeat(40), title: 'fix: direct' },
        ],
        api: {
          previous: 'lace-sdk@0.1.0',
          bump: 'feature',
          added: ['index:closeWallet'],
          removed: [],
          changed: [],
          compatible: [],
        },
      }),
    ).toBe(
      [
        '## Changes',
        '',
        '- feat: add a wallet (#12)',
        '- fix: direct (bbbbbbbbbbbb)',
        '',
        '## API',
        '',
        'Compared with `lace-sdk@0.1.0`: a feature change.',
        '',
        '- Added: `index:closeWallet`',
        '- Removed: none',
        '- Changed: none',
        '',
      ].join('\n'),
    );
    expect(renderNotes({ ref: undefined, changes: [] })).toBe(
      "## Changes\n\nThe SDK's first release.\n",
    );
  });
});

describe('promotion to a major version (release.json)', () => {
  it('promotes to <major>.0.0 when its major is above the previous release', () => {
    expect(promotedVersion('0.4.2', 1)).toBe('1.0.0');
    expect(promotedVersion(undefined, 1)).toBe('1.0.0');
    expect(promotedVersion('0.4.2', 0)).toBeUndefined();
    expect(promotedVersion('1.3.0', 1)).toBeUndefined();
    expect(promotedVersion('2.0.0', 1)).toBeUndefined();
  });

  it('sets the version whatever the API diff, and keeps the deprecation rule', () => {
    const promoted = nextStableVersion({
      previousVersion: '0.4.2',
      previous: PREVIOUS,
      next: declarations(UNCHANGED),
      overrides: [],
      major: 1,
    });
    expect(promoted).toMatchObject({ version: '1.0.0', bump: 'promotion' });
    const breaking = nextStableVersion({
      previousVersion: '0.4.2',
      previous: PREVIOUS,
      next: declarations(CHANGED),
      overrides: [],
      major: 1,
    });
    expect(breaking).toMatchObject({
      version: '1.0.0',
      bump: 'promotion',
      undeprecated: ['index:createWallet'],
    });
  });

  it('leaves later majors to the API diff', () => {
    expect(
      nextStableVersion({
        previousVersion: '1.2.0',
        previous: PREVIOUS,
        next: declarations(REMOVED_DEPRECATED),
        overrides: [],
        major: 1,
      }).version,
    ).toBe('2.0.0');
  });

  it('reads the major from release.json, 0 without one, and refuses another value', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'release-json-'));
    expect(readReleaseConfig(directory)).toEqual({ major: 0 });
    fs.writeFileSync(path.join(directory, 'release.json'), '{ "major": 1 }');
    expect(readReleaseConfig(directory)).toEqual({ major: 1 });
    fs.writeFileSync(path.join(directory, 'release.json'), '{ "major": "1" }');
    expect(() => readReleaseConfig(directory)).toThrow(/whole number/);
  });
});

describe('the family', () => {
  it('reads every package, the Cardano packages under their names, chunks included', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'family-'));
    const write = (file: string, text: string) => {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), text);
    };
    write(
      'apps/lace-sdk/dist/index.d.ts',
      'declare const sdk: number;\nexport { sdk };\n',
    );
    write(
      'apps/lace-cardano/dist/core-chunk.d.ts',
      'interface Address { bech32: string }\nexport { Address };\n',
    );
    write(
      'apps/lace-cardano/dist/core.d.ts',
      "export { Address } from './core-chunk';\n",
    );
    write(
      'apps/lace-cardano-ledger/dist/index.d.ts',
      'declare const ledger: number;\nexport { ledger };\n',
    );
    const exports = readFamilyExports(root);
    expect([...exports.keys()].sort()).toEqual([
      '@laceio/cardano-ledger/index:ledger',
      '@laceio/cardano/core:Address',
      'index:sdk',
    ]);
    expect(exports.get('@laceio/cardano/core:Address')?.signature).toContain(
      'bech32',
    );
  });
});

describe('stampVersion', () => {
  const tree = (version: string, pin: string) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stamp-'));
    const write = (directory: string, manifest: object) => {
      fs.mkdirSync(path.join(root, directory), { recursive: true });
      fs.writeFileSync(
        path.join(root, directory, 'package.json'),
        JSON.stringify(manifest),
      );
    };
    write('apps/lace-sdk', { name: '@laceio/sdk', version });
    write('apps/lace-cardano', { name: '@laceio/cardano', version });
    for (const device of ['ledger', 'trezor']) {
      write(`apps/lace-cardano-${device}`, {
        name: `@laceio/cardano-${device}`,
        version,
        dependencies: { '@laceio/cardano': pin, other: '^1.0.0' },
      });
    }
    return root;
  };
  const read = (root: string, directory: string) =>
    JSON.parse(
      fs.readFileSync(path.join(root, directory, 'package.json'), 'utf8'),
    ) as { version: string; dependencies?: Record<string, string> };

  it('stamps every package and every pin on the family', () => {
    const root = tree(DEVELOPMENT_VERSION, DEVELOPMENT_VERSION);
    expect(stampVersion(root, '0.2.0-canary.1')).toHaveLength(4);
    expect(read(root, 'apps/lace-sdk').version).toBe('0.2.0-canary.1');
    expect(read(root, 'apps/lace-cardano-ledger').dependencies).toEqual({
      '@laceio/cardano': '0.2.0-canary.1',
      other: '^1.0.0',
    });
  });

  it('refuses a manifest or a pin with a version of its own', () => {
    expect(() =>
      stampVersion(tree('0.1.0', DEVELOPMENT_VERSION), '0.2.0'),
    ).toThrow(/is at 0\.1\.0/);
    expect(() =>
      stampVersion(tree(DEVELOPMENT_VERSION, '0.1.0'), '0.2.0'),
    ).toThrow(/pins @laceio\/cardano 0\.1\.0/);
  });
});

describe('a stable release below a canary', () => {
  // 0.2.0 shipped; a changed export made the nightly canary preview 0.3.0;
  // an override then declared the change compatible, so the stable release
  // is 0.2.1, below that canary.
  const exported = (signature: string) =>
    new Map([['index:f', { key: 'index:f', signature, deprecated: false }]]);
  const before = exported('declare function f(a: string): void;');
  const after = exported('declare function f(a: string, b?: number): void;');
  const published = (...records: [tagName: string, publishedAt: string][]) =>
    releasesOf(
      records.map(([tagName, publishedAt]) => ({
        tagName,
        isDraft: false,
        isPrerelease: tagName.includes('-canary.'),
        publishedAt,
      })),
    );
  const stableAfter020 = (overrides: ReleaseOverride[]) =>
    nextStableVersion({
      previousVersion: '0.2.0',
      previous: before,
      next: after,
      overrides,
    });
  const override = [
    { version: '0.2.1', export: 'index:f', reason: 'an optional parameter' },
  ];

  it('the canary previews the breaking version before the override', () => {
    const history = published(['lace-sdk@0.2.0', '2026-10-01T00:00:00Z']);
    expect(
      nextRelease({
        channel: 'canary',
        releases: history,
        previous: previousStable(history),
        stable: stableAfter020([]),
      }).tag,
    ).toBe('lace-sdk@0.3.0-canary.0');
  });

  it('the stable release takes 0.2.1 below that canary, and later canaries keep previewing 0.3.0', () => {
    const history = published(
      ['lace-sdk@0.2.0', '2026-10-01T00:00:00Z'],
      ['lace-sdk@0.3.0-canary.0', '2026-10-02T00:00:00Z'],
    );
    const stable = nextRelease({
      channel: 'stable',
      releases: history,
      previous: previousStable(history),
      stable: stableAfter020(override),
    });
    expect(stable).toMatchObject({ tag: 'lace-sdk@0.2.1', problems: [] });
    // Before 0.2.1 ships, the next canary does not go back to 0.2.1.
    const canary = nextRelease({
      channel: 'canary',
      releases: history,
      previous: previousStable(history),
      stable: stableAfter020(override),
    });
    expect(canary).toMatchObject({
      tag: 'lace-sdk@0.3.0-canary.1',
      raisedFrom: '0.2.1',
    });
    expect(latestRelease(history)?.tag).toBe('lace-sdk@0.3.0-canary.0');
  });

  it('after 0.2.1, canaries count from it and resume above 0.3.0-canary.0', () => {
    const history = published(
      ['lace-sdk@0.2.0', '2026-10-01T00:00:00Z'],
      ['lace-sdk@0.3.0-canary.0', '2026-10-02T00:00:00Z'],
      ['lace-sdk@0.2.1', '2026-10-03T00:00:00Z'],
    );
    // The canary's changes count from the release published last.
    expect(latestRelease(history)?.tag).toBe('lace-sdk@0.2.1');
    expect(canaryBaseFloor(history)).toBe('0.3.0');
    const canary = nextRelease({
      channel: 'canary',
      releases: history,
      previous: previousStable(history),
      stable: nextStableVersion({
        previousVersion: '0.2.1',
        previous: after,
        next: after,
        overrides: [],
      }),
    });
    expect(canary).toMatchObject({
      tag: 'lace-sdk@0.3.0-canary.1',
      raisedFrom: '0.2.2',
      problems: [],
    });
  });

  it('once 0.3.0 ships, the floor is gone and canaries follow the API diff', () => {
    const history = published(
      ['lace-sdk@0.3.0-canary.1', '2026-10-04T00:00:00Z'],
      ['lace-sdk@0.3.0', '2026-10-05T00:00:00Z'],
    );
    expect(canaryBaseFloor(history)).toBeUndefined();
    expect(
      nextRelease({
        channel: 'canary',
        releases: history,
        previous: previousStable(history),
        stable: nextStableVersion({
          previousVersion: '0.3.0',
          previous: after,
          next: after,
          overrides: [],
        }),
      }).tag,
    ).toBe('lace-sdk@0.3.1-canary.0');
  });
});

describe('dependencies in the release scope', () => {
  it("leaves manifests and the lockfile to the dependency scope, except the family's own", () => {
    const reached = new Set(['packages/lib/core/src/index.ts']);
    expect(isShipped('package-lock.json', reached)).toBe(false);
    expect(isShipped('package.json', reached)).toBe(false);
    expect(isShipped('apps/lace-sdk/package.json', reached)).toBe(true);
    expect(isDependencyFile('package-lock.json')).toBe(true);
    expect(isDependencyFile('packages/lib/core/package.json')).toBe(true);
    expect(isDependencyFile('apps/lace-cardano/package.json')).toBe(false);
    expect(isDependencyFile('apps/lace-sdk/src/index.ts')).toBe(false);
  });

  it('lists dependency updates apart, with their pull requests', () => {
    const notes = renderNotes({
      ref: 'lace-sdk@0.1.0',
      changes: [
        { sha: 'a'.repeat(40), number: 5, title: 'feat: a wallet' },
        {
          sha: 'b'.repeat(40),
          number: 6,
          title: 'chore(deps): bump rxjs',
          dependencies: true,
        },
      ],
    });
    expect(notes).toBe(
      [
        '## Changes',
        '',
        '- feat: a wallet (#5)',
        '',
        '## Dependency updates',
        '',
        '- chore(deps): bump rxjs (#6)',
        '',
      ].join('\n'),
    );
    expect(
      renderNotes({
        ref: 'lace-sdk@0.1.0',
        changes: [
          { sha: 'b'.repeat(40), number: 6, title: 'bump', dependencies: true },
        ],
      }),
    ).toContain('Dependency updates only.');
  });
});

describe('overrides and the canary floor', () => {
  const sig = (signature: string) => ({ key: '', signature, deprecated: true });
  const before = new Map([
    ['index:gone', sig('declare const gone: number;')],
    ['index:f', sig('declare function f(a: string): void;')],
  ]);
  const after = new Map([
    ['index:f', sig('declare function f(a: string, b?: number): void;')],
  ]);

  it('applies an override only to the version the release takes, as the public check does', () => {
    // A deprecated removal makes it 0.2.0, so an override for 0.1.1 is not this release's.
    const stale = nextStableVersion({
      previousVersion: '0.1.0',
      previous: before,
      next: after,
      overrides: [{ version: '0.1.1', export: 'index:f', reason: 'optional' }],
    });
    expect(stale).toMatchObject({
      version: '0.2.0',
      compatible: [],
      breaking: ['index:gone', 'index:f'],
    });
    expect(
      stableReleaseProblems({
        previousVersion: '0.1.0',
        nextVersion: stale.version,
        previous: before,
        next: after,
        overrides: [
          { version: '0.1.1', export: 'index:f', reason: 'optional' },
        ],
      }),
    ).toEqual([]);
    const own = nextStableVersion({
      previousVersion: '0.1.0',
      previous: before,
      next: after,
      overrides: [{ version: '0.2.0', export: 'index:f', reason: 'optional' }],
    });
    expect(own).toMatchObject({
      version: '0.2.0',
      compatible: ['index:f'],
      breaking: ['index:gone'],
    });
  });

  it('never lets the canary being checked raise its own floor', () => {
    const history = tags('lace-sdk@0.1.0', 'lace-sdk@9.0.0-canary.0');
    const release = nextRelease({
      channel: 'canary',
      releases: history,
      previous: previousStable(history),
      expect: parseReleaseTag('lace-sdk@9.0.0-canary.0'),
      stable: stableAfter('0.1.0', UNCHANGED),
    });
    expect(release.problems).toEqual([
      expect.stringContaining(
        'lace-sdk@9.0.0-canary.0 is not the version this commit takes',
      ),
    ]);
  });
});
