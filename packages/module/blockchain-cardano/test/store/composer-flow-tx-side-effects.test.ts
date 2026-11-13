import {
  composerFlowActions,
  LOVELACE_TOKEN_ID,
} from '@lace-contract/cardano-context';
import { AccountId } from '@lace-contract/wallet-repo';
import { BigNumber } from '@lace-lib/util';
import { testSideEffect } from '@lace-lib/util-dev';
import { describe, expect, it, vi } from 'vitest';

import {
  makeComposerAwaitingConfirmation,
  makeComposerProcessing,
} from '../../src/store/composer-flow-tx-side-effects';

import type {
  CardanoPaymentAddress,
  ComposerFlowSliceState,
  ComposerRequest,
} from '@lace-contract/cardano-context';
import type {
  TxConfirmationResult,
  TxSubmissionResult,
} from '@lace-contract/tx-executor';
import type { AnyWallet } from '@lace-contract/wallet-repo';

const testAccountId = AccountId('test-account');
const testWallet = {
  accounts: [{ accountId: testAccountId, blockchainName: 'Cardano' }],
} as unknown as AnyWallet;
const testFees = [{ amount: BigNumber(200_000n), tokenId: LOVELACE_TOKEN_ID }];
const testSerializedTx = 'a100818258...';
const testSignedTx = 'b200818258...';
const testTxId = 'txId123';

const testRequest: ComposerRequest = {
  outputs: [
    {
      address: 'addr_test1recipient' as unknown as CardanoPaymentAddress,
      lovelace: '2000000',
    },
  ],
};

const errorTranslationKeys = {
  title: 'v2.composer.build.error.title',
  subtitle: 'v2.composer.build.error.subtitle',
} as const;

const awaitingConfirmationState = {
  status: 'AwaitingConfirmation',
  accountId: testAccountId,
  request: testRequest,
  fees: testFees,
  serializedTx: testSerializedTx,
  txId: testTxId,
} as ComposerFlowSliceState;

const processingState = {
  status: 'Processing',
  accountId: testAccountId,
  request: testRequest,
  fees: testFees,
  serializedTx: testSignedTx,
  txId: testTxId,
} as ComposerFlowSliceState;

describe('composer-flow tx side-effects', () => {
  describe('makeComposerAwaitingConfirmation', () => {
    it('calls confirmTx with the wallet that owns the composing account', () => {
      const confirmTx = vi.fn();

      testSideEffect(
        {
          build: ({ cold }) => {
            confirmTx.mockReturnValue(cold('-'));
            return makeComposerAwaitingConfirmation({ confirmTx });
          },
        },
        ({ cold, expectObservable, flush }) => ({
          stateObservables: {
            composerFlow: {
              selectState$: cold('a', { a: awaitingConfirmationState }),
            },
            wallets: { selectAll$: cold('a', { a: [testWallet] }) },
          },
          dependencies: { actions: composerFlowActions },
          assertion: sideEffect$ => {
            expectObservable(sideEffect$).toBe('-');
            flush();
            // Signing rides the same tx-executor seam a normal Send uses,
            // so a composed tx needs no new host API.
            expect(confirmTx).toHaveBeenCalledWith(
              expect.objectContaining({
                accountId: testAccountId,
                blockchainName: 'Cardano',
                serializedTx: testSerializedTx,
                wallet: testWallet,
              }),
              expect.any(Function),
            );
          },
        }),
      );
    });

    it('dispatches "confirmationCompleted" with the success result', () => {
      const confirmResult: TxConfirmationResult = {
        success: true,
        serializedTx: testSignedTx,
      };

      testSideEffect(
        {
          build: ({ cold }) =>
            makeComposerAwaitingConfirmation({
              confirmTx: (_, mapResult) =>
                cold('a', { a: mapResult(confirmResult) }),
            }),
        },
        ({ cold, expectObservable }) => ({
          stateObservables: {
            composerFlow: {
              selectState$: cold('a', { a: awaitingConfirmationState }),
            },
            wallets: { selectAll$: cold('a', { a: [testWallet] }) },
          },
          dependencies: { actions: composerFlowActions },
          assertion: sideEffect$ => {
            expectObservable(sideEffect$).toBe('a', {
              a: composerFlowActions.composerFlow.confirmationCompleted({
                result: confirmResult,
              }),
            });
          },
        }),
      );
    });

    it('dispatches "confirmationCompleted" with the failure result', () => {
      const confirmResult: TxConfirmationResult = {
        success: false,
        error: { name: 'ConfirmationError', message: 'User cancelled' },
        errorTranslationKeys,
      };

      testSideEffect(
        {
          build: ({ cold }) =>
            makeComposerAwaitingConfirmation({
              confirmTx: (_, mapResult) =>
                cold('a', { a: mapResult(confirmResult) }),
            }),
        },
        ({ cold, expectObservable }) => ({
          stateObservables: {
            composerFlow: {
              selectState$: cold('a', { a: awaitingConfirmationState }),
            },
            wallets: { selectAll$: cold('a', { a: [testWallet] }) },
          },
          dependencies: { actions: composerFlowActions },
          assertion: sideEffect$ => {
            expectObservable(sideEffect$).toBe('a', {
              a: composerFlowActions.composerFlow.confirmationCompleted({
                result: confirmResult,
              }),
            });
          },
        }),
      );
    });

    it('emits a failed "confirmationCompleted" when no wallet owns the account', () => {
      const confirmTx = vi.fn();

      testSideEffect(
        {
          build: ({ cold }) => {
            confirmTx.mockReturnValue(cold('-'));
            return makeComposerAwaitingConfirmation({ confirmTx });
          },
        },
        ({ cold, expectObservable, flush }) => ({
          stateObservables: {
            composerFlow: {
              selectState$: cold('a', { a: awaitingConfirmationState }),
            },
            wallets: { selectAll$: cold('a', { a: [] as AnyWallet[] }) },
          },
          dependencies: { actions: composerFlowActions },
          assertion: sideEffect$ => {
            expectObservable(sideEffect$).toBe('a', {
              a: composerFlowActions.composerFlow.confirmationCompleted({
                result: { success: false, errorTranslationKeys },
              }),
            });
            flush();
            expect(confirmTx).not.toHaveBeenCalled();
          },
        }),
      );
    });
  });

  describe('makeComposerProcessing', () => {
    it('dispatches only processingResulted on submission success, without a pending activity', () => {
      const submitResult: TxSubmissionResult = {
        success: true,
        txId: testTxId,
      };

      testSideEffect(
        {
          build: ({ cold }) =>
            makeComposerProcessing({
              submitTx: (_, mapResult) =>
                cold('a', { a: mapResult(submitResult) }),
            }),
        },
        ({ cold, expectObservable }) => ({
          stateObservables: {
            composerFlow: { selectState$: cold('a', { a: processingState }) },
          },
          dependencies: { actions: composerFlowActions },
          assertion: sideEffect$ => {
            expectObservable(sideEffect$).toBe('a', {
              a: composerFlowActions.composerFlow.processingResulted({
                result: submitResult,
              }),
            });
          },
        }),
      );
    });

    it('dispatches only processingResulted when the submission fails', () => {
      const submitResult: TxSubmissionResult = {
        success: false,
        error: { name: 'SubmissionError', message: 'rejected' },
        errorTranslationKeys,
      };

      testSideEffect(
        {
          build: ({ cold }) =>
            makeComposerProcessing({
              submitTx: (_, mapResult) =>
                cold('a', { a: mapResult(submitResult) }),
            }),
        },
        ({ cold, expectObservable }) => ({
          stateObservables: {
            composerFlow: { selectState$: cold('a', { a: processingState }) },
          },
          dependencies: { actions: composerFlowActions },
          assertion: sideEffect$ => {
            expectObservable(sideEffect$).toBe('a', {
              a: composerFlowActions.composerFlow.processingResulted({
                result: submitResult,
              }),
            });
          },
        }),
      );
    });

    it('forwards a non-result emission from submitTx untouched', () => {
      // submitTx multiplexes: intermediate emissions are actions the
      // tx-executor wants dispatched, not the final submission result.
      const intermediate = { type: 'txExecutor/someIntermediateAction' };

      testSideEffect(
        {
          build: ({ cold }) =>
            makeComposerProcessing({
              submitTx: () => cold('a', { a: intermediate }) as never,
            }),
        },
        ({ cold, expectObservable }) => ({
          stateObservables: {
            composerFlow: { selectState$: cold('a', { a: processingState }) },
          },
          dependencies: { actions: composerFlowActions },
          assertion: sideEffect$ => {
            expectObservable(sideEffect$).toBe('a', { a: intermediate });
          },
        }),
      );
    });
  });
});
