import { catchError, concat, EMPTY, filter, map, mergeMap, of } from 'rxjs';

import { createAccountRecordStore } from '../account-record';

import type { PassportAccountRecord } from '../account-record';
import type { SideEffect } from '@lace-contract/passport';

/** Whether a stored record names an activated account rather than a deployment in progress. */
const isActivatedRecord = (
  record: PassportAccountRecord | undefined,
): record is PassportAccountRecord =>
  record !== undefined && record.deployment === undefined;

/**
 * Rehydrates the persisted account record into the store on startup, so a
 * returning user's account is recognised without a new passkey ceremony.
 * Only a record whose activation succeeded is restored, hence status
 * 'ready'; a record still carrying a pending deployment names no usable
 * account and is left for the create flow to resume, or for sign-in to
 * complete once the chain shows it activated. The record names the
 * account but not its build, which only the chain holds. With the default
 * bundle alone registered the build is known, so the account is published
 * from the record at once and the grant roster follows from the chain;
 * with more, the account is published once its verifier keys resolve, in
 * the same pass as the roster. A chain read that fails publishes nothing
 * more, and the next sign-in recognises the account instead, reporting
 * what the chain refused. The device set is not persisted and is rebuilt
 * from chain by the device-management flows. A record sealed by a
 * passkey authoriser cannot be opened without a ceremony, and a ceremony
 * cannot run without a user gesture, so no storage key is passed here: a
 * sealed record reads as absent and the sign-in flow recognises the
 * account instead.
 */
export const restorePassportAccount: SideEffect = (
  _actionObservables,
  _stateObservables,
  dependencies,
) => {
  const {
    actions,
    createKeyValueStorage,
    passportBundles,
    passportFlows,
    passportNetwork,
  } = dependencies;
  const [defaultBundle, ...registeredBundles] = passportBundles.bundles;
  const publishAccount = (record: PassportAccountRecord, bundleId: string) => [
    actions.passport.setAccount({
      address: record.address,
      bindingVersion: record.bindingVersion,
      bundleId,
      status: 'ready',
      networkId: passportNetwork.networkId,
    }),
    actions.passport.setLocalUseCounter(record.localUseCounter),
  ];
  const restored = (record: PassportAccountRecord) =>
    passportFlows.restoreAccount(record, dependencies).pipe(
      filter(event => event.type === 'done'),
      map(({ result }) => result),
    );

  return createAccountRecordStore(createKeyValueStorage)
    .read()
    .pipe(
      filter(isActivatedRecord),
      mergeMap(record =>
        registeredBundles.length === 0
          ? concat(
              of(...publishAccount(record, defaultBundle.id)),
              restored(record).pipe(
                map(({ grants }) => actions.passport.setGrants(grants)),
                catchError(() => EMPTY),
              ),
            )
          : restored(record).pipe(
              mergeMap(({ bundleId, grants }) => [
                ...publishAccount(record, bundleId),
                actions.passport.setGrants(grants),
              ]),
              catchError(() => EMPTY),
            ),
      ),
    );
};
