/** Types for entries.mjs, for its TypeScript callers. */
type Channel = 'canary' | 'stable';

export const STABLE_ENTRIES: readonly string[];
export const CANARY_ONLY_ENTRIES: readonly {
  name: string;
  peers: readonly RegExp[];
  publishedPeers?: Readonly<Record<string, string>>;
  source?: string;
  importsMidnight?: boolean;
}[];
export const MIDNIGHT_WORKER: {
  readonly name: string;
  readonly source: string;
};
export const channelBuildInputSources: (channel: Channel) => string[];
export const channelEntryNames: (channel: Channel) => string[];
export const entrySource: (entry: string, channel: Channel) => string;
export const SHARED_DECLARATIONS: RegExp;
export const entryFiles: (entry: string) => string[];
export const channelPublishedPeers: (
  channel: Channel,
) => Readonly<Record<string, string>>;
