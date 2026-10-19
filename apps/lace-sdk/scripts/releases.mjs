// The SDK's releases, as this repository's GitHub releases record them
// (ADR 66). A published `lace-sdk@X.Y.Z` release that is not a prerelease is
// a stable release; a published `lace-sdk@X.Y.Z-canary.N` prerelease is a
// canary. A draft, a tag with no published release, or a release whose
// prerelease flag disagrees with its name is no release. These are the only
// record of which versions exist: the manifests on main name
// DEVELOPMENT_VERSION, and the release workflows compute each version from
// these releases and the API diff (scripts/next-version.ts), never from a
// registry. git still holds each release's tree, at its tag. Node's built-ins
// only, so a workflow job can read the releases before anything is installed.
//
//   node scripts/releases.mjs fetch [--out <file>]        the GitHub releases, as JSON
//   node scripts/releases.mjs check                       refuse releases and tags that disagree
//   node scripts/releases.mjs previous [--below X.Y.Z]    newest stable release (below X.Y.Z)
//   node scripts/releases.mjs latest [--except TAG]       newest release, canary or stable (other than TAG)
//   node scripts/releases.mjs stamp <root> <version>      stamp the family's manifests
//
// `previous` and `latest` print a tag, or nothing when there is none. The
// releases come from LACE_SDK_RELEASES_FILE (as `fetch` writes it) when set,
// otherwise from the GitHub API through `gh`, for GITHUB_REPOSITORY or the
// checked-out repository.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export const TAG_PREFIX = 'lace-sdk@';

/**
 * The version every manifest of the SDK's family names on main. Only a
 * release stamps a real version, into the release's own copy, so nothing is
 * committed back.
 */
export const DEVELOPMENT_VERSION = '0.0.0-development';

/**
 * The packages one `lace-sdk@` release carries, in lockstep at its version:
 * the SDK and the Cardano packages (ADR 68).
 */
export const FAMILY_DIRECTORIES = [
  'apps/lace-sdk',
  'apps/lace-cardano',
  'apps/lace-cardano-ledger',
  'apps/lace-cardano-trezor',
];

/** The version of the SDK's first stable release. */
export const FIRST_VERSION = '0.1.0';

/** Parses a semver version, `X.Y.Z[-prerelease]`. */
export const parseVersion = text => {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(text);
  if (!match) throw new Error(`Not a semver version: ${text}`);
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4],
  };
};

/** Compares versions; a prerelease sorts below its release. */
export const compareVersions = (a, b) =>
  a.major - b.major ||
  a.minor - b.minor ||
  a.patch - b.patch ||
  (a.prerelease === b.prerelease
    ? 0
    : a.prerelease === undefined
    ? 1
    : b.prerelease === undefined
    ? -1
    : a.prerelease.localeCompare(b.prerelease, 'en', { numeric: true }));

/**
 * A release tag's parts, `lace-sdk@X.Y.Z` or `lace-sdk@X.Y.Z-canary.N`, or
 * undefined for any other name.
 */
export const parseReleaseTag = tag => {
  const match = /^lace-sdk@(\d+\.\d+\.\d+)(?:-canary\.(\d+))?$/.exec(tag);
  if (!match) return undefined;
  const canary = match[2] === undefined ? undefined : Number(match[2]);
  return {
    tag,
    base: match[1],
    canary,
    version: canary === undefined ? match[1] : `${match[1]}-canary.${canary}`,
  };
};

/** Whether a release record's prerelease flag matches its tag's channel. */
const isLabelled = (release, isPrerelease) =>
  Boolean(isPrerelease) === (release.canary !== undefined);

/**
 * The SDK's releases among GitHub's release records, oldest first: each
 * published (not draft) `lace-sdk@` release. A canary is a prerelease and a
 * stable release is not; a published record whose flag disagrees with its
 * tag is refused rather than left out, since a record anyone with write
 * access can edit would otherwise steer the version (releaseRecordProblems).
 */
export const releasesOf = records => {
  const mislabelled = records.filter(({ tagName, isDraft, isPrerelease }) => {
    const release = parseReleaseTag(tagName);
    return release && !isDraft && !isLabelled(release, isPrerelease);
  });
  if (mislabelled.length > 0) {
    throw new Error(
      `release records disagree with their tags: ${mislabelled
        .map(
          ({ tagName, isPrerelease }) =>
            `${tagName} is ${isPrerelease ? '' : 'not '}a prerelease`,
        )
        .join('; ')}`,
    );
  }
  return records
    .filter(({ isDraft }) => !isDraft)
    .map(({ tagName, publishedAt }) => {
      const release = parseReleaseTag(tagName);
      return release
        ? { ...release, publishedAt: publishedAt ?? '' }
        : undefined;
    })
    .filter(Boolean)
    .sort((a, b) =>
      compareVersions(parseVersion(a.version), parseVersion(b.version)),
    );
};

/**
 * Where the release records and the protected tags disagree: a `lace-sdk@`
 * tag without a published release whose prerelease flag matches its name (a
 * bare tag, a draft, a release flipped to or from prerelease, or one
 * deleted), and a published release without its tag. Only the tags are
 * protected (a ruleset); the records can be edited by anyone with write
 * access, so a release workflow refuses to version against them until they
 * agree, rather than leave a release out and number the next one past it.
 */
export const releaseRecordProblems = (records, tagNames) => {
  const tags = new Set(tagNames.filter(name => parseReleaseTag(name)));
  const published = new Map(
    records
      .filter(({ isDraft, tagName }) => !isDraft && parseReleaseTag(tagName))
      .map(record => [record.tagName, record]),
  );
  const problems = [];
  for (const tag of [...tags].sort()) {
    const record = published.get(tag);
    if (!record) {
      problems.push(
        `${tag} is tagged but has no published release: publish its release, or, if it never published, delete the tag (gh api -X DELETE /repos/<repository>/git/refs/tags/${tag}; docs/publish-public.md, Resuming a partial SDK release)`,
      );
    } else if (!isLabelled(parseReleaseTag(tag), record.isPrerelease)) {
      problems.push(
        `${tag}'s release is ${
          record.isPrerelease ? '' : 'not '
        }marked as a prerelease, against its tag: restore the flag (a canary is a prerelease, a stable release is not)`,
      );
    }
  }
  for (const tag of [...published.keys()].sort()) {
    if (!tags.has(tag)) {
      problems.push(
        `${tag} has a published release but no tag: restore the tag, or delete the release`,
      );
    }
  }
  return problems;
};

/**
 * The newest stable release, or undefined before the first. With `below`, the
 * newest whose version is below it: the release a given version follows.
 */
export const previousStable = (releases, { below } = {}) =>
  releases
    .filter(({ canary }) => canary === undefined)
    .filter(
      ({ version }) =>
        below === undefined ||
        compareVersions(parseVersion(version), parseVersion(below)) < 0,
    )
    .at(-1);

/**
 * The release published last, canary or stable, or undefined before the
 * first: what a canary's changes count from. By publication, not version: a
 * stable release can ship below a canary's version (the stable release that
 * canary previewed past), and is then the newer of the two. Releases with the
 * same time, or none recorded, fall back to version order.
 */
export const latestRelease = releases =>
  [...releases]
    .map((release, order) => ({ release, order }))
    .sort(
      (a, b) =>
        (a.release.publishedAt ?? '').localeCompare(
          b.release.publishedAt ?? '',
        ) || a.order - b.order,
    )
    .at(-1)?.release;

/**
 * The highest stable version a canary since the latest stable release
 * previews: the floor a canary's version never goes below until the next
 * stable release, so the `canary` dist-tag only moves forward. Undefined when
 * no canary previews a version above the latest stable.
 */
export const canaryBaseFloor = releases => {
  const stable = previousStable(releases);
  return releases
    .filter(
      ({ canary, base }) =>
        canary !== undefined &&
        (stable === undefined ||
          compareVersions(parseVersion(base), parseVersion(stable.version)) >
            0),
    )
    .map(({ base }) => base)
    .sort((a, b) => compareVersions(parseVersion(a), parseVersion(b)))
    .at(-1);
};

/** The number the next canary of `base` takes: one past its highest, from 0. */
export const nextCanaryNumber = (releases, base) =>
  Math.max(
    -1,
    ...releases
      .filter(release => release.base === base && release.canary !== undefined)
      .map(({ canary }) => canary),
  ) + 1;

/**
 * The version after `previous` for a change of kind `bump` (ADR 66,
 * "Versioning before and after 1.0"): before 1.0 a breaking change takes the
 * next minor and anything else the next patch; from 1.0 a breaking change
 * takes the next major, a feature the next minor and anything else the next
 * patch. Without a previous release, the first version.
 */
export const bumpVersion = (previous, bump) => {
  if (previous === undefined) return FIRST_VERSION;
  const { major, minor, patch } = parseVersion(previous);
  if (major === 0) {
    return bump === 'breaking' ? `0.${minor + 1}.0` : `0.${minor}.${patch + 1}`;
  }
  if (bump === 'breaking') return `${major + 1}.0.0`;
  if (bump === 'feature') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
};

/**
 * The major version `apps/lace-sdk/release.json` asks for: `{ "major": N }`,
 * a reviewed change that promotes the family to N.0.0 (the 1.0 decision, ADR
 * 66), or 0 when the file is absent.
 */
export const readReleaseConfig = packageDirectory => {
  const file = path.join(packageDirectory, 'release.json');
  if (!fs.existsSync(file)) return { major: 0 };
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Number.isInteger(config.major) || config.major < 0) {
    throw new Error(
      `${file}: major must be a whole number, not ${config.major}`,
    );
  }
  return { major: config.major };
};

/**
 * The promoted version `major` asks for, when it is above the previous stable
 * release's major (or, before the first release, above 0): `<major>.0.0`.
 * Otherwise undefined, and the API diff decides; later majors follow from it.
 */
export const promotedVersion = (previous, major) => {
  const current = previous === undefined ? 0 : parseVersion(previous).major;
  return major > current ? `${major}.0.0` : undefined;
};

/**
 * Stamps a release's `version` into the family's manifests under `root` (the
 * release's snapshot): each package's version, and each dependency of one on
 * another, which main pins to the development version so the workspace links
 * it. Refuses a manifest that does not name the development version, so a
 * version committed by hand never publishes. Returns `name@version` of each.
 */
export const stampVersion = (root, version) => {
  parseVersion(version);
  const manifests = FAMILY_DIRECTORIES.map(directory => {
    const file = path.join(root, directory, 'package.json');
    return { file, manifest: JSON.parse(fs.readFileSync(file, 'utf8')) };
  });
  const names = new Set(manifests.map(({ manifest }) => manifest.name));
  return manifests.map(({ file, manifest }) => {
    if (manifest.version !== DEVELOPMENT_VERSION) {
      throw new Error(
        `${manifest.name} is at ${manifest.version}, not ${DEVELOPMENT_VERSION}: a release computes its version, so the manifest names none`,
      );
    }
    manifest.version = version;
    for (const field of ['dependencies', 'peerDependencies']) {
      for (const [name, range] of Object.entries(manifest[field] ?? {})) {
        if (!names.has(name)) continue;
        if (range !== DEVELOPMENT_VERSION) {
          throw new Error(
            `${manifest.name} pins ${name} ${range}, not ${DEVELOPMENT_VERSION}: the release pins the family to its own version`,
          );
        }
        manifest[field][name] = version;
      }
    }
    fs.writeFileSync(file, JSON.stringify(manifest, undefined, 2) + '\n');
    return `${manifest.name}@${version}`;
  });
};

const repository = () =>
  process.env.GITHUB_REPOSITORY ||
  execFileSync(
    'gh',
    ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'],
    {
      encoding: 'utf8',
    },
  ).trim();

/** This repository's GitHub release records of the SDK, from the API. */
export const fetchReleaseRecords = () =>
  execFileSync(
    'gh',
    [
      'api',
      '--paginate',
      `/repos/${repository()}/releases?per_page=100`,
      '--jq',
      '.[] | select(.tag_name | startswith("lace-sdk@")) | {tagName: .tag_name, isDraft: .draft, isPrerelease: .prerelease, publishedAt: (.published_at // "")}',
    ],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));

/** The SDK's releases: from LACE_SDK_RELEASES_FILE, or from the API. */
/** This repository's `lace-sdk@` tags, from git (all tags fetched). */
export const gitTagNames = () =>
  execFileSync('git', ['tag', '--list', `${TAG_PREFIX}*`], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);

/**
 * The SDK's releases: from LACE_SDK_RELEASES_FILE, or from the API, once
 * they agree with the tags (releaseRecordProblems); otherwise it throws.
 */
export const loadReleases = () => {
  const records = process.env.LACE_SDK_RELEASES_FILE
    ? JSON.parse(fs.readFileSync(process.env.LACE_SDK_RELEASES_FILE, 'utf8'))
    : fetchReleaseRecords();
  const problems = releaseRecordProblems(records, gitTagNames());
  if (problems.length > 0) {
    throw new Error(
      `the lace-sdk@ releases and tags disagree, so no version is computed:\n- ${problems.join(
        '\n- ',
      )}`,
    );
  }
  return releasesOf(records);
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      below: { type: 'string' },
      except: { type: 'string' },
      out: { type: 'string' },
    },
  });
  const [command] = positionals;
  const commands = {
    fetch: () => {
      const json = JSON.stringify(fetchReleaseRecords());
      if (values.out) fs.writeFileSync(values.out, json + '\n');
      return json;
    },
    check: () => {
      const records = process.env.LACE_SDK_RELEASES_FILE
        ? JSON.parse(
            fs.readFileSync(process.env.LACE_SDK_RELEASES_FILE, 'utf8'),
          )
        : fetchReleaseRecords();
      const problems = releaseRecordProblems(records, gitTagNames());
      if (problems.length === 0) return 'the lace-sdk@ releases and tags agree';
      // eslint-disable-next-line no-console -- workflow annotations
      for (const problem of problems) console.log(`::error::${problem}`);
      process.exit(1);
    },
    previous: () =>
      previousStable(loadReleases(), { below: values.below })?.tag,
    latest: () =>
      latestRelease(
        loadReleases().filter(release => release.tag !== values.except),
      )?.tag,
    stamp: () => stampVersion(positionals[1], positionals[2]).join('\n'),
  };
  if (!Object.hasOwn(commands, command ?? '')) {
    // eslint-disable-next-line no-console -- usage
    console.error(
      'usage: node scripts/releases.mjs fetch [--out <file>] | check | previous [--below X.Y.Z] | latest [--except TAG] | stamp <root> <version>',
    );
    process.exit(2);
  }
  // eslint-disable-next-line no-console -- the command's result
  console.log(commands[command]() ?? '');
}
