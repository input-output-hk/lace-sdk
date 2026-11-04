import { Cardano, ProviderFailure } from '@cardano-sdk/core';
import { logger } from '@cardano-sdk/util-dev';
import { CardanoPaymentAddress } from '@lace-contract/cardano-context';
import { Timestamp } from '@lace-lib/util';
import { HttpClientError, ProviderError } from '@lace-lib/util-provider';
import { firstValueFrom } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BlockfrostActivityProvider } from '../../../src/blockfrost';
import { mockResponses } from '../util';

import { mockBlockfrostAddressTransactions } from './mocks/address-transactions-mocks';

import type { Responses } from '@blockfrost/blockfrost-js';
import type { CardanoTransactionHistoryItem } from '@lace-contract/cardano-context';
import type { HttpClient } from '@lace-lib/util-provider';
import type { Mock } from 'vitest';

describe('BlockfrostActivityProvider', () => {
  let request: Mock;
  let provider: BlockfrostActivityProvider;

  beforeEach(() => {
    request = vi.fn();
    const client = { request } as unknown as HttpClient;
    provider = new BlockfrostActivityProvider(client, logger);
  });

  describe('getTransaction', () => {
    const txId = Cardano.TransactionId(
      '80be2d8820b8946037764fcba8177a3eb1cae94bf8993def14dda20cb89390c2',
    );

    const txDetailsResponse: Responses['tx_content'] = {
      hash: '80be2d8820b8946037764fcba8177a3eb1cae94bf8993def14dda20cb89390c2',
      block: 'dede5b32714120326c9e1c18e31ffe3b9442951b66d904be9da751aa5c0179bb',
      block_height: 3572194,
      block_time: 1749722211,
      slot: 94039011,
      index: 0,
      output_amount: [
        {
          unit: 'lovelace',
          quantity: '3477500077',
        },
      ],
      fees: '168317',
      deposit: '0',
      size: 286,
      invalid_before: null,
      invalid_hereafter: null,
      utxo_count: 3,
      withdrawal_count: 0,
      mir_cert_count: 0,
      delegation_count: 0,
      stake_cert_count: 0,
      pool_update_count: 0,
      pool_retire_count: 0,
      asset_mint_or_burn_count: 0,
      redeemer_count: 0,
      valid_contract: true,
    };

    const txCborResponse: Responses['tx_content_cbor'] = {
      cbor: '84a300d90102818258207577617e7378a6a3f6f09185c662feeb86428366430b263e399879152c9e55fe01018282583900f84435ea4e419e66b7b2f5e639137c42faf38c55a35cb5549d47872ce1efac84e56a57f4e8bfc75efcac6941ad0bee0e7f0bb4cd2bc7c04d1a01298be0825839001d67cd7aeaaedee4fe73ecaabe7cc892a48fb450119dda0ddd76f9252e7b13f6d9124a16ddfec464771f57e184571fb3cb8f8b3c1a7558681ace1ce4cd021a0002917da100818258207afdd392701bfe44e3b6a59f173177685689a6672e7b71647ea7087ea1aaf5a158400ba94aff77ac8c05e4df45ff4e2cfc70ee8e92bf0efade11507122da68b8b18bbc1a7b7b08538681c083232a8cb9d964380f2bb899ab4b18a6384887b80a6301f5f6',
    };

    const txUtxosResponse: Responses['tx_content_utxo'] = {
      hash: '80be2d8820b8946037764fcba8177a3eb1cae94bf8993def14dda20cb89390c2',
      inputs: [
        {
          address:
            'addr_test1qqwk0nt6a2hdae87w0k240nuezf2fra52qgemksdm4m0jffw0vfldkgjfgtdmlkyv3m374lps3t3lv7t379ncxn4tp5qlnk7yu',
          amount: [
            {
              unit: 'lovelace',
              quantity: '3477668394',
            },
          ],
          tx_hash:
            '7577617e7378a6a3f6f09185c662feeb86428366430b263e399879152c9e55fe',
          output_index: 1,
          data_hash: null,
          inline_datum: null,
          reference_script_hash: null,
          collateral: false,
          reference: false,
        },
      ],
      outputs: [
        {
          address:
            'addr_test1qruygd02feqeue4hkt67vwgn03p04uuv2k34ed25n4rcwt8pa7kgfet22l6w3078tm72c62p4597urnlpw6v6278cpxs8jxykl',
          amount: [
            {
              unit: 'lovelace',
              quantity: '19500000',
            },
          ],
          output_index: 0,
          data_hash: null,
          inline_datum: null,
          collateral: false,
          reference_script_hash: null,
          consumed_by_tx: null,
        },
        {
          address:
            'addr_test1qqwk0nt6a2hdae87w0k240nuezf2fra52qgemksdm4m0jffw0vfldkgjfgtdmlkyv3m374lps3t3lv7t379ncxn4tp5qlnk7yu',
          amount: [
            {
              unit: 'lovelace',
              quantity: '3458000077',
            },
          ],
          output_index: 1,
          data_hash: null,
          inline_datum: null,
          collateral: false,
          reference_script_hash: null,
          consumed_by_tx: null,
        },
      ],
    };

    it('fetches and constructs transaction', async () => {
      mockResponses(request, [
        [`txs/${txId}`, { data: txDetailsResponse }],
        [`txs/${txId}/cbor`, { data: txCborResponse }],
        [`txs/${txId}/utxos`, { data: txUtxosResponse }],
      ]);

      const txDetails = (
        await firstValueFrom(provider.getTransactionDetails(txId))
      ).unwrap();

      // Verify hydratedTx properties
      expect(txDetails.id).toEqual(txId);
      expect(txDetails.blockHeader).toEqual({
        blockNo: Cardano.BlockNo(3572194),
        hash: Cardano.BlockId(
          'dede5b32714120326c9e1c18e31ffe3b9442951b66d904be9da751aa5c0179bb',
        ),
        slot: Cardano.Slot(94039011),
      });
      expect(txDetails.inputSource).toEqual(Cardano.InputSource.inputs);
      expect(txDetails.body.inputs).toHaveLength(1);
      expect(txDetails.body.outputs).toHaveLength(2);

      // Verify txDetails properties
      expect(txDetails.blockTime).toEqual(txDetailsResponse.block_time);
    });

    it('copies treasury donation from the parsed cbor into the body', async () => {
      // Same tx as txCborResponse but with a treasury donation (map key 22) of 1_000_000 lovelace.
      const txCborWithDonation: Responses['tx_content_cbor'] = {
        cbor: '84a400818258207577617e7378a6a3f6f09185c662feeb86428366430b263e399879152c9e55fe01018282583900f84435ea4e419e66b7b2f5e639137c42faf38c55a35cb5549d47872ce1efac84e56a57f4e8bfc75efcac6941ad0bee0e7f0bb4cd2bc7c04d1a01298be0825839001d67cd7aeaaedee4fe73ecaabe7cc892a48fb450119dda0ddd76f9252e7b13f6d9124a16ddfec464771f57e184571fb3cb8f8b3c1a7558681ace1ce4cd021a0002917d161a000f4240a100818258207afdd392701bfe44e3b6a59f173177685689a6672e7b71647ea7087ea1aaf5a158400ba94aff77ac8c05e4df45ff4e2cfc70ee8e92bf0efade11507122da68b8b18bbc1a7b7b08538681c083232a8cb9d964380f2bb899ab4b18a6384887b80a6301f5f6',
      };

      mockResponses(request, [
        [`txs/${txId}`, { data: txDetailsResponse }],
        [`txs/${txId}/cbor`, { data: txCborWithDonation }],
        [`txs/${txId}/utxos`, { data: txUtxosResponse }],
      ]);

      const txDetails = (
        await firstValueFrom(provider.getTransactionDetails(txId))
      ).unwrap();

      expect(txDetails.body.donation).toEqual(1_000_000n);
    });

    /**
     * The transaction with metadata whose single entry nests `depth` lists:
     * the recorded transaction with its empty auxiliary data replaced.
     */
    const txCborWithMetadataDepth = (depth: number) => ({
      cbor: `${txCborResponse.cbor.slice(0, -2)}a100${'81'.repeat(depth)}00`,
    });

    it('decodes a transaction whose metadata nests within the limit', async () => {
      mockResponses(request, [
        [`txs/${txId}`, { data: txDetailsResponse }],
        [`txs/${txId}/cbor`, { data: txCborWithMetadataDepth(60) }],
        [`txs/${txId}/utxos`, { data: txUtxosResponse }],
      ]);

      const result = await firstValueFrom(provider.getTransactionDetails(txId));

      expect(result.isOk()).toBe(true);
      expect(result.unwrap().auxiliaryData?.blob?.size).toBe(1);
    });

    it('refuses a transaction whose metadata nests deeper than can be decoded, before decoding it', async () => {
      mockResponses(request, [
        [`txs/${txId}`, { data: txDetailsResponse }],
        [`txs/${txId}/cbor`, { data: txCborWithMetadataDepth(5000) }],
        [`txs/${txId}/utxos`, { data: txUtxosResponse }],
      ]);

      const start = performance.now();
      const result = await firstValueFrom(provider.getTransactionDetails(txId));

      expect(result.isErr()).toBe(true);
      expect(result.unwrapErr()).toMatchObject({
        reason: ProviderFailure.InvalidResponse,
      });
      expect(performance.now() - start).toBeLessThan(1000);
    });

    it('handles error on tx details fetch', async () => {
      const error = new HttpClientError(404, 'Transaction not found');
      mockResponses(request, [
        [`txs/${txId}`, error],
        [`txs/${txId}/cbor`, error],
        [`txs/${txId}/utxos`, error],
      ]);

      const result = await firstValueFrom(provider.getTransactionDetails(txId));

      expect(result.expectErr('should be 404 not found error')).toEqual(
        new ProviderError(
          ProviderFailure.NotFound,
          error,
          'Transaction not found',
        ),
      );
    });

    it('handles error on tx cbor fetch', async () => {
      const error = new HttpClientError(500, 'Internal server error');
      mockResponses(request, [
        [`txs/${txId}`, { data: txDetailsResponse }],
        [`txs/${txId}/cbor`, error],
      ]);

      const result = await firstValueFrom(provider.getTransactionDetails(txId));

      expect(result.expectErr('should be internal server error')).toEqual(
        new ProviderError(
          ProviderFailure.Unhealthy,
          error,
          'Internal server error',
        ),
      );
    });

    it('handles error on tx utxos fetch', async () => {
      const error = new HttpClientError(500, 'Internal server error');
      mockResponses(request, [
        [`txs/${txId}`, { data: txDetailsResponse }],
        [`txs/${txId}/cbor`, { data: txCborResponse }],
        [`txs/${txId}/utxos`, error],
      ]);

      const result = await firstValueFrom(provider.getTransactionDetails(txId));

      expect(result.expectErr('should be internal server error')).toEqual(
        new ProviderError(
          ProviderFailure.Unhealthy,
          error,
          'Internal server error',
        ),
      );
    });
  });

  describe('getAddressTransactionHistory', () => {
    const addresses = [
      CardanoPaymentAddress(
        'addr_test1qrr7pflnkppvp49sl2hjs9v255ydycp8zxuxzfjw03vev9ns6cdlwymh7v9kr8cd8cy5vx8l7h6v9da84ml2cjd90fusnjsh8d',
      ),
      CardanoPaymentAddress(
        'addr_test1qruygd02feqeue4hkt67vwgn03p04uuv2k34ed25n4rcwt8pa7kgfet22l6w3078tm72c62p4597urnlpw6v6278cpxs8jxykl',
      ),
      CardanoPaymentAddress(
        'addr_test1qqwk0nt6a2hdae87w0k240nuezf2fra52qgemksdm4m0jffw0vfldkgjfgtdmlkyv3m374lps3t3lv7t379ncxn4tp5qlnk7yu',
      ),
    ];

    it('fetches transactions history for an address, returning only the latest 10', async () => {
      // Mock responses for each address using our prepared mock data
      mockResponses(request, [
        [
          `addresses/${addresses[0]}/transactions?count=5&order=desc`,
          { data: mockBlockfrostAddressTransactions[addresses[0]] },
        ],
        [
          `addresses/${addresses[1]}/transactions?count=10&order=desc`,
          { data: mockBlockfrostAddressTransactions[addresses[1]] },
        ],
      ]);

      const resultAddress1 = (
        await firstValueFrom(
          provider.getAddressTransactionHistory({
            address: addresses[0],
            numberOfItems: 5,
          }),
        )
      ).unwrap();

      const resultAddress2 = (
        await firstValueFrom(
          provider.getAddressTransactionHistory({
            address: addresses[1],
            numberOfItems: 10,
          }),
        )
      ).unwrap();

      expect(resultAddress1).toEqual(
        mockBlockfrostAddressTransactions[
          addresses[0]
        ].map<CardanoTransactionHistoryItem>(raw => ({
          txId: Cardano.TransactionId(raw.tx_hash),
          blockNumber: Cardano.BlockNo(raw.block_height),
          txIndex: Cardano.TxIndex(raw.tx_index),
          blockTime: Timestamp(raw.block_time * 1000),
        })),
      );
      expect(resultAddress2).toEqual(
        mockBlockfrostAddressTransactions[
          addresses[1]
        ].map<CardanoTransactionHistoryItem>(raw => ({
          txId: Cardano.TransactionId(raw.tx_hash),
          blockNumber: Cardano.BlockNo(raw.block_height),
          txIndex: Cardano.TxIndex(raw.tx_index),
          blockTime: Timestamp(raw.block_time * 1000),
        })),
      );
    });

    it('handles error when fetching transactions', async () => {
      const error = new HttpClientError(500, 'Internal server error');
      mockResponses(request, [
        [`addresses/${addresses[0]}/transactions?count=10&order=desc`, error],
      ]);

      const result = await firstValueFrom(
        provider.getAddressTransactionHistory({
          address: addresses[0],
          numberOfItems: 10,
        }),
      );

      expect(result.expectErr('should be internal server error')).toEqual(
        new ProviderError(
          ProviderFailure.Unhealthy,
          error,
          'Internal server error',
        ),
      );
    });

    it('returns Ok([]) when Blockfrost responds 404 (address has no on-chain activity)', async () => {
      // 404 from `addresses/{address}/transactions` means the address has
      // never had a transaction — not a fetch failure. Returning Err would
      // fail the per-account transaction-polling round and cause every
      // subsequent tip change to re-trigger the same failure, locking the
      // wallet into a perpetual "syncing" state on fresh mainnet wallets.
      const error = new HttpClientError(404, 'Not Found');
      mockResponses(request, [
        [`addresses/${addresses[0]}/transactions?count=10&order=desc`, error],
      ]);

      const result = await firstValueFrom(
        provider.getAddressTransactionHistory({
          address: addresses[0],
          numberOfItems: 10,
        }),
      );

      expect(result.expect('should treat 404 as empty')).toEqual([]);
    });
  });

  describe('getAssetTransactionHistory', () => {
    const assetId = Cardano.AssetId(
      '87e5931f96faa62899239102381dd637acd7d7b20752f070651f88904879647261486561645632',
    );
    const endpoint = (page: number, count = 100) =>
      `assets/${assetId}/transactions?order=asc&page=${page}&count=${count}`;

    /** Transactions of a Hydra head state token, recorded on Preprod. */
    const recordedHistory: Responses['asset_transactions'] = [
      {
        tx_hash:
          'ab1b61fcffe37dda1b44bbcf504b48e8ed22aee0124ebbd80f124ad8c769a36d',
        tx_index: 4,
        block_height: 4946836,
        block_time: 1784296284,
      },
      {
        tx_hash:
          '2e96fef857407ad08c5a8d7da74484cecaabdf0d7ef688b45930f713ae7f926a',
        tx_index: 21,
        block_height: 4946893,
        block_time: 1784297559,
      },
      {
        tx_hash:
          '6eda4f6cd2338f1f77e8c103eea3e225aa086860e0fe27a4dec8f344d867872d',
        tx_index: 0,
        block_height: 4946905,
        block_time: 1784297886,
      },
      {
        tx_hash:
          'e5b07d117c390f9b87694ed21ebedb50dbe3170d49c0a7bfeeaeb1b3f4e11933',
        tx_index: 2,
        block_height: 4950617,
        block_time: 1784381935,
      },
    ];

    const toHistoryItem = (
      raw: Responses['asset_transactions'][number],
    ): CardanoTransactionHistoryItem => ({
      txId: Cardano.TransactionId(raw.tx_hash),
      txIndex: Cardano.TxIndex(raw.tx_index),
      blockNumber: Cardano.BlockNo(raw.block_height),
      blockTime: Timestamp(raw.block_time * 1000),
    });

    it('lists the transactions of an asset oldest first', async () => {
      mockResponses(request, [[endpoint(1), { data: recordedHistory }]]);

      const result = await firstValueFrom(
        provider.getAssetTransactionHistory({ assetId }),
      );

      expect(result.unwrap()).toEqual(recordedHistory.map(toHistoryItem));
    });

    it('pages through the history until a page comes back short', async () => {
      mockResponses(request, [
        [endpoint(1, 2), { data: recordedHistory.slice(0, 2) }],
        [endpoint(2, 2), { data: recordedHistory.slice(2, 4) }],
        [endpoint(3, 2), { data: [] }],
      ]);

      const result = await firstValueFrom(
        provider.getAssetTransactionHistory({ assetId, pageSize: 2 }),
      );

      expect(result.unwrap()).toEqual(recordedHistory.map(toHistoryItem));
      expect(request).toHaveBeenCalledTimes(3);
    });

    it('starts the listing at the requested page', async () => {
      mockResponses(request, [
        [endpoint(2, 2), { data: recordedHistory.slice(2, 4) }],
        [endpoint(3, 2), { data: [] }],
      ]);

      const result = await firstValueFrom(
        provider.getAssetTransactionHistory({ assetId, page: 2, pageSize: 2 }),
      );

      expect(result.unwrap()).toEqual(
        recordedHistory.slice(2, 4).map(toHistoryItem),
      );
      expect(request).toHaveBeenCalledTimes(2);
    });

    it('stops paging once maxPages pages were read', async () => {
      mockResponses(request, [
        [endpoint(1, 1), { data: recordedHistory.slice(0, 1) }],
        [endpoint(2, 1), { data: recordedHistory.slice(1, 2) }],
      ]);

      const result = await firstValueFrom(
        provider.getAssetTransactionHistory({
          assetId,
          maxPages: 2,
          pageSize: 1,
        }),
      );

      expect(result.unwrap()).toEqual(
        recordedHistory.slice(0, 2).map(toHistoryItem),
      );
      expect(request).toHaveBeenCalledTimes(2);
    });

    it('treats a 404 (asset never minted) as an empty history', async () => {
      mockResponses(request, [
        [endpoint(1), new HttpClientError(404, 'Not Found')],
      ]);

      const result = await firstValueFrom(
        provider.getAssetTransactionHistory({ assetId }),
      );

      expect(result.expect('should treat 404 as empty')).toEqual([]);
    });

    it('surfaces non-404 errors as Err', async () => {
      const error = new HttpClientError(500, 'Internal server error');
      mockResponses(request, [[endpoint(1), error]]);

      const result = await firstValueFrom(
        provider.getAssetTransactionHistory({ assetId }),
      );

      expect(result.expectErr('should be internal server error')).toEqual(
        new ProviderError(
          ProviderFailure.Unhealthy,
          error,
          'Internal server error',
        ),
      );
    });

    it('requests afresh on each subscription, so a retry does not replay a failure', async () => {
      request
        .mockRejectedValueOnce(new HttpClientError(500, 'Server Error'))
        .mockResolvedValueOnce({ data: recordedHistory });

      const history$ = provider.getAssetTransactionHistory({ assetId });
      expect(request).not.toHaveBeenCalled();

      expect((await firstValueFrom(history$)).isErr()).toBe(true);
      const retried = await firstValueFrom(history$);

      expect(retried.unwrap()).toHaveLength(recordedHistory.length);
      expect(request).toHaveBeenCalledTimes(2);
    });
  });
});
