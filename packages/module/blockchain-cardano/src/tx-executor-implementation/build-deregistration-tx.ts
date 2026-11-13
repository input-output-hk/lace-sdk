import {
  LOVELACE_TOKEN_ID,
  type AccountRewardAccountDetailsMap,
} from '@lace-contract/cardano-context';
import { Cardano } from '@lace-lib/cardano-core';
import { TransactionBuilder } from '@lace-lib/cardano-tx-builder';
import { BigNumber } from '@lace-lib/util';
import { defer, firstValueFrom, of } from 'rxjs';
import { catchError } from 'rxjs/operators';

import { refuseExtensionAccount } from '../store/account-guards';

import { isRewardWithdrawalPending } from './reward-withdrawal';

import type { AnyAddress } from '@lace-contract/addresses';
import type {
  BuildDeregistrationTx,
  BuildDeregistrationTxResult,
} from '@lace-contract/cardano-context';
import type { SideEffectDependencies } from '@lace-contract/module';
import type { FeeEntry } from '@lace-contract/tx-executor';
import type { AccountId } from '@lace-contract/wallet-repo';

const TWO_HOURS_IN_SECONDS = 7200;

const getStakeCredentialFromAddress = (
  address: string,
): Cardano.Credential | undefined => {
  const cardanoAddress = Cardano.Address.fromString(address);
  if (!cardanoAddress) return undefined;

  const baseAddress = cardanoAddress.asBase();
  if (!baseAddress) return undefined;

  return baseAddress.getStakeCredential();
};

/**
 * Gets the stake key deposit for the given account if it is registered.
 * Returns the deposit amount if registered, undefined if not registered or details not available.
 */
const getStakeKeyDeposit = (
  accountId: AccountId,
  rewardAccountDetails: AccountRewardAccountDetailsMap,
  protocolParameters: Cardano.ProtocolParameters,
): bigint | undefined => {
  const details = rewardAccountDetails[accountId];
  if (!details) return undefined;
  if (!details.rewardAccountInfo?.isRegistered) return undefined;
  return BigInt(protocolParameters.stakeKeyDeposit);
};

/**
 * Constructs a reward account address from a stake credential.
 */
const getRewardAccount = (
  stakeCredential: Cardano.Credential,
  networkMagic: Cardano.NetworkMagics,
): Cardano.RewardAccount => {
  const networkId =
    networkMagic === Cardano.NetworkMagics.Mainnet
      ? Cardano.NetworkId.Mainnet
      : Cardano.NetworkId.Testnet;
  return Cardano.RewardAccount.fromCredential(stakeCredential, networkId);
};

/**
 * Gets the withdrawable amount for the given account.
 */
const getWithdrawableAmount = (
  accountId: AccountId,
  rewardAccountDetails: AccountRewardAccountDetailsMap,
): bigint => {
  const details = rewardAccountDetails[accountId];
  if (!details?.rewardAccountInfo?.withdrawableAmount) return 0n;
  return BigInt(details.rewardAccountInfo.withdrawableAmount.toString());
};

export const makeBuildDeregistrationTx =
  (dependencies: SideEffectDependencies): BuildDeregistrationTx =>
  params =>
    defer(async (): Promise<BuildDeregistrationTxResult> => {
      const { accountId } = params;

      const [
        networkMagic,
        protocolParameters,
        accountUtxos,
        cardanoAddresses,
        rewardAccountDetails,
        pendingRewardWithdrawals,
      ] = await Promise.all([
        firstValueFrom(dependencies.txExecutorCardano.cardanoNetworkMagic$),
        firstValueFrom(
          dependencies.txExecutorCardano.cardanoProtocolParameters$,
        ),
        firstValueFrom(
          dependencies.txExecutorCardano.cardanoSettledAvailableAccountUtxos$,
        ),
        firstValueFrom(dependencies.txExecutorCardano.cardanoAddresses$),
        firstValueFrom(
          dependencies.txExecutorCardano.cardanoRewardAccountDetails$,
        ),
        firstValueFrom(
          dependencies.txExecutorCardano.cardanoPendingRewardWithdrawals$,
        ),
      ]);

      if (!networkMagic) {
        return {
          success: false,
          error: new Error('Network magic not available'),
        };
      }

      if (!protocolParameters) {
        return {
          success: false,
          error: new Error('Protocol parameters not available'),
        };
      }

      refuseExtensionAccount(accountId, cardanoAddresses);

      const availableUtxo = accountUtxos[accountId] ?? [];

      const accountAddresses: AnyAddress[] = cardanoAddresses.filter(
        (addr): addr is AnyAddress =>
          addr.accountId === accountId && addr.blockchainName === 'Cardano',
      );

      if (!accountAddresses[0]) {
        return {
          success: false,
          error: new Error('No Cardano addresses found for account'),
        };
      }

      const changeAddress = Cardano.PaymentAddress(
        accountAddresses[0].address as string,
      );

      const stakeCredential = getStakeCredentialFromAddress(
        accountAddresses[0].address,
      );

      if (!stakeCredential) {
        return {
          success: false,
          error: new Error('Could not extract stake credential from address'),
        };
      }

      // Check if stake key is registered (can only de-register if registered)
      const deposit = getStakeKeyDeposit(
        accountId,
        rewardAccountDetails,
        protocolParameters as Cardano.ProtocolParameters,
      );

      if (deposit === undefined) {
        return {
          success: false,
          error: new Error(
            'Stake key is not registered or reward account details not available',
          ),
        };
      }

      const builder = new TransactionBuilder(
        networkMagic,
        protocolParameters as Cardano.ProtocolParameters,
      )
        .setChangeAddress(changeAddress)
        .expiresIn(TWO_HOURS_IN_SECONDS)
        .setUnspentOutputs(availableUtxo);

      // The ledger refuses to deregister a stake key whose reward balance is
      // not zero, and takes only a withdrawal of the whole balance, so a
      // non-zero balance is withdrawn in the same transaction. An in-flight
      // transaction that withdraws the rewards leaves the balance at zero:
      // this transaction then withdraws nothing and depends on that one like
      // any chained transaction. If that one never lands, the node refuses
      // this one too, and the rewards stay in the reward account.
      const rewardAccount = getRewardAccount(stakeCredential, networkMagic);
      const withdrawalAmount = isRewardWithdrawalPending({
        pendingRewardWithdrawals,
        networkMagic,
        rewardAccount,
      })
        ? 0n
        : getWithdrawableAmount(accountId, rewardAccountDetails);

      if (withdrawalAmount > 0n) {
        builder.addRewardsWithdrawal(rewardAccount, withdrawalAmount);
      }

      // Add the Conway-era unregistration certificate with deposit
      builder.addStakeDeregistrationCertificate(stakeCredential, deposit);

      const tx = await builder.build();

      const core = tx.toCore();
      const feeBigint = core.body.fee;

      const fees: FeeEntry[] = [
        { amount: BigNumber(feeBigint), tokenId: LOVELACE_TOKEN_ID },
      ];

      const serializedTx = tx.toCbor();

      // depositReturn is positive (user gets this back)
      const depositReturn = String(deposit);

      return {
        success: true,
        serializedTx,
        fees,
        depositReturn,
        withdrawalAmount: String(withdrawalAmount),
      };
    }).pipe(
      catchError((error: Error) =>
        of({
          success: false as const,
          error,
        }),
      ),
    );
