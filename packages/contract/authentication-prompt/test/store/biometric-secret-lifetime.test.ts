import { ByteArray } from '@lace-lib/util';
import {
  BehaviorSubject,
  EMPTY,
  Subject,
  delay,
  from,
  of,
  throwError,
} from 'rxjs';
import { TestScheduler } from 'rxjs/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as authSecretAccessor from '../../src/store/auth-secret-accessor';
import {
  initializeInternalAuthSecretAccessor,
  sendAuthSecretApi,
} from '../../src/store/auth-secret-accessor-internal';
import { createVerifyAndPropagateAuthSecret } from '../../src/store/side-effects/auth-verification-handler';
import {
  makeAuthenticationBiometricVerifying,
  resetBiometricRetryState,
  resetPreAuthState,
} from '../../src/store/side-effects/biometrics-side-effects';
import { makeAuthenticationPromptVerifying } from '../../src/store/side-effects/password-side-effects';
import { stateMachine } from '../../src/store/state-machine';
import { AuthSecret } from '../../src/value-objects';

import {
  createMockLocalAuth,
  createMockSecureStore,
} from './biometric-test-utils';

import type { LocalAuthenticateResult } from '../../src/local-authentication';
import type { AuthenticationPromptEvent } from '../../src/store/state-machine';
import type {
  AuthenticationPromptSliceState,
  Config,
} from '../../src/store/types';
import type { LacePlatform } from '@lace-contract/module';
import type { Observable, Subscription } from 'rxjs';

vi.mock('@lace-contract/i18n', async () => {
  const actual = await vi.importActual('@lace-contract/i18n');
  return { ...actual, getI18n: () => ({ t: (key: string) => key }) };
});

const config: Config = {
  purpose: 'action-authorization',
  cancellable: true,
  confirmButtonLabel: 'authentication-prompt.confirm-button-label',
  message: 'authentication-prompt.message.wallet-lock',
};
const events = stateMachine.events;
const secretHex = Buffer.from('synthetic-test-password').toString('hex');
const makeSecret = () =>
  AuthSecret(ByteArray.fromUTF8('synthetic-test-password'));
const subscriptions: Subscription[] = [];
const keystoreError = () =>
  new Error('Could not decrypt the value. Caused by: unknown');
const nextStoreTurn = async () =>
  new Promise(resolve => setTimeout(resolve, 20));

const makeHarness = ({
  getItem = () => secretHex,
  platform = 'android',
  localAuthentication = createMockLocalAuth(),
  send = (secret: AuthSecret) =>
    from(sendAuthSecretApi.sendAuthSecretInternally(secret)),
  dispatchOutput = false,
}: {
  getItem?: () => string;
  platform?: LacePlatform;
  localAuthentication?: ReturnType<typeof createMockLocalAuth>;
  send?: (secret: AuthSecret) => Observable<void>;
  dispatchOutput?: boolean;
} = {}) => {
  const state$ = new BehaviorSubject<AuthenticationPromptSliceState>(
    stateMachine.initialState,
  );
  const dispatch = (event: AuthenticationPromptEvent) => {
    state$.next(stateMachine.transition(state$.value, event));
  };
  const open = (method: 'Biometric' | 'Password') => {
    dispatch(events.requested(config));
    dispatch(
      method === 'Password'
        ? events.openedPassword()
        : events.openedBiometric(),
    );
  };
  const interrupt = (event: 'cancelled' | 'preempted') => {
    dispatch(events[event]());
    expect(state$.value).toMatchObject({
      status: 'Completing',
      success: false,
    });
    dispatch(events.completed({ success: false }));
  };
  const verifyAuthSecret = vi.fn((_params: { authSecret: AuthSecret }) =>
    of(true),
  );
  const verifyAndPropagateAuthSecret = createVerifyAndPropagateAuthSecret({
    ...initializeInternalAuthSecretAccessor(),
    verifyAuthSecret,
  });
  const sendAuthSecretInternally = vi.fn(send);
  const secureStore = createMockSecureStore(getItem);
  const dependencies = {
    actions: { authenticationPrompt: events },
    secureStore,
    localAuthentication,
  };
  const state = { authenticationPrompt: { selectState$: state$ } };
  const emitted: AuthenticationPromptEvent[] = [];
  const errors: unknown[] = [];
  const connect = (source: Observable<unknown>) => {
    // Reproduce the store's asynchronous action delivery in the regression cases.
    const output = dispatchOutput ? source.pipe(delay(0)) : source;
    const subscription = output.subscribe({
      next: event => {
        emitted.push(event as AuthenticationPromptEvent);
        if (dispatchOutput) dispatch(event as AuthenticationPromptEvent);
      },
      error: error => errors.push(error),
    });
    subscriptions.push(subscription);
    return subscription;
  };
  connect(
    makeAuthenticationPromptVerifying({ verifyAndPropagateAuthSecret })(
      {} as never,
      state as never,
      dependencies as never,
    ),
  );
  const biometricSubscription = connect(
    makeAuthenticationBiometricVerifying({
      verifyAndPropagateAuthSecret,
      platform,
      sendAuthSecretInternally,
    })({} as never, state as never, dependencies as never),
  );
  return {
    state$,
    dispatch,
    open,
    interrupt,
    verifyAuthSecret,
    sendAuthSecretInternally,
    secureStore,
    emitted,
    errors,
    biometricSubscription,
  };
};

beforeEach(() => {
  authSecretAccessor.clearAuthSecret();
  resetBiometricRetryState();
  resetPreAuthState();
});
afterEach(() => {
  subscriptions.splice(0).forEach(subscription => {
    subscription.unsubscribe();
  });
  authSecretAccessor.clearAuthSecret();
  vi.restoreAllMocks();
});

describe('biometric producer lifetime', () => {
  it.each(['preempted', 'cancelled'] as const)(
    '%s prevents late Android recovery from retaining or publishing a secret for a later password login',
    async interruption => {
      const propagate = vi.spyOn(authSecretAccessor, 'propagateAuthSecret');
      const preAuth$ = new Subject<LocalAuthenticateResult>();
      const localAuthentication = createMockLocalAuth();
      localAuthentication.authenticate = vi.fn(() => preAuth$);
      let reads = 0;
      const flow = makeHarness({
        localAuthentication,
        dispatchOutput: true,
        getItem: () => {
          if (++reads === 1) throw keystoreError();
          return secretHex;
        },
      });
      flow.open('Biometric');
      flow.dispatch(events.confirmedBiometric());
      expect(localAuthentication.authenticate).toHaveBeenCalledOnce();
      flow.interrupt(interruption);
      flow.open('Password');
      preAuth$.next({ success: true });
      preAuth$.complete();
      await nextStoreTurn();
      expect.soft(flow.secureStore.getItem).toHaveBeenCalledOnce();
      expect.soft(flow.sendAuthSecretInternally).not.toHaveBeenCalled();
      expect.soft(flow.verifyAuthSecret).not.toHaveBeenCalled();
      expect.soft(flow.emitted).toEqual([]);
      const staleClones = flow.verifyAuthSecret.mock.calls.map(
        ([params]) => params.authSecret,
      );
      await sendAuthSecretApi.sendAuthSecretInternally(makeSecret());
      flow.dispatch(events.confirmedPassword());
      await nextStoreTurn();
      expect(flow.state$.value).toMatchObject({
        status: 'Completing',
        success: true,
      });
      expect(flow.verifyAuthSecret).toHaveBeenCalledTimes(1);
      const clone = flow.verifyAuthSecret.mock.calls[0][0].authSecret;
      expect(propagate).toHaveBeenCalledExactlyOnceWith(clone);
      expect(
        propagate.mock.calls.some(([secret]) => staleClones.includes(secret)),
      ).toBe(false);
      expect(clone.every(byte => byte === 0)).toBe(true);
    },
  );

  describe.each(['ios', 'android'] as const)('%s delivery', platform => {
    it.each(['preempted', 'cancelled'] as const)(
      '%s wipes a retrieved password while the delivery acknowledgement is pending',
      async interruption => {
        const propagate = vi.spyOn(authSecretAccessor, 'propagateAuthSecret');
        const delivery$ = new Subject<void>();
        let reads = 0;
        const flow = makeHarness({
          platform,
          getItem: () => {
            if (platform === 'android' && ++reads === 1) throw keystoreError();
            return secretHex;
          },
          send: secret => {
            void sendAuthSecretApi.sendAuthSecretInternally(secret);
            return delivery$;
          },
        });
        flow.open('Biometric');
        flow.dispatch(events.confirmedBiometric());
        // Also drain the old implementation's Promise-based Android recovery.
        await nextStoreTurn();
        const input = flow.sendAuthSecretInternally.mock.calls[0][0];
        expect([...input]).toEqual([...makeSecret()]);
        expect(flow.verifyAuthSecret).not.toHaveBeenCalled();
        flow.interrupt(interruption);
        expect.soft(input.every(byte => byte === 0)).toBe(true);
        delivery$.next();
        delivery$.complete();
        expect.soft(flow.verifyAuthSecret).not.toHaveBeenCalled();
        expect.soft(flow.emitted).toEqual([]);
        await sendAuthSecretApi.sendAuthSecretInternally(makeSecret());
        flow.open('Password');
        flow.dispatch(events.confirmedPassword());
        const verified = events.verifiedPassword({ success: true });
        expect(flow.emitted).toContainEqual(verified);
        flow.dispatch(verified);
        expect(flow.verifyAuthSecret).toHaveBeenCalledOnce();
        const clone = flow.verifyAuthSecret.mock.calls[0][0].authSecret;
        expect(propagate).toHaveBeenCalledExactlyOnceWith(clone);
        expect(clone.every(byte => byte === 0)).toBe(true);
      },
    );
  });

  it.each(['throw', 'error', 'empty', 'unsubscribe'] as const)(
    'wipes the retrieved buffer when delivery ends through %s',
    outcome => {
      const delivery$ = new Subject<void>();
      const flow = makeHarness({
        platform: 'ios',
        send: () => {
          if (outcome === 'throw')
            throw new Error('synthetic delivery failure');
          if (outcome === 'error')
            return throwError(() => new Error('synthetic delivery failure'));
          return outcome === 'empty' ? EMPTY : delivery$;
        },
      });
      flow.open('Biometric');
      flow.dispatch(events.confirmedBiometric());
      const input = flow.sendAuthSecretInternally.mock.calls[0][0];
      if (outcome === 'unsubscribe') flow.biometricSubscription.unsubscribe();
      expect(input.every(byte => byte === 0)).toBe(true);
      expect(flow.verifyAuthSecret).not.toHaveBeenCalled();
      expect(flow.errors).toEqual([]);
      expect(flow.emitted).toEqual(
        outcome === 'throw' || outcome === 'error'
          ? [
              events.verifiedBiometric({
                success: false,
                failureReason: 'verification_failed',
              }),
            ]
          : [],
      );
    },
  );

  it('keeps native pre-auth exclusive after cancellation, then allows a new recovery', () => {
    const scheduler = new TestScheduler((actual, expected) => {
      expect(actual).toEqual(expected);
    });
    scheduler.run(({ cold, expectSubscriptions, flush }) => {
      const oldNative$ = cold<LocalAuthenticateResult>('----s|', {
        s: { success: true },
      });
      const nextNative$ = cold<LocalAuthenticateResult>('-s|', {
        s: { success: true },
      });
      const localAuthentication = createMockLocalAuth();
      localAuthentication.authenticate = vi
        .fn()
        .mockReturnValueOnce(oldNative$)
        .mockReturnValueOnce(nextNative$);
      let reads = 0;
      const flow = makeHarness({
        localAuthentication,
        getItem: () => {
          if (++reads <= 3) throw keystoreError();
          return secretHex;
        },
        send: secret => {
          void sendAuthSecretApi.sendAuthSecretInternally(secret);
          return of(undefined);
        },
      });
      flow.open('Biometric');
      flow.dispatch(events.confirmedBiometric());
      scheduler.schedule(() => {
        flow.interrupt('preempted');
        flow.open('Biometric');
        flow.dispatch(events.confirmedBiometric());
        expect(localAuthentication.authenticate).toHaveBeenCalledOnce();
        expect(flow.emitted).toHaveLength(1);
        flow.dispatch(flow.emitted[0]);
      }, 2);
      scheduler.schedule(() => {
        expect(flow.secureStore.getItem).toHaveBeenCalledTimes(2);
        expect(flow.sendAuthSecretInternally).not.toHaveBeenCalled();
        flow.dispatch(events.confirmedBiometric());
      }, 6);
      flush();
      expectSubscriptions(oldNative$.subscriptions).toBe('^---!');
      expectSubscriptions(nextNative$.subscriptions).toBe('------^!');
      expect(localAuthentication.authenticate).toHaveBeenCalledTimes(2);
      expect(flow.verifyAuthSecret).toHaveBeenCalledOnce();
      expect(flow.emitted[1]).toEqual(
        events.verifiedBiometric({ success: true }),
      );
      flow.dispatch(flow.emitted[1]);
      const clone = flow.verifyAuthSecret.mock.calls[0][0].authSecret;
      expect(clone.every(byte => byte === 0)).toBe(true);
    });
  });

  it.each(['error', 'empty', 'throw'] as const)(
    'releases native pre-auth ownership after %s and permits retry',
    async outcome => {
      const localAuthentication = createMockLocalAuth();
      localAuthentication.authenticate = vi
        .fn()
        .mockImplementationOnce(() => {
          if (outcome === 'throw') throw new Error('synthetic native failure');
          return outcome === 'empty'
            ? EMPTY
            : throwError(() => new Error('synthetic native failure'));
        })
        .mockReturnValue(of({ success: true }));
      let reads = 0;
      const flow = makeHarness({
        localAuthentication,
        getItem: () => {
          if (++reads <= 2) throw keystoreError();
          return secretHex;
        },
        send: secret => {
          void sendAuthSecretApi.sendAuthSecretInternally(secret);
          return of(undefined);
        },
      });
      flow.open('Biometric');
      flow.dispatch(events.confirmedBiometric());
      await nextStoreTurn();
      expect(flow.emitted[0]).toMatchObject({
        payload: { success: false, failureReason: 'pre_auth_failed' },
      });
      flow.dispatch(flow.emitted[0]);
      flow.dispatch(events.confirmedBiometric());
      await nextStoreTurn();
      expect(localAuthentication.authenticate).toHaveBeenCalledTimes(2);
      expect(flow.verifyAuthSecret).toHaveBeenCalledOnce();
      flow.dispatch(flow.emitted[1]);
      expect(
        flow.verifyAuthSecret.mock.calls[0][0].authSecret.every(
          byte => byte === 0,
        ),
      ).toBe(true);
    },
  );

  it('ignores cancellation of a mandatory prompt and preserves the successful Android session secret', () => {
    const propagate = vi.spyOn(authSecretAccessor, 'propagateAuthSecret');
    const preAuth$ = new Subject<LocalAuthenticateResult>();
    const localAuthentication = createMockLocalAuth();
    localAuthentication.authenticate = vi.fn(() => preAuth$);
    let reads = 0;
    const flow = makeHarness({
      localAuthentication,
      getItem: () => {
        if (++reads === 1) throw keystoreError();
        return secretHex;
      },
      send: secret => {
        void sendAuthSecretApi.sendAuthSecretInternally(secret);
        return of(undefined);
      },
    });
    flow.dispatch(events.requested({ ...config, cancellable: false }));
    flow.dispatch(events.openedBiometric());
    flow.dispatch(events.confirmedBiometric());
    flow.dispatch(events.cancelled());
    expect(flow.state$.value.status).toBe('VerifyingBiometric');
    preAuth$.next({ success: true });
    preAuth$.complete();
    expect(flow.verifyAuthSecret).toHaveBeenCalledOnce();
    const clone = flow.verifyAuthSecret.mock.calls[0][0].authSecret;
    expect([...clone]).toEqual([...makeSecret()]);
    flow.dispatch(flow.emitted[0]);
    expect(propagate).toHaveBeenCalledExactlyOnceWith(clone);
    expect(clone.every(byte => byte === 0)).toBe(true);
    expect(
      flow.sendAuthSecretInternally.mock.calls[0][0].every(byte => byte === 0),
    ).toBe(true);
    const available: number[][] = [];
    subscriptions.push(
      authSecretAccessor
        .accessAuthSecret(secret => of([...secret]))
        .subscribe(secret => available.push(secret)),
    );
    expect(available).toEqual([[...makeSecret()]]);
  });

  it.each(['failure', 'error'] as const)(
    'ignores a late native %s after the prompt ends',
    async outcome => {
      const preAuth$ = new Subject<LocalAuthenticateResult>();
      const localAuthentication = createMockLocalAuth();
      localAuthentication.authenticate = vi.fn(() => preAuth$);
      const flow = makeHarness({
        localAuthentication,
        getItem: () => {
          throw keystoreError();
        },
      });
      flow.open('Biometric');
      flow.dispatch(events.confirmedBiometric());
      flow.interrupt('preempted');
      flow.open('Password');
      if (outcome === 'failure')
        preAuth$.next({ success: false, error: 'lockout' });
      else preAuth$.error(new Error('synthetic native failure'));
      preAuth$.complete();
      await nextStoreTurn();
      expect(flow.emitted).toEqual([]);
      expect(flow.errors).toEqual([]);
      expect(flow.secureStore.getItem).toHaveBeenCalledOnce();
      expect(flow.secureStore.deleteItemAsync).not.toHaveBeenCalled();
      expect(flow.sendAuthSecretInternally).not.toHaveBeenCalled();
    },
  );
});
