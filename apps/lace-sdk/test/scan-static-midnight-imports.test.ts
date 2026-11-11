import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, it } from 'vitest';

import {
  chunksHolding,
  filesImportingEntry,
  findLedgerReachingImports,
  findStaticMidnightImports,
  packageRequireClosure,
  undeclaredPackageRequires,
  unexpectedPackageImports,
} from '../src/scan-static-midnight-imports';

it('finds Midnight through Cardano ESM and CJS static chunks, not dynamic chunks', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lace-sdk-scan-'));
  try {
    fs.writeFileSync(
      path.join(directory, 'cardano.js'),
      "import './static.js';\nimport('./dynamic.js');\n",
    );
    fs.writeFileSync(
      path.join(directory, 'static.js'),
      "export { value } from '@midnight-ntwrk/compact-runtime';\n",
    );
    fs.writeFileSync(
      path.join(directory, 'dynamic.js'),
      "import '@polkadot/api';\n",
    );
    fs.writeFileSync(
      path.join(directory, 'cardano.cjs'),
      "const chunk = require('./static.cjs');\nPromise.resolve().then(() => require('./dynamic.cjs'));\n",
    );
    fs.writeFileSync(
      path.join(directory, 'static.cjs'),
      "require('@midnightntwrk/wallet-sdk');\n",
    );
    fs.writeFileSync(
      path.join(directory, 'dynamic.cjs'),
      "require('@polkadot/api');\n",
    );

    expect(findStaticMidnightImports(directory, 'cardano.js')).toEqual([
      'static.js: static import of "@midnight-ntwrk/compact-runtime"',
    ]);
    expect(findStaticMidnightImports(directory, 'cardano.cjs')).toEqual([
      'static.cjs: static import of "@midnightntwrk/wallet-sdk"',
    ]);
    // The import-only check follows the lazy chunks as well, since the engine
    // may sit behind one; the imports it reports are still the static ones.
    expect(
      findStaticMidnightImports(directory, 'cardano.js', { lazyChunks: true }),
    ).toEqual([
      'static.js: static import of "@midnight-ntwrk/compact-runtime"',
      'dynamic.js: static import of "@polkadot/api"',
    ]);
    expect(
      findStaticMidnightImports(directory, 'cardano.cjs', { lazyChunks: true }),
    ).toEqual([
      'static.cjs: static import of "@midnightntwrk/wallet-sdk"',
      'dynamic.cjs: static import of "@polkadot/api"',
    ]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it('names every package a CommonJS closure requires or imports, static and lazy, by package', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lace-sdk-closure-'));
  try {
    fs.writeFileSync(
      path.join(directory, 'midnight.cjs'),
      "const chunk = require('./static.cjs');\nPromise.resolve().then(() => require('./lazy.cjs'));\nrequire('rxjs');\n",
    );
    fs.writeFileSync(
      path.join(directory, 'static.cjs'),
      "require('@midnight-ntwrk/ledger-v8');\nrequire('node:crypto');\n",
    );
    fs.writeFileSync(
      path.join(directory, 'lazy.cjs'),
      "import('@polkadot/api-base/types/errors');\nrequire('lodash/isEqual.js');\n",
    );
    const closure = packageRequireClosure(directory, 'midnight.cjs');
    expect([...closure.keys()].sort()).toEqual([
      '@midnight-ntwrk/ledger-v8',
      '@polkadot/api-base',
      'lodash',
      'node:crypto',
      'rxjs',
    ]);
    expect([...closure.get('@polkadot/api-base')!]).toEqual(['lazy.cjs']);
    // The build refuses a package in that closure that package.json does not
    // declare, naming the file that requires it; built-ins never count.
    const declared = {
      rxjs: '^7',
      lodash: '^4',
      '@midnight-ntwrk/ledger-v8': '8.1.0',
    };
    expect(
      undeclaredPackageRequires(directory, 'midnight.cjs', declared),
    ).toEqual(['@polkadot/api-base (lazy.cjs)']);
    expect(
      undeclaredPackageRequires(directory, 'midnight.cjs', {
        ...declared,
        '@polkadot/api-base': '^16',
      }),
    ).toEqual([]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it('names every package an ESM closure imports, static and lazy, by package', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lace-sdk-closure-'));
  try {
    fs.writeFileSync(
      path.join(directory, 'experimental.js'),
      "import { a } from './static.js';\nimport('./lazy.js');\nimport('@midnightntwrk/wallet-sdk-facade');\n",
    );
    fs.writeFileSync(
      path.join(directory, 'static.js'),
      "import { b } from '@midnightntwrk/ledger-v9';\nimport 'node:crypto';\nexport { c } from 'rxjs';\n",
    );
    fs.writeFileSync(
      path.join(directory, 'lazy.js'),
      "/**\n * @example\n```js\nimport * as bip39 from '@scure/bip39';\n```\n */\nimport { d } from '@midnight-ntwrk/compact-runtime';\n",
    );
    expect(
      undeclaredPackageRequires(directory, 'experimental.js', { rxjs: '^7' }),
    ).toEqual([
      '@midnightntwrk/wallet-sdk-facade (experimental.js)',
      '@midnightntwrk/ledger-v9 (static.js)',
      '@midnight-ntwrk/compact-runtime (lazy.js)',
    ]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it('reports the Midnight packages a static closure inlines only when asked, and not those of a lazy chunk', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lace-sdk-scan-'));
  try {
    fs.writeFileSync(
      path.join(directory, 'midnight-worker.js'),
      "import './midnight-worker-static.js';\nimport('./midnight-worker-lazy.js');\n",
    );
    fs.writeFileSync(
      path.join(directory, 'midnight-worker-static.js'),
      [
        '//#region ../../node_modules/rxjs/dist/esm5/index.js',
        '//#region ../../node_modules/@midnightntwrk/wallet-sdk-hd/dist/index.js',
        '//#region ../../packages/lib/x/node_modules/@polkadot/util/index.js',
        '//#region ../../packages/module/midnight-sync/src/index.ts',
        'export const value = 1;',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(directory, 'midnight-worker-lazy.js'),
      "//#region ../../node_modules/@midnightntwrk/wallet-sdk-facade/dist/index.js\nimport { a } from '@midnight-ntwrk/ledger-v8';\n",
    );

    expect(findStaticMidnightImports(directory, 'midnight-worker.js')).toEqual(
      [],
    );
    expect(
      findStaticMidnightImports(directory, 'midnight-worker.js', {
        inlined: true,
      }),
    ).toEqual([
      'midnight-worker-static.js: inlines "@midnightntwrk/wallet-sdk-hd"',
      'midnight-worker-static.js: inlines "@polkadot/util"',
    ]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it('names each package outside the allowed patterns that a closure imports, static or lazy, but no built-in', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lace-sdk-closure-'));
  try {
    fs.writeFileSync(
      path.join(directory, 'midnight-worker.js'),
      "import { a } from './midnight-worker-util.js';\nimport('./midnight-worker-engine.js');\n",
    );
    fs.writeFileSync(
      path.join(directory, 'midnight-worker-util.js'),
      'var types = freeModule && freeModule.require && freeModule.require("util").types;\n',
    );
    fs.writeFileSync(
      path.join(directory, 'midnight-worker-engine.js'),
      [
        "import * as ledger from '@midnight-ntwrk/ledger-v8';",
        "import { b } from '@subsquid/scale-codec';",
        "import { c } from '@subsquid/util-internal-hex';",
        "import { d } from '@polkadot/api';",
        "import { e } from '@midnight-ntwrk/compact-runtime';",
      ].join('\n'),
    );
    const allowed = [
      /^@midnight-ntwrk\/ledger-v\d+$/,
      /^@subsquid\/scale-codec$/,
    ];
    expect(
      unexpectedPackageImports(directory, 'midnight-worker.js', allowed),
    ).toEqual([
      '@subsquid/util-internal-hex (midnight-worker-engine.js)',
      '@polkadot/api (midnight-worker-engine.js)',
      '@midnight-ntwrk/compact-runtime (midnight-worker-engine.js)',
    ]);
    expect(
      unexpectedPackageImports(directory, 'midnight-worker.js', [
        ...allowed,
        /^@subsquid\//,
        /^@polkadot\//,
        /^@midnight-ntwrk\//,
      ]),
    ).toEqual([]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it('names each file of an entry graph, static and lazy, that imports the entry itself', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lace-sdk-graph-'));
  try {
    fs.writeFileSync(
      path.join(directory, 'midnight-worker.js'),
      "import { a } from './midnight-worker-shared.js';\nimport('./midnight-worker-host.js');\n",
    );
    fs.writeFileSync(
      path.join(directory, 'midnight-worker-shared.js'),
      "/**\n * @example\n```js\nimport { b } from './midnight-worker.js';\n```\n */\nexport const a = 1;\n",
    );
    fs.writeFileSync(
      path.join(directory, 'midnight-worker-host.js'),
      "import { a } from './midnight-worker-shared.js';\nimport { take } from \"./midnight-worker.js\";\nimport('./midnight-worker-init.js');\n",
    );
    fs.writeFileSync(
      path.join(directory, 'midnight-worker-init.js'),
      "import('./midnight-worker.js');\n",
    );
    expect(filesImportingEntry(directory, 'midnight-worker.js')).toEqual([
      'midnight-worker-host.js',
      'midnight-worker-init.js',
    ]);
    fs.writeFileSync(
      path.join(directory, 'midnight-worker-host.js'),
      "import { a } from './midnight-worker-shared.js';\nimport { take } from './midnight-worker-take.js';\n",
    );
    fs.writeFileSync(
      path.join(directory, 'midnight-worker-take.js'),
      'export const take = 1;\n',
    );
    expect(filesImportingEntry(directory, 'midnight-worker.js')).toEqual([]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it('reports the ledger-reaching imports of several roots together: the ledger of either scope, the address format and the wallet SDK engine, but not its HD derivation or abstractions', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lace-sdk-ledger-'));
  try {
    fs.writeFileSync(
      path.join(directory, 'midnight.js'),
      "import './light.js';\nimport('./page-init.js');\n",
    );
    fs.writeFileSync(
      path.join(directory, 'light.js'),
      [
        "import { NetworkId } from '@midnightntwrk/wallet-sdk-abstractions';",
        "import { HDWallet } from '@midnightntwrk/wallet-sdk/hd';",
        "import { HDWallet as Leaf } from '@midnightntwrk/wallet-sdk-hd';",
        "import { ErrorCodes } from '@midnight-ntwrk/dapp-connector-api';",
        "import { Buffer } from 'buffer';",
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(directory, 'page-init.js'),
      "import './light.js';\nimport * as ledger from '@midnight-ntwrk/ledger-v8';\n",
    );
    fs.writeFileSync(
      path.join(directory, 'addon.js'),
      [
        "import { EncryptionSecretKey } from '@midnightntwrk/wallet-sdk-address-format';",
        "import { WalletFacade } from '@midnightntwrk/wallet-sdk/facade';",
        "import { DustWallet } from '@midnightntwrk/wallet-sdk-dust-wallet';",
        "import * as v9 from '@midnightntwrk/ledger-v9';",
        "import { ContractState } from '@midnight-ntwrk/compact-runtime';",
      ].join('\n'),
    );

    // The lazy page init is not followed; the addon root is checked as a second root.
    expect(findLedgerReachingImports(directory, ['midnight.js'])).toEqual([]);
    expect(
      findLedgerReachingImports(directory, ['midnight.js', 'addon.js']),
    ).toEqual([
      'addon.js: static import of "@midnightntwrk/wallet-sdk-address-format"',
      'addon.js: static import of "@midnightntwrk/wallet-sdk/facade"',
      'addon.js: static import of "@midnightntwrk/wallet-sdk-dust-wallet"',
      'addon.js: static import of "@midnightntwrk/ledger-v9"',
      'addon.js: static import of "@midnight-ntwrk/compact-runtime"',
    ]);
    expect(findLedgerReachingImports(directory, ['page-init.js'])).toEqual([
      'page-init.js: static import of "@midnight-ntwrk/ledger-v8"',
    ]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it('finds the one chunk of the right format that inlines each source, by its region marker, and refuses none or several', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lace-sdk-chunks-'));
  try {
    fs.writeFileSync(
      path.join(directory, 'midnight-engine-Ab12.js'),
      '//#region ../../packages/module/midnight-sync/src/exported-modules/midnight-engine.ts\nexport const a = 1;\n',
    );
    fs.writeFileSync(
      path.join(directory, 'midnight-engine-Cd34.cjs'),
      '//#region ../../packages/module/midnight-sync/src/exported-modules/midnight-engine.ts\nexports.a = 1;\n',
    );
    fs.writeFileSync(
      path.join(directory, 'other.js'),
      '//#region ../../packages/module/midnight-sync/src/store/sdk-init.ts\nexport const b = 1;\n',
    );
    const engine =
      'packages/module/midnight-sync/src/exported-modules/midnight-engine.ts';

    expect(chunksHolding(directory, [engine], 'midnight.js')).toEqual([
      'midnight-engine-Ab12.js',
    ]);
    expect(chunksHolding(directory, [engine], 'midnight.cjs')).toEqual([
      'midnight-engine-Cd34.cjs',
    ]);
    expect(() =>
      chunksHolding(directory, ['src/missing.ts'], 'midnight.js'),
    ).toThrow('found 0');
    fs.writeFileSync(
      path.join(directory, 'twin.js'),
      '//#region ../../packages/module/midnight-sync/src/exported-modules/midnight-engine.ts\n',
    );
    expect(() => chunksHolding(directory, [engine], 'midnight.js')).toThrow(
      'found 2',
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
