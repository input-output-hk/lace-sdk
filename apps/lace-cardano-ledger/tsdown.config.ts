import { defineConfig } from 'tsdown';

// The adapter's own source is inlined; the domain layer it is written against
// stays an import of @laceio/cardano, which the consumer shares with the rest
// of its install, and every other package an import of a declared dependency.
const PORTED = /^@lace-lib\/cardano-([a-z-]+)$/;
const isAdapterSource = (id: string) =>
  id === '@lace-lib/cardano-hardware-ledger';
const isBareSpecifier = (id: string) => /^[^./]/.test(id);

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm', 'cjs'],
  dts: {
    resolve: [/^@lace-lib\/cardano-hardware-/],
    // Rooted at the repository so the adapter's sources emit.
    tsconfig: './tsconfig.dts.json',
    eager: true,
  },
  platform: 'neutral',
  target: 'es2022',
  clean: true,
  external: id => isBareSpecifier(id) && !isAdapterSource(id),
  outputOptions: {
    paths: id =>
      id === '@lace-lib/util/common'
        ? '@laceio/cardano/util'
        : id.replace(PORTED, '@laceio/cardano/$1'),
  },
});
