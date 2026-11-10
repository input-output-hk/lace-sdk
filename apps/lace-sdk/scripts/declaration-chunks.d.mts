/** Types for declaration-chunks.mjs, for its TypeScript callers. */
import type { OutputOptions, Plugin } from 'rollup';

export const DECLARATION_OUTPUT: OutputOptions;
export const declarationFiles: (directory: string) => string[];

export const redirectSdkBarrelReferences: (build: {
  dtsWork: string;
  resolveDtsFile: (file: string) => string;
  toRelative: (fromFile: string, target: string) => string;
  moduleSuffixes: string[];
}) => void;
export const namespaceMembersFromOtherChunks: Plugin;
export const extractLaceAugmentations: (lines: string[]) => {
  kept: string[];
  blocks: { specifier: string; lines: string[] }[];
};
export const placeModuleAugmentations: (build: {
  resolveInternalSpecifier: (specifier: string) => string | null;
}) => Plugin;
export const assertDeclarationLayout: (build: {
  entries: string[];
  allowedEntryImports?: Record<string, string[]>;
}) => Plugin;
