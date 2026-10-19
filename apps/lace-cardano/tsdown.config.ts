import { defineConfig } from 'tsdown';

// One entry per published subpath. The ported @lace-lib/cardano-* packages and
// @lace-lib/util/common, which holds the ported general-purpose utilities, are
// inlined, with the modules several entries share emitted once as chunks, so a
// consumer holds one copy of each; every other package stays an import of a
// declared dependency, which the consumer shares with the rest of its install.
export const ENTRIES = [
  'core',
  'crypto',
  'util',
  'key-management',
  'input-selection',
  'tx-construction',
  'dapp-connector',
] as const;

const isPortedPackage = (id: string) =>
  id.startsWith('@lace-lib/cardano-') || id === '@lace-lib/util/common';
const isBareSpecifier = (id: string) => /^[^./]/.test(id);

export default defineConfig({
  entry: Object.fromEntries(ENTRIES.map(entry => [entry, `src/${entry}.ts`])),
  format: ['esm', 'cjs'],
  // The ported packages' declarations are bundled too, so the published
  // types stand on their own.
  dts: {
    resolve: [/^@lace-lib\/cardano-/, /^@lace-lib\/util\/common$/],
    // Rooted at the repository so the ported packages' sources emit.
    tsconfig: './tsconfig.dts.json',
    eager: true,
  },
  platform: 'neutral',
  target: 'es2022',
  clean: true,
  external: id => isBareSpecifier(id) && !isPortedPackage(id),
});
