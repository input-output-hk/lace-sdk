/**
 * An Account Custody Contract executed in process over the compact
 * runtime: circuits run against a local query context with no node,
 * indexer, proof server or wallet, so a test can issue and revoke grants
 * through the module's own authoriser and gated call and read the
 * resulting ledger state back. The contract's assertions run exactly as
 * on chain, so a challenge the contract's mirror does not reproduce, or a
 * scope the issue rules refuse, aborts the call here as it would there.
 * The account may run from another build's generated module, and carry a
 * callee: a contract its circuits call, executed in process beside it
 * through the runtime's own cross-contract resolution.
 */
import { AccAddress } from '@lace-contract/passport';
import { ByteArray, HexBytes } from '@lace-lib/util';
import {
  ContractOperation,
  createCircuitContext,
  createConstructorContext,
  sampleContractAddress,
} from '@midnight-ntwrk/compact-runtime';
import * as ledgerV9 from '@midnightntwrk/ledger-v9';

import { Contract, ledger, pureCircuits } from '../../src/acc/acc-module';
import { devJubjubAuthoriser } from '../../src/acc/dev-authoriser';
import { executeGatedCall } from '../../src/acc/gated-call';
import { createPassportRegistry } from '../../src/acc/registry';
import {
  JubjubDevice,
  authArgs,
  randomJubjubScalar,
} from '../../src/acc/signer';
import { resolveUseCounter } from '../../src/acc/use-counter';

import type { Ledger, Witnesses } from '../../src/acc/acc-module';
import type { GatedContractHandle } from '../../src/acc/gated-call';
import type { GrantCircuitCall } from '../../src/acc/grants';
import type {
  AccountBundle,
  MaintenanceVerifyingKey,
  PassportAuthoriser,
  ShieldedCoin,
  UseCounter,
} from '@lace-contract/passport';
import type {
  ChargedState,
  CircuitContext,
  CircuitResults,
  ConstructorContext,
  ConstructorResult,
  ContractInstance,
  ContractModuleProvider,
  ContractState,
  ContractStateProvider,
  JubjubPoint,
  Module,
} from '@midnight-ntwrk/compact-runtime';

/** A held coin as the contract's witness hands it to a spend. */
type QualifiedCoin = {
  nonce: Uint8Array;
  color: Uint8Array;
  value: bigint;
  mt_index: bigint;
};

/** The coin a shielded spend consumes, present only while one runs. */
type PrivateState = { heldCoin?: QualifiedCoin };
type ImpureCircuit = (
  context: CircuitContext<PrivateState>,
  ...args: unknown[]
) => Promise<CircuitResults<PrivateState, unknown>>;

/**
 * Serves the coin the running spend was given, and refuses a spend
 * outside one, since the simulated account captures no coins of its own.
 */
const witnesses: Witnesses<PrivateState> = {
  held_coin: context => {
    const { heldCoin } = context.privateState;
    if (!heldCoin) throw new Error('The simulated account holds no coins');
    return [context.privateState, heldCoin];
  },
};

/** A fixed block time in POSIX seconds, before any sensible expiry. */
const SIM_BLOCK_TIME = 1_800_000_000;
/** The block the simulated transaction builds on, which pins where a callee's state is read. */
const SIM_PARENT_BLOCK_HASH = '00'.repeat(32);
const VETO_WINDOW_SECONDS = 259_200n;
const SALT_LENGTH = 32;
const ENC_KEY_LENGTH = 32;
const RECOVERY_WRAP_LENGTH = 64;

type CoinPublicKey = { bytes: Uint8Array };

/** A coin the account holds, with the tree index its commitment took. */
type SimHeldCoin = ShieldedCoin & { mtIndex: bigint };

/**
 * The contract maintenance authority as the ledger keeps it: a committee
 * at threshold one and the counter the next update is built against.
 */
type SimAuthority = {
  committee: MaintenanceVerifyingKey[];
  threshold: number;
  counter: bigint;
};

/**
 * The constructor arguments every build of the account takes: the boot
 * commitment, `enc_key`, the recovery public key, the recovery wrap and
 * the veto window.
 */
type AccountConstructorArgs = [
  Uint8Array,
  Uint8Array,
  JubjubPoint,
  Uint8Array,
  bigint,
];

/**
 * The surface of a generated account contract the sim drives: its
 * circuits and the constructor every build of the account shares.
 */
type SimAccountContract = {
  impureCircuits: unknown;
  initialState: (
    context: ConstructorContext<PrivateState>,
    ...args: AccountConstructorArgs
  ) => Promise<ConstructorResult<PrivateState>>;
};

/**
 * A generated module the sim runs an account from: a build of the account
 * contract whose ledger decodes to `L`, the vendored build by default.
 */
export type SimAccountModule<L extends Ledger = Ledger> = {
  Contract: new (witnesses: Witnesses<PrivateState>) => SimAccountContract;
  ledger: (state: ChargedState) => L;
};

const accountModule: SimAccountModule = { Contract, ledger };

/** A witnessless contract whose constructor takes no argument. */
type SimCalleeContract = ContractInstance & {
  initialState: (
    context: ConstructorContext<Record<string, never>>,
  ) => Promise<ConstructorResult<Record<string, never>>>;
};

/**
 * A generated module the sim deploys a callee from: what the runtime
 * resolves a cross-contract call against, with the constructor the sim
 * deploys it through and the ledger decoder a test reads its state by.
 */
export type SimCalleeModule<L> = Omit<Module, 'Contract'> & {
  Contract: new (witnesses: Record<string, never>) => SimCalleeContract;
  ledger: (state: ChargedState) => L;
};

type CreateCalleeSimOptions<L> = {
  /** The callee's address, as the account names it in a contract argument. */
  address: string;
  /** Loads the callee's generated module, as a registered called contract does. */
  module: () => Promise<SimCalleeModule<L>>;
  /** The verifier key the deployed contract holds for each of its operations. */
  verifierKeys: Readonly<Record<string, Uint8Array>>;
};

/**
 * A contract an account circuit calls, deployed in process: the runtime
 * resolves its module through `moduleProvider` and reads its deployed
 * state through `stateProvider`, served only at the parent block the
 * account's call is pinned to, checks the module's verifier key
 * fingerprints against the keys the state holds as it would on chain,
 * and each accepted call of the account leaves the callee's state
 * advanced for the next.
 */
export class CalleeSim<L> {
  public readonly address: string;
  public readonly moduleProvider: ContractModuleProvider;
  public readonly stateProvider: ContractStateProvider;
  private readonly module: SimCalleeModule<L>;
  private readonly state: ContractState;

  private constructor(
    address: string,
    module: SimCalleeModule<L>,
    state: ContractState,
  ) {
    this.address = address;
    this.module = module;
    this.state = state;
    this.moduleProvider = {
      resolve: callee => (callee === address ? async () => module : undefined),
    };
    this.stateProvider = {
      getContractState: async (blockHash, callee) =>
        blockHash === SIM_PARENT_BLOCK_HASH && callee === address
          ? state
          : undefined,
    };
  }

  /** Deploys the callee from its constructor, holding the given verifier keys. */
  public static async create<L>({
    address,
    module,
    verifierKeys,
  }: CreateCalleeSimOptions<L>): Promise<CalleeSim<L>> {
    const loaded = await module();
    const contract = new loaded.Contract({});
    const deployed = await contract.initialState(
      createConstructorContext<Record<string, never>>(
        {},
        { bytes: crypto.getRandomValues(new Uint8Array(ENC_KEY_LENGTH)) },
      ),
    );
    const state = deployed.currentContractState;
    for (const [circuit, verifierKey] of Object.entries(verifierKeys)) {
      const operation = new ContractOperation();
      operation.verifierKey = verifierKey;
      state.setOperation(circuit, operation);
    }
    return new CalleeSim(address, loaded, state);
  }

  public ledger(): L {
    return this.module.ledger(this.state.data);
  }

  /** The deployed state as the runtime reads it. */
  public contractState(): ContractState {
    return this.state;
  }

  /** Takes the ledger state an accepted call of the account left the callee in. */
  public adopt(state: ChargedState): void {
    this.state.data = state;
  }
}

type AccountSimProps<L extends Ledger> = {
  addressHex: string;
  scalar: bigint;
  module: SimAccountModule<L>;
  contract: SimAccountContract;
  state: ChargedState;
  coinPublicKey: CoinPublicKey;
  operations?: readonly string[];
  authority: SimAuthority;
  bundles?: readonly AccountBundle[];
  callee?: CalleeSim<unknown>;
};

type CreateAccountSimOptions<L extends Ledger> = {
  /** The X25519 public key the constructor stores as `enc_key`; random by default. */
  encKey?: Uint8Array;
  /** The initial device's scalar; random by default. */
  scalar?: bigint;
  /**
   * The operations the contract state reports verifier keys for; every
   * impure circuit by default. The sim runs any circuit regardless.
   */
  operations?: readonly string[];
  /** The maintenance committee the deployment leaves; none, a locked account, by default. */
  committee?: MaintenanceVerifyingKey[];
  /** The build the account runs from; the vendored one by default. */
  module?: SimAccountModule<L>;
  /** The bundles registered beside the default, whose described circuits the sim's authoriser signs. */
  bundles?: readonly AccountBundle[];
  /** The contract the account's circuits call, deployed in process beside it. */
  callee?: CalleeSim<unknown>;
};

export class AccountSim<L extends Ledger = Ledger> {
  public readonly address: Uint8Array;
  public readonly account: AccAddress;
  public readonly authoriser: PassportAuthoriser;
  private readonly addressHex: string;
  private readonly scalar: bigint;
  private state: ChargedState;
  private readonly module: SimAccountModule<L>;
  private readonly contract: SimAccountContract;
  private readonly circuits: Record<string, ImpureCircuit>;
  private readonly coinPublicKey: CoinPublicKey;
  private operations: readonly string[];
  private authority: SimAuthority;
  private readonly bundles: readonly AccountBundle[] | undefined;
  private readonly callee: CalleeSim<unknown> | undefined;

  private constructor({
    addressHex,
    scalar,
    module,
    contract,
    state,
    coinPublicKey,
    operations,
    authority,
    bundles,
    callee,
  }: AccountSimProps<L>) {
    this.addressHex = addressHex;
    this.scalar = scalar;
    this.address = ByteArray.fromHex(HexBytes(addressHex));
    this.account = AccAddress(addressHex);
    this.authoriser = devJubjubAuthoriser(
      scalar,
      createPassportRegistry({ bundles }),
    );
    this.module = module;
    this.contract = contract;
    this.circuits = contract.impureCircuits as Record<string, ImpureCircuit>;
    this.state = state;
    this.coinPublicKey = coinPublicKey;
    this.operations = operations ?? Object.keys(this.circuits);
    this.authority = authority;
    this.bundles = bundles;
    this.callee = callee;
  }

  /** Deploys and activates an account whose initial device is the sim's. */
  public static async create<L extends Ledger = Ledger>({
    encKey = crypto.getRandomValues(new Uint8Array(ENC_KEY_LENGTH)),
    scalar = randomJubjubScalar(),
    operations,
    committee = [],
    module = accountModule as SimAccountModule<L>,
    bundles,
    callee,
  }: CreateAccountSimOptions<L> = {}): Promise<AccountSim<L>> {
    const device = new JubjubDevice(scalar);
    const contract = new module.Contract(witnesses);
    const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
    const coinPublicKey: CoinPublicKey = {
      bytes: crypto.getRandomValues(new Uint8Array(ENC_KEY_LENGTH)),
    };
    const deployed = await contract.initialState(
      createConstructorContext<PrivateState>({}, coinPublicKey),
      device.bootCommitment(salt),
      encKey,
      JubjubDevice.generate().pk,
      new Uint8Array(RECOVERY_WRAP_LENGTH),
      VETO_WINDOW_SECONDS,
    );
    const sim = new AccountSim<L>({
      addressHex: sampleContractAddress(),
      scalar,
      module,
      contract,
      state: deployed.currentContractState.data,
      coinPublicKey,
      operations,
      authority: { committee, threshold: 1, counter: 0n },
      bundles,
      callee,
    });
    await sim.call('activate_initial_device_with_jubjub', device.pk, salt);
    return sim;
  }

  /**
   * The account as it stands now, as a second sim: calls on either leave
   * the other where it was, so a test can run two histories from one
   * costly state. A callee is shared, since its state lives on its own.
   */
  public fork(): AccountSim<L> {
    return new AccountSim<L>({
      addressHex: this.addressHex,
      scalar: this.scalar,
      module: this.module,
      contract: this.contract,
      state: this.state,
      coinPublicKey: this.coinPublicKey,
      operations: this.operations,
      authority: this.authority,
      bundles: this.bundles,
      callee: this.callee,
    });
  }

  /** The maintenance authority the contract holds now. */
  public maintenanceAuthority(): SimAuthority {
    return this.authority;
  }

  /**
   * Applies a maintenance update as the ledger would: it must be built
   * against the current counter and carry, at index 0, a signature of the
   * sole committee member over its data. A replace installs its
   * authority, a verifier key insert adds its operation to those the
   * contract state reports, and the counter advances by one.
   */
  public maintain(update: ledgerV9.MaintenanceUpdate): void {
    const { committee, counter } = this.authority;
    const [[index, signature]] = update.signatures;
    if (
      committee.length !== 1 ||
      index !== 0n ||
      update.counter !== counter ||
      !ledgerV9.verifySignature(committee[0], update.dataToSign, signature)
    ) {
      throw new Error('The simulated contract refuses the maintenance update');
    }
    let next: SimAuthority = { ...this.authority, counter: counter + 1n };
    for (const change of update.updates) {
      if (change instanceof ledgerV9.VerifierKeyInsert) {
        const operation = String(change.operation);
        if (!this.operations.includes(operation)) {
          this.operations = [...this.operations, operation];
        }
      }
      if (change instanceof ledgerV9.ReplaceAuthority) {
        const { committee: installed, threshold } = change.authority;
        next = {
          committee: installed.map(({ tag, value }) => ({ tag, value })),
          threshold,
          counter: change.authority.counter,
        };
      }
    }
    this.authority = next;
  }

  /** The device key behind the sim's authoriser. */
  public device(): JubjubDevice {
    return new JubjubDevice(this.scalar);
  }

  /** Runs one circuit against the current state and keeps the result. */
  public async call(circuit: string, ...args: unknown[]): Promise<unknown> {
    return (await this.run(circuit, ...args)).result;
  }

  /**
   * Deposits a shielded coin with its inbox entry through the
   * permissionless circuit, as any depositor may, and returns the coin
   * commitment the contract claimed for it: what the chain would carry as
   * the output's commitment.
   */
  public async deposit(coin: ShieldedCoin, entry: Uint8Array): Promise<string> {
    const results = await this.run('deposit_shielded', coin, entry);
    const [commitment] =
      results.context.callContext.currentQueryContext.effects
        .claimedShieldedReceives;
    if (commitment === undefined) {
      throw new Error('The simulated deposit claimed no coin');
    }
    return commitment;
  }

  /**
   * Spends a held coin in full to a user through the device-gated
   * shielded withdrawal, signed by the sim's device as the module's
   * authoriser would sign it, and returns the nullifier the contract
   * claimed for the spend: what the chain would record for the input.
   */
  public async withdrawShielded(
    coin: SimHeldCoin,
    recipient: Uint8Array,
  ): Promise<string> {
    const ledgerState = this.ledger();
    const { useCounter } = await resolveUseCounter({
      ledgerState,
      authoriser: this.authoriser,
      address: this.account,
    });
    const device = this.device();
    const held: QualifiedCoin = {
      nonce: coin.nonce,
      color: coin.color,
      value: coin.value,
      mt_index: coin.mtIndex,
    };
    const authorisation = device.sign(
      (sigR, grindNonce) =>
        pureCircuits.challenge_withdraw_shielded_with_jubjub(
          { bytes: this.address },
          sigR,
          device.pk,
          { bytes: recipient },
          coin.color,
          coin.value,
          held,
          ledgerState.auth_nonce,
          grindNonce,
        ),
      useCounter,
    );
    const results = await this.runWith(
      { heldCoin: held },
      'withdraw_shielded_with_jubjub',
      { bytes: recipient },
      coin.color,
      coin.value,
      ...authArgs(authorisation),
    );
    const [nullifier] =
      results.context.callContext.currentQueryContext.effects.claimedNullifiers;
    if (nullifier === undefined) {
      throw new Error('The simulated withdrawal claimed no nullifier');
    }
    return nullifier;
  }

  public ledger(): L {
    return this.module.ledger(this.state);
  }

  /** The contract state as an indexer would serve it. */
  public contractState(): {
    data: ChargedState;
    operations: () => string[];
  } {
    return { data: this.state, operations: () => [...this.operations] };
  }

  /**
   * The found-contract handle shape, over every circuit of the contract,
   * each call answering the finalized call data a flow reads back: the
   * transaction id and the circuit's return value.
   */
  public handle(): GatedContractHandle {
    return {
      callTx: Object.fromEntries(
        Object.keys(this.circuits).map(circuit => [
          circuit,
          async (...args: unknown[]) => ({
            public: { txId: `simulated-${circuit}` },
            private: { result: await this.call(circuit, ...args) },
          }),
        ]),
      ),
    };
  }

  /** Submits a gated call through the module's gate, as a flow would. */
  public async gated(
    call: GrantCircuitCall,
    knownUseCounter?: UseCounter,
  ): Promise<UseCounter> {
    const { advancedCounter } = await executeGatedCall({
      handle: this.handle(),
      authoriser: this.authoriser,
      circuit: call.circuit,
      args: call.args,
      address: this.account,
      ledgerState: this.ledger(),
      knownUseCounter,
    });
    return advancedCounter;
  }

  private async run(
    circuit: string,
    ...args: unknown[]
  ): Promise<CircuitResults<PrivateState, unknown>> {
    return this.runWith({}, circuit, ...args);
  }

  private async runWith(
    privateState: PrivateState,
    circuit: string,
    ...args: unknown[]
  ): Promise<CircuitResults<PrivateState, unknown>> {
    const impure = this.circuits[circuit];
    if (!impure)
      throw new Error(`Simulated contract has no circuit ${circuit}`);
    const { callee } = this;
    const context = createCircuitContext<PrivateState>({
      circuitId: circuit,
      contractAddress: this.addressHex,
      coinPublicKeyOrZswapState: this.coinPublicKey,
      contractState: this.state,
      privateState,
      time: SIM_BLOCK_TIME,
      ...(callee
        ? {
            parentBlockHash: SIM_PARENT_BLOCK_HASH,
            crossContract: {
              stateProvider: callee.stateProvider,
              moduleProvider: callee.moduleProvider,
            },
          }
        : {}),
    });
    const results = await impure(context, ...args);
    this.state = results.context.callContext.currentQueryContext.state;
    const calleeState = callee
      ? results.context.queryContexts[callee.address]?.state
      : undefined;
    if (callee && calleeState) callee.adopt(calleeState);
    return results;
  }
}
