import type { MidnightSDKNetworkId } from '@lace-contract/midnight-context';
import type { ConnectedAPI } from '@midnight-ntwrk/dapp-connector-api';
import type { Runtime } from 'webextension-polyfill';

export type NetworkInfo = {
  getNetworkId: () => Promise<MidnightSDKNetworkId>;
  checkNetworkSupport: (networkId: string) => Promise<void>;
};

export type LockInfo = {
  isLocked: () => Promise<boolean>;
};

/**
 * Raw proof-server access behind the page-side `getProvingProvider`. The
 * dApp holds its circuits' key material, so the page assembles each `/check`
 * and `/prove` payload itself and the wallet forwards the opaque bytes over
 * the proof server it is configured with — for `tee-delegated`, the attested
 * channel. The wallet never resolves a URL for the dApp.
 */
export type ProofServerApi = {
  checkCircuit: (payload: Uint8Array) => Promise<Uint8Array>;
  proveCircuit: (payload: Uint8Array) => Promise<Uint8Array>;
};

/**
 * The connector surface the service worker implements: `getProvingProvider`
 * is page-side only (it needs the dApp's key-material callbacks, which cannot
 * cross the messaging boundary) and is composed over {@link ProofServerApi}.
 */
export type DAppConnectorWalletAPI = Omit<ConnectedAPI, 'getProvingProvider'> &
  ProofServerApi;

export type ExtendedDAppConnectorWalletAPI = DAppConnectorWalletAPI &
  LockInfo &
  NetworkInfo;

export type SenderContext = { sender: Runtime.MessageSender };
type FunctionWithSender<T> = T extends (...args: infer Args) => infer R
  ? (...args: [...Args, SenderContext]) => R
  : T;

export type WithSenderContext<T> = {
  [K in keyof T]: FunctionWithSender<T[K]>;
};
