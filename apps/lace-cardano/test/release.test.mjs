// Integration tests of the Cardano packages' release path: the release check
// (scripts/check-release.ts) and the publish job's plan
// (scripts/release-plan.mjs), run as a release runs them, against fixture
// packages packed by npm, a directory of tarballs standing in for npm, and a
// local registry that answers 404 or 503.
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { lookUp, plan } from '../scripts/release-plan.mjs';

const CHECK = path.resolve(import.meta.dirname, '../scripts/check-release.ts');

const temporary = () =>
  fs.mkdtempSync(path.join(os.tmpdir(), 'lace-cardano-release-test-'));

// npm retries a failed request with backoff and caches what it reads; the
// tests want each answer at once, as the registry gives it.
const npmEnvironment = () => ({
  ...process.env,
  npm_config_fetch_retries: '0',
  npm_config_cache: temporary(),
  NPM_CONFIG_LOGLEVEL: 'error',
});

/** A tree holding the three packages at `version`, as the release check reads it. */
const fixtureRoot = ({
  version = '0.2.0',
  core = 'export declare const a: number;',
} = {}) => {
  const root = temporary();
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  };
  const manifest = (name, dependencies) =>
    JSON.stringify(
      { name, version, files: ['dist'], dependencies },
      undefined,
      2,
    );
  write('apps/lace-cardano/package.json', manifest('@laceio/cardano'));
  write('apps/lace-cardano/dist/core.d.ts', `${core}\n`);
  write('apps/lace-cardano/dist/core.js', 'export const a = 1;\n');
  for (const device of ['ledger', 'trezor']) {
    write(
      `apps/lace-cardano-${device}/package.json`,
      manifest(`@laceio/cardano-${device}`, { '@laceio/cardano': version }),
    );
    write(
      `apps/lace-cardano-${device}/dist/index.d.ts`,
      'export declare const b: number;\n',
    );
    write(`apps/lace-cardano-${device}/dist/index.js`, 'export const b = 1;\n');
  }
  return root;
};

/** Runs the release check; returns its exit status and output. */
const check = (root, tag, environment = {}) => {
  const out = temporary();
  const run = spawnSync(process.execPath, [CHECK], {
    encoding: 'utf8',
    env: {
      ...npmEnvironment(),
      RELEASE_REPOSITORY_ROOT: root,
      RELEASE_TAG: tag,
      RELEASE_TARBALLS: out,
      ...environment,
    },
  });
  return {
    status: run.status,
    output: run.stdout + run.stderr,
    tarballs: fs.readdirSync(out).sort(),
    out,
  };
};

/** A directory standing in for npm, holding copies of `tarballs`. */
const published = (...tarballs) => {
  const directory = temporary();
  for (const tarball of tarballs) {
    fs.copyFileSync(tarball, path.join(directory, path.basename(tarball)));
  }
  return directory;
};

/** The manifest inside a tarball. */
const manifestOf = tarball =>
  JSON.parse(
    execFileSync('tar', ['-xzOf', tarball, 'package/package.json'], {
      encoding: 'utf8',
    }),
  );

describe('the release check', () => {
  it('publishes every package in a first stable release, under both names', () => {
    const result = check(fixtureRoot(), 'lace-sdk@0.2.0');
    assert.equal(result.status, 0, result.output);
    assert.deepEqual(result.tarballs, [
      'input-output-hk-lace-cardano-0.2.0.tgz',
      'input-output-hk-lace-cardano-ledger-0.2.0.tgz',
      'input-output-hk-lace-cardano-trezor-0.2.0.tgz',
      'laceio-cardano-0.2.0.tgz',
      'laceio-cardano-ledger-0.2.0.tgz',
      'laceio-cardano-trezor-0.2.0.tgz',
    ]);
  });

  it('accepts a version npm has when the build is identical, and refuses a changed one', () => {
    const first = check(fixtureRoot(), 'lace-sdk@0.2.0');
    const npm = published(
      ...first.tarballs
        .filter(f => f.startsWith('laceio-'))
        .map(f => path.join(first.out, f)),
    );
    const same = check(fixtureRoot(), 'lace-sdk@0.2.0', {
      PUBLISHED_TARBALLS: npm,
    });
    assert.equal(same.status, 0, same.output);
    assert.match(
      same.output,
      /@laceio\/cardano@0\.2\.0: already released, unchanged/,
    );
    const changed = check(
      fixtureRoot({ core: 'export declare const a: string;' }),
      'lace-sdk@0.2.0',
      {
        PUBLISHED_TARBALLS: npm,
      },
    );
    assert.equal(changed.status, 1);
    assert.match(
      changed.output,
      /@laceio\/cardano@0\.2\.0 is already published and this build differs from it \(dist\/core\.d\.ts\)/,
    );
  });

  it('refuses a stable release that removes an export the latest release did not deprecate', () => {
    const older = check(
      fixtureRoot({
        version: '0.1.0',
        core: 'export declare const a: number;\nexport declare const gone: number;',
      }),
      'lace-sdk@0.1.0',
    );
    const npm = published(
      ...older.tarballs
        .filter(f => f.startsWith('laceio-'))
        .map(f => path.join(older.out, f)),
    );
    const result = check(fixtureRoot(), 'lace-sdk@0.2.0', {
      PUBLISHED_TARBALLS: npm,
    });
    assert.equal(result.status, 1);
    assert.match(
      result.output,
      /core:gone changes or is removed without being @deprecated in 0\.1\.0/,
    );
  });

  it('refuses a release whose device packages pin another @laceio/cardano than the one released', () => {
    const root = fixtureRoot();
    const ledger = path.join(root, 'apps/lace-cardano-ledger/package.json');
    const manifest = JSON.parse(fs.readFileSync(ledger, 'utf8'));
    manifest.dependencies['@laceio/cardano'] = '0.1.0';
    fs.writeFileSync(ledger, JSON.stringify(manifest, undefined, 2));
    const result = check(root, 'lace-sdk@0.2.0', {
      PUBLISHED_TARBALLS: published(),
    });
    assert.equal(result.status, 1);
    assert.match(
      result.output,
      /@laceio\/cardano-ledger pins @laceio\/cardano 0\.1\.0, but this release's @laceio\/cardano is 0\.2\.0/,
    );
  });

  it('refuses a package.json that does not name the release version', () => {
    for (const tag of ['lace-sdk@0.3.0', 'lace-sdk@0.2.0-canary.0']) {
      const result = check(fixtureRoot(), tag, {
        PUBLISHED_TARBALLS: published(),
      });
      assert.equal(result.status, 1, tag);
      assert.match(
        result.output,
        /@laceio\/cardano@0\.2\.0: apps\/lace-cardano\/package\.json must name this release's version/,
      );
    }
  });

  it('refuses a canary before the first stable release', () => {
    const result = check(
      fixtureRoot({ version: '0.2.0-canary.0' }),
      'lace-sdk@0.2.0-canary.0',
      { PUBLISHED_TARBALLS: published() },
    );
    assert.equal(result.status, 1);
    assert.deepEqual(result.tarballs, []);
    assert.match(result.output, /release a stable version first/);
  });

  describe('a canary', () => {
    let stable;
    before(() => {
      const older = check(fixtureRoot({ version: '0.1.0' }), 'lace-sdk@0.1.0');
      stable = older.tarballs
        .filter(f => f.startsWith('laceio-'))
        .map(f => path.join(older.out, f));
    });
    const canariesOf = result =>
      result.tarballs
        .filter(f => f.startsWith('laceio-'))
        .map(f => path.join(result.out, f));

    it("publishes every package at the release's canary version, pinning the family's canary", () => {
      const result = check(
        fixtureRoot({ version: '0.1.1-canary.4' }),
        'lace-sdk@0.1.1-canary.4',
        { PUBLISHED_TARBALLS: published(...stable) },
      );
      assert.equal(result.status, 0, result.output);
      assert.equal(result.tarballs.length, 6);
      const ledger = manifestOf(
        path.join(result.out, 'laceio-cardano-ledger-0.1.1-canary.4.tgz'),
      );
      assert.deepEqual(ledger.dependencies, {
        '@laceio/cardano': '0.1.1-canary.4',
      });
    });

    it('completes a re-run of a canary npm has, and refuses a changed build under it', () => {
      const first = check(
        fixtureRoot({ version: '0.1.1-canary.0' }),
        'lace-sdk@0.1.1-canary.0',
        { PUBLISHED_TARBALLS: published(...stable) },
      );
      const npm = published(...stable, ...canariesOf(first));
      const again = check(
        fixtureRoot({ version: '0.1.1-canary.0' }),
        'lace-sdk@0.1.1-canary.0',
        { PUBLISHED_TARBALLS: npm },
      );
      assert.equal(again.status, 0, again.output);
      assert.match(
        again.output,
        /@laceio\/cardano@0\.1\.1-canary\.0: already released, unchanged/,
      );
      const changed = check(
        fixtureRoot({
          version: '0.1.1-canary.0',
          core: 'export declare const a: string;',
        }),
        'lace-sdk@0.1.1-canary.0',
        { PUBLISHED_TARBALLS: npm },
      );
      assert.equal(changed.status, 1);
      assert.match(changed.output, /a published version is final/);
    });

    it('refuses a canary that previews a version npm has released', () => {
      const result = check(
        fixtureRoot({ version: '0.1.0-canary.2' }),
        'lace-sdk@0.1.0-canary.2',
        { PUBLISHED_TARBALLS: published(...stable) },
      );
      assert.equal(result.status, 1);
      assert.match(result.output, /not above the latest stable 0\.1\.0/);
    });
  });
});

/**
 * A local registry answering every request with `status` and `body`, in a
 * process of its own: a lookup blocks this one while npm waits for it.
 */
const registry = (status, body = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import http from 'node:http';
const server = http.createServer((_request, response) => {
  response.writeHead(${status}, { 'content-type': 'application/json' });
  response.end(${JSON.stringify(JSON.stringify(body))});
});
server.listen(0, '127.0.0.1', () => process.stdout.write(server.address().port + '\\n'));`,
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    child.once('error', reject);
    child.stdout.once('data', port =>
      resolve({ child, url: `http://127.0.0.1:${String(port).trim()}` }),
    );
  });

describe('registry failures', () => {
  let notFound;
  let unavailable;
  before(async () => {
    notFound = await registry(404);
    unavailable = await registry(503);
    Object.assign(process.env, {
      npm_config_fetch_retries: '0',
      npm_config_cache: temporary(),
    });
  });
  after(() => {
    notFound.child.kill();
    unavailable.child.kill();
  });

  it('the release check reads E404 as no release, and fails on any other answer', () => {
    const absent = check(fixtureRoot(), 'lace-sdk@0.2.0', {
      RELEASE_NPM_REGISTRY: notFound.url,
    });
    assert.equal(absent.status, 0, absent.output);
    assert.match(absent.output, /first release/);
    const down = check(fixtureRoot(), 'lace-sdk@0.2.0', {
      RELEASE_NPM_REGISTRY: unavailable.url,
    });
    assert.notEqual(down.status, 0);
    assert.doesNotMatch(down.output, /publishes/);
  });

  it('a lookup is absent on E404 and fails on any other answer', () => {
    assert.equal(lookUp('@laceio/cardano', notFound.url), 'absent');
    assert.equal(lookUp('@laceio/cardano@0.2.0', notFound.url), 'absent');
    assert.throws(
      () => lookUp('@laceio/cardano', unavailable.url),
      /did not answer for @laceio\/cardano/,
    );
  });

  it('a canary plan carries every package on canary, at the version the manifests name', () => {
    const root = fixtureRoot({ version: '0.2.0-canary.3' });
    const stable = check(fixtureRoot({ version: '0.1.0' }), 'lace-sdk@0.1.0');
    const canary = check(root, 'lace-sdk@0.2.0-canary.3', {
      PUBLISHED_TARBALLS: published(
        ...stable.tarballs
          .filter(f => f.startsWith('laceio-'))
          .map(f => path.join(stable.out, f)),
      ),
    });
    assert.equal(canary.status, 0, canary.output);
    const result = plan({
      tag: 'lace-sdk@0.2.0-canary.3',
      root,
      tarballs: canary.out,
    });
    assert.deepEqual(
      result.items.map(item => `${item.name}@${item.version} ${item.distTag}`),
      [
        '@laceio/cardano@0.2.0-canary.3 canary',
        '@laceio/cardano-ledger@0.2.0-canary.3 canary',
        '@laceio/cardano-trezor@0.2.0-canary.3 canary',
      ],
    );
    assert.throws(
      () =>
        plan({
          tag: 'lace-sdk@0.2.0-canary.4',
          root,
          tarballs: canary.out,
        }),
      /names @laceio\/cardano@0\.2\.0-canary\.3, not this release's 0\.2\.0-canary\.4/,
    );
  });

  it('a stable plan carries each package and holds its tarballs to its name and version', () => {
    const root = fixtureRoot();
    const built = check(root, 'lace-sdk@0.2.0');
    const result = plan({
      tag: 'lace-sdk@0.2.0',
      root,
      tarballs: built.out,
    });
    assert.deepEqual(
      result.items.map(item => `${item.name}@${item.version} ${item.distTag}`),
      [
        '@laceio/cardano@0.2.0 latest',
        '@laceio/cardano-ledger@0.2.0 latest',
        '@laceio/cardano-trezor@0.2.0 latest',
      ],
    );
    fs.copyFileSync(
      path.join(built.out, 'laceio-cardano-0.2.0.tgz'),
      path.join(built.out, 'input-output-hk-lace-cardano-0.2.0.tgz'),
    );
    assert.throws(
      () =>
        plan({
          tag: 'lace-sdk@0.2.0',
          root,
          tarballs: built.out,
        }),
      /holds @laceio\/cardano@0\.2\.0, not @input-output-hk\/lace-cardano@0\.2\.0/,
    );
  });
});
