// copied from Lace v1 and adjusted to vitest
// https://github.com/input-output-hk/lace/blob/27873f3b5dd8ec0e6926a5dd1653986a97ac81e8/packages/cardano/src/wallet/lib/__tests__/blockfrost-input-resolver.test.ts
import {
  BlockfrostInputResolverProvider,
  BlockfrostToCardanoSDK,
} from '@lace-lib/cardano-provider-core';
import {
  HttpClientError,
  ProviderError,
  ProviderFailure,
} from '@lace-lib/util-provider';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mockResponses } from '../util';

import type { Cardano } from '@lace-lib/cardano-core';
import type { HttpClient } from '@lace-lib/util-provider';
import type { Logger } from 'ts-log';

describe('BlockfrostInputResolverProvider', () => {
  const clientMock = {
    request: vi.fn(),
  };
  const loggerMock = {
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  };
  let resolver: BlockfrostInputResolverProvider;

  beforeEach(() => {
    resolver = new BlockfrostInputResolverProvider(
      clientMock as unknown as HttpClient,
      loggerMock as unknown as Logger,
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should fetch transaction output', async () => {
    const txIn: Cardano.TxIn = {
      txId: 'txId2' as Cardano.TransactionId,
      index: 1,
    };
    const responseMock = {
      outputs: [
        {
          output_index: 1,
          address: 'addr2',
          amount: [{ unit: 'lovelace', quantity: '2000' }],
        },
      ],
    };

    mockResponses(clientMock.request, [
      [`txs/${txIn.txId}/utxos`, { data: responseMock }],
    ]);

    vi.spyOn(BlockfrostToCardanoSDK, 'txOut').mockReturnValue({
      address: 'addr2' as Cardano.PaymentAddress,
      value: { coins: BigInt(2000) },
    } as Cardano.TxOut);

    const result1 = await resolver.resolveInput(txIn);

    expect(result1).toEqual({
      address: 'addr2',
      value: { coins: BigInt(2000) },
    });
    expect(clientMock.request).toHaveBeenCalledTimes(1);
  });

  it('should return null if transaction output is not found', async () => {
    const txIn: Cardano.TxIn = {
      txId: 'txId3' as Cardano.TransactionId,
      index: 2,
    };
    const responseMock = { outputs: [] };
    mockResponses(clientMock.request, [
      [`txs/${txIn.txId}/utxos`, { data: responseMock }],
    ]);

    const result = await resolver.resolveInput(txIn);

    expect(result).toBeNull();
  });

  it('should return null for 404 errors from Blockfrost', async () => {
    const txIn: Cardano.TxIn = {
      txId: 'txId4' as Cardano.TransactionId,
      index: 0,
    };

    const error = new HttpClientError(404, 'Not Found');
    error.status = 404;

    mockResponses(clientMock.request, [[`txs/${txIn.txId}/utxos`, error]]);

    const result = await resolver.resolveInput(txIn);

    expect(result).toBeNull();
  });

  it('should throw errors for non-404 Blockfrost errors', async () => {
    const txIn: Cardano.TxIn = {
      txId: 'txId5' as Cardano.TransactionId,
      index: 0,
    };
    const error = new HttpClientError(500, 'Internal server error');
    error.status = 500;

    mockResponses(clientMock.request, [[`txs/${txIn.txId}/utxos`, error]]);

    try {
      await resolver.resolveInput(txIn);
    } catch (error_) {
      expect(error_).toEqual(
        new ProviderError(
          ProviderFailure.Unhealthy,
          error,
          'Internal server error',
        ),
      );
    }
  });

  describe('resolveTransactionOutputs', () => {
    const txId = 'txId6' as Cardano.TransactionId;
    const firstAddress =
      'addr_test1qruygd02feqeue4hkt67vwgn03p04uuv2k34ed25n4rcwt8pa7kgfet22l6w3078tm72c62p4597urnlpw6v6278cpxs8jxykl';
    const secondAddress =
      'addr_test1qqwk0nt6a2hdae87w0k240nuezf2fra52qgemksdm4m0jffw0vfldkgjfgtdmlkyv3m374lps3t3lv7t379ncxn4tp5qlnk7yu';

    beforeEach(() => {
      vi.restoreAllMocks();
    });

    const blockfrostOutput = (
      address: string,
      quantity: string,
      outputIndex: number,
    ) => ({
      address,
      amount: [{ unit: 'lovelace', quantity }],
      output_index: outputIndex,
      data_hash: null,
      inline_datum: null,
      collateral: false,
      reference_script_hash: null,
      consumed_by_tx: null,
    });

    it('should return every output of the transaction keyed by its index', async () => {
      mockResponses(clientMock.request, [
        [
          `txs/${txId}/utxos`,
          {
            data: {
              hash: txId,
              inputs: [],
              outputs: [
                blockfrostOutput(firstAddress, '19500000', 0),
                blockfrostOutput(secondAddress, '3458000077', 3),
              ],
            },
          },
        ],
      ]);

      const outputs = await resolver.resolveTransactionOutputs(txId);

      expect(outputs).not.toBeNull();
      expect([...outputs!.keys()]).toEqual([0, 3]);
      expect(outputs!.get(0)?.address).toBe(firstAddress);
      expect(outputs!.get(0)?.value.coins).toBe(BigInt(19_500_000));
      expect(outputs!.get(3)?.address).toBe(secondAddress);
      expect(outputs!.get(3)?.value.coins).toBe(BigInt(3_458_000_077));
      expect(clientMock.request).toHaveBeenCalledTimes(1);
    });

    it('should return null for 404 errors from Blockfrost', async () => {
      const error = new HttpClientError(404, 'Not Found');
      error.status = 404;
      mockResponses(clientMock.request, [[`txs/${txId}/utxos`, error]]);

      await expect(
        resolver.resolveTransactionOutputs(txId),
      ).resolves.toBeNull();
    });

    it('should rethrow errors other than 404', async () => {
      const error = new HttpClientError(500, 'Internal server error');
      error.status = 500;
      mockResponses(clientMock.request, [[`txs/${txId}/utxos`, error]]);

      await expect(resolver.resolveTransactionOutputs(txId)).rejects.toEqual(
        new ProviderError(
          ProviderFailure.Unhealthy,
          error,
          'Internal server error',
        ),
      );
    });
  });
});
