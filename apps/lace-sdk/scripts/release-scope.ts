// Whether a change reaches what the SDK's family ships, and the release notes
// of the pull requests that did, from this repository's history alone. What
// the family ships is the source the SDK's two builds and the Cardano
// packages reach (scripts/reach.mjs, which the declaration build and the
// standalone repository's generator share), the third-party packages those
// builds bundle or the packages depend on, as the lockfile resolves them
// (dependency-scope.ts), and the files of each package that decide its
// output.
//
//   node scripts/release-scope.ts changed [<ref>]                 JSON: { ref, ships, files }
//   node scripts/release-scope.ts notes [<ref>] [--api <json>] [--first-canary] [--out <file>]
//   node scripts/release-scope.ts public-notes [<ref>] --api <json> [--out <file>]
//   node scripts/release-scope.ts fragment-check <base>             exits 1 without a fragment
//
// `changed` says whether anything the SDK ships differs between <ref> (the
// previous release's tag) and HEAD. `notes` lists the pull requests merged
// into HEAD since <ref> whose own change reached it, with the API diff from
// scripts/next-version.ts when given, as Markdown: the private release's
// notes. `public-notes` writes the public ones from next-version.ts's result
// alone: the version, the API section and where the docs and packages are,
// with no pull request, commit or SHA. Without <ref>, before the
// first release of the channel, everything ships and the notes name the
// first release; the first canary's notes take the latest stable release as
// <ref> with --first-canary, and list the changes since it. Both notes open
// with the changelog fragments added since <ref> (FRAGMENT_DIRECTORY), the
// users' account of the release. `fragment-check` fails a pull request into
// <base> that changes what the family ships and adds no fragment, nor edits
// one no release holds yet, or whose fragments name an internal term.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { parse as parseYaml } from 'yaml';

import {
  binaryOwners,
  buildTargetOf,
  buildTargetSeeds,
  importsOf,
  manifestBuildChanges,
  type ProjectJson,
  type Lockfile,
  lockSignature,
  packageOfSpecifier,
  type Seed,
  signatureChanges,
} from './dependency-scope.ts';
import {
  CARDANO_APPS,
  cardanoReachedFiles,
  channelEntries,
  compilerOptions,
  packageDirectory,
  reachedWorkspaceFiles,
} from './reach.mjs';
import { internalTermFindings } from './release-notes-check.ts';
import { TAG_PREFIX } from './releases.mjs';

const repositoryRoot = path.resolve(packageDirectory, '../..');

/**
 * The files of the family's packages, and of the workspace, that decide the
 * published output beside the source the builds reach: the bundler and
 * declaration configuration, the build and pack scripts, the manifests, the
 * README, licence and notice each tarball carries, and release.json, whose
 * major sets the version. Tests, docs and the release tooling itself are left
 * out.
 */
export const SHIPPING_PATHS: readonly string[] = [
  'apps/lace-sdk/src/',
  'apps/lace-sdk/package.json',
  // The build target's command decides what the build runs.
  'apps/lace-sdk/project.json',
  'apps/lace-sdk/release.json',
  'apps/lace-sdk/README.md',
  'apps/lace-sdk/tsdown.config.ts',
  'apps/lace-sdk/rollup.dts.config.mjs',
  'apps/lace-sdk/tsconfig.json',
  'apps/lace-sdk/tsconfig.build.json',
  'apps/lace-sdk/tsconfig.dts-bundle.json',
  'apps/lace-sdk/tsconfig.dts-gen.json',
  'apps/lace-sdk/scripts/build.sh',
  'apps/lace-sdk/scripts/dts-gen-config.mjs',
  'apps/lace-sdk/scripts/entries.mjs',
  'apps/lace-sdk/scripts/pack.mjs',
  'apps/lace-sdk/scripts/reach.mjs',
  ...CARDANO_APPS.flatMap(app => [
    `${app}/src/`,
    `${app}/scripts/build.sh`,
    `${app}/package.json`,
    `${app}/project.json`,
    `${app}/README.md`,
    `${app}/LICENSE`,
    `${app}/NOTICE`,
    `${app}/tsdown.config.ts`,
    `${app}/tsconfig.json`,
    `${app}/tsconfig.dts.json`,
  ]),
  'tsconfig.base.json',
];

/**
 * A manifest or lockfile outside the family's own packages: a change to one
 * ships only through the dependencies it resolves (dependency-scope.ts).
 */
export const isDependencyFile = (file: string) =>
  /(^|\/)(package\.json|package-lock\.json)$/.test(file) &&
  !SHIPPING_PATHS.includes(file);

/** A change the release notes name: a pull request, or a commit pushed directly. */
export interface ShippedChange {
  sha: string;
  number?: number;
  title: string;
  /** Whether the change reached what ships through manifests and lockfiles alone. */
  dependencies?: boolean;
}

/** The part of scripts/next-version.ts's result the notes show. */
export interface NotesApi {
  /** The release's tag, version and channel, for the public notes. */
  tag?: string;
  version?: string;
  channel?: string;
  previous: string | null;
  bump: string;
  added: readonly string[];
  removed: readonly string[];
  changed: readonly string[];
  compatible: readonly string[];
  /** The stable version a canary previews. */
  base?: string;
  /** A canary's own changes: its canary build against `canary.previous`'s. */
  canary?: {
    previous: string;
    added: readonly string[];
    removed: readonly string[];
    changed: readonly string[];
  };
}

/** Whether `file` (repository-relative) is part of what the SDK ships. */
export const isShipped = (file: string, reached: ReadonlySet<string>) =>
  reached.has(file) ||
  SHIPPING_PATHS.some(entry =>
    entry.endsWith('/') ? file.startsWith(entry) : file === entry,
  );

/**
 * The workspace source the SDK's two builds and the Cardano packages reach,
 * repository-relative.
 */
export const reachedFiles = (): Set<string> =>
  new Set(
    [
      ...(['stable', 'canary'] as const).flatMap(channel =>
        reachedWorkspaceFiles(
          channelEntries(channel),
          compilerOptions(channel),
        ),
      ),
      ...cardanoReachedFiles(),
    ].map(file =>
      path.relative(repositoryRoot, file).split(path.sep).join('/'),
    ),
  );

/** The family's own packages: their manifests are part of what ships. */
const FAMILY_APPS = ['apps/lace-sdk', ...CARDANO_APPS];

/**
 * The third-party packages the family's builds reach, as seeds to resolve in
 * a lockfile: each module the reached source and the family's own source
 * import, from the package directory that imports it, and what the family's
 * manifests at `ref` declare.
 */
const dependencySeeds = (ref: string, reached: ReadonlySet<string>): Seed[] => {
  const ownSources = FAMILY_APPS.flatMap(app =>
    fs
      .readdirSync(path.join(repositoryRoot, app, 'src'), { recursive: true })
      .map(file => `${app}/src/${String(file).split(path.sep).join('/')}`),
  );
  const seeds: Seed[] = [];
  for (const file of new Set([...reached, ...ownSources])) {
    if (!/\.[cm]?[jt]sx?$/.test(file)) continue;
    const absolute = path.join(repositoryRoot, file);
    if (!fs.existsSync(absolute)) continue;
    const from =
      /^(packages\/[^/]+\/[^/]+|apps\/[^/]+)\//.exec(file)?.[1] ?? '';
    for (const specifier of importsOf(fs.readFileSync(absolute, 'utf8'))) {
      const name = packageOfSpecifier(specifier);
      if (name) seeds.push({ from, name });
    }
  }
  // The tools the build targets run from the root install, and what the
  // scripts and configuration they load import.
  seeds.push(
    ...buildToolSeeds(
      ref,
      readAt<Lockfile>(ref, 'package-lock.json') ?? { packages: {} },
    ),
  );
  for (const app of FAMILY_APPS) {
    const manifest = readAt<Record<string, Record<string, string>>>(
      ref,
      `${app}/package.json`,
    );
    for (const field of [
      'dependencies',
      'peerDependencies',
      'devDependencies',
    ]) {
      for (const name of Object.keys(manifest?.[field] ?? {})) {
        seeds.push({ from: app, name });
      }
    }
  }
  return seeds;
};

/** A file's text at `ref`, or undefined when `ref` has no such file. */
const textAt = (ref: string, file: string): string | undefined => {
  try {
    return execFileSync('git', ['show', `${ref}:${file}`], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch {
    return undefined;
  }
};

/** The names of the files directly in `directory` at `ref`. */
const filesAt = (ref: string, directory: string): string[] => {
  try {
    return execFileSync(
      'git',
      ['ls-tree', '--name-only', `${ref}:${directory}`],
      {
        cwd: repositoryRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    )
      .split('\n')
      .filter(Boolean);
  } catch {
    return [];
  }
};

/**
 * The seeds of what the family's build targets run from the root install
 * (dependency-scope.ts buildTargetSeeds), read at `ref` with the lockfile of
 * the same commit: its project.json files, the scripts they run and the
 * tools' configuration, so both sides of a comparison are consistent and a
 * change to the build itself is compared like any other. A family app that
 * `ref` does not have yet builds nothing there.
 */
const buildToolSeeds = (ref: string, lock: Lockfile): Seed[] => {
  const owners = binaryOwners(lock);
  const read = (file: string) => textAt(ref, file);
  return FAMILY_APPS.flatMap(app => {
    const project = read(`${app}/project.json`);
    if (project === undefined) return [];
    return buildTargetSeeds({
      target: buildTargetOf(app, JSON.parse(project) as ProjectJson),
      read,
      configs: filesAt(ref, app).filter(file =>
        /\.config\.[cm]?[jt]s$/.test(file),
      ),
      owners,
      hasPackage: name => Boolean(lock.packages[`node_modules/${name}`]),
    });
  });
};

const readAt = <T>(ref: string, file: string): T | undefined => {
  try {
    return JSON.parse(
      execFileSync('git', ['show', `${ref}:${file}`], {
        cwd: repositoryRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: 256 * 1024 * 1024,
      }),
    ) as T;
  } catch {
    return undefined;
  }
};

const signatureAt = (ref: string, reached: ReadonlySet<string>) =>
  lockSignature(
    readAt<Lockfile>(ref, 'package-lock.json') ?? { packages: {} },
    dependencySeeds(ref, reached),
    readAt<{ overrides?: Record<string, unknown> }>(ref, 'package.json')
      ?.overrides,
  );

/**
 * The third-party packages whose resolved entries, or the root overrides
 * that name them, differ between two commits, among those the family's
 * builds reach.
 */
export const dependencyChanges = (
  from: string,
  to: string,
  reached: ReadonlySet<string> = reachedFiles(),
): string[] =>
  signatureChanges(signatureAt(from, reached), signatureAt(to, reached));

/**
 * The pull request a commit on the first-parent history merged: GitHub's
 * merge commit (`Merge pull request #N from …`, the title in its body) or a
 * squash merge (`Title (#N)`). Undefined for a commit pushed directly.
 */
export const pullRequestOf = ({
  subject,
  body,
}: {
  subject: string;
  body: string;
}): { number: number; title: string } | undefined => {
  const merge = /^Merge pull request #(\d+) from \S+/.exec(subject);
  if (merge) {
    const title = body
      .split('\n')
      .map(line => line.trim())
      .find(Boolean);
    return { number: Number(merge[1]), title: title ?? subject };
  }
  const squash = /^(.*\S)\s+\(#(\d+)\)$/.exec(subject);
  return squash ? { number: Number(squash[2]), title: squash[1] } : undefined;
};

type Manifest = Record<string, unknown>;

/**
 * The manifests of the workspace packages the family's builds reach, among
 * `files`, whose build fields differ between two readings, each with the
 * fields that changed: an `exports` entry redirecting a reached subpath, or
 * `sideEffects`, changes what bundles while every reached source file and
 * lock entry stays the same.
 */
export const workspaceManifestChanges = ({
  files,
  reached,
  before,
  after,
}: {
  files: readonly string[];
  reached: ReadonlySet<string>;
  before: (file: string) => Manifest | undefined;
  after: (file: string) => Manifest | undefined;
}): string[] => {
  const packages = new Set(
    [...reached].flatMap(
      file => /^(packages\/[^/]+\/[^/]+|apps\/[^/]+)\//.exec(file)?.[1] ?? [],
    ),
  );
  return files
    .filter(file => {
      const directory = path.posix.dirname(file);
      return (
        file.endsWith('/package.json') &&
        packages.has(directory) &&
        !FAMILY_APPS.includes(directory)
      );
    })
    .flatMap(file => {
      const fields = manifestBuildChanges(before(file), after(file));
      return fields.length > 0 ? [`${file} (${fields.join(', ')})`] : [];
    });
};

const git = (args: string[], cwd = repositoryRoot, input?: string): string =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    input,
    maxBuffer: 256 * 1024 * 1024,
  });

const changedFiles = (from: string, to: string): string[] =>
  git(['diff', '--name-only', '--no-renames', from, to, '--'])
    .split('\n')
    .filter(Boolean);

/** The shipped files that differ between `ref` and HEAD. */
export const shippedChanges = (
  ref: string,
  reached: ReadonlySet<string> = reachedFiles(),
): string[] => {
  const files = changedFiles(ref, 'HEAD');
  return [
    ...files.filter(file => isShipped(file, reached)),
    ...workspaceManifestChanges({
      files,
      reached,
      before: file => readAt<Manifest>(ref, file),
      after: file => readAt<Manifest>('HEAD', file),
    }).map(entry => `manifest: ${entry}`),
    ...(files.some(isDependencyFile)
      ? dependencyChanges(ref, 'HEAD', reached).map(
          entry => `dependency: ${entry}`,
        )
      : []),
  ];
};

/**
 * The commits on HEAD's first-parent history since `ref`, each with the
 * files it changed against its first parent: one per merged pull request.
 */
const firstParentCommits = (ref: string) =>
  git(['log', '--first-parent', '--format=%H%x1f%s%x1f%b%x1e', `${ref}..HEAD`])
    .split('\x1e')
    .map(record => record.replace(/^\n/, ''))
    .filter(Boolean)
    .map(record => {
      const [sha = '', subject = '', body = ''] = record.split('\x1f');
      const parent = git(['rev-list', '--parents', '-n', '1', sha])
        .trim()
        .split(' ')[1];
      return {
        sha,
        subject,
        body,
        parent,
        files: parent
          ? changedFiles(parent, sha)
          : git(['show', '--name-only', '--format=', sha])
              .split('\n')
              .filter(Boolean),
      };
    })
    .reverse();

/**
 * A ticket of the internal tracker, as titles write it: `LW-123`, `LW 123`,
 * `LW_123`, `LW123`, or with `lace` for `LW`.
 */
const TICKET = '(?:lw|lace)[\\s_-]?\\d{3,}';

/**
 * A pull request's title as the public notes carry it: the ticket references
 * this repository's titles carry (`[LW-123]`, `LW-123:`, a `(lw-123)` scope)
 * name an internal tracker, so they are dropped.
 */
export const cleanTitle = (title: string): string =>
  title
    // A title made from a branch name: `Feat/<ticket> …`.
    .replace(
      /^(?:feat|fix|chore|refactor|docs|test|ci|build|perf)\/(?=\S)/i,
      '',
    )
    .replaceAll(new RegExp(`\\s*\\[${TICKET}\\]`, 'gi'), '')
    .replaceAll(new RegExp(`\\(${TICKET}\\)`, 'gi'), '')
    .replaceAll(new RegExp(`\\b${TICKET}\\b[:/]?\\s*`, 'gi'), '')
    .replaceAll(/\s{2,}/g, ' ')
    .trim();

/**
 * The pull request's title as GitHub holds it now, when RELEASE_NOTES_TITLES
 * is `github`: a title a release manager edits on GitHub, to take an internal
 * term out of the notes, is what the next run writes. Undefined otherwise,
 * or when the API does not answer, and the merge commit's title stands.
 */
const titleFromGitHub = (pull: number): string | undefined => {
  if (process.env.RELEASE_NOTES_TITLES !== 'github') return undefined;
  try {
    return (
      execFileSync(
        'gh',
        [
          'api',
          `/repos/${process.env.GITHUB_REPOSITORY}/pulls/${pull}`,
          '--jq',
          '.title',
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      ).trim() || undefined
    );
  } catch {
    return undefined;
  }
};

/**
 * The family's changelog fragments, which changie writes (`.changie.yaml`
 * beside them): one file per user-facing change, with its kind. A release
 * commits nothing back, so it deletes no fragment: a release's notes take the
 * fragments added since the release its changes count from, and the monthly
 * sweep (sdk-changelog-sweep.yml) deletes those both channels have released.
 */
export const FRAGMENT_DIRECTORY = 'apps/lace-sdk/.changes/fragments';

/** The fragment kinds, Keep a Changelog's, in the order the notes list them. */
export const FRAGMENT_KINDS = [
  'Added',
  'Changed',
  'Deprecated',
  'Removed',
  'Fixed',
  'Security',
] as const;

export interface Fragment {
  /** The fragment's path, repository-relative. */
  file: string;
  kind: (typeof FRAGMENT_KINDS)[number];
  body: string;
  /**
   * The build the change is in: `canary` for a feature only the canary build
   * has, which a stable release's notes leave out.
   */
  build: 'canary' | 'stable';
  /** When changie wrote it, which orders fragments of one kind. */
  time: string;
}

/** A fragment's YAML, read strictly: a known kind, a body and its build. */
export const parseFragment = (file: string, text: string): Fragment => {
  const value: unknown = parseYaml(text);
  const record = (value ?? {}) as Record<string, unknown>;
  const kind = FRAGMENT_KINDS.find(known => known === record.kind);
  const body = typeof record.body === 'string' ? record.body.trim() : '';
  if (!kind) {
    throw new Error(
      `${file}: kind must be one of ${FRAGMENT_KINDS.join(', ')}, not ${String(
        record.kind,
      )}`,
    );
  }
  if (!body) throw new Error(`${file}: the fragment has no body`);
  const custom = (record.custom ?? {}) as Record<string, unknown>;
  const build = custom.Build;
  if (build !== 'stable' && build !== 'canary') {
    throw new Error(
      `${file}: custom.Build must be stable or canary, not ${String(build)}`,
    );
  }
  const time =
    record.time instanceof Date
      ? record.time.toISOString()
      : typeof record.time === 'string' || typeof record.time === 'number'
      ? String(record.time)
      : '';
  return { file, kind, body, build, time };
};

/** The fragment files that differ between `ref` and HEAD as `filter` selects. */
const fragmentFilesSince = (ref: string, filter: 'A' | 'M', root: string) =>
  git(
    [
      'diff',
      '--name-only',
      '--no-renames',
      `--diff-filter=${filter}`,
      ref,
      'HEAD',
      '--',
      FRAGMENT_DIRECTORY,
    ],
    root,
  )
    .split('\n')
    .filter(file => file.endsWith('.yaml'));

const fragmentAtHead = (file: string, root: string) =>
  parseFragment(file, git(['show', `HEAD:${file}`], root));

/**
 * The fragments added since `ref` that HEAD holds, or every fragment before
 * the first release.
 */
export const fragmentsSince = (
  ref: string | undefined,
  root = repositoryRoot,
): Fragment[] =>
  (ref
    ? fragmentFilesSince(ref, 'A', root)
    : git(['ls-files', '--', FRAGMENT_DIRECTORY], root)
        .split('\n')
        .filter(file => file.endsWith('.yaml'))
  ).map(file => fragmentAtHead(file, root));

/**
 * Those of `files` that a `lace-sdk@` tag's tree holds. A tag counts whether
 * or not its release was published: the check needs only git, and treating a
 * draft as released asks for a new fragment where an edit would have done.
 */
const releasedFragmentFiles = (
  files: readonly string[],
  root: string,
): Set<string> => {
  const tags = git(
    ['for-each-ref', '--format=%(refname)', `refs/tags/${TAG_PREFIX}*`],
    root,
  )
    .split('\n')
    .filter(Boolean);
  if (files.length === 0 || tags.length === 0) return new Set();
  const answers = git(
    ['cat-file', '--batch-check'],
    root,
    tags.flatMap(tag => files.map(file => `${tag}:${file}\n`)).join(''),
  ).split('\n');
  return new Set(
    files.filter((_, index) =>
      tags.some(
        (_, tag) => !answers[tag * files.length + index]?.endsWith(' missing'),
      ),
    ),
  );
};

/**
 * The fragments a pull request into `base` adds or edits, and which of the
 * edited ones a release already holds. A release lists only the fragments
 * added since the release before it of its channel, so an edit to a fragment
 * a release holds reaches no later release's notes: the change it describes
 * needs a fragment of its own.
 */
export const pullRequestFragments = (
  base: string,
  root = repositoryRoot,
): { fragments: Fragment[]; released: string[] } => {
  const edited = fragmentFilesSince(base, 'M', root);
  const held = releasedFragmentFiles(edited, root);
  return {
    fragments: [...fragmentFilesSince(base, 'A', root), ...edited].map(file =>
      fragmentAtHead(file, root),
    ),
    released: edited.filter(file => held.has(file)),
  };
};

/** A fragment's entry: its body as a list item, continued lines indented. */
const fragmentItem = (fragment: Fragment) =>
  `- ${fragment.body.split('\n').join('\n  ')}`;

/**
 * The fragments a release of `channel` lists: a stable release leaves out
 * changes only the canary build has.
 */
const releasedFragments = (
  fragments: readonly Fragment[],
  channel: string | undefined,
) =>
  channel === 'stable'
    ? fragments.filter(fragment => fragment.build === 'stable')
    : fragments;

/** The fragments by kind, in Keep a Changelog's order, oldest first. */
const fragmentLines = (fragments: readonly Fragment[]): string[] =>
  FRAGMENT_KINDS.flatMap(kind => {
    const ofKind = fragments
      .filter(fragment => fragment.kind === kind)
      .sort(
        (a, b) => a.time.localeCompare(b.time) || a.file.localeCompare(b.file),
      );
    return ofKind.length > 0
      ? [`### ${kind}`, '', ...ofKind.map(fragmentItem), '']
      : [];
  });

/**
 * A pull request's fragment problems: a change to what the family ships that
 * adds no fragment, nor edits one no release holds yet, and any fragment it
 * touches naming an internal term, which the public notes' leak-check would
 * refuse at release.
 */
export const fragmentProblems = ({
  shipped,
  fragments,
  released = [],
}: {
  shipped: readonly string[];
  /** The fragments the pull request adds or edits. */
  fragments: readonly Fragment[];
  /** The edited fragments a release already holds, which count for nothing. */
  released?: readonly string[];
}): string[] => [
  ...(shipped.length > 0 &&
  fragments.every(fragment => released.includes(fragment.file))
    ? [
        `This change reaches what the SDK family ships (${shipped
          .slice(0, 5)
          .join(', ')}${shipped.length > 5 ? ', …' : ''}) and adds ${
          released.length > 0
            ? `no changelog fragment: a release already holds ${released.join(
                ', ',
              )}, so an edit to it reaches no later release's notes`
            : 'or edits no changelog fragment'
        }. From apps/lace-sdk, run \`npx changie new\` and describe the change for the SDK's users, edit an unreleased fragment already describing it, or label the pull request \`skip-changelog\` when they would not notice it.`,
      ]
    : []),
  ...fragments.flatMap(fragment =>
    internalTermFindings(fragment.body).map(
      finding =>
        `${fragment.file} names an internal term (${finding}); the public release notes publish the fragment as written.`,
    ),
  ),
];

const exportList = (keys: readonly string[]) =>
  keys.length > 0 ? keys.map(key => `\`${key}\``).join(', ') : 'none';

/**
 * The API section's body. A canary describes what it changed, its canary
 * build against the one its changes count from, and names the stable version
 * it previews; the stable diff alone would miss its canary-only surface.
 */
const apiLines = (api: NotesApi): string[] => {
  if (api.channel === 'canary' && api.canary) {
    const { canary } = api;
    return [
      `The canary build, compared with \`${canary.previous}\`'s:`,
      '',
      `- Added: ${exportList(canary.added)}`,
      `- Removed: ${exportList(canary.removed)}`,
      `- Changed: ${exportList(canary.changed)}`,
      ...(api.previous && api.base
        ? [
            '',
            `It previews \`${api.base}\`: the stable API takes a ${api.bump} change since \`${api.previous}\`.`,
          ]
        : []),
    ];
  }
  if (!api.previous) {
    return [`The first release, with ${api.added.length} stable exports.`];
  }
  return [
    `Compared with \`${api.previous}\`: a ${api.bump} change.`,
    '',
    `- Added: ${exportList(api.added)}`,
    `- Removed: ${exportList(api.removed)}`,
    `- Changed: ${exportList(api.changed)}`,
    ...(api.compatible.length > 0
      ? [`- Declared compatible: ${exportList(api.compatible)}`]
      : []),
  ];
};

/**
 * The release notes: the pull requests (or direct commits) whose change
 * reached what the SDK ships, oldest first, then the API diff.
 */
export const renderNotes = ({
  ref,
  changes,
  api,
  fragments = [],
  firstCanary = false,
}: {
  ref: string | undefined;
  changes: readonly ShippedChange[];
  api?: NotesApi;
  /** The changelog fragments added since `ref`. */
  fragments?: readonly Fragment[];
  /** The first canary, whose changes count from the latest stable `ref`. */
  firstCanary?: boolean;
}): string => {
  const released = releasedFragments(fragments, api?.channel);
  const lines =
    released.length > 0
      ? ["## What's new", '', ...fragmentLines(released), '## Changes', '']
      : ['## Changes', ''];
  const item = (change: ShippedChange) =>
    change.number === undefined
      ? `- ${change.title} (${change.sha.slice(0, 12)})`
      : `- ${change.title} (#${change.number})`;
  const code = changes.filter(change => !change.dependencies);
  const dependencies = changes.filter(change => change.dependencies);
  if (ref === undefined) {
    lines.push("The SDK's first release.");
  } else if (firstCanary) {
    lines.push(
      `The SDK's first canary, with the changes since \`${ref}\`${
        changes.length === 0 ? ': none, beyond the canary features' : ':'
      }`,
    );
  } else if (changes.length === 0) {
    lines.push(`No change to what the SDK ships since \`${ref}\`.`);
  } else if (code.length === 0) {
    lines.push('Dependency updates only.');
  }
  lines.push(...code.map(item));
  if (dependencies.length > 0) {
    lines.push('', '## Dependency updates', '', ...dependencies.map(item));
  }
  if (api) {
    lines.push('', '## API', '', ...apiLines(api));
  }
  return lines.join('\n') + '\n';
};

/** The packages each release carries, in lockstep, at its version. */
const RELEASED_PACKAGES = [
  '@laceio/sdk',
  '@laceio/cardano',
  '@laceio/cardano-ledger',
  '@laceio/cardano-trezor',
];

/**
 * The public notes of a release: its version, the API section, and where its
 * docs and packages are. They name no pull request, commit or SHA: the
 * release reaches the public repository as one commit with none of this
 * repository's history, so its notes describe the published API alone, and
 * the list of pull requests stays in the private release (renderNotes).
 */
export const renderPublicNotes = (
  api: NotesApi,
  fragments: readonly Fragment[] = [],
): string => {
  const version = api.version ?? '';
  const isCanary = api.channel === 'canary';
  const released = releasedFragments(fragments, api.channel);
  const docs = isCanary
    ? 'https://sdk.lace.io/canary/'
    : `https://sdk.lace.io/v/${version}/`;
  const lines = [
    `## ${api.tag ?? `lace-sdk@${version}`}`,
    '',
    isCanary
      ? `A canary release, previewing the next stable version: install it as \`@canary\` or \`@${version}\`.`
      : 'A stable release.',
    '',
    ...(released.length > 0
      ? ["## What's new", '', ...fragmentLines(released)]
      : []),
    '## API',
    '',
  ];
  if (api.bump === 'promotion') {
    lines.push(
      `The packages are promoted to \`${version.replace(/-.*/, '')}\`.`,
      '',
    );
  }
  lines.push(
    ...apiLines(api),
    '',
    '## Packages',
    '',
    ...RELEASED_PACKAGES.map(
      name =>
        `- [\`${name}@${version}\`](https://www.npmjs.com/package/${name}/v/${version})`,
    ),
    '',
    `Docs: ${docs}`,
  );
  return lines.join('\n') + '\n';
};

/** The changes since `ref` that reached what the SDK ships. */
export const shippedPullRequests = (
  ref: string,
  reached: ReadonlySet<string> = reachedFiles(),
): ShippedChange[] =>
  firstParentCommits(ref)
    .map(commit => {
      const { parent } = commit;
      // A reached workspace package's manifest ships like its source.
      const code = [
        ...commit.files.filter(file => isShipped(file, reached)),
        ...(parent
          ? workspaceManifestChanges({
              files: commit.files,
              reached,
              before: file => readAt<Manifest>(parent, file),
              after: file => readAt<Manifest>(commit.sha, file),
            })
          : []),
      ];
      const dependencies =
        code.length === 0 &&
        commit.parent &&
        commit.files.some(isDependencyFile)
          ? dependencyChanges(commit.parent, commit.sha, reached)
          : [];
      return { commit, code, dependencies };
    })
    .filter(({ code, dependencies }) => code.length + dependencies.length > 0)
    .map(({ commit, code }) => {
      const pull = pullRequestOf(commit);
      return {
        sha: commit.sha,
        ...(pull ?? {}),
        title: cleanTitle(
          (pull && titleFromGitHub(pull.number)) ??
            pull?.title ??
            commit.subject,
        ),
        ...(code.length === 0 && { dependencies: true }),
      };
    });

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      api: { type: 'string' },
      out: { type: 'string' },
      'first-canary': { type: 'boolean' },
    },
  });
  const [command, ref] = positionals;
  const readApi = () =>
    values.api
      ? (JSON.parse(fs.readFileSync(values.api, 'utf8')) as NotesApi)
      : undefined;
  if (
    !['changed', 'notes', 'public-notes', 'fragment-check'].includes(
      command ?? '',
    ) ||
    (command === 'public-notes' && !values.api) ||
    (command === 'fragment-check' && !ref)
  ) {
    // eslint-disable-next-line no-console -- usage
    console.error(
      'usage: node scripts/release-scope.ts changed [<ref>] | notes [<ref>] [--api <json>] [--first-canary] [--out <file>] | public-notes [<ref>] --api <json> [--out <file>] | fragment-check <base>',
    );
    process.exit(2);
  }
  if (command === 'fragment-check') {
    const problems = fragmentProblems({
      shipped: shippedChanges(ref ?? ''),
      ...pullRequestFragments(ref ?? ''),
    });
    for (const problem of problems) {
      // eslint-disable-next-line no-console -- the check's verdict
      console.error(`::error::${problem}`);
    }
    process.exit(problems.length > 0 ? 1 : 0);
  }
  const publicApi = command === 'public-notes' ? readApi() : undefined;
  const result = publicApi
    ? renderPublicNotes(publicApi, fragmentsSince(ref))
    : command === 'changed'
    ? (() => {
        const files = ref ? shippedChanges(ref) : [];
        const isShipping = ref === undefined || files.length > 0;
        return (
          JSON.stringify(
            { ref: ref ?? null, ships: isShipping, files },
            undefined,
            2,
          ) + '\n'
        );
      })()
    : renderNotes({
        ref,
        changes: ref ? shippedPullRequests(ref) : [],
        api: readApi(),
        fragments: fragmentsSince(ref),
        firstCanary: values['first-canary'] === true,
      });
  if (values.out) fs.writeFileSync(values.out, result);
  process.stdout.write(result);
}
