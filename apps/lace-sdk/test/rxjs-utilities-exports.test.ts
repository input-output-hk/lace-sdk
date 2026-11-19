import * as rxjsUtilities from '@lace-lib/cardano-util-rxjs';
import { describe, expect, it } from 'vitest';

import * as sdk from '../src';
import * as canary from '../src/index.canary';

import type {
  BehaviorObservable,
  ObservableType,
  PollProps,
  ReconnectionConfig,
} from '../src';

const RXJS_UTILITIES = [
  'TrackerSubject',
  'blockingWithLatestFrom',
  'concatAndCombineLatest',
  'finalizeWithLatest',
  'passthrough',
  'poll',
  'shareRetryBackoff',
  'toEmpty',
] as const;

describe('RxJS utility exports', () => {
  it('exports every runtime name of @cardano-sdk/util-rxjs', () => {
    expect(Object.keys(rxjsUtilities).sort()).toEqual(
      [...RXJS_UTILITIES].sort(),
    );
  });

  it.each(RXJS_UTILITIES)(
    'exports %s from the root entry of both builds',
    name => {
      expect(sdk[name]).toBeDefined();
      expect(sdk[name]).toBe(rxjsUtilities[name]);
      expect(canary[name]).toBe(rxjsUtilities[name]);
    },
  );

  it('exports the types of @cardano-sdk/util-rxjs', () => {
    const props: PollProps<number> = {
      sample: async () => 1,
      retryBackoffConfig: { initialInterval: 1 },
      logger: console,
    };
    const reconnection: ReconnectionConfig = { initialInterval: 1 };
    const tracked: BehaviorObservable<number> = new sdk.TrackerSubject(
      sdk.poll(props),
    );
    const value: ObservableType<typeof tracked> = 1;

    expect([reconnection.initialInterval, value]).toEqual([1, 1]);
    (tracked as sdk.TrackerSubject<number>).complete();
  });
});
