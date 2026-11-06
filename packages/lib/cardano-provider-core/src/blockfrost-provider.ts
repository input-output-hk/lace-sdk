// copied from @cardano-sdk/cardano-services-client
import { contextLogger } from '@lace-lib/cardano-util';
import { toProviderError } from '@lace-lib/util-provider';

import type { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import type { HealthCheckResponse, Provider } from '@lace-lib/cardano-core';
import type { HttpClient } from '@lace-lib/util-provider';
import type { Logger } from 'ts-log';
import type { AsyncReturnType } from 'type-fest';

interface PaginatedRequestProps {
  endpoint: string;
  pageSize: number;
  requestInit?: RequestInit;
  page?: number;
  /** Pages requested at most, counting from `page`. Unbounded when absent. */
  maxPages?: number;
}

export abstract class BlockfrostProvider implements Provider {
  protected logger: Logger;
  readonly #client: HttpClient;

  public constructor(client: HttpClient, logger: Logger) {
    this.#client = client;
    this.logger = contextLogger(logger, this.constructor.name);
  }

  public async healthCheck(): Promise<HealthCheckResponse> {
    try {
      const result = await this.#client.request<
        AsyncReturnType<BlockFrostAPI['health']>
      >('health');
      return { ok: result.data.is_healthy };
    } catch (error) {
      return { ok: false, reason: toProviderError(error).message };
    }
  }

  /**
   * @param endpoint - e.g. 'blocks/latest'
   * @param requestInit - request options
   * @throws `ProviderError`
   */
  protected async request<T>(
    endpoint: string,
    requestInit?: RequestInit,
  ): Promise<T> {
    try {
      this.logger.debug('request', endpoint);
      const response = await this.#client.request<T>(endpoint, requestInit);
      this.logger.debug('response', response);
      return response?.data;
    } catch (error) {
      this.logger.debug('error', error);
      throw toProviderError(error);
    }
  }

  /**
   * @param endpoint - e.g. 'blocks/latest'
   * @param pageSize - number of items per page
   * @param requestInit - request options
   * @param maxPages - pages requested at most, counting from `page`; the first
   * page is always requested, so a value below 1 acts as 1
   * @throws `ProviderError`
   */
  protected async paginatedRequests<T extends unknown[]>({
    endpoint,
    pageSize,
    requestInit,
    page = 1,
    maxPages = Number.POSITIVE_INFINITY,
  }: PaginatedRequestProps): Promise<T> {
    const separator = endpoint.includes('?') ? '&' : '?';
    const url = `${endpoint}${separator}page=${page}&count=${pageSize}`;
    const response = await this.request<T>(url, requestInit);

    if (response.length !== pageSize || maxPages <= 1) return response;

    // Hermes corrupts a spread of an awaited value inside an array literal when
    // the async frame resumes (LW-15491) — keep the await hoisted out of the literal.
    const rest = await this.paginatedRequests<T>({
      endpoint,
      pageSize,
      requestInit,
      page: page + 1,
      maxPages: maxPages - 1,
    });

    return [...response, ...rest] as T;
  }
}
