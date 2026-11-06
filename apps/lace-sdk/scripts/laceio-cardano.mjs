// The SDK depends on @laceio/cardano, the Cardano domain layer this
// repository maintains (ADR 68), rather than bundling its own copy of the
// workspace packages that layer publishes, so an app using both can share one
// copy of its classes and types. The platform's sources import
// @lace-lib/cardano-<name>, so the SDK's bundle (tsdown.config.ts) and its
// declarations (rollup.dts.config.mjs) both resolve each package the domain
// layer publishes to its @laceio/cardano/<name> subpath, external. The
// subpaths are the ones its package.json exports, so the two builds and the
// package cannot disagree. Worker mode's worker, which shares nothing with an
// app, bundles the subpath instead (tsdown.config.ts).
import fs from 'node:fs';
import path from 'node:path';

const manifest = JSON.parse(
  fs.readFileSync(
    path.resolve(import.meta.dirname, '../../lace-cardano/package.json'),
    'utf8',
  ),
);

/** The subpaths @laceio/cardano publishes: `core`, `crypto`, … */
export const CARDANO_SUBPATHS = new Set(
  Object.keys(manifest.exports).map(subpath => subpath.replace(/^\.\//, '')),
);

/** The @laceio/cardano subpath an @lace-lib/cardano-<name> import maps to. */
export const cardanoSubpathOf = source => {
  const match = /^@lace-lib\/cardano-([a-z-]+)$/.exec(source);
  return match && CARDANO_SUBPATHS.has(match[1]) ? match[1] : undefined;
};

/**
 * Whether `file` belongs to a workspace package @laceio/cardano publishes,
 * which the SDK imports from it rather than bundling.
 */
export const isLaceioCardanoFile = file => {
  const match = /[/\\]packages[/\\]lib[/\\]cardano-([a-z-]+)[/\\]/.exec(file);
  return Boolean(match && CARDANO_SUBPATHS.has(match[1]));
};

/** Resolves each workspace package the domain layer publishes to it, external. */
export const useLaceioCardano = {
  name: 'use-laceio-cardano',
  resolveId: source => {
    const subpath = cardanoSubpathOf(source);
    return subpath
      ? { id: `@laceio/cardano/${subpath}`, external: true }
      : null;
  },
};
