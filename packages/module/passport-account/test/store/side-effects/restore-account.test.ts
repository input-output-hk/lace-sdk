import { GrantId, GrantSlot, passportActions } from '@lace-contract/passport';
import { testSideEffect } from '@lace-lib/util-dev';
import { of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';

import { accManifest } from '../../../src/acc/manifest';
import { sealRecord } from '../../../src/store/envelope';
import { restorePassportAccount } from '../../../src/store/side-effects/restore-account';

import type { RestoredAccount } from '../../../src/flows/restore-account';
import type { FlowEvent } from '../../../src/store/dependencies';
import type {
  ActionCreators,
  GrantRecord,
  Selectors,
} from '@lace-contract/passport';
import type { RunHelpers } from 'rxjs/testing';

const actions = { ...passportActions };

const accountAddress = 'ac'.repeat(32);
const grantId = GrantId('ab'.repeat(32));
const network = {
  networkId: 'undeployed',
  indexerUrl: 'http://indexer.example.com/api/v3/graphql',
  indexerWsUrl: 'ws://indexer.example.com/api/v3/graphql/ws',
  nodeUrl: 'http://node.example.com',
  artefactUrl: 'http://artefacts.example.com/account',
};
const record = {
  address: accountAddress,
  bindingVersion: '0.1.0-lace.1',
  localUseCounter: '4',
};
const grantRecord: GrantRecord = {
  id: grantId,
  slot: GrantSlot(3),
  active: true,
  epoch: 0,
  generation: 0,
  issuedAt: 1,
  scope: {
    operations: ['withdraw-unshielded'],
    read: false,
    objectCommit: '00'.repeat(32),
    perCallCap: '300',
    cap: '450',
    expiresAt: null,
    rpCommit: '00'.repeat(32),
    readPkHash: '00'.repeat(32),
    window: null,
    callerCommit: '00'.repeat(32),
  },
  spentWindow: { start: 0, spent: '0' },
};

/** The default bundle alone, and the default with one more build. */
const defaultOnly = { bundles: [{ id: 'account' }] };
const withTally = { bundles: [{ id: 'account' }, { id: 'account-tally' }] };

const restoredOf = (bundleId: string) => ({
  a: actions.passport.setAccount({
    address: record.address,
    bindingVersion: record.bindingVersion,
    bundleId,
    status: 'ready',
    networkId: 'undeployed',
  }),
  c: actions.passport.setLocalUseCounter('4'),
  g: actions.passport.setGrants([grantRecord]),
});

const events = (
  bundleId: string,
): Record<string, FlowEvent<RestoredAccount>> => ({
  r: { type: 'done', result: { bundleId, grants: [grantRecord] } },
});

type RestoreTest = {
  stored: unknown[];
  bundles: { bundles: { id: string }[] };
  restored: (cold: RunHelpers['cold']) => ReturnType<RunHelpers['cold']>;
  assertion: (harness: {
    sideEffect$: Parameters<RunHelpers['expectObservable']>[0];
    helpers: RunHelpers;
    restoreAccount: ReturnType<typeof vi.fn>;
  }) => void;
};

/**
 * Drives the restore on the virtual scheduler with the stored records
 * read in one frame and the chain read replaced by a cold marble.
 */
const runRestoreTest = ({
  stored,
  bundles,
  restored,
  assertion,
}: RestoreTest) => {
  testSideEffect<Selectors, ActionCreators>(restorePassportAccount, helpers => {
    const { cold } = helpers;
    const restoreAccount = vi.fn(() => restored(cold));
    const storage = {
      getValues: vi.fn(() => cold('(s|)', { s: stored })),
      setValue: vi.fn(),
    };
    return {
      dependencies: {
        actions,
        createKeyValueStorage: vi.fn(() => storage),
        passportBundles: bundles,
        passportFlows: { restoreAccount },
        passportNetwork: network,
      } as never,
      assertion: sideEffect$ => {
        assertion({ sideEffect$, helpers, restoreAccount });
      },
    };
  });
};

describe('restorePassportAccount', () => {
  describe('with the default bundle alone', () => {
    it('publishes the account and use counter in the frame of the read, then the roster the chain holds', () => {
      runRestoreTest({
        stored: [record],
        bundles: defaultOnly,
        restored: cold => cold('-----(r|)', events('account')),
        assertion: ({ sideEffect$, helpers, restoreAccount }) => {
          helpers
            .expectObservable(sideEffect$)
            .toBe('(ac)-(g|)', restoredOf('account'));
          helpers.flush();
          expect(restoreAccount).toHaveBeenCalledExactlyOnceWith(
            record,
            expect.objectContaining({ actions }),
          );
        },
      });
    });

    it('keeps the account restored when the chain read fails', () => {
      runRestoreTest({
        stored: [record],
        bundles: defaultOnly,
        restored: cold => cold('-----#', {}, new Error('indexer down')),
        assertion: ({ sideEffect$, helpers }) => {
          helpers
            .expectObservable(sideEffect$)
            .toBe('(ac)-|', restoredOf('account'));
        },
      });
    });
  });

  describe('with more builds registered', () => {
    it('publishes the account under the bundle its verifier keys resolve to, with the use counter and roster, once the chain is read', () => {
      runRestoreTest({
        stored: [record],
        bundles: withTally,
        restored: cold => cold('--(r|)', events('account-tally')),
        assertion: ({ sideEffect$, helpers }) => {
          helpers
            .expectObservable(sideEffect$)
            .toBe('--(acg|)', restoredOf('account-tally'));
        },
      });
    });

    it('restores nothing when the chain read fails, leaving sign-in to report it', () => {
      runRestoreTest({
        stored: [record],
        bundles: withTally,
        restored: cold => cold('--#', {}, new Error('no bundle covers it')),
        assertion: ({ sideEffect$, helpers }) => {
          helpers.expectObservable(sideEffect$).toBe('--|');
        },
      });
    });
  });

  it('emits nothing for a record whose deployment is still pending', () => {
    const pendingRecord = {
      ...record,
      deployment: {
        operations: ['deposit_unshielded'],
        lockAccount: true,
        saltHex: '07'.repeat(32),
        authorityKey: { tag: 'schnorr', value: 'authority-key' },
        handoverAuthority: { tag: 'schnorr', value: 'cd'.repeat(32) },
      },
    };
    runRestoreTest({
      stored: [pendingRecord],
      bundles: defaultOnly,
      restored: cold => cold('(r|)', events('account')),
      assertion: ({ sideEffect$, helpers, restoreAccount }) => {
        helpers.expectObservable(sideEffect$).toBe('|');
        helpers.flush();
        expect(restoreAccount).not.toHaveBeenCalled();
      },
    });
  });

  it('emits nothing when no account record is persisted', () => {
    runRestoreTest({
      stored: [],
      bundles: defaultOnly,
      restored: cold => cold('(r|)', events('account')),
      assertion: ({ sideEffect$, helpers, restoreAccount }) => {
        helpers.expectObservable(sideEffect$).toBe('|');
        helpers.flush();
        expect(restoreAccount).not.toHaveBeenCalled();
      },
    });
  });

  it('emits nothing for a sealed record, which needs a ceremony to open', async () => {
    const key = await crypto.subtle.importKey(
      'raw',
      new Uint8Array(32).fill(7),
      { name: 'AES-GCM' },
      false,
      ['encrypt', 'decrypt'],
    );
    const sealed = await sealRecord(key, {
      ...record,
      bindingVersion: accManifest.bindingVersion,
    });
    const restoreAccount = vi.fn();
    const published: unknown[] = [];
    await new Promise<void>((resolve, reject) => {
      restorePassportAccount(
        {} as never,
        {} as never,
        {
          actions,
          createKeyValueStorage: vi.fn(() => ({
            getValues: vi.fn(() => of([sealed])),
            setValue: vi.fn(),
          })),
          passportBundles: defaultOnly,
          passportFlows: { restoreAccount },
          passportNetwork: network,
        } as never,
      ).subscribe({
        next: action => published.push(action),
        error: reject,
        complete: resolve,
      });
    });

    expect(published).toEqual([]);
    expect(restoreAccount).not.toHaveBeenCalled();
  });
});
