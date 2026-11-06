import type { Plugin } from 'rolldown';

export const CARDANO_SUBPATHS: ReadonlySet<string>;
export const cardanoSubpathOf: (source: string) => string | undefined;
export const isLaceioCardanoFile: (file: string) => boolean;
export const useLaceioCardano: Plugin;
