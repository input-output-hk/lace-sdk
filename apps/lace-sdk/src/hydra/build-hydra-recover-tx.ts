import { Cardano, Serialization } from '@lace-lib/cardano-core';
import {
  TransactionBuilder,
  minAdaRequired,
  resolveSlotNo,
} from '@lace-lib/cardano-tx-builder';
import { toHydraDepositRecovery } from '@lace-lib/hydra-head';
import { Err, Ok } from '@lace-lib/util';
import { firstValueFrom } from 'rxjs';

import { cardanoProviderOf } from '../cardano-provider-registry';
import { createProviderPlutusContext } from '../create-plutus-context';

import type { CardanoContextObservables } from '../create-tx-builder';
import type { addressesSelectors } from '@lace-contract/addresses';
import type { RequiredProtocolParameters } from '@lace-contract/cardano-context';
import type {
  createModuleLoader,
  StateObservables,
} from '@lace-contract/module';
import type { AccountId } from '@lace-contract/wallet-repo';
import type { PlutusContext } from '@lace-lib/cardano-tx-builder';
import type { HydraDepositRecovery, HydraOutRef } from '@lace-lib/hydra-head';
import type { Result } from '@lace-lib/util';

/** How long a recover transaction stays valid after it is built. */
const VALIDITY_MILLISECONDS = 2 * 60 * 60 * 1000;

/** Bytes the ledger adds to an output's size when it prices its minimum ada. */
const OUTPUT_OVERHEAD_BYTES = 160n;

/** How a committed output is written in the recover: the builder's map or the legacy array. */
export type OutputForm = 'legacy' | 'map';

/**
 * Picks the form each committed output ships in so that it holds the ledger's
 * minimum ada for its size. The builder writes every output as a map, which
 * needs a little more ada than the legacy array an output without an inline
 * datum or reference script can take, so an output funded at its legacy
 * minimum keeps the legacy form. Its value is never topped up, since the
 * deposit validator checks it.
 *
 * @throws When an output holds less ada than either form needs.
 */
const outputFormsOf = (
  outputs: readonly Cardano.TxOut[],
  coinsPerUtxoByte: bigint,
): OutputForm[] =>
  outputs.map((output, index) => {
    if (output.value.coins >= minAdaRequired(output, coinsPerUtxoByte)) {
      return 'map';
    }
    const legacy = Serialization.TransactionOutput.fromCore(output);
    const legacySize = BigInt(legacy.toCbor().length / 2);
    if (
      !legacy.isBabbageOutput() &&
      output.value.coins >=
        (OUTPUT_OVERHEAD_BYTES + legacySize) * coinsPerUtxoByte
    ) {
      return 'legacy';
    }
    throw new Error(
      `Committed output ${index} holds less ada than the ledger now requires of it, so a recover cannot pay it back`,
    );
  });

/**
 * Writes the outputs that need it in the legacy array form, which only
 * shrinks the transaction, so its fee and collateral still cover it.
 *
 * @throws When the rewritten transaction would be larger.
 */
const withOutputForms = (
  tx: Serialization.Transaction,
  outputs: readonly Cardano.TxOut[],
  forms: readonly OutputForm[],
): Serialization.Transaction => {
  if (!forms.includes('legacy')) return tx;
  const rewritten = Serialization.Transaction.fromCbor(tx.toCbor());
  const body = rewritten.body();
  const shipped = body.outputs();
  forms.forEach((form, index) => {
    if (form === 'legacy') {
      shipped[index] = Serialization.TransactionOutput.fromCore(outputs[index]);
    }
  });
  body.setOutputs(shipped);
  rewritten.setBody(body);
  if (rewritten.toCbor().length > tx.toCbor().length) {
    throw new Error(
      'Writing the committed outputs as committed grew the recover',
    );
  }
  return rewritten;
};

/**
 * Structural requirement: a wallet created by `createLaceWallet` with the
 * Cardano modules loaded, whose accounts and UTxOs have synced.
 */
export type WalletWithHydraRecovery = {
  stateObservables: {
    cardanoContext: Pick<
      CardanoContextObservables,
      | 'selectAvailableAccountUtxos$'
      | 'selectChainId$'
      | 'selectProtocolParameters$'
      | 'selectSettledAccountUnspendableUtxos$'
    >;
    addresses: Pick<
      StateObservables<typeof addressesSelectors>['addresses'],
      'selectAllAddresses$'
    >;
  };
  /** @internal Not for direct SDK consumer use. */
  _loadModules: ReturnType<typeof createModuleLoader>;
};

/** The options of `buildHydraRecoverTx`: the deposit and whose it is. */
export interface BuildHydraRecoverTxProps {
  /**
   * The Cardano account the deposit commits funds to. Its UTxOs pay the fee
   * and post the collateral, and its first address takes the change.
   */
  accountId: AccountId;
  /**
   * The output reference of the deposit UTxO, as the `outpoint` of a deposit
   * in `wallet.stateObservables.hydraHeadsIndex` gives it.
   */
  deposit: HydraOutRef;
  /**
   * The instant the transaction is built at, in epoch milliseconds, after the
   * deposit's deadline. Defaults to the current time.
   */
  now?: number;
}

/** What the recover transaction is assembled from, once read from the wallet. */
export interface HydraRecoverTxInputs {
  networkMagic: Cardano.NetworkMagics;
  protocolParameters: RequiredProtocolParameters;
  plutusContext: PlutusContext;
  recovery: HydraDepositRecovery;
  changeAddress: Cardano.PaymentAddress;
  /** UTxOs that may pay the fee. */
  utxos: Cardano.Utxo[];
  /** UTxOs the collateral may be drawn from. */
  collateralUtxos: Cardano.Utxo[];
  /** The instant the transaction is built at, in epoch milliseconds. */
  now: number;
}

/**
 * Assembles and balances the recover transaction of a deposit: it spends the
 * deposit with the `Recover` redeemer, runs the deposit validator attached to
 * its witness set, pays the committed outputs back before any change, and is
 * valid from the first slot that starts after the deadline for two hours.
 * Each committed output ships in a form whose size its ada covers.
 *
 * @throws When that first slot has not started at `now`, when a committed
 * output holds less ada than the ledger requires of it in any form, when the build
 * fails, as when the UTxOs cannot pay the fee or the evaluator refuses the
 * transaction, or when the built transaction does not pay the committed
 * outputs back unchanged.
 */
export const assembleHydraRecoverTx = async ({
  networkMagic,
  protocolParameters,
  plutusContext,
  recovery,
  changeAddress,
  utxos,
  collateralUtxos,
  now,
}: HydraRecoverTxInputs): Promise<Serialization.Transaction> => {
  const invalidBefore = Cardano.Slot(
    resolveSlotNo(networkMagic, recovery.deadline) + 1,
  );
  if (resolveSlotNo(networkMagic, now) < invalidBefore) {
    throw new Error(
      `The deposit can be recovered from slot ${invalidBefore}, the first after its deadline`,
    );
  }
  const forms = outputFormsOf(
    recovery.outputs,
    BigInt(protocolParameters.coinsPerUtxoByte),
  );
  const builder = new TransactionBuilder(networkMagic, protocolParameters)
    .setChangeAddress(changeAddress)
    .setUnspentOutputs(utxos)
    .setCollateralUtxos(collateralUtxos)
    .setCollateralChangeAddress(changeAddress)
    .setPlutusContext(plutusContext)
    .addInput(recovery.deposit, { redeemer: recovery.redeemer })
    .attachScript(recovery.script)
    .setValidityInterval({
      invalidBefore,
      invalidHereafter: resolveSlotNo(
        networkMagic,
        now + VALIDITY_MILLISECONDS,
      ),
    });
  for (const output of recovery.outputs) builder.addOutput(output);
  return shipAsCommitted(await builder.build(), recovery, forms);
};

/**
 * Checks the balanced recover pays the committed outputs back, then writes
 * each in its form. The check runs on the balanced transaction: without
 * change the builder refunds a fee saving to a committed output at the change
 * address, and writing that output as committed would hide the refund while
 * keeping the lowered fee, leaving the transaction unbalanced.
 *
 * @throws When the balanced transaction changed a committed output, or the
 * rewritten one would be larger.
 */
export const shipAsCommitted = (
  tx: Serialization.Transaction,
  recovery: Pick<HydraDepositRecovery, 'outputs'>,
  forms: readonly OutputForm[],
): Serialization.Transaction => {
  assertPaysBackAsCommitted(tx, recovery);
  return withOutputForms(tx, recovery.outputs, forms);
};

/** An output in one encoding, so outputs compare whatever form they came in. */
const encodedOutput = (output: Cardano.TxOut): string =>
  Serialization.TransactionOutput.fromCore(output).toCbor();

/**
 * Checks that a recover pays the committed outputs back first and unchanged.
 * The builder refunds a fee saving to the change it adds; without such change
 * it refunds to an output at the change address, which may be a committed one,
 * and the validator would then refuse the transaction.
 *
 * @throws When an output before the change differs from the committed one.
 */
export const assertPaysBackAsCommitted = (
  tx: Serialization.Transaction,
  { outputs }: Pick<HydraDepositRecovery, 'outputs'>,
): void => {
  const shipped = tx.body().outputs();
  const isUnchanged = outputs.every(
    (output, index) =>
      shipped[index] !== undefined &&
      encodedOutput(shipped[index].toCore()) === encodedOutput(output),
  );
  if (!isUnchanged) {
    throw new Error(
      'The recover would not pay the committed outputs back as committed: fund the account with another UTxO and try again',
    );
  }
};

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** The hex payment key hashes of addresses whose payment part is a key. */
const paymentKeyHashesOf = (addresses: readonly string[]): string[] =>
  addresses.flatMap(address => {
    const payment = Cardano.Address.fromString(address)?.getProps().paymentPart;
    return payment?.type === Cardano.CredentialType.KeyHash
      ? [payment.hash]
      : [];
  });

/**
 * Builds the transaction that recovers a Hydra deposit of the account once
 * its deadline has passed without the head absorbing it, as the draft CIP
 * "Hydra Head UTxO Recognition" has a wallet offer. It works for the deposit
 * validator of every Hydra release the registry knows.
 *
 * The transaction spends the deposit with the deposit validator's `Recover`
 * redeemer, pays the outputs the deposit datum commits back exactly as it
 * names them, before the change, and is valid from the first slot after the
 * deadline. The account's UTxOs pay the fee and post the collateral, its
 * reserved collateral first when some of it is settled and no known
 * transaction spends it, and the wallet's Cardano provider reads the deposit
 * and evaluates the script. A transaction that
 * spends a deposit address without a head is recognised as a recover, so its
 * activity shows as one. Sign it with `signCardanoTx` and submit it with
 * `submitCardanoTx`, like any other transaction.
 *
 * @param wallet - A wallet with the Cardano modules loaded (see
 *   {@link WalletWithHydraRecovery}).
 * @param props - The account and the deposit (see
 *   {@link BuildHydraRecoverTxProps}).
 * @returns `Ok` with the unsigned transaction, or `Err` when the wallet has no
 *   provider, network or address for the account yet, the deposit cannot be
 *   read, it is not a deposit committing funds to the account's keys, its
 *   deadline has not passed, it commits an output a recover cannot restore
 *   exactly, or the build fails. It never rejects.
 */
export const buildHydraRecoverTx = async (
  wallet: WalletWithHydraRecovery,
  { accountId, deposit, now = Date.now() }: BuildHydraRecoverTxProps,
): Promise<Result<Serialization.Transaction, Error>> => {
  const cardanoProvider = cardanoProviderOf(wallet);
  if (!cardanoProvider) {
    return Err(
      new Error(
        'Cardano provider not available: create the wallet with createLaceWallet and the Cardano modules loaded',
      ),
    );
  }

  try {
    const { cardanoContext, addresses } = wallet.stateObservables;
    const [chainId, protocolParameters, allAddresses] = await Promise.all([
      firstValueFrom(cardanoContext.selectChainId$),
      firstValueFrom(cardanoContext.selectProtocolParameters$),
      firstValueFrom(addresses.selectAllAddresses$),
    ]);
    if (!chainId || !protocolParameters) {
      return Err(
        new Error(
          'Cardano network not initialized: await waitForNetworkInfo before building the recover transaction',
        ),
      );
    }
    const accountAddresses = allAddresses
      .filter(
        address =>
          address.accountId === accountId &&
          address.blockchainName === 'Cardano',
      )
      .map(({ address }) => address as string);
    if (accountAddresses.length === 0) {
      return Err(
        new Error(`No Cardano address found for account ${accountId}`),
      );
    }

    const txIn = {
      txId: Cardano.TransactionId(deposit.txId),
      index: deposit.index,
    };
    const resolved = await firstValueFrom(
      cardanoProvider.resolveInput(txIn, { chainId }),
    );
    if (resolved.isErr()) {
      return Err(
        new Error(`Deposit not readable: ${resolved.error.message}`, {
          cause: resolved.error,
        }),
      );
    }
    if (!resolved.value) {
      return Err(
        new Error(`Deposit ${deposit.txId}#${deposit.index} not found`),
      );
    }
    const recovery = toHydraDepositRecovery(
      [{ ...txIn, address: resolved.value.address }, resolved.value],
      paymentKeyHashesOf(accountAddresses),
      now,
    );

    const plutusContext = await createProviderPlutusContext(
      cardanoProvider,
      chainId,
    );
    if (plutusContext.isErr()) return Err(plutusContext.error);
    const [available, reserved] = await Promise.all([
      firstValueFrom(cardanoContext.selectAvailableAccountUtxos$),
      firstValueFrom(cardanoContext.selectSettledAccountUnspendableUtxos$),
    ]);
    const utxos = available[accountId] ?? [];
    const reservedCollateral = reserved[accountId] ?? [];

    return Ok(
      await assembleHydraRecoverTx({
        networkMagic: chainId.networkMagic as Cardano.NetworkMagics,
        protocolParameters,
        plutusContext: plutusContext.value,
        recovery,
        changeAddress: Cardano.PaymentAddress(accountAddresses[0]),
        utxos,
        collateralUtxos:
          reservedCollateral.length > 0 ? reservedCollateral : utxos,
        now,
      }),
    );
  } catch (error) {
    return Err(
      new Error(`Recover transaction not built: ${messageOf(error)}`, {
        cause: error,
      }),
    );
  }
};
