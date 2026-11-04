import { GrantId, GrantSlot } from '@lace-contract/passport';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { restoreAccount } from '../../src/flows/restore-account';

import type { FlowContext } from '../../src/flows/types';

const mocks = vi.hoisted(() => ({
  createIndexerClient: vi.fn(),
  queryAccountByBuild: vi.fn(),
  readGrants: vi.fn(),
}));

vi.mock('../../src/infra/indexer', () => ({
  createIndexerClient: mocks.createIndexerClient,
}));
vi.mock('../../src/flows/account-call', () => ({
  queryAccountByBuild: mocks.queryAccountByBuild,
}));
vi.mock('../../src/acc/read-grants', () => ({
  readGrants: mocks.readGrants,
}));

const accountAddress = 'ac'.repeat(32);
const grantId = GrantId('ab'.repeat(32));
const network = {
  networkId: 'undeployed',
  indexerUrl: 'http://indexer.example.com/api/v3/graphql',
  indexerWsUrl: 'ws://indexer.example.com/api/v3/graphql/ws',
};
const indexer = { tag: 'indexer' };
const ledgerState = { tag: 'decoded-ledger-state' };
const bundles = { tag: 'registry' };
const context = {
  seams: { passportNetwork: network },
  bundles,
} as unknown as FlowContext;
const record = {
  address: accountAddress,
  bindingVersion: '0.1.0-lace.1',
  localUseCounter: '4',
};

describe('restoreAccount', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createIndexerClient.mockReturnValue(indexer);
    mocks.queryAccountByBuild.mockResolvedValue({
      bundle: { id: 'account-tally' },
      ledgerState,
    });
    mocks.readGrants.mockReturnValue([]);
  });

  it('answers the bundle the chain resolves and the roster read with the slots the record kept', async () => {
    const grants = [{ id: grantId }];
    mocks.readGrants.mockReturnValue(grants);
    const storedGrant = {
      slot: 3,
      scopeSalt: '07'.repeat(32),
      granteePublicKey: 'cd'.repeat(32),
      origin: 'lace.io',
    };

    await expect(
      restoreAccount(
        { ...record, grants: { [grantId]: storedGrant } },
        context,
      ),
    ).resolves.toEqual({ bundleId: 'account-tally', grants });
    expect(mocks.createIndexerClient).toHaveBeenCalledExactlyOnceWith({
      indexerUrl: network.indexerUrl,
      indexerWsUrl: network.indexerWsUrl,
    });
    expect(mocks.queryAccountByBuild).toHaveBeenCalledExactlyOnceWith(
      indexer,
      accountAddress,
      bundles,
    );
    expect(mocks.readGrants).toHaveBeenCalledExactlyOnceWith(
      ledgerState,
      new Map([[grantId, GrantSlot(3)]]),
    );
  });

  it('reads an empty roster for an account that issued no grant', async () => {
    await expect(restoreAccount(record, context)).resolves.toEqual({
      bundleId: 'account-tally',
      grants: [],
    });
    expect(mocks.readGrants).toHaveBeenCalledExactlyOnceWith(
      ledgerState,
      new Map(),
    );
  });

  it('propagates a chain read the indexer or the registry refuses', async () => {
    const refused = new Error('no bundle covers the account');
    mocks.queryAccountByBuild.mockRejectedValue(refused);

    await expect(restoreAccount(record, context)).rejects.toBe(refused);
    expect(mocks.readGrants).not.toHaveBeenCalled();
  });
});
