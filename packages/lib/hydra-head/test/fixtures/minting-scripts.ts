import recorded from './preprod-head-minting-scripts.blockfrost.json';

import type { HydraOutRef, HydraProtocolVersion } from '../../src';

/** Minting script of a real head, as Blockfrost `scripts/{hash}/cbor` returns it. */
export type RecordedMintingScript = {
  version: HydraProtocolVersion;
  headId: string;
  /** Output reference the head's init spent, applied to the script. */
  seed: HydraOutRef;
  cbor: string;
};

/** Minting scripts of one real Preprod head of every registered release. */
export const preprodMintingScripts: RecordedMintingScript[] = recorded.heads;
