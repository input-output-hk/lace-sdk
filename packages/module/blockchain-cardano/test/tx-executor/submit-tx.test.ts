import { AccountId } from '@lace-contract/wallet-repo';
import { Cardano, Serialization } from '@lace-lib/cardano-core';
import { Ok, Err } from '@lace-lib/util';
import { BehaviorSubject, firstValueFrom, of, Subject } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';

import { makeSubmitTx } from '../../src/tx-executor-implementation/submit-tx';

import type { SideEffectDependencies } from '@lace-contract/module';
import type { Result } from '@lace-lib/util';

const testAccountId = AccountId('test-account');

const otherAddress =
  'addr_test1qqt3r9kd56aq9ajynjkz8hdfw3kc0pcv3tpzug8azxls62tvvz7nw9gmznn65g4ksrrfvyzhz52knc3mqxdyya47gz2qmcjmcq';

const previousTxId = Cardano.TransactionId(
  '39a7a284c2a0948189dc45dec670211cd4d72f7b66c5726c08d9b3df11e44d58',
);

const mainnetChainId = Cardano.ChainIds.Mainnet;

const emptyWitness: Cardano.Witness = { signatures: new Map() };

const buildCbor = (body: Cardano.TxBody): string =>
  Serialization.Transaction.fromCore({
    body,
    id: '0'.repeat(64) as Cardano.TransactionId,
    witness: emptyWitness,
  }).toCbor();

const signedCbor = buildCbor({
  inputs: [{ txId: previousTxId, index: 0 }],
  outputs: [
    {
      address: Cardano.PaymentAddress(otherAddress),
      value: { coins: 9_800_000n },
    },
  ],
  fee: 200_000n,
});

const submitProps = {
  accountId: testAccountId,
  blockchainName: 'Cardano',
  blockchainSpecificSendFlowData: {},
} as const;

const submitWith = async (deps: SideEffectDependencies, serializedTx: string) =>
  firstValueFrom(makeSubmitTx(deps)({ ...submitProps, serializedTx }));

describe('makeSubmitTx', () => {
  it('propagates provider submit errors', async () => {
    const deps = {
      cardanoProvider: { submitTx: () => of(Err(new Error('boom'))) },
      txExecutorCardano: { cardanoChainId$: of(mainnetChainId) },
    } as unknown as SideEffectDependencies;

    const result = await submitWith(deps, signedCbor);

    expect(result.success).toBe(false);
  });

  it('submits to the current chain and returns the txId with no activity metadata', async () => {
    const returnedTxId = String(
      Serialization.Transaction.fromCbor(
        Serialization.TxCBOR(signedCbor),
      ).getId(),
    );
    const submitTx = vi.fn(() => of(Ok(returnedTxId)));
    const deps = {
      cardanoProvider: { submitTx },
      txExecutorCardano: { cardanoChainId$: of(mainnetChainId) },
    } as unknown as SideEffectDependencies;

    const result = await submitWith(deps, signedCbor);

    // The in-flight store holds the spend; the flow's row carries none of it.
    expect(result).toEqual({ success: true, txId: returnedTxId });
    expect(submitTx).toHaveBeenCalledWith(
      { signedTransaction: signedCbor },
      { chainId: mainnetChainId },
    );
  });

  it('submits once, to the chain current when the submission starts', () => {
    const txId = Cardano.TransactionId(
      '4c4e67bafa15e742c13c592b65c8f74c769cd7d9af04c848099672d1ba391b49',
    );
    const chainId$ = new BehaviorSubject<Cardano.ChainId>(mainnetChainId);
    const mainnetAnswer$ = new Subject<Result<Cardano.TransactionId, Error>>();
    // The other network refuses the transaction at once: its inputs are not there.
    const submitTx = vi.fn(
      (_args: unknown, { chainId }: { chainId: Cardano.ChainId }) =>
        chainId === mainnetChainId
          ? mainnetAnswer$
          : of(Err(new Error('BadInputsUTxO'))),
    );
    const deps = {
      cardanoProvider: { submitTx },
      txExecutorCardano: { cardanoChainId$: chainId$ },
    } as unknown as SideEffectDependencies;
    const results: unknown[] = [];

    makeSubmitTx(deps)({ ...submitProps, serializedTx: signedCbor }).subscribe(
      result => results.push(result),
    );
    chainId$.next(Cardano.ChainIds.Preprod);

    expect(results).toEqual([]);

    mainnetAnswer$.next(Ok(txId));

    expect(submitTx).toHaveBeenCalledTimes(1);
    expect(submitTx).toHaveBeenCalledWith(
      { signedTransaction: signedCbor },
      { chainId: mainnetChainId },
    );
    expect(results).toEqual([{ success: true, txId }]);
  });

  it('succeeds when the accepted bytes do not decode as a transaction', async () => {
    const deps = {
      cardanoProvider: {
        submitTx: () =>
          of(
            Ok(
              '4c4e67bafa15e742c13c592b65c8f74c769cd7d9af04c848099672d1ba391b49',
            ),
          ),
      },
      txExecutorCardano: { cardanoChainId$: of(mainnetChainId) },
    } as unknown as SideEffectDependencies;

    const result = await submitWith(deps, 'deadbeef');

    expect(result).toEqual({
      success: true,
      txId: '4c4e67bafa15e742c13c592b65c8f74c769cd7d9af04c848099672d1ba391b49',
    });
  });

  it('errors when chainId is not available', async () => {
    const submitTx = vi.fn(() => of(Ok('ignored')));
    const deps = {
      cardanoProvider: { submitTx },
      txExecutorCardano: { cardanoChainId$: of(undefined) },
    } as unknown as SideEffectDependencies;

    const result = await submitWith(deps, signedCbor);

    expect(result.success).toBe(false);
    expect(submitTx).not.toHaveBeenCalled();
  });
});
