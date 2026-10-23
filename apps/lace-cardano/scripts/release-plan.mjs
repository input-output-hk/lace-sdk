// Decides what a release's publish-cardano job publishes, from the release
// tag and the Cardano packages' manifests at the release commit, which carry
// the release's version (stamped by lace-platform's sdk-release.yml), and
// holds the tarballs build-cardano packed to exactly those names and
// versions (tools/open-source-release/templates-sdk/.github/
// workflows/publish-release.yml). It runs in the job that holds publishing
// credentials, so it imports Node's built-ins alone and runs no npm command on
// a tarball's contents.
//
//   node release-plan.mjs plan
//     RELEASE_TAG, CARDANO_TARBALLS (build-cardano's tarballs), CARDANO_PLAN
//     (the plan file to write) and GITHUB_OUTPUT (`any` and `subjects`).
//   node release-plan.mjs exists <spec> <registry>
//     Prints `present` or `absent`.
//
// The registries decide nothing here: `exists` only lets the publish job skip a
// version a registry already has, so a re-run completes a partial publish. A
// registry answers a lookup with the version, or with E404 when the package
// or version does not exist. Anything else, a timeout, a refused connection, an
// authentication failure or a 5xx, fails the lookup, so a registry outage
// stops the release rather than leaving a package out of it.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const NPMJS = 'https://registry.npmjs.org';

/** The packages, the domain layer first: the others depend on it. */
const DIRECTORIES = [
  'apps/lace-cardano',
  'apps/lace-cardano-ledger',
  'apps/lace-cardano-trezor',
];

/**
 * Whether `spec` (a package, or a package at a version) exists on
 * `registry`: `present` or `absent`. Throws when the registry does not answer
 * either way.
 */
export const lookUp = (spec, registry = NPMJS) => {
  const scope = spec.match(/^(@[^/]+)\//)?.[1];
  const run = spawnSync(
    'npm',
    [
      'view',
      spec,
      'version',
      scope ? `--${scope}:registry=${registry}` : `--registry=${registry}`,
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  if (run.status === 0) return run.stdout.trim() ? 'present' : 'absent';
  if (/\bE404\b/.test(run.stderr)) return 'absent';
  const code =
    run.stderr.match(/code (E[A-Z0-9]+)/)?.[1] ?? `exit ${run.status}`;
  throw new Error(`The registry did not answer for ${spec} (${code})`);
};

/** The file name npm gives a package's tarball. */
const tarballName = (name, version) =>
  `${name.replace(/^@/, '').replace('/', '-')}-${version}.tgz`;

/** Fails unless `tarball` holds package/ alone, as `expected` (name@version). */
const checkTarball = (tarball, expected) => {
  if (!fs.existsSync(tarball)) {
    throw new Error(`build-cardano packed no ${path.basename(tarball)}`);
  }
  const entries = spawnSync('tar', ['-tzf', tarball], { encoding: 'utf8' });
  if (
    entries.status !== 0 ||
    entries.stdout
      .split('\n')
      .some(entry => entry && !entry.startsWith('package/'))
  ) {
    throw new Error(`${path.basename(tarball)} holds entries outside package/`);
  }
  const manifest = JSON.parse(
    spawnSync('tar', ['-xzOf', tarball, 'package/package.json'], {
      encoding: 'utf8',
    }).stdout,
  );
  const actual = `${manifest.name}@${manifest.version}`;
  if (actual !== expected) {
    throw new Error(
      `${path.basename(tarball)} holds ${actual}, not ${expected}`,
    );
  }
};

/**
 * The release's plan: every package of a family release, or the one package
 * a package's release names, at the release's version, which each manifest
 * must name, with its dist-tag (`latest`, or `canary` for a canary) and both
 * tarballs.
 */
export const plan = ({ tag, root = process.cwd(), tarballs }) => {
  const match =
    /^(lace-sdk|@laceio\/cardano(?:-ledger|-trezor)?)@(\d+\.\d+\.\d+(?:-canary\.(\d+))?)$/.exec(
      tag,
    );
  if (!match)
    throw new Error(
      `'${tag}' does not name lace-sdk@X.Y.Z[-canary.N] or a Cardano package's <name>@X.Y.Z[-canary.N]`,
    );
  const [, released, version, canary] = match;
  const manifests = DIRECTORIES.map(directory => ({
    directory,
    manifest: JSON.parse(
      fs.readFileSync(path.join(root, directory, 'package.json'), 'utf8'),
    ),
  })).filter(
    ({ manifest }) => released === 'lace-sdk' || manifest.name === released,
  );
  const items = manifests.map(({ directory, manifest }) => {
    if (manifest.version !== version) {
      throw new Error(
        `${directory}/package.json names ${manifest.name}@${manifest.version}, not this release's ${version}`,
      );
    }
    const githubName = `@input-output-hk/${path.basename(directory)}`;
    const item = {
      name: manifest.name,
      version,
      tarball: path.join(tarballs, tarballName(manifest.name, version)),
      githubName,
      githubTarball: path.join(tarballs, tarballName(githubName, version)),
      distTag: canary === undefined ? 'latest' : 'canary',
    };
    checkTarball(item.tarball, `${item.name}@${version}`);
    checkTarball(item.githubTarball, `${githubName}@${version}`);
    return item;
  });
  return { items, notices: [] };
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  try {
    if (command === 'exists' && args.length >= 1) {
      // eslint-disable-next-line no-console -- the command's result
      console.log(lookUp(args[0], args[1] ?? NPMJS));
    } else if (command === 'plan') {
      const { items, notices } = plan({
        tag: process.env.RELEASE_TAG ?? '',
        tarballs: process.env.CARDANO_TARBALLS ?? '',
      });
      for (const notice of notices) {
        // eslint-disable-next-line no-console -- a workflow annotation
        console.log(`::notice::${notice}`);
      }
      fs.writeFileSync(
        process.env.CARDANO_PLAN ?? 'cardano-plan',
        items
          .map(item =>
            [
              item.name,
              item.version,
              item.tarball,
              item.githubName,
              item.githubTarball,
              item.distTag,
            ].join(' '),
          )
          .join('\n') + (items.length ? '\n' : ''),
      );
      for (const item of items) {
        // eslint-disable-next-line no-console -- the plan, for the run's log
        console.log(
          `✓ ${item.name}@${item.version} and ${item.githubName}@${item.version} on ${item.distTag}`,
        );
      }
      if (process.env.GITHUB_OUTPUT) {
        fs.appendFileSync(
          process.env.GITHUB_OUTPUT,
          `any=${items.length > 0}\nsubjects<<EOF\n${items
            .flatMap(item => [item.tarball, item.githubTarball])
            .join('\n')}\nEOF\n`,
        );
      }
    } else {
      throw new Error(
        'usage: release-plan.mjs plan | release-plan.mjs exists <spec> [registry]',
      );
    }
  } catch (error) {
    // eslint-disable-next-line no-console -- a workflow annotation
    console.error(`::error::${error.message}`);
    process.exit(1);
  }
}
