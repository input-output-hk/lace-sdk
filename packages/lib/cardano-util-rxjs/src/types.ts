import type { RetryBackoffConfig } from 'backoff-rxjs';
import type { Observable } from 'rxjs';

/** The type of the values an observable emits. */
export type ObservableType<O> = O extends Observable<infer T> ? T : unknown;

/** Retry backoff settings without a `shouldRetry` filter. */
export type ReconnectionConfig = Omit<RetryBackoffConfig, 'shouldRetry'>;
