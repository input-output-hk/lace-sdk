import { toEmpty } from '@cardano-sdk/util-rxjs';
import { firstStateOfStatus } from '@lace-lib/util-store';
import {
  filter,
  take,
  merge,
  tap,
  switchMap,
  of,
  EMPTY,
  takeUntil,
} from 'rxjs';

import { propagateAuthSecret } from '../auth-secret-accessor';

import type { AuthSecret } from '../../value-objects';
import type {
  AuthSecretVerifier,
  AuthenticationPromptSliceState,
  AccessAuthSecret,
  BiometricFailureReason,
} from '../types';
import type { Observable } from 'rxjs';

type VerifyAuthSecret = (
  ...params: Parameters<AuthSecretVerifier['verifyAuthSecret']>
) => Observable<Awaited<ReturnType<AuthSecretVerifier['verifyAuthSecret']>>>;

type MakeVerifyAndPropagateAuthSecretParams = {
  accessSecretFromAuthFlow: AccessAuthSecret;
  verifyAuthSecret: VerifyAuthSecret;
};

/**
 * Payload produced for password-flow verified events. Password flow only ever
 * fails with "wrong credential" at this stage, so no failureReason is emitted.
 */
type PasswordVerificationPayload = { success: boolean };

/**
 * Payload produced for biometric-flow verified events. When verification fails
 * here (authSecret didn't match sentinel), we attach failureReason so
 * analytics can distinguish retrieval-stage failures from verification-stage
 * failures.
 */
type BiometricVerificationPayload = {
  success: boolean;
  failureReason?: BiometricFailureReason;
};

type VerifyAndPropagateAuthSecretParams<T, P> = {
  selectAuthenticationPromptState$: Observable<AuthenticationPromptSliceState>;
  actionCreator: (params: P) => T;
  /**
   * Failure reason to attach when verification returns false. Biometric flow
   * passes `'verification_failed'`; password flow omits it.
   */
  failureReason?: BiometricFailureReason;
};

type VerifyAndPropagateAuthSecret = {
  <T>(
    params: VerifyAndPropagateAuthSecretParams<T, PasswordVerificationPayload>,
  ): Observable<T>;
  <T>(
    params: VerifyAndPropagateAuthSecretParams<T, BiometricVerificationPayload>,
  ): Observable<T>;
};

const propagateOnSuccessfulCompletion = (
  state$: Observable<AuthenticationPromptSliceState>,
  authSecret: AuthSecret,
): Observable<never> =>
  firstStateOfStatus(state$, 'Completing').pipe(
    take(1),
    filter(state => state.success),
    tap(() => {
      propagateAuthSecret(authSecret);
    }),
    toEmpty,
  );

export const createVerifyAndPropagateAuthSecret =
  ({
    accessSecretFromAuthFlow,
    verifyAuthSecret,
  }: MakeVerifyAndPropagateAuthSecretParams): VerifyAndPropagateAuthSecret =>
  <T>({
    selectAuthenticationPromptState$,
    actionCreator,
    failureReason,
  }: VerifyAndPropagateAuthSecretParams<
    T,
    BiometricVerificationPayload
  >): Observable<T> =>
    accessSecretFromAuthFlow(authSecret =>
      verifyAuthSecret({ authSecret }).pipe(
        switchMap(success => {
          const payload: BiometricVerificationPayload =
            !success && failureReason
              ? { success, failureReason }
              : { success };

          return merge(
            success
              ? propagateOnSuccessfulCompletion(
                  selectAuthenticationPromptState$,
                  authSecret,
                )
              : EMPTY,
            of(actionCreator(payload)),
          );
        }),
        // Arm cancellation before verification resolves. Successful completion
        // must reach the propagation arm before the accessor wipes its clone.
        takeUntil(
          firstStateOfStatus(
            selectAuthenticationPromptState$,
            'Completing',
          ).pipe(
            take(1),
            filter(state => !state.success),
          ),
        ),
      ),
    );

export type { VerifyAndPropagateAuthSecret };
