/**
 * The public repository's last check of the Cardano packages before they
 * publish (publish-release.yml build-cardano), against what npm already has
 * (ADR 66, ADR 68). The packages release in lockstep with @laceio/sdk: one
 * `lace-sdk@` release carries one version for every package of the family,
 * which lace-platform computed from its releases and the API diff with the
 * previous release's build (apps/lace-sdk/scripts/next-version.ts) and stamped
 * into each package.json and each pin on another package of the family. The
 * registry decides nothing here; it is checked, as a gate and for idempotency:
 *
 * - each package.json, and each pin on another package of the release, must
 *   name the tag's version;
 * - a version npm already has must be this build, byte for byte, so a re-run
 *   completes a partial publish and nothing else ships under a published
 *   version;
 * - in a stable release (`lace-sdk@X.Y.Z`), a new version must be above the
 *   latest stable on npm and, against that release's declarations, break no
 *   export without the version bump and the prior `@deprecated` the rules
 *   require;
 * - in a canary release (`lace-sdk@X.Y.Z-canary.N`), every package publishes
 *   at the canary version on the `canary` dist-tag, which must preview a
 *   version above its latest stable on npm and not sort below a version npm
 *   has; npm makes a package's first version its `latest`, so a package's
 *   first release is stable.
 *
 * A package released on its own (`@laceio/cardano-ledger@X.Y.Z[-canary.N]`)
 * is held to the same rules alone, at the tag's version, and each pin on
 * another package of the family must be the range the release gives it
 * (apps/lace-sdk/scripts/releases.mjs familyRange) on a version npm already
 * has: a package releases after the packages it depends on.
 *
 * Run after the three packages are built, with the release's tag:
 *
 * ```bash
 * RELEASE_TAG=lace-sdk@0.1.0 node apps/lace-cardano/scripts/check-release.ts
 * RELEASE_TAG=@laceio/cardano@0.1.2 node apps/lace-cardano/scripts/check-release.ts
 * ```
 *
 * RELEASE_TARBALLS names a directory to write the tarball of each package the
 * release publishes into, as npm packs it, with a copy under its GitHub
 * Packages name (`@input-output-hk/<directory name>`), so the release job can
 * publish each to the registries that still lack its version, completing a
 * partial publish on a re-run. PUBLISHED_TARBALLS names a directory of
 * tarballs that stands in for npm, for a dry run. RELEASE_NPM_REGISTRY names
 * another registry to read, and RELEASE_REPOSITORY_ROOT another tree holding
 * the three packages, for the tests (test/release.test.mjs).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// @laceio/sdk's release check and this one apply one set of versioning rules, and
// both packages publish from the same repository.
// eslint-disable-next-line @nx/enforce-module-boundaries
import {
  canaryReleaseProblems,
  latestCanarySinceOf,
  latestStableOf,
  readExports,
  republishProblems,
  stableReleaseProblems,
  type ReleaseOverride,
} from '../../lace-sdk/scripts/release-compat.ts';
// eslint-disable-next-line @nx/enforce-module-boundaries
import { familyRange } from '../../lace-sdk/scripts/releases.mjs';

const out = process.env.RELEASE_TARBALLS;
if (out) fs.mkdirSync(out, { recursive: true });

const repositoryRoot =
  process.env.RELEASE_REPOSITORY_ROOT ??
  path.resolve(import.meta.dirname, '../../..');

const tag = process.env.RELEASE_TAG ?? '';
const tagMatch =
  /^(lace-sdk|@laceio\/cardano(?:-ledger|-trezor)?)@(\d+\.\d+\.\d+(?:-canary\.(\d+))?)$/.exec(
    tag,
  );
if (!tagMatch) {
  throw new Error(
    `RELEASE_TAG must be lace-sdk@X.Y.Z[-canary.N] or a Cardano package's <name>@X.Y.Z[-canary.N], not ${tag}`,
  );
}
/** The package released on its own, or undefined for the family's release. */
const releasedPackage = tagMatch[1] === 'lace-sdk' ? undefined : tagMatch[1];
/** The version the release publishes. */
const releaseVersion = tagMatch[2] ?? '';
/** Whether the release is a canary. */
const isCanary = tagMatch[3] !== undefined;
const NPM_REGISTRY = [
  `--@laceio:registry=${
    process.env.RELEASE_NPM_REGISTRY ?? 'https://registry.npmjs.org'
  }`,
];

/** Each package, with the declaration file of each entry it exports. */
const PACKAGES = [
  {
    directory: 'apps/lace-cardano',
    entries: [
      'core',
      'crypto',
      'util',
      'key-management',
      'input-selection',
      'tx-construction',
      'dapp-connector',
    ],
  },
  { directory: 'apps/lace-cardano-ledger', entries: ['index'] },
  { directory: 'apps/lace-cardano-trezor', entries: ['index'] },
];

const temporary = () =>
  fs.mkdtempSync(path.join(os.tmpdir(), 'lace-cardano-release-'));

const npm = (args: string[], cwd?: string): string =>
  execFileSync('npm', [...args, ...NPM_REGISTRY], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NPM_CONFIG_LOGLEVEL: 'error' },
  }).trim();

/** The file name npm gives a package's tarball. */
const tarballName = (name: string, version: string) =>
  `${name.replace(/^@/, '').replace('/', '-')}-${version}.tgz`;

/** The version a stand-in tarball of `name` holds, by npm's file name. */
const tarballVersion = (name: string, file: string): string | undefined =>
  new RegExp(
    `^${tarballName(name, '(\\d+\\.\\d+\\.\\d+[^/]*?)').replaceAll(
      '.tgz',
      '\\.tgz',
    )}$`,
  ).exec(file)?.[1];

/** Every version of `name` on npm, or in PUBLISHED_TARBALLS for a dry run. */
const publishedVersions = (name: string): string[] => {
  const stand = process.env.PUBLISHED_TARBALLS;
  if (stand) {
    return fs
      .readdirSync(stand)
      .map(file => tarballVersion(name, file))
      .filter(version => version !== undefined);
  }
  try {
    const versions = JSON.parse(npm(['view', name, 'versions', '--json'])) as
      | string[]
      | string;
    return Array.isArray(versions) ? versions : [versions];
  } catch (error) {
    if (String((error as { stderr?: string }).stderr).includes('E404')) {
      return [];
    }
    throw error;
  }
};

/** The published tarball of `name@version`, unpacked; returns its package/. */
const unpackPublished = (name: string, version: string): string => {
  const directory = temporary();
  const stand = process.env.PUBLISHED_TARBALLS;
  const tarball = stand
    ? path.join(stand, tarballName(name, version))
    : path.join(
        directory,
        npm(
          ['pack', `${name}@${version}`, '--pack-destination', directory],
          directory,
        )
          .split('\n')
          .at(-1) ?? '',
      );
  execFileSync('tar', ['-xzf', tarball, '-C', directory]);
  return path.join(directory, 'package');
};

/** Packs the package directory as npm publishes it; returns the tarball. */
const pack = (directory: string, out: string): string => {
  const [packed] = JSON.parse(
    execFileSync(
      'npm',
      ['pack', '--json', '--ignore-scripts', '--pack-destination', out],
      {
        cwd: directory,
        encoding: 'utf8',
        env: { ...process.env, NPM_CONFIG_LOGLEVEL: 'error' },
      },
    ),
  ) as { filename: string }[];
  return path.join(out, packed.filename);
};

/**
 * Repacks a tarball from the same files with its manifest's name replaced, as
 * the GitHub Packages name is.
 */
const repack = (
  tarball: string,
  out: string,
  replace: { name: string },
): string => {
  const staging = temporary();
  execFileSync('tar', ['-xzf', tarball, '-C', staging]);
  const manifestFile = path.join(staging, 'package', 'package.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as Record<
    string,
    unknown
  >;
  fs.writeFileSync(
    manifestFile,
    JSON.stringify({ ...manifest, ...replace }, undefined, 2) + '\n',
  );
  return pack(path.join(staging, 'package'), out);
};

/** Writes a package's tarball for npm, and its copy for GitHub Packages. */
const writeTarballs = (tarball: string, directory: string) => {
  if (!out) return;
  const npmTarball = path.join(out, path.basename(tarball));
  fs.copyFileSync(tarball, npmTarball);
  repack(npmTarball, out, {
    name: `@input-output-hk/${path.basename(directory)}`,
  });
};

/** The package/ directory of an unpacked tarball. */
const unpack = (tarball: string): string => {
  const directory = temporary();
  execFileSync('tar', ['-xzf', tarball, '-C', directory]);
  return path.join(directory, 'package');
};

const declarationsIn = (directory: string, entries: string[]) =>
  Object.fromEntries(
    entries
      .map((entry): [string, string] => [
        entry,
        path.join(directory, 'dist', `${entry}.d.ts`),
      ])
      .filter(([, file]) => fs.existsSync(file)),
  );

const readOverrides = (directory: string): ReleaseOverride[] => {
  const file = path.join(directory, 'release-overrides.json');
  return fs.existsSync(file)
    ? (JSON.parse(fs.readFileSync(file, 'utf8')) as ReleaseOverride[])
    : [];
};

interface Manifest {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
}
const manifestOf = (directory: string): Manifest =>
  JSON.parse(
    fs.readFileSync(
      path.join(repositoryRoot, directory, 'package.json'),
      'utf8',
    ),
  ) as Manifest;

const names = new Set(
  PACKAGES.map(({ directory }) => manifestOf(directory).name),
);

/**
 * The problems with a pin of a package released on its own on another
 * package of the family: the range its release gives the version the
 * snapshot stamps that package at, which npm must already have.
 */
const pinProblems = (name: string, dependency: string, pin: string) => {
  const directory = PACKAGES.find(
    entry => manifestOf(entry.directory).name === dependency,
  )?.directory;
  if (directory === undefined) return [];
  const { version } = manifestOf(directory);
  const range = familyRange(version, isCanary);
  if (pin !== range) {
    return [
      `${name} pins ${dependency} ${pin}, but its release gives ${dependency}@${version} the range ${range}`,
    ];
  }
  return publishedVersions(dependency).includes(version)
    ? []
    : [
        `${name} depends on ${dependency}@${version}, which npm does not have: release ${dependency} first`,
      ];
};

const problems: string[] = [];
const verdicts: string[] = [];
const released = PACKAGES.filter(
  ({ directory }) =>
    releasedPackage === undefined ||
    manifestOf(directory).name === releasedPackage,
);
for (const { directory, entries } of released) {
  const packageDirectory = path.join(repositoryRoot, directory);
  const { name, version, dependencies } = manifestOf(directory);
  // The release stamps its version into the package it publishes, and its
  // pins on the family; any other version is not this release's.
  if (version !== releaseVersion) {
    problems.push(
      `${name}@${version}: ${directory}/package.json must name this release's version ${releaseVersion}, which the release stamps into its snapshot`,
    );
    continue;
  }
  for (const [dependency, pin] of Object.entries(dependencies ?? {})) {
    if (!names.has(dependency)) continue;
    if (releasedPackage !== undefined) {
      problems.push(...pinProblems(name, dependency, pin));
    } else if (pin !== releaseVersion) {
      problems.push(
        `${name} pins ${dependency} ${pin}, but this release's ${dependency} is ${releaseVersion}`,
      );
    }
  }
  const tarball = pack(packageDirectory, temporary());
  const built = unpack(tarball);

  const published = publishedVersions(name);
  if (published.includes(version)) {
    const republished = republishProblems({
      name,
      version,
      published: unpackPublished(name, version),
      built,
    });
    if (republished.length > 0) {
      problems.push(...republished);
      continue;
    }
    // Written again for a registry that still lacks it.
    writeTarballs(tarball, directory);
    verdicts.push(`${name}@${version}: already released, unchanged`);
    continue;
  }

  const latest = latestStableOf(published);
  const packageProblems = isCanary
    ? canaryReleaseProblems({
        latestStable: latest,
        latestCanary: latestCanarySinceOf(published),
        canaryVersion: version,
      })
    : latest === undefined
    ? []
    : stableReleaseProblems({
        previousVersion: latest,
        nextVersion: version,
        // The domain layer's entries import their declarations from shared
        // chunks, which are part of the API compared.
        previous: readExports(
          declarationsIn(unpackPublished(name, latest), entries),
          { followRelativeImports: true },
        ),
        next: readExports(declarationsIn(packageDirectory, entries), {
          followRelativeImports: true,
        }),
        overrides: readOverrides(packageDirectory),
      });
  if (packageProblems.length > 0) {
    problems.push(...packageProblems.map(problem => `${name}: ${problem}`));
    continue;
  }
  writeTarballs(tarball, directory);
  verdicts.push(
    `${name}@${version}: publishes${isCanary ? ' on canary' : ''}${
      latest
        ? ` (meets the versioning rules against ${latest})`
        : ' (first release)'
    }`,
  );
}

if (problems.length > 0) {
  // eslint-disable-next-line no-console -- the release gate's verdict
  console.error(
    `${
      releasedPackage ?? 'The Cardano packages'
    } cannot be released:\n- ${problems.join('\n- ')}`,
  );
  process.exit(1);
}
// eslint-disable-next-line no-console -- the release gate's verdict
console.log(verdicts.join('\n'));
