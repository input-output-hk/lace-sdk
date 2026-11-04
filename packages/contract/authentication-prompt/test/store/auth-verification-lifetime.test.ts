import { ByteArray } from '@lace-lib/util';
import { BehaviorSubject, Subject, from, of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as authSecretAccessor from '../../src/store/auth-secret-accessor';
import {
  initializeInternalAuthSecretAccessor,
  sendAuthSecretApi,
} from '../../src/store/auth-secret-accessor-internal';
import { createVerifyAndPropagateAuthSecret } from '../../src/store/side-effects/auth-verification-handler';
import { makeAuthenticationBiometricVerifying } from '../../src/store/side-effects/biometrics-side-effects';
import { makeAuthenticationPromptVerifying } from '../../src/store/side-effects/password-side-effects';
import { stateMachine } from '../../src/store/state-machine';
import { AuthSecret } from '../../src/value-objects';

import {
  createMockLocalAuth,
  createMockSecureStore,
} from './biometric-test-utils';

import type { AuthenticationPromptEvent } from '../../src/store/state-machine';
import type {
  AuthenticationPromptSliceState,
  Config,
} from '../../src/store/types';
import type { Subscription } from 'rxjs';

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
const subscriptions: Subscription[] = [];
const makeSecret = () =>
  AuthSecret(ByteArray.fromUTF8('synthetic-test-password'));
const expectZeroed = (secret: AuthSecret) => {
  expect([...secret]).toEqual(new Array(secret.length).fill(0));
};

type Method = 'Biometric' | 'Password';

const makeFlow = (method: Method = 'Password', promptConfig = config) => {
  const state$ = new BehaviorSubject<AuthenticationPromptSliceState>(
    stateMachine.initialState,
  );
  const dispatch = (event: AuthenticationPromptEvent) => {
    state$.next(stateMachine.transition(state$.value, event));
  };
  const startPrompt = (nextMethod: Method) => {
    dispatch(events.requested(promptConfig));
    dispatch(
      nextMethod === 'Password'
        ? events.openedPassword()
        : events.openedBiometric(),
    );
    dispatch(
      nextMethod === 'Password'
        ? events.confirmedPassword()
        : events.confirmedBiometric(),
    );
  };
  const startVerification = async (verificationMethod: Method) => {
    const input = makeSecret();
    const result$ = new Subject<boolean>();
    const verifyAuthSecret = vi.fn(
      (_params: { authSecret: AuthSecret }) => result$,
    );
    const verify = createVerifyAndPropagateAuthSecret({
      ...initializeInternalAuthSecretAccessor(),
      verifyAuthSecret,
    });
    await sendAuthSecretApi.sendAuthSecretInternally(input);
    const emitted: AuthenticationPromptEvent[] = [];
    const errors: unknown[] = [];
    const subscription = verify<AuthenticationPromptEvent>({
      selectAuthenticationPromptState$: state$,
      actionCreator:
        verificationMethod === 'Password'
          ? events.verifiedPassword
          : events.verifiedBiometric,
      ...(verificationMethod === 'Biometric'
        ? { failureReason: 'verification_failed' as const }
        : {}),
    }).subscribe({
      next: event => emitted.push(event),
      error: error => errors.push(error),
    });
    subscriptions.push(subscription);
    const clone = verifyAuthSecret.mock.calls[0][0].authSecret;
    expect(clone).not.toBe(input);
    expect([...clone]).toEqual([...makeSecret()]);
    expectZeroed(input);
    const resolve = (success: boolean) => {
      result$.next(success);
      result$.complete();
    };
    return { clone, emitted, errors, subscription, result$, resolve };
  };
  startPrompt(method);
  return { state$, dispatch, startPrompt, startVerification };
};

beforeEach(() => {
  authSecretAccessor.clearAuthSecret();
});
afterEach(() => {
  subscriptions.splice(0).forEach(subscription => {
    subscription.unsubscribe();
  });
  authSecretAccessor.clearAuthSecret();
  vi.restoreAllMocks();
});

describe.each<Method>(['Password', 'Biometric'])(
  '%s verification secret lifetime',
  method => {
    it('propagates once on success, then wipes the verification clone', async () => {
      const propagate = vi.spyOn(authSecretAccessor, 'propagateAuthSecret');
      const flow = makeFlow(method);
      const attempt = await flow.startVerification(method);
      attempt.resolve(true);
      expect(propagate).not.toHaveBeenCalled();
      expect([...attempt.clone]).toEqual([...makeSecret()]);
      flow.dispatch(attempt.emitted[0]);
      expect(propagate).toHaveBeenCalledExactlyOnceWith(attempt.clone);
      expectZeroed(attempt.clone);
      expect(attempt.subscription.closed).toBe(true);
      const available: number[][] = [];
      subscriptions.push(
        authSecretAccessor
          .accessAuthSecret(secret => of([...secret]))
          .subscribe(secret => available.push(secret)),
      );
      expect(available).toEqual([[...makeSecret()]]);
    });

    it('wipes a rejected credential and preserves the failure payload', async () => {
      const propagate = vi.spyOn(authSecretAccessor, 'propagateAuthSecret');
      const flow = makeFlow(method);
      const attempt = await flow.startVerification(method);
      attempt.resolve(false);
      expectZeroed(attempt.clone);
      expect(attempt.subscription.closed).toBe(true);
      expect(attempt.emitted[0]).toMatchObject({
        payload:
          method === 'Biometric'
            ? { success: false, failureReason: 'verification_failed' }
            : { success: false },
      });
      expect(propagate).not.toHaveBeenCalled();
    });

    describe.each(['preempted', 'cancelled'] as const)('%s', interruption => {
      it.each(['pending verification', 'pending verified action'] as const)(
        'wipes immediately with %s and ignores a late verifier result',
        async phase => {
          const propagate = vi.spyOn(authSecretAccessor, 'propagateAuthSecret');
          const flow = makeFlow(method, {
            ...config,
            cancellable: interruption === 'cancelled',
          });
          const attempt = await flow.startVerification(method);
          if (phase === 'pending verified action') attempt.resolve(true);
          const emittedBeforeInterruption = [...attempt.emitted];
          flow.dispatch(events[interruption]());
          expect(flow.state$.value).toMatchObject({
            status: 'Completing',
            success: false,
          });
          expectZeroed(attempt.clone);
          expect(attempt.subscription.closed).toBe(true);
          flow.dispatch(events.completed({ success: false }));
          attempt.resolve(true);
          expect(attempt.emitted).toEqual(emittedBeforeInterruption);
          expect(propagate).not.toHaveBeenCalled();
        },
      );

      it('never uses the interrupted clone in a later successful prompt', async () => {
        const propagate = vi.spyOn(authSecretAccessor, 'propagateAuthSecret');
        const flow = makeFlow(method);
        const first = await flow.startVerification(method);
        first.resolve(true);
        flow.dispatch(events[interruption]());
        flow.dispatch(events.completed({ success: false }));
        const nextMethod = method === 'Password' ? 'Biometric' : 'Password';
        flow.startPrompt(nextMethod);
        const second = await flow.startVerification(nextMethod);
        second.resolve(true);
        flow.dispatch(second.emitted[0]);
        expect(propagate).toHaveBeenCalledExactlyOnceWith(second.clone);
        expect(
          propagate.mock.calls.some(([secret]) => secret === first.clone),
        ).toBe(false);
        expectZeroed(first.clone);
        expectZeroed(second.clone);
        expect(first.subscription.closed).toBe(true);
      });
    });

    it('wipes when verification errors', async () => {
      const flow = makeFlow(method);
      const attempt = await flow.startVerification(method);
      const error = new Error('synthetic verifier failure');
      attempt.result$.error(error);
      expect(attempt.errors).toEqual([error]);
      expectZeroed(attempt.clone);
    });

    it('wipes when the owner unsubscribes', async () => {
      const flow = makeFlow(method);
      const attempt = await flow.startVerification(method);
      attempt.subscription.unsubscribe();
      expectZeroed(attempt.clone);
    });

    it('keeps a non-cancellable prompt active until verification succeeds', async () => {
      const flow = makeFlow(method, { ...config, cancellable: false });
      const attempt = await flow.startVerification(method);
      flow.dispatch(events.cancelled());
      expect([...attempt.clone]).toEqual([...makeSecret()]);
      expect(attempt.subscription.closed).toBe(false);
      attempt.resolve(true);
      flow.dispatch(attempt.emitted[0]);
      expectZeroed(attempt.clone);
    });
  },
);

describe('production verification side effects', () => {
  it.each<Method>(['Password', 'Biometric'])(
    'only propagates the new clone after an interrupted password prompt and a %s login',
    async nextMethod => {
      const propagate = vi.spyOn(authSecretAccessor, 'propagateAuthSecret');
      const flow = makeFlow();
      const verifyAuthSecret = vi.fn((_params: { authSecret: AuthSecret }) =>
        of(true),
      );
      const verifyAndPropagateAuthSecret = createVerifyAndPropagateAuthSecret({
        ...initializeInternalAuthSecretAccessor(),
        verifyAuthSecret,
      });
      const emitted: unknown[] = [];
      const dependencies = {
        actions: { authenticationPrompt: events },
        secureStore: createMockSecureStore(() =>
          Buffer.from(makeSecret()).toString('hex'),
        ),
        localAuthentication: createMockLocalAuth(),
      };
      const stateObservables = {
        authenticationPrompt: { selectState$: flow.state$ },
      };
      await sendAuthSecretApi.sendAuthSecretInternally(makeSecret());
      subscriptions.push(
        makeAuthenticationPromptVerifying({ verifyAndPropagateAuthSecret })(
          {} as never,
          stateObservables as never,
          dependencies as never,
        ).subscribe(event => emitted.push(event)),
      );
      subscriptions.push(
        makeAuthenticationBiometricVerifying({
          verifyAndPropagateAuthSecret,
          platform: 'ios',
          sendAuthSecretInternally: secret =>
            from(sendAuthSecretApi.sendAuthSecretInternally(secret)),
        })(
          {} as never,
          stateObservables as never,
          dependencies as never,
        ).subscribe(event => emitted.push(event)),
      );
      const firstClone = verifyAuthSecret.mock.calls[0][0].authSecret;
      flow.dispatch(events.preempted());
      flow.dispatch(events.completed({ success: false }));
      if (nextMethod === 'Password')
        await sendAuthSecretApi.sendAuthSecretInternally(makeSecret());
      flow.startPrompt(nextMethod);
      await Promise.resolve();
      expect(verifyAuthSecret).toHaveBeenCalledTimes(2);
      const secondClone = verifyAuthSecret.mock.calls[1][0].authSecret;
      expect(emitted).toHaveLength(2);
      const verified =
        nextMethod === 'Password'
          ? events.verifiedPassword({ success: true })
          : events.verifiedBiometric({ success: true });
      expect(emitted[1]).toEqual(verified);
      flow.dispatch(verified);
      expect(propagate).toHaveBeenCalledExactlyOnceWith(secondClone);
      expect(
        propagate.mock.calls.some(([secret]) => secret === firstClone),
      ).toBe(false);
      expectZeroed(firstClone);
      expectZeroed(secondClone);
    },
  );
});
