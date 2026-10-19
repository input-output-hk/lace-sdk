// Lays the built package out the way npm installs its tarball, with its
// declared dependencies alone, then loads every subpath through `import` and
// `require()` in plain Node and type-checks test/consumer-types.mts against
// it under the three module resolutions consumers use. The node resolution
// proves typesVersions: it ignores the exports map, which Mesh and Gero's
// TypeScript configurations still do.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
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
const subpaths = Object.keys(manifest.exports).map(key => key.slice(2));

/** The installed copy of `name` that Node resolves from this package. */
const findInstalledDependency = name => {
  for (
    let directory = packageDirectory;
    directory !== path.dirname(directory);
    directory = path.dirname(directory)
  ) {
    const candidate = path.join(directory, 'node_modules', name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
  }
  throw new Error(`Dependency ${name} is not installed`);
};

const installDirectory = fs.mkdtempSync(
  path.join(os.tmpdir(), 'lace-cardano-check-'),
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
  const semver = createRequire(import.meta.url)('semver');
  for (const [name, range] of Object.entries(manifest.dependencies)) {
    const source = findInstalledDependency(name);
    const { version } = JSON.parse(
      fs.readFileSync(path.join(source, 'package.json'), 'utf8'),
    );
    assert.ok(
      semver.satisfies(version, range),
      `${name}@${version} is linked for the check, outside the declared range ${range}`,
    );
    const link = path.join(nodeModules, name);
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(source, link, 'dir');
  }
  // A consumer whose code meets Buffer has Node's types installed; the
  // package's declarations name Buffer and nothing else outside its
  // dependencies.
  fs.mkdirSync(path.join(nodeModules, '@types'), { recursive: true });
  fs.symlinkSync(
    findInstalledDependency('@types/node'),
    path.join(nodeModules, '@types/node'),
    'dir',
  );

  // The RxJS utilities ship with the Lace SDK, not here: no subpath's import
  // closure, through the chunks the entries share, reaches rxjs, so core types
  // and serialization install and load without it.
  const ENGINE_PACKAGES = ['rxjs', 'backoff-rxjs'];
  const distribution = path.join(installed, 'dist');
  // The declarations carry their doc comments, whose prose can read like
  // an import ('from "cborBytes" in cardano-cli'), so comments are dropped
  // before the imports are read.
  const withoutComments = source =>
    source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const importsOf = file =>
    [
      ...withoutComments(
        fs.readFileSync(path.join(distribution, file), 'utf8'),
      ).matchAll(/(?:from\s*|import\s*\(?\s*|require\()["']([^"']+)["']/g),
    ].map(match => match[1]);
  const packageOf = specifier =>
    specifier.startsWith('@')
      ? specifier.split('/').slice(0, 2).join('/')
      : specifier.split('/')[0];
  const closureOf = entry => {
    const seen = new Set();
    const queue = [entry];
    const reached = new Set();
    while (queue.length > 0) {
      const file = queue.shift();
      if (seen.has(file)) continue;
      seen.add(file);
      for (const specifier of importsOf(file)) {
        if (specifier.startsWith('.')) queue.push(path.normalize(specifier));
        else reached.add(packageOf(specifier));
      }
    }
    return reached;
  };
  for (const name of subpaths) {
    for (const extension of ['js', 'cjs']) {
      const reached = closureOf(`${name}.${extension}`);
      for (const engine of ENGINE_PACKAGES) {
        assert.ok(
          !reached.has(engine),
          `${name}.${extension} reaches ${engine}, which belongs to the Lace SDK`,
        );
      }
    }
  }

  // Every subpath loads both ways, and the entries share one copy of the
  // modules they have in common: the era flag set through one entry is the
  // flag the serialization in another reads.
  const probe = load => `
(async () => {
  const names = ${JSON.stringify(subpaths)};
  const modules = {};
  for (const name of names) modules[name] = ${load(
    '`' + manifest.name + '/${name}`',
  )};
  const core = modules.core;
  const txConstruction = modules['tx-construction'];
  const crypto = modules.crypto;
  await crypto.ready();
  // The error core throws is the class the util entry exports: the entries
  // share one copy of the modules they have in common.
  let sharedUtil = false;
  try {
    core.Cardano.PaymentAddress('not an address');
  } catch (error) {
    sharedUtil = error instanceof modules.util.InvalidStringError;
  }
  console.log(JSON.stringify({
    exports: Object.fromEntries(names.map(name => [name, Object.keys(modules[name]).length])),
    sharedUtil,
    address: core.Cardano.Address.fromBech32('addr_test1qqydn46r6mhge0kfpqmt36m6q43knzsd9ga32n96m89px3nuzcjqw982pcftgx53fu5527z2cj2tkx2h8ux2vxsg475qypp3m9').getNetworkId(),
    keyHash: crypto.Ed25519PublicKey.fromHex('0b1c96fad4179d7910bd9485ac28c4c11368c83d18d01b29d4cf84d8ff6a06c4').hash().hex(),
    blob: modules.util.HexBlob('ab'),
    builderExcluded: typeof txConstruction.GenericTxBuilder,
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
    for (const name of subpaths) {
      assert.ok(result.exports[name] > 0, `${file}: ${name} exports nothing`);
    }
    assert.equal(result.sharedUtil, true, `${file}: entries share one util`);
    assert.equal(result.address, 0, `${file}: address network id`);
    assert.match(result.keyHash, /^[0-9a-f]{56}$/, `${file}: key hash`);
    assert.equal(result.blob, 'ab', `${file}: HexBlob`);
    assert.equal(
      result.builderExcluded,
      'undefined',
      `${file}: the transaction builder is not published here`,
    );
  }

  // Every module the declarations import is a declared dependency: a
  // consumer's type check, which reads them in full, finds all of them.
  const BUILTINS = new Set(['buffer']);
  for (const file of fs.readdirSync(distribution)) {
    if (!/\.d\.(c|m)?ts$/.test(file)) continue;
    for (const specifier of importsOf(file)) {
      if (specifier.startsWith('.')) continue;
      assert.ok(
        !specifier.startsWith('packages/') && !specifier.startsWith('/'),
        `${file} imports ${specifier}, a workspace path`,
      );
      const name = packageOf(specifier.replace(/^node:/, ''));
      assert.ok(
        BUILTINS.has(name) ||
          name in manifest.dependencies ||
          `@types/${name}` in manifest.dependencies,
        `${file} imports ${specifier}, which ${manifest.name} does not declare`,
      );
    }
  }

  // The consumer fixture type-checks under every resolution, with the
  // package's declarations checked in full, as TypeScript does by default.
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
          skipLibCheck: false,
          types: ['node'],
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
    `${manifest.name}@${manifest.version}: ${
      subpaths.length
    } subpaths load through import and require() and type-check under ${Object.keys(
      RESOLUTIONS,
    ).join(', ')}`,
  );
} finally {
  fs.rmSync(installDirectory, { recursive: true, force: true });
}
