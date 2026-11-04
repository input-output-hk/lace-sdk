import { firstValueFrom } from 'rxjs';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  encodeMidnightFinalizedTx,
  midnightEngineGeneration,
} from '../../src/worker/codec';

import {
  fakeEngines,
  finalized,
  PASSWORD,
  sealedAccount,
  settings,
  useFastKeyDerivation,
} from './engine-host-fakes';
import { createHost } from './engine-host-setup';

import type {
  OpaqueMidnightFinalizedTx,
  OpaqueMidnightRecipe,
} from '../../src/worker/codec';
import type {
  MidnightEngineHost,
  MidnightWorkerCaller,
} from '../../src/worker/protocol';
import type {
  MidnightAccountProps,
  MidnightWallet,
} from '@lace-contract/midnight-context';
import type { InMemoryWalletAccount } from '@lace-contract/wallet-repo';

vi.mock('../../src/store/dependencies', async importOriginal => {
  const fakes = await import('./engine-host-fakes');
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    createStartMidnightAccountWallet: fakes.fakeEngines.createStart,
  };
});

const originOf = (engine: MidnightWallet) => ({
  accountId: engine.accountId,
  engineGeneration: midnightEngineGeneration(engine),
});

const reasonOf = async (call: Promise<unknown>) =>
  call.then(
    () => 'resolved',
    (error: unknown) => (error as { reason?: string }).reason ?? error,
  );

type Values = {
  recipe: OpaqueMidnightRecipe;
  proved: OpaqueMidnightFinalizedTx;
};

const valuesOf = async (
  host: MidnightEngineHost,
  caller: MidnightWorkerCaller,
): Promise<Values> => ({
  recipe: await host.build({
    ...caller,
    tx: { kind: 'dust-registration' },
  }),
  proved: encodeMidnightFinalizedTx(
    finalized(),
    originOf(fakeEngines.current(caller.accountId).engine),
  ),
});

const refusals = async (
  host: MidnightEngineHost,
  caller: MidnightWorkerCaller,
  { recipe, proved }: Values,
) =>
  Promise.all([
    reasonOf(host.sign({ ...caller, recipe })),
    reasonOf(host.prove({ ...caller, recipe })),
    reasonOf(host.discard({ ...caller, recipe })),
    reasonOf(host.submit({ ...caller, transaction: proved })),
  ]);

const STALE = ['stale-value', 'stale-value', 'stale-value', 'stale-value'];

describe('engine-host-generations', () => {
  let a: InMemoryWalletAccount<MidnightAccountProps>;
  let b: InMemoryWalletAccount<MidnightAccountProps>;
  const attach = async (
    host: MidnightEngineHost,
    clientId: string,
    account: InMemoryWalletAccount<MidnightAccountProps>,
  ) =>
    host.attach({
      clientId,
      account,
      password: PASSWORD.slice(),
      settings: settings(),
    });

  beforeAll(async () => {
    useFastKeyDerivation();
    a = await sealedAccount({ walletId: 'wallet-a' });
    b = await sealedAccount({ walletId: 'wallet-b' });
  });
  beforeEach(() => {
    fakeEngines.reset();
  });

  it('refuses values from before a runtime restart', async () => {
    const before = createHost().host;
    const caller = { clientId: 'tab-1', accountId: a.accountId };
    const { engineGeneration } = await attach(before, 'tab-1', a);
    const values = await valuesOf(before, caller);
    const after = createHost().host;

    const restarted = await attach(after, 'tab-1', a);

    expect(restarted.engineGeneration).not.toBe(engineGeneration);
    await expect(refusals(after, caller, values)).resolves.toEqual(STALE);
  });

  it('refuses values from before an account reset', async () => {
    const { host } = createHost();
    const caller = { clientId: 'tab-1', accountId: a.accountId };
    const { engineGeneration } = await attach(host, 'tab-1', a);
    const values = await valuesOf(host, caller);

    await host.resetAccount({ ...caller, storage: 'memory' });
    const status = await firstValueFrom(host.streams(caller).status$);

    expect(status.engineGeneration).not.toBe(engineGeneration);
    expect(status.engineGeneration).toBe(
      midnightEngineGeneration(fakeEngines.current(a.accountId).engine),
    );
    await expect(refusals(host, caller, values)).resolves.toEqual(STALE);
  });

  it('refuses values of every account from before a bulk resync', async () => {
    const { host } = createHost();
    const callerA = { clientId: 'tab-1', accountId: a.accountId };
    const callerB = { clientId: 'tab-2', accountId: b.accountId };
    const generations = [
      (await attach(host, 'tab-1', a)).engineGeneration,
      (await attach(host, 'tab-2', b)).engineGeneration,
    ];
    const valuesA = await valuesOf(host, callerA);
    const valuesB = await valuesOf(host, callerB);

    await host.resyncAll({ clientId: 'tab-1', storage: 'memory' });
    const statuses = await Promise.all(
      [callerA, callerB].map(async caller =>
        firstValueFrom(host.streams(caller).status$),
      ),
    );

    expect(statuses.map(({ engineGeneration }) => engineGeneration)).toEqual(
      [a, b].map(({ accountId }) =>
        midnightEngineGeneration(fakeEngines.current(accountId).engine),
      ),
    );
    statuses.forEach(({ engineGeneration }, index) => {
      expect(engineGeneration).not.toBe(generations[index]);
    });
    await expect(refusals(host, callerA, valuesA)).resolves.toEqual(STALE);
    await expect(refusals(host, callerB, valuesB)).resolves.toEqual(STALE);
  });

  it('refuses values from before a re-attach that followed the last client leaving while another account kept the worker alive', async () => {
    const { host } = createHost();
    const caller = { clientId: 'tab-1', accountId: a.accountId };
    const { engineGeneration } = await attach(host, 'tab-1', a);
    await attach(host, 'tab-2', b);
    const values = await valuesOf(host, caller);

    await host.detach(caller);
    const reattached = await attach(host, 'tab-1', a);

    expect(fakeEngines.of(a.accountId)).toHaveLength(2);
    expect(fakeEngines.of(b.accountId)[0].tornDown).toBe(false);
    expect(reattached.engineGeneration).not.toBe(engineGeneration);
    await expect(refusals(host, caller, values)).resolves.toEqual(STALE);
  });
});
