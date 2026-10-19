// Lays the built package out the way npm installs its tarball, with its
// declared dependencies alone, then loads it through `import` and `require()`
// in plain Node and type-checks test/consumer-types.mts against it under the
// three module resolutions consumers use.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const manifest = JSON.parse(
  fs.readFileSync(path.join(packageDirectory, 'package.json'), 'utf8'),
);

// The tarball carries the licence and the notices of the upstream code it
// contains, beside the build.
const packed = spawnSync(
  'npm',
  ['pack', '--dry-run', '--json', '--ignore-scripts'],
  {
    cwd: packageDirectory,
    encoding: 'utf8',
  },
);
assert.equal(packed.status, 0, `npm pack failed:\n${packed.stderr}`);
const packedFiles = new Set(
  JSON.parse(packed.stdout)[0].files.map(file => file.path),
);
for (const file of ['LICENSE', 'NOTICE']) {
  assert.ok(packedFiles.has(file), `The packed tarball lacks ${file}`);
}

/**
 * The installed copy of `name` that Node resolves from `from`: a dependency's
 * own dependencies resolve from where that dependency is installed, which may
 * be a nested copy rather than the one at the root.
 */
const findInstalledDependency = (name, from = packageDirectory) => {
  for (
    let directory = from;
    directory !== path.dirname(directory);
    directory = path.dirname(directory)
  ) {
    const candidate = path.join(directory, 'node_modules', name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
  }
  throw new Error(`Dependency ${name} is not installed`);
};

/** The dependencies of `name`, linked beside it, so its own imports resolve. */
const linkDependencies = (nodeModules, directory, seen = new Set()) => {
  const dependencies = JSON.parse(
    fs.readFileSync(path.join(directory, 'package.json'), 'utf8'),
  ).dependencies;
  for (const name of Object.keys(dependencies ?? {})) {
    if (seen.has(name)) continue;
    seen.add(name);
    const link = path.join(nodeModules, name);
    fs.mkdirSync(path.dirname(link), { recursive: true });
    const target = findInstalledDependency(name, directory);
    fs.symlinkSync(target, link, 'dir');
    linkDependencies(nodeModules, target, seen);
  }
};

const installDirectory = fs.mkdtempSync(
  path.join(os.tmpdir(), 'lace-cardano-trezor-check-'),
);
try {
  const nodeModules = path.join(installDirectory, 'node_modules');
  const installed = path.join(nodeModules, manifest.name);
  fs.mkdirSync(installed, { recursive: true });
  fs.copyFileSync(
    path.join(packageDirectory, 'package.json'),
    path.join(installed, 'package.json'),
  );
  for (const entry of manifest.files) {
    fs.cpSync(path.join(packageDirectory, entry), path.join(installed, entry), {
      recursive: true,
    });
  }
  linkDependencies(nodeModules, packageDirectory);

  // A consumer that imports the adapter and the domain layer side by side, in
  // either module syntax, meets one implementation of the domain layer: the
  // adapter's errors and base classes are the classes @laceio/cardano exports.
  const probe = load => `
(async () => {
  const adapter = ${load('"' + manifest.name + '"')};
  const keyManagement = ${load('"@laceio/cardano/key-management"')};
  const util = ${load('"@laceio/cardano/util"')};
  const core = ${load('"@laceio/cardano/core"')};
  const caught = async run => {
    try {
      await run();
      return 'no error';
    } catch (error) {
      return error;
    }
  };
  // An output to an address the wallet owns, without the stake key path the
  // transformer needs.
  const address =
    'addr_test1qqydn46r6mhge0kfpqmt36m6q43knzsd9ga32n96m89px3nuzcjqw982pcftgx53fu5527z2cj2tkx2h8ux2vxsg475qypp3m9';
  const missingStakePath = await caught(() =>
    adapter.toTxOut(
      { txOut: { address, value: { coins: 1n } }, index: 0, isCollateral: false },
      {
        knownAddresses: [{ address, accountIndex: 0, index: 0, type: 0 }],
        outputsFormat: [],
      },
    ),
  );
  const notImplemented = await caught(() =>
    adapter.TrezorKeyAgent.prototype.signBlob.call({}),
  );
  console.log(JSON.stringify({
    exports: Object.keys(adapter).length,
    keyAgent: typeof adapter.TrezorKeyAgent,
    keyAgentBase: adapter.TrezorKeyAgent.prototype instanceof keyManagement.KeyAgentBase,
    invalidArgument: missingStakePath instanceof util.InvalidArgumentError,
    notImplemented: notImplemented instanceof core.NotImplementedError,
  }));
})().catch(error => { console.error(error); process.exit(1); });
`;
  const probes = {
    'probe.mjs': probe(specifier => `await import(${specifier})`),
    'probe.cjs': probe(specifier => `require(${specifier})`),
  };
  for (const [file, source] of Object.entries(probes)) {
    fs.writeFileSync(path.join(installDirectory, file), source);
    const run = spawnSync(process.execPath, [file], {
      cwd: installDirectory,
      encoding: 'utf8',
      timeout: 60_000,
    });
    assert.equal(run.status, 0, `${file} failed in Node:\n${run.stderr}`);
    const result = JSON.parse(run.stdout);
    assert.ok(result.exports > 0, `${file}: the package exports nothing`);
    assert.equal(result.keyAgent, 'function', `${file}: TrezorKeyAgent`);
    assert.equal(
      result.keyAgentBase,
      true,
      `${file}: TrezorKeyAgent extends the KeyAgentBase @laceio/cardano/key-management exports`,
    );
    assert.equal(
      result.invalidArgument,
      true,
      `${file}: the adapter throws the InvalidArgumentError @laceio/cardano/util exports`,
    );
    assert.equal(
      result.notImplemented,
      true,
      `${file}: the adapter throws the NotImplementedError @laceio/cardano/core exports`,
    );
  }

  const FIXTURE = 'consumer-types.mts';
  fs.copyFileSync(
    path.join(packageDirectory, 'test', FIXTURE),
    path.join(installDirectory, FIXTURE),
  );
  const tsc = path.join(findInstalledDependency('typescript'), 'bin/tsc');
  const RESOLUTIONS = {
    node10: { module: 'ESNext', moduleResolution: 'Node10' },
    node16: { module: 'Node16', moduleResolution: 'Node16' },
    bundler: { module: 'ESNext', moduleResolution: 'Bundler' },
  };
  for (const [resolution, moduleOptions] of Object.entries(RESOLUTIONS)) {
    const project = path.join(installDirectory, `tsconfig.${resolution}.json`);
    fs.writeFileSync(
      project,
      JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          ...moduleOptions,
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          types: [],
        },
        files: [FIXTURE],
      }),
    );
    const run = spawnSync(process.execPath, [tsc, '-p', project], {
      encoding: 'utf8',
    });
    assert.equal(
      run.status,
      0,
      `${FIXTURE} does not type-check with ${resolution} module resolution:\n${run.stdout}${run.stderr}`,
    );
  }
  // eslint-disable-next-line no-console -- concise build proof
  console.log(
    `${manifest.name}@${
      manifest.version
    }: loads through import and require() and type-checks under ${Object.keys(
      RESOLUTIONS,
    ).join(', ')}`,
  );
} finally {
  fs.rmSync(installDirectory, { recursive: true, force: true });
}
