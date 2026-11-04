import {
  CircuitNotRegisteredError,
  NotAuthorisedError,
  passportActions,
} from '@lace-contract/passport';
import { testSideEffect } from '@lace-lib/util-dev';
import { NEVER } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import '../../../src/augmentations';
import { runPassportFlow } from '../../../src/store/side-effects/passport-flows';

import type { ContractCallResult } from '../../../src/flows/call-contract';
import type { FlowEvent } from '../../../src/store/dependencies';
import type {
  ActionCreators,
  CallContractPayload,
  PassportAccountInfo,
  PassportDevice,
  PassportFlow,
  Selectors,
} from '@lace-contract/passport';
import type { Observable } from 'rxjs';
import type { RunHelpers } from 'rxjs/testing';

const actions = { ...passportActions };

const account: PassportAccountInfo = {
  address: 'ac'.repeat(32),
  bindingVersion: '0.1.0-lace.2-tally',
  bundleId: 'account-tally',
  status: 'ready',
  networkId: 'undeployed',
};
const sampledDevices: PassportDevice[] = [
  { commitmentHex: '11'.repeat(32), isLocal: true },
];
const refreshedDevices: PassportDevice[] = [
  { commitmentHex: '1a'.repeat(32), isLocal: true },
];
const circuit = 'tally_set_with_jubjub';
const payload: CallContractPayload = {
  circuit,
  args: ['ab'.repeat(32), '42'],
};
const heldCoin = {
  nonceHex: 'cd'.repeat(32),
  colorHex: 'ef'.repeat(32),
  value: '5',
  mtIndex: '2',
};
const called: ContractCallResult = {
  circuit,
  txId: 'call-tx',
  result: '42',
  devices: refreshedDevices,
  localUseCounter: '3',
};

/** The flow events a cold marble may carry, keyed by their marble letter. */
const events: Record<string, FlowEvent<ContractCallResult>> = {
  c: { type: 'progress', stage: 'proving' },
  d: { type: 'progress', stage: 'sponsoring' },
  f: { type: 'done', result: called },
  g: { type: 'done', result: { ...called, result: undefined } },
};

/** The actions the gate and the flow publish, keyed by their marble letter. */
const emitted = {
  a: actions.passport.setFlow('ceremony'),
  c: actions.passport.setFlow('proving'),
  d: actions.passport.setFlow('sponsoring'),
  h: actions.passport.setDevices(refreshedDevices),
  i: actions.passport.setLocalUseCounter('3'),
  k: actions.passport.setLastContractCall({
    circuit,
    txId: 'call-tx',
    result: '42',
  }),
  l: actions.passport.setLastContractCall({ circuit, txId: 'call-tx' }),
  j: actions.passport.setFlow('ready'),
  n: actions.passport.setFlowError({
    code: 'no-account',
    message: 'No ready Passport account is available.',
  }),
};

type FlowTest = {
  account?: string;
  payload?: CallContractPayload;
  flows?: (cold: RunHelpers['cold']) => Observable<FlowEvent<unknown>>[];
  assertion: (harness: {
    sideEffect$: Observable<unknown>;
    helpers: RunHelpers;
    flow: ReturnType<typeof vi.fn>;
  }) => void;
};

/**
 * Drives the gate on the virtual scheduler with the call flow replaced by
 * cold marbles; the other triggers never fire. Account letters are a the
 * account, u none.
 */
const runFlowTest = ({
  account: accountMarble = 'a',
  payload: triggered = payload,
  flows = () => [],
  assertion,
}: FlowTest) => {
  testSideEffect<Selectors, ActionCreators>(runPassportFlow, helpers => {
    const { cold, hot } = helpers;
    const flow = vi.fn((): Observable<FlowEvent<unknown>> => NEVER);
    for (const flow$ of flows(cold)) flow.mockReturnValueOnce(flow$);
    return {
      actionObservables: {
        passport: {
          addDevice$: NEVER,
          callContract$: hot('-t', {
            t: actions.passport.callContract(triggered),
          }),
          createAccount$: NEVER,
          installOperations$: NEVER,
          issueGrant$: NEVER,
          readShieldedHoldings$: NEVER,
          removeDevice$: NEVER,
          revokeAllGrants$: NEVER,
          revokeGrant$: NEVER,
          signIn$: NEVER,
        },
      },
      stateObservables: {
        passport: {
          selectAccount$: hot<PassportAccountInfo | undefined>(accountMarble, {
            a: account,
            u: undefined,
          }),
          selectDevices$: hot<PassportDevice[]>('t', { t: sampledDevices }),
          selectFlow$: hot<PassportFlow>('r', { r: 'ready' }),
          selectLocalUseCounter$: hot('k', { k: '2' }),
        },
      },
      dependencies: {
        actions,
        passportFlows: { callContract: flow },
      } as never,
      assertion: sideEffect$ => {
        assertion({ sideEffect$, helpers, flow });
      },
    };
  });
};

describe('runPassportFlow: callContract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs the call over the sampled account, roster and counter, then publishes the roster, the counter, the call and ready', () => {
    runFlowTest({
      flows: cold => [cold('-c-d-(f|)', events)],
      assertion: ({ sideEffect$, helpers, flow }) => {
        helpers.expectObservable(sideEffect$).toBe('-ac-d-(hikj)', emitted);
        helpers.flush();
        expect(flow).toHaveBeenCalledExactlyOnceWith(
          {
            circuit,
            args: payload.args,
            account,
            devices: sampledDevices,
            localUseCounter: '2',
          },
          expect.objectContaining({ actions }),
        );
      },
    });
  });

  it('hands the witnesses the action names to the flow', () => {
    runFlowTest({
      payload: { ...payload, witnesses: { heldCoin } },
      flows: cold => [cold('-(f|)', events)],
      assertion: ({ sideEffect$, helpers, flow }) => {
        helpers.expectObservable(sideEffect$).toBe('-a(hikj)', emitted);
        helpers.flush();
        expect(flow).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ witnesses: { heldCoin } }),
          expect.anything(),
        );
      },
    });
  });

  it('publishes a call whose circuit returned nothing without a result', () => {
    runFlowTest({
      flows: cold => [cold('-(g|)', events)],
      assertion: ({ sideEffect$, helpers }) => {
        helpers.expectObservable(sideEffect$).toBe('-a(hilj)', emitted);
      },
    });
  });

  it.each([
    [new NotAuthorisedError('failed assert: invalid signature')],
    [new CircuitNotRegisteredError('No such circuit.')],
  ] as const)(
    'maps a typed flow failure to one setFlowError carrying its code: $code',
    failure => {
      runFlowTest({
        flows: cold => [cold('-#', events, failure)],
        assertion: ({ sideEffect$, helpers }) => {
          helpers.expectObservable(sideEffect$).toBe('-ak', {
            ...emitted,
            k: actions.passport.setFlowError({
              code: failure.code,
              message: failure.message,
            }),
          });
        },
      });
    },
  );

  it('maps an untyped flow failure to setFlowError with the contract-call-failed code', () => {
    runFlowTest({
      flows: cold => [cold('-#', events, new Error('node unreachable'))],
      assertion: ({ sideEffect$, helpers }) => {
        helpers.expectObservable(sideEffect$).toBe('-ak', {
          ...emitted,
          k: actions.passport.setFlowError({
            code: 'contract-call-failed',
            message: 'node unreachable',
          }),
        });
      },
    });
  });

  it('refuses with no-account when no account is in state, without calling the flow', () => {
    runFlowTest({
      account: 'u',
      assertion: ({ sideEffect$, helpers, flow }) => {
        helpers.expectObservable(sideEffect$).toBe('-(an)', emitted);
        helpers.flush();
        expect(flow).not.toHaveBeenCalled();
      },
    });
  });
});
