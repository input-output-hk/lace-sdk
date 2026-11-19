import { ReplaySubject } from 'rxjs';

import type { Observable, Subscription } from 'rxjs';

type NO_VALUE_TYPE = 'TRACKER_SUBJECT_NO_VALUE';

/** An observable that also holds the last value it emitted, or `TrackerSubject.NO_VALUE` before its first. */
export interface BehaviorObservable<T> extends Observable<T> {
  /** The last value emitted, or `TrackerSubject.NO_VALUE` before the first. */
  get value(): NO_VALUE_TYPE | T;
}

/**
 * Subscribes to `source$` as soon as it is created and replays its last value to
 * every subscriber, like a `BehaviorSubject` that has no value until the source
 * emits. Unsubscribing, completing or erroring it unsubscribes from the source.
 */
export class TrackerSubject<T>
  extends ReplaySubject<T>
  implements BehaviorObservable<T>
{
  /** What `value` holds before the source first emits. */
  static NO_VALUE: NO_VALUE_TYPE = 'TRACKER_SUBJECT_NO_VALUE';

  #sourceSubscription$: Subscription;
  #value: NO_VALUE_TYPE | T = 'TRACKER_SUBJECT_NO_VALUE';
  get value(): NO_VALUE_TYPE | T {
    return this.#value;
  }
  constructor(source$: Observable<T>) {
    super(1);
    this.#sourceSubscription$ = source$.subscribe(this);
  }
  next(value: T) {
    this.#value = value;
    super.next(value);
  }
  complete() {
    this.#sourceUnsubscribe();
    super.complete();
  }
  error(err: unknown) {
    this.#sourceUnsubscribe();
    super.error(err);
  }
  unsubscribe() {
    this.#sourceUnsubscribe();
    super.unsubscribe();
  }
  #sourceUnsubscribe() {
    // can be undefined if source observable completes immediatelly upon subscription in constructor
    if (this.#sourceSubscription$) this.#sourceSubscription$.unsubscribe();
  }
}
