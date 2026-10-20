/**
 * An Account Custody Contract executed in process over the compact
 * runtime: circuits run against a local query context with no node,
 * indexer, proof server or wallet, so a test can issue and revoke grants
 * through the module's own authoriser and gated call and read the
 * resulting ledger state back. The contract's assertions run exactly as
 * on chain, so a challenge the contract's mirror does not reproduce, or a
 * scope the issue rules refuse, aborts the call here as it would there.
 */
import { AccAddress } from '@lace-contract/passport';
import { ByteArray, HexBytes } from '@lace-lib/util';
import {
  createCircuitContext,
  createConstructorContext,
  sampleContractAddress,
} from '@midnight-ntwrk/compact-runtime';

import { Contract, ledger } from '../../src/acc/acc-module';
import { devJubjubAuthoriser } from '../../src/acc/dev-authoriser';
import { executeGatedCall } from '../../src/acc/gated-call';
import { JubjubDevice, randomJubjubScalar } from '../../src/acc/signer';

import type { Ledger, Witnesses } from '../../src/acc/acc-module';
import type { GatedContractHandle } from '../../src/acc/gated-call';
import type { GrantCircuitCall } from '../../src/acc/grants';
import type {
  PassportAuthoriser,
  ShieldedCoin,
  UseCounter,
} from '@lace-contract/passport';
import type {
  ChargedState,
  CircuitContext,
  CircuitResults,
} from '@midnight-ntwrk/compact-runtime';

type PrivateState = Record<string, never>;
type ImpureCircuit = (
  context: CircuitContext<PrivateState>,
  ...args: unknown[]
) => Promise<CircuitResults<PrivateState, unknown>>;

/** A fixed block time in POSIX seconds, before any sensible expiry. */
const SIM_BLOCK_TIME = 1_800_000_000;
const VETO_WINDOW_SECONDS = 259_200n;
const SALT_LENGTH = 32;
const ENC_KEY_LENGTH = 32;
const RECOVERY_WRAP_LENGTH = 64;

const witnesses: Witnesses<PrivateState> = {
  held_coin: () => {
    throw new Error('The simulated account holds no coins');
  },
};

type CoinPublicKey = { bytes: Uint8Array };

type AccountSimProps = {
  addressHex: string;
  scalar: bigint;
  contract: InstanceType<typeof Contract>;
  state: ChargedState;
  coinPublicKey: CoinPublicKey;
  operations?: readonly string[];
};

type CreateAccountSimOptions = {
  /** The X25519 public key the constructor stores as `enc_key`; random by default. */
  encKey?: Uint8Array;
  /** The initial device's scalar; random by default. */
  scalar?: bigint;
  /**
   * The operations the contract state reports verifier keys for; every
   * impure circuit by default. The sim runs any circuit regardless.
   */
  operations?: readonly string[];
};

export class AccountSim {
  public readonly address: Uint8Array;
  public readonly account: AccAddress;
  public readonly authoriser: PassportAuthoriser;
  private readonly addressHex: string;
  private readonly scalar: bigint;
  private state: ChargedState;
  private readonly contract: InstanceType<typeof Contract>;
  private readonly circuits: Record<string, ImpureCircuit>;
  private readonly coinPublicKey: CoinPublicKey;
  private readonly operations: readonly string[];

  private constructor({
    addressHex,
    scalar,
    contract,
    state,
    coinPublicKey,
    operations,
  }: AccountSimProps) {
    this.addressHex = addressHex;
    this.scalar = scalar;
    this.address = ByteArray.fromHex(HexBytes(addressHex));
    this.account = AccAddress(addressHex);
    this.authoriser = devJubjubAuthoriser(scalar);
    this.contract = contract;
    this.circuits = contract.impureCircuits as unknown as Record<
      string,
      ImpureCircuit
    >;
    this.state = state;
    this.coinPublicKey = coinPublicKey;
    this.operations = operations ?? Object.keys(this.circuits);
  }

  /** Deploys and activates an account whose initial device is the sim's. */
  public static async create({
    encKey = crypto.getRandomValues(new Uint8Array(ENC_KEY_LENGTH)),
    scalar = randomJubjubScalar(),
    operations,
  }: CreateAccountSimOptions = {}): Promise<AccountSim> {
    const device = new JubjubDevice(scalar);
    const contract = new Contract<PrivateState>(witnesses);
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
    const sim = new AccountSim({
      addressHex: sampleContractAddress(),
      scalar,
      contract,
      state: deployed.currentContractState.data,
      coinPublicKey,
      operations,
    });
    await sim.call('activate_initial_device_with_jubjub', device.pk, salt);
    return sim;
  }

  /**
   * The account as it stands now, as a second sim: calls on either leave
   * the other where it was, so a test can run two histories from one
   * costly state.
   */
  public fork(): AccountSim {
    return new AccountSim({
      addressHex: this.addressHex,
      scalar: this.scalar,
      contract: this.contract,
      state: this.state,
      coinPublicKey: this.coinPublicKey,
      operations: this.operations,
    });
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

  public ledger(): Ledger {
    return ledger(this.state);
  }

  /** The contract state as an indexer would serve it. */
  public contractState(): {
    data: ChargedState;
    operations: () => string[];
  } {
    return { data: this.state, operations: () => [...this.operations] };
  }

  /** The found-contract handle shape, over every circuit of the contract. */
  public handle(): GatedContractHandle {
    return {
      callTx: Object.fromEntries(
        Object.keys(this.circuits).map(circuit => [
          circuit,
          async (...args: unknown[]) => {
            await this.call(circuit, ...args);
            return { txId: `simulated-${circuit}` };
          },
        ]),
      ),
    };
  }

  /** Submits a gated call through the module's gate, as a flow would. */
  public async gated(
    call: GrantCircuitCall,
    knownUseCounter?: UseCounter,
  ): Promise<UseCounter> {
    return executeGatedCall({
      handle: this.handle(),
      authoriser: this.authoriser,
      circuit: call.circuit,
      args: call.args,
      address: this.account,
      ledgerState: this.ledger(),
      knownUseCounter,
    });
  }

  private async run(
    circuit: string,
    ...args: unknown[]
  ): Promise<CircuitResults<PrivateState, unknown>> {
    const impure = this.circuits[circuit];
    if (!impure)
      throw new Error(`Simulated contract has no circuit ${circuit}`);
    const context = createCircuitContext<PrivateState>({
      circuitId: circuit,
      contractAddress: this.addressHex,
      coinPublicKeyOrZswapState: this.coinPublicKey,
      contractState: this.state,
      privateState: {},
      time: SIM_BLOCK_TIME,
    });
    const results = await impure(context, ...args);
    this.state = results.context.callContext.currentQueryContext.state;
    return results;
  }
}
