import * as Crypto from '@lace-lib/cardano-crypto';
import { HexBlob } from '@lace-lib/cardano-util';

import { Address, CredentialType, RewardAddress } from '../../Cardano/Address';
import { Slot } from '../../Cardano/types/Block';
import { SerializationError, SerializationFailure } from '../../errors';
import { hexToBytes } from '../../util/misc';
import { CborReader, CborReaderState, CborWriter } from '../CBOR';
import { Certificate } from '../Certificates';
import { CborSet } from '../Common';

import { Guards } from './Guards';
import { ProposalProcedure } from './ProposalProcedure';
import { TransactionInput } from './TransactionInput';
import { TransactionOutput } from './TransactionOutput';
import {
  accountBalanceIntervalsFromCore,
  accountBalanceIntervalsToCore,
  multiAssetsToTokenMap,
  readAccountBalanceIntervals,
  readRequiredTopLevelGuards,
  requiredTopLevelGuardsFromCore,
  requiredTopLevelGuardsToCore,
  sortCanonically,
  tokenMapToMultiAsset,
  writeAccountBalanceIntervals,
  writeRequiredTopLevelGuards,
} from './Utils';
import { VotingProcedures } from './VotingProcedures';

import type { AccountBalanceInterval } from './AccountBalanceInterval';
import type * as Cardano from '../../Cardano';
import type { Credential, DeserializationOptions } from '../Common';
import type { PlutusData } from '../PlutusData';

type TransactionInputSet = CborSet<
  ReturnType<TransactionInput['toCore']>,
  TransactionInput
>;

const TOP_LEVEL_ONLY_KEYS = new Set([2n, 13n, 16n, 17n, 23n, 27n]);

/**
 * The body of a Dijkstra sub transaction (CIP-0118 nested transactions).
 *
 * A sub transaction body reuses the top level transaction body keys but excludes fee (2),
 * collateral inputs (13), collateral return (16), total collateral (17), sub transactions (23)
 * and starting account balance intervals (27) - the enclosing transaction pays the fee, posts
 * collateral and asserts starting balances for the whole batch. Key 24
 * required_top_level_guards names guards the enclosing transaction must carry, each with an
 * optional plutus datum.
 *
 * Unlike the permissive top level decoder, decoding mirrors the ledger decoderByKey exactly:
 * keys 0 and 1 are required and any key outside the CDDL sub_transaction_body key set is
 * rejected rather than skipped.
 */
export class SubTransactionBody {
  // Required fields
  #inputs: TransactionInputSet;
  #outputs: Array<TransactionOutput>;

  // Optional fields
  #ttl: Cardano.Slot | undefined;
  #certs: CborSet<ReturnType<Certificate['toCore']>, Certificate> | undefined;
  #withdrawals: Map<Cardano.RewardAccount, Cardano.Lovelace> | undefined;
  #auxiliaryDataHash: Crypto.Hash32ByteBase16 | undefined;
  #validityStartInterval: Cardano.Slot | undefined;
  #mint: Cardano.TokenMap | undefined;
  #scriptDataHash: Crypto.Hash32ByteBase16 | undefined;
  #guards: Guards | undefined;
  #networkId: Cardano.NetworkId | undefined;
  #referenceInputs: TransactionInputSet | undefined;
  #votingProcedures: VotingProcedures | undefined;
  #proposalProcedures:
    | CborSet<ReturnType<ProposalProcedure['toCore']>, ProposalProcedure>
    | undefined;
  #currentTreasuryValue: Cardano.Lovelace | undefined;
  #donation: Cardano.Lovelace | undefined;
  #requiredTopLevelGuards: Map<Credential, PlutusData | null> | undefined;
  #directDeposits: Map<Cardano.RewardAccount, Cardano.Lovelace> | undefined;
  #accountBalanceIntervals:
    | Map<Cardano.RewardAccount, AccountBalanceInterval>
    | undefined;
  #originalBytes: HexBlob | undefined = undefined;

  /**
   * Initializes a new instance of the SubTransactionBody class.
   *
   * @param inputs A list of references to UTxOs (Unspent Transaction Outputs) that the sub transaction intends to spend.
   * @param outputs A list of outputs where ownership of the value will be assigned by address.
   */
  constructor(inputs: TransactionInputSet, outputs: Array<TransactionOutput>) {
    this.#inputs = inputs;
    this.#outputs = outputs;
  }

  /**
   * Serializes a SubTransactionBody into CBOR format.
   *
   * @returns The SubTransactionBody in CBOR format.
   */
  toCbor(): HexBlob {
    const writer = new CborWriter();

    if (this.#originalBytes) return this.#originalBytes;

    // CDDL
    // sub_transaction_body =
    //   {   0  : set<transaction_input>
    //   ,   1  : [* transaction_output]
    //   , ? 3  : slot
    //   , ? 4  : certificates
    //   , ? 5  : withdrawals
    //   , ? 7  : auxiliary_data_hash
    //   , ? 8  : slot
    //   , ? 9  : mint
    //   , ? 11 : script_data_hash
    //   , ? 14 : guards
    //   , ? 15 : network_id
    //   , ? 18 : nonempty_set<transaction_input>
    //   , ? 19 : voting_procedures
    //   , ? 20 : proposal_procedures
    //   , ? 21 : coin
    //   , ? 22 : positive_coin
    //   , ? 24 : required_top_level_guards
    //   , ? 25 : direct_deposits
    //   , ? 26 : account_balance_intervals
    //   }
    writer.writeStartMap(this.#getMapSize());

    writer.writeInt(0n);
    writer.writeEncodedValue(hexToBytes(this.#inputs.toCbor()));

    writer.writeInt(1n);
    writer.writeStartArray(this.#outputs.length);

    for (const output of this.#outputs) {
      writer.writeEncodedValue(Buffer.from(output.toCbor(), 'hex'));
    }

    if (this.#ttl !== undefined) {
      writer.writeInt(3n);
      writer.writeInt(this.#ttl);
    }

    if (this.#certs !== undefined && this.#certs.size() > 0) {
      writer.writeInt(4n);
      writer.writeEncodedValue(hexToBytes(this.#certs.toCbor()));
    }

    if (this.#withdrawals !== undefined && this.#withdrawals.size > 0) {
      writer.writeInt(5n);
      // Create a new map with address bytes to avoid logic duplication and address checks
      const withdrawalsWithAddressBytes = new Map();
      for (const [key, value] of this.#withdrawals) {
        const rewardAddress = RewardAddress.fromAddress(
          Address.fromBech32(key),
        );
        if (!rewardAddress) {
          throw new SerializationError(
            SerializationFailure.InvalidAddress,
            `Invalid withdrawal address: ${key}`,
          );
        }
        const rewardAddressBytes = rewardAddress.toAddress().toBytes();
        withdrawalsWithAddressBytes.set(rewardAddressBytes, value);
      }

      // Sort withdrawals by address bytes, canonically
      const sortedCanonically = [...withdrawalsWithAddressBytes].sort((a, b) =>
        a > b ? 1 : -1,
      );

      writer.writeStartMap(sortedCanonically.length);

      for (const [key, value] of sortedCanonically) {
        writer.writeByteString(Buffer.from(key, 'hex'));
        writer.writeInt(value);
      }
    }

    if (this.#auxiliaryDataHash !== undefined) {
      writer.writeInt(7n);
      writer.writeByteString(Buffer.from(this.#auxiliaryDataHash, 'hex'));
    }

    if (this.#validityStartInterval !== undefined) {
      writer.writeInt(8n);
      writer.writeInt(this.#validityStartInterval);
    }

    if (this.#mint !== undefined && this.#mint.size > 0) {
      writer.writeInt(9n);

      const multiassets = tokenMapToMultiAsset(this.#mint);

      writer.writeStartMap(multiassets.size);
      const sortedMultiAssets = new Map(
        [...multiassets.entries()].sort(sortCanonically),
      );

      for (const [scriptHash, assets] of sortedMultiAssets.entries()) {
        writer.writeByteString(Buffer.from(scriptHash, 'hex'));

        const sortedAssets = new Map(
          [...assets.entries()].sort(sortCanonically),
        );

        writer.writeStartMap(sortedAssets.size);
        for (const [assetName, quantity] of sortedAssets.entries()) {
          writer.writeByteString(Buffer.from(assetName, 'hex'));
          writer.writeInt(quantity);
        }
      }
    }

    if (this.#scriptDataHash !== undefined) {
      writer.writeInt(11n);
      writer.writeByteString(Buffer.from(this.#scriptDataHash, 'hex'));
    }

    if (this.#guards !== undefined && this.#guards.size() > 0) {
      writer.writeInt(14n);
      writer.writeEncodedValue(hexToBytes(this.#guards.toCbor()));
    }

    if (this.#networkId !== undefined) {
      writer.writeInt(15n);
      writer.writeInt(this.#networkId);
    }

    if (
      this.#referenceInputs !== undefined &&
      this.#referenceInputs.size() > 0
    ) {
      writer.writeInt(18n);
      writer.writeEncodedValue(hexToBytes(this.#referenceInputs.toCbor()));
    }

    if (this.#votingProcedures !== undefined) {
      writer.writeInt(19n);
      writer.writeEncodedValue(
        Buffer.from(this.#votingProcedures.toCbor(), 'hex'),
      );
    }

    if (
      this.#proposalProcedures !== undefined &&
      this.#proposalProcedures.size() > 0
    ) {
      writer.writeInt(20n);
      writer.writeEncodedValue(hexToBytes(this.#proposalProcedures.toCbor()));
    }

    if (this.#currentTreasuryValue !== undefined) {
      writer.writeInt(21n);
      writer.writeInt(this.#currentTreasuryValue);
    }

    if (this.#donation !== undefined && this.#donation > 0n) {
      writer.writeInt(22n);
      writer.writeInt(this.#donation);
    }

    if (
      this.#requiredTopLevelGuards !== undefined &&
      this.#requiredTopLevelGuards.size > 0
    ) {
      writer.writeInt(24n);
      writeRequiredTopLevelGuards(writer, this.#requiredTopLevelGuards);
    }

    if (this.#directDeposits !== undefined && this.#directDeposits.size > 0) {
      writer.writeInt(25n);

      const depositsWithAddressBytes = new Map();
      for (const [key, value] of this.#directDeposits) {
        const rewardAddress = RewardAddress.fromAddress(
          Address.fromBech32(key),
        );
        if (!rewardAddress) {
          throw new SerializationError(
            SerializationFailure.InvalidAddress,
            `Invalid direct deposit address: ${key}`,
          );
        }
        depositsWithAddressBytes.set(
          rewardAddress.toAddress().toBytes(),
          value,
        );
      }

      const sortedCanonically = [...depositsWithAddressBytes].sort((a, b) =>
        a > b ? 1 : -1,
      );

      writer.writeStartMap(sortedCanonically.length);

      for (const [key, value] of sortedCanonically) {
        writer.writeByteString(Buffer.from(key, 'hex'));
        writer.writeInt(value);
      }
    }

    if (
      this.#accountBalanceIntervals !== undefined &&
      this.#accountBalanceIntervals.size > 0
    ) {
      writer.writeInt(26n);
      writeAccountBalanceIntervals(writer, this.#accountBalanceIntervals);
    }

    return writer.encodeAsHex();
  }

  /**
   * Deserializes the SubTransactionBody from a CBOR byte array.
   *
   * Key admission is strict regardless of options, mirroring the ledger decoderByKey: keys 0
   * and 1 are required, the top-level-only keys 2, 13, 16, 17 and 23 are rejected, and any
   * other key outside the CDDL sub_transaction_body key set is rejected rather than skipped.
   * A key may appear only once, the certificates, withdrawals, mint, reference inputs, voting
   * procedures and proposal procedures must not be empty when present, the donation must be
   * greater than zero, and the guards must not repeat a key hash or credential.
   *
   * @param cbor The CBOR encoded SubTransactionBody object.
   * @param options Deserialization options forwarded to nested output and proposal decoding.
   * @returns The new SubTransactionBody instance.
   */
  static fromCbor(
    cbor: HexBlob,
    options?: DeserializationOptions,
  ): SubTransactionBody {
    const reader = new CborReader(cbor);

    const inputs = CborSet.fromCore([], TransactionInput.fromCore);
    const outputs: Array<TransactionOutput> = new Array<TransactionOutput>();
    const body = new SubTransactionBody(inputs, outputs);

    let hasInputs = false;
    let hasOutputs = false;
    const seenKeys = new Set<bigint>();

    reader.readStartMap();

    while (reader.peekState() !== CborReaderState.EndMap) {
      const key = reader.readInt();

      if (seenKeys.has(key))
        throw new SerializationError(
          SerializationFailure.InvalidType,
          `Duplicate sub transaction body map key: ${key}`,
        );

      seenKeys.add(key);

      switch (key) {
        case 0n: {
          const inputsBytes = reader.readEncodedValue();
          body.setInputs(
            CborSet.fromCbor(
              HexBlob.fromBytes(inputsBytes),
              TransactionInput.fromCbor,
            ),
          );
          hasInputs = true;
          break;
        }
        case 1n: {
          reader.readStartArray();

          while (reader.peekState() !== CborReaderState.EndArray) {
            body
              .outputs()
              .push(
                TransactionOutput.fromCbor(
                  HexBlob.fromBytes(reader.readEncodedValue()),
                  options,
                ),
              );
          }

          reader.readEndArray();
          hasOutputs = true;

          break;
        }
        case 3n:
          body.setTtl(Slot(Number(reader.readInt())));
          break;
        case 4n: {
          const certs = CborSet.fromCbor<
            ReturnType<Certificate['toCore']>,
            Certificate
          >(HexBlob.fromBytes(reader.readEncodedValue()), Certificate.fromCbor);

          if (certs.size() === 0)
            throw new SerializationError(
              SerializationFailure.InvalidType,
              'certificates (sub transaction body key 4) must be a non-empty set',
            );

          body.setCerts(certs);
          break;
        }
        case 5n: {
          reader.readStartMap();

          body.setWithdrawals(
            new Map<Cardano.RewardAccount, Cardano.Lovelace>(),
          );

          while (reader.peekState() !== CborReaderState.EndMap) {
            const account = Address.fromBytes(
              HexBlob.fromBytes(reader.readByteString()),
            ).toBech32() as Cardano.RewardAccount;

            const amount = reader.readInt();
            body.withdrawals()!.set(account, amount);
          }

          reader.readEndMap();

          if (body.withdrawals()!.size === 0)
            throw new SerializationError(
              SerializationFailure.InvalidType,
              'withdrawals (sub transaction body key 5) must be a non-empty map',
            );

          break;
        }
        case 7n:
          body.setAuxiliaryDataHash(
            HexBlob.fromBytes(
              reader.readByteString(),
            ) as unknown as Crypto.Hash32ByteBase16,
          );
          break;
        case 8n:
          body.setValidityStartInterval(Slot(Number(reader.readInt())));
          break;
        case 9n: {
          const multiassets = new Map<
            Crypto.Hash28ByteBase16,
            Map<Cardano.AssetName, bigint>
          >();

          reader.readStartMap();
          while (reader.peekState() !== CborReaderState.EndMap) {
            const scriptHash = HexBlob.fromBytes(
              reader.readByteString(),
            ) as unknown as Crypto.Hash28ByteBase16;

            if (!multiassets.has(scriptHash))
              multiassets.set(scriptHash, new Map<Cardano.AssetName, bigint>());

            reader.readStartMap();
            while (reader.peekState() !== CborReaderState.EndMap) {
              const assetName = Buffer.from(reader.readByteString()).toString(
                'hex',
              ) as unknown as Cardano.AssetName;
              const quantity = reader.readInt();

              multiassets.get(scriptHash)!.set(assetName, quantity);
            }
            reader.readEndMap();
          }
          reader.readEndMap();

          if (multiassets.size === 0)
            throw new SerializationError(
              SerializationFailure.InvalidType,
              'mint (sub transaction body key 9) must be a non-empty map',
            );

          body.setMint(multiAssetsToTokenMap(multiassets));
          break;
        }
        case 11n:
          body.setScriptDataHash(
            HexBlob.fromBytes(
              reader.readByteString(),
            ) as unknown as Crypto.Hash32ByteBase16,
          );
          break;
        case 14n: {
          const guards = Guards.fromCbor(
            HexBlob.fromBytes(reader.readEncodedValue()),
          );
          const keyHashes = guards.keyHashes() ?? [];

          if (new Set(keyHashes).size !== keyHashes.length)
            throw new SerializationError(
              SerializationFailure.InvalidType,
              'guards (sub transaction body key 14) must not contain duplicate key hashes',
            );

          body.setGuards(guards);
          break;
        }
        case 15n:
          body.setNetworkId(Number(reader.readInt()) as Cardano.NetworkId);
          break;
        case 18n: {
          const referenceInputs = CborSet.fromCbor<
            ReturnType<TransactionInput['toCore']>,
            TransactionInput
          >(
            HexBlob.fromBytes(reader.readEncodedValue()),
            TransactionInput.fromCbor,
          );

          if (referenceInputs.size() === 0)
            throw new SerializationError(
              SerializationFailure.InvalidType,
              'reference_inputs (sub transaction body key 18) must be a non-empty set',
            );

          body.setReferenceInputs(referenceInputs);
          break;
        }
        case 19n: {
          const votingProcedures = VotingProcedures.fromCbor(
            HexBlob.fromBytes(reader.readEncodedValue()),
          );

          if (votingProcedures.getVoters().length === 0)
            throw new SerializationError(
              SerializationFailure.InvalidType,
              'voting_procedures (sub transaction body key 19) must be a non-empty map',
            );

          body.setVotingProcedures(votingProcedures);
          break;
        }
        case 20n: {
          const proposalProcedures = CborSet.fromCbor<
            ReturnType<ProposalProcedure['toCore']>,
            ProposalProcedure
          >(HexBlob.fromBytes(reader.readEncodedValue()), proposalCbor =>
            ProposalProcedure.fromCbor(proposalCbor, options),
          );

          if (proposalProcedures.size() === 0)
            throw new SerializationError(
              SerializationFailure.InvalidType,
              'proposal_procedures (sub transaction body key 20) must be a non-empty set',
            );

          body.setProposalProcedures(proposalProcedures);
          break;
        }
        case 21n:
          body.setCurrentTreasuryValue(reader.readInt());
          break;
        case 22n: {
          const donation = reader.readInt();

          if (donation <= 0n)
            throw new SerializationError(
              SerializationFailure.InvalidType,
              'donation (sub transaction body key 22) must be greater than zero',
            );

          body.setDonation(donation);
          break;
        }
        case 24n: {
          body.setRequiredTopLevelGuards(
            readRequiredTopLevelGuards(
              reader,
              'required_top_level_guards (sub transaction body key 24)',
            ),
          );
          break;
        }
        case 25n: {
          reader.readStartMap();

          const directDeposits = new Map<
            Cardano.RewardAccount,
            Cardano.Lovelace
          >();

          while (reader.peekState() !== CborReaderState.EndMap) {
            const account = Address.fromBytes(
              HexBlob.fromBytes(reader.readByteString()),
            ).toBech32() as Cardano.RewardAccount;

            directDeposits.set(account, reader.readInt());
          }

          reader.readEndMap();

          if (directDeposits.size === 0)
            throw new SerializationError(
              SerializationFailure.InvalidType,
              'direct_deposits (sub transaction body key 25) must be a non-empty map',
            );

          body.setDirectDeposits(directDeposits);
          break;
        }
        case 26n: {
          body.setAccountBalanceIntervals(
            readAccountBalanceIntervals(
              reader,
              'account_balance_intervals (sub transaction body key 26)',
            ),
          );
          break;
        }
        default:
          throw new SerializationError(
            SerializationFailure.UnknownField,
            TOP_LEVEL_ONLY_KEYS.has(key)
              ? `Top-level-only transaction body map key not allowed in sub transaction body: ${key}`
              : `Unknown sub transaction body map key: ${key}`,
          );
      }
    }

    reader.readEndMap();

    if (!hasInputs)
      throw new SerializationError(
        SerializationFailure.InvalidType,
        'Sub transaction body missing required key: 0',
      );
    if (!hasOutputs)
      throw new SerializationError(
        SerializationFailure.InvalidType,
        'Sub transaction body missing required key: 1',
      );

    body.#originalBytes = cbor;

    return body;
  }

  /**
   * Creates a Core SubTransactionBody object from the current SubTransactionBody object.
   *
   * @returns The Core SubTransactionBody object.
   */
  toCore(): Cardano.SubTransactionBody {
    const guardCredentials = this.#guards?.credentials();
    const guardKeyHashes =
      this.#guards?.keyHashes() ??
      guardCredentials
        ?.filter(credential => credential.type === CredentialType.KeyHash)
        .map(credential => Crypto.Ed25519KeyHashHex(credential.hash));

    return {
      ...(this.#accountBalanceIntervals && {
        accountBalanceIntervals: accountBalanceIntervalsToCore(
          this.#accountBalanceIntervals,
        ),
      }),
      auxiliaryDataHash: this.#auxiliaryDataHash,
      certificates: this.#certs?.values() ? this.#certs.toCore() : undefined,
      ...(this.#directDeposits && {
        directDeposits: [...this.#directDeposits].map(
          ([stakeAddress, quantity]) => ({ quantity, stakeAddress }),
        ),
      }),
      donation: this.#donation,
      ...(guardCredentials && { guards: guardCredentials }),
      inputs: this.#inputs.toCore(),
      mint: this.#mint,
      networkId: this.#networkId,
      outputs: this.#outputs.map(output => output.toCore()),
      proposalProcedures: this.#proposalProcedures?.values()
        ? this.#proposalProcedures.toCore()
        : undefined,
      referenceInputs: this.#referenceInputs?.size()
        ? this.#referenceInputs.toCore()
        : undefined,
      requiredExtraSignatures:
        guardKeyHashes && guardKeyHashes.length > 0
          ? guardKeyHashes
          : undefined,
      ...(this.#requiredTopLevelGuards && {
        requiredTopLevelGuards: requiredTopLevelGuardsToCore(
          this.#requiredTopLevelGuards,
        ),
      }),
      scriptIntegrityHash: this.#scriptDataHash,
      treasuryValue: this.#currentTreasuryValue,
      validityInterval:
        this.#ttl !== undefined || this.#validityStartInterval !== undefined
          ? {
              invalidBefore: this.#validityStartInterval,
              invalidHereafter: this.#ttl,
            }
          : undefined,
      votingProcedures: this.#votingProcedures
        ? this.#votingProcedures.toCore()
        : undefined,
      withdrawals: this.#withdrawals
        ? [...this.#withdrawals].map(([stakeAddress, quantity]) => ({
            quantity,
            stakeAddress,
          }))
        : undefined,
    };
  }

  /**
   * Creates a SubTransactionBody object from the given Core SubTransactionBody object.
   *
   * @param coreSubTransactionBody The core SubTransactionBody object.
   */
  static fromCore(
    coreSubTransactionBody: Cardano.SubTransactionBody,
  ): SubTransactionBody {
    const body = new SubTransactionBody(
      CborSet.fromCore(
        coreSubTransactionBody.inputs,
        TransactionInput.fromCore,
      ),
      coreSubTransactionBody.outputs.map(output =>
        TransactionOutput.fromCore(output),
      ),
    );

    if (coreSubTransactionBody.auxiliaryDataHash)
      body.setAuxiliaryDataHash(coreSubTransactionBody.auxiliaryDataHash);

    if (coreSubTransactionBody.certificates)
      body.setCerts(
        CborSet.fromCore(
          coreSubTransactionBody.certificates,
          Certificate.fromCore,
        ),
      );

    if (coreSubTransactionBody.mint) body.setMint(coreSubTransactionBody.mint);

    if (coreSubTransactionBody.networkId !== undefined)
      body.setNetworkId(coreSubTransactionBody.networkId);

    if (coreSubTransactionBody.referenceInputs)
      body.setReferenceInputs(
        CborSet.fromCore(
          coreSubTransactionBody.referenceInputs,
          TransactionInput.fromCore,
        ),
      );

    if (coreSubTransactionBody.guards)
      body.setGuards(Guards.fromCredentials(coreSubTransactionBody.guards));
    else if (coreSubTransactionBody.requiredExtraSignatures)
      body.setGuards(
        Guards.fromKeyHashes(coreSubTransactionBody.requiredExtraSignatures),
      );

    if (coreSubTransactionBody.scriptIntegrityHash)
      body.setScriptDataHash(coreSubTransactionBody.scriptIntegrityHash);

    if (coreSubTransactionBody.validityInterval) {
      if (
        coreSubTransactionBody.validityInterval.invalidHereafter !== undefined
      )
        body.setTtl(coreSubTransactionBody.validityInterval.invalidHereafter);
      if (coreSubTransactionBody.validityInterval.invalidBefore !== undefined)
        body.setValidityStartInterval(
          coreSubTransactionBody.validityInterval.invalidBefore,
        );
    }

    if (coreSubTransactionBody.withdrawals) {
      body.setWithdrawals(new Map<Cardano.RewardAccount, Cardano.Lovelace>());

      for (const coreWithdrawal of coreSubTransactionBody.withdrawals) {
        body
          .withdrawals()!
          .set(coreWithdrawal.stakeAddress, coreWithdrawal.quantity);
      }
    }

    if (coreSubTransactionBody.requiredTopLevelGuards)
      body.setRequiredTopLevelGuards(
        requiredTopLevelGuardsFromCore(
          coreSubTransactionBody.requiredTopLevelGuards,
        ),
      );

    if (coreSubTransactionBody.directDeposits) {
      body.setDirectDeposits(
        new Map<Cardano.RewardAccount, Cardano.Lovelace>(),
      );

      for (const coreDeposit of coreSubTransactionBody.directDeposits) {
        body
          .directDeposits()!
          .set(coreDeposit.stakeAddress, coreDeposit.quantity);
      }
    }

    if (coreSubTransactionBody.accountBalanceIntervals)
      body.setAccountBalanceIntervals(
        accountBalanceIntervalsFromCore(
          coreSubTransactionBody.accountBalanceIntervals,
        ),
      );

    if (coreSubTransactionBody.donation !== undefined)
      body.setDonation(coreSubTransactionBody.donation);
    if (coreSubTransactionBody.treasuryValue !== undefined)
      body.setCurrentTreasuryValue(coreSubTransactionBody.treasuryValue);
    if (coreSubTransactionBody.votingProcedures)
      body.setVotingProcedures(
        VotingProcedures.fromCore(coreSubTransactionBody.votingProcedures),
      );
    if (coreSubTransactionBody.proposalProcedures)
      body.setProposalProcedures(
        CborSet.fromCore(
          coreSubTransactionBody.proposalProcedures,
          ProposalProcedure.fromCore,
        ),
      );

    return body;
  }

  /**
   * Sets the list of references to UTxOs (Unspent Transaction Outputs) that the sub transaction intends to spend.
   *
   * @param inputs the list of references to UTxOs.
   */
  setInputs(inputs: TransactionInputSet) {
    this.#inputs = inputs;
    this.#originalBytes = undefined;
  }

  /**
   * Gets the list of references to UTxOs (Unspent Transaction Outputs) that the sub transaction intends to spend.
   *
   * @returns The list of references to UTxOs.
   */
  inputs() {
    return this.#inputs;
  }

  /**
   * Sets the list of outputs where the value will go.
   *
   * @param outputs The list of outputs.
   */
  setOutputs(outputs: Array<TransactionOutput>) {
    this.#outputs = outputs;
    this.#originalBytes = undefined;
  }

  /**
   * Gets the list of outputs where the value will go.
   *
   * @returns The list of outputs.
   */
  outputs(): Array<TransactionOutput> {
    return this.#outputs;
  }

  /**
   * Sets the slot number until which the sub transaction is valid.
   *
   * @param ttl The slot number until which the sub transaction is valid.
   */
  setTtl(ttl: Cardano.Slot) {
    this.#ttl = ttl;
    this.#originalBytes = undefined;
  }

  /**
   * Gets the slot number until which the sub transaction is valid.
   *
   * @returns The slot number until which the sub transaction is valid.
   */
  ttl(): Cardano.Slot | undefined {
    return this.#ttl;
  }

  /**
   * Sets the certificates to be issued by this sub transaction.
   *
   * @param certs The certificates to be issued by this sub transaction.
   */
  setCerts(
    certs: CborSet<ReturnType<Certificate['toCore']>, Certificate>,
  ): void {
    this.#certs = certs;
    this.#originalBytes = undefined;
  }

  /**
   * Gets the certificates to be issued by this sub transaction.
   *
   * @returns The certificates to be issued by this sub transaction.
   */
  certs() {
    return this.#certs;
  }

  /**
   * Sets the list of withdrawals. This specifies from which staking addresses rewards should be withdrawn.
   *
   * @param withdrawals The list of withdrawals.
   */
  setWithdrawals(
    withdrawals: Map<Cardano.RewardAccount, Cardano.Lovelace>,
  ): void {
    this.#withdrawals = withdrawals;
    this.#originalBytes = undefined;
  }

  /**
   * Gets the list of withdrawals. This specifies from which staking addresses rewards should be withdrawn.
   *
   * @returns The list of withdrawals.
   */
  withdrawals(): Map<Cardano.RewardAccount, Cardano.Lovelace> | undefined {
    return this.#withdrawals;
  }

  /**
   * Sets the hash of the auxiliary data of the sub transaction, such as transaction metadata.
   *
   * @param auxiliaryDataHash The hash of the auxiliary data of the sub transaction.
   */
  setAuxiliaryDataHash(auxiliaryDataHash: Crypto.Hash32ByteBase16): void {
    this.#auxiliaryDataHash = auxiliaryDataHash;
    this.#originalBytes = undefined;
  }

  /**
   * Gets the hash of the auxiliary data of the sub transaction, such as transaction metadata.
   *
   * @returns The hash of the auxiliary data of the sub transaction.
   */
  auxiliaryDataHash(): Crypto.Hash32ByteBase16 | undefined {
    return this.#auxiliaryDataHash;
  }

  /**
   * Sets the validity interval start for this sub transaction. This specifies the earliest
   * slot in which the sub transaction is valid.
   *
   * @param validityStartInterval The earliest slot in which the sub transaction is valid.
   */
  setValidityStartInterval(validityStartInterval: Cardano.Slot): void {
    this.#validityStartInterval = validityStartInterval;
    this.#originalBytes = undefined;
  }

  /**
   * Gets the validity interval start for this sub transaction. This specifies the earliest
   * slot in which the sub transaction is valid.
   *
   * @returns The earliest slot in which the sub transaction is valid.
   */
  validityStartInterval(): Cardano.Slot | undefined {
    return this.#validityStartInterval;
  }

  /**
   * Sets details about the tokens being minted or burned in the sub transaction.
   *
   * @param mint The list of tokens being minted or burned.
   */
  setMint(mint: Cardano.TokenMap): void {
    // We need to segregate the token map as a multiasset to be able to sort it correctly in canonical form.
    this.#mint = multiAssetsToTokenMap(
      new Map([...tokenMapToMultiAsset(mint).entries()].sort(sortCanonically)),
    );

    this.#originalBytes = undefined;
  }

  /**
   * Gets details about the tokens being minted or burned in the sub transaction.
   *
   * @returns The list of tokens being minted or burned.
   */
  mint(): Cardano.TokenMap | undefined {
    return this.#mint;
  }

  /**
   * Sets the script data integrity hash.
   *
   * @param scriptDataHash The script data integrity hash.
   */
  setScriptDataHash(scriptDataHash: Crypto.Hash32ByteBase16): void {
    this.#scriptDataHash = scriptDataHash;
    this.#originalBytes = undefined;
  }

  /**
   * Gets the script data integrity hash.
   *
   * @returns The script data integrity hash.
   */
  scriptDataHash(): Crypto.Hash32ByteBase16 | undefined {
    return this.#scriptDataHash;
  }

  /**
   * Sets the guards on body key 14. Guards are credentials that must approve the sub
   * transaction, in either the key hash set or credential ordered set wire form.
   *
   * @param guards The guards that must approve the sub transaction.
   */
  setGuards(guards: Guards): void {
    this.#guards = guards;
    this.#originalBytes = undefined;
  }

  /**
   * Gets the guards of body key 14.
   *
   * @returns The guards, or undefined when key 14 is absent.
   */
  guards(): Guards | undefined {
    return this.#guards;
  }

  /**
   * Sets the network id on this sub transaction. This is an identifier used to distinguish
   * between different networks.
   *
   * @param networkId The id of the network this sub transaction is intended for.
   */
  setNetworkId(networkId: Cardano.NetworkId): void {
    this.#networkId = networkId;
    this.#originalBytes = undefined;
  }

  /**
   * Gets the network id on this sub transaction. This is an identifier used to distinguish
   * between different networks.
   *
   * @returns The id of the network this sub transaction is intended for.
   */
  networkId(): Cardano.NetworkId | undefined {
    return this.#networkId;
  }

  /**
   * Reference inputs allows looking at an output without spending it. This facilitates access to information
   * stored on the blockchain without the need of spending and recreating UTxOs.
   *
   * @param referenceInputs The reference inputs.
   */
  setReferenceInputs(referenceInputs: TransactionInputSet): void {
    this.#referenceInputs = referenceInputs;
    this.#originalBytes = undefined;
  }

  /**
   * Gets the reference inputs of this sub transaction.
   *
   * @returns the reference inputs.
   */
  referenceInputs() {
    return this.#referenceInputs;
  }

  /**
   * Sets the voting procedures of this sub transaction.
   *
   * @param votingProcedures the voting procedures.
   */
  setVotingProcedures(votingProcedures: VotingProcedures): void {
    this.#votingProcedures = votingProcedures;
    this.#originalBytes = undefined;
  }

  /**
   * Gets the voting procedures of this sub transaction.
   *
   * @returns the voting procedures.
   */
  votingProcedures(): VotingProcedures | undefined {
    return this.#votingProcedures;
  }

  /**
   * Sets the proposal procedures of this sub transaction.
   *
   * @param proposalProcedure the proposal procedures.
   */
  setProposalProcedures(
    proposalProcedure: CborSet<
      ReturnType<ProposalProcedure['toCore']>,
      ProposalProcedure
    >,
  ): void {
    this.#proposalProcedures = proposalProcedure;
    this.#originalBytes = undefined;
  }

  /**
   * Gets the proposal procedures of this sub transaction.
   *
   * @returns the proposal procedures.
   */
  proposalProcedures() {
    return this.#proposalProcedures;
  }

  /**
   * Sets the current treasury value of this sub transaction.
   *
   * @param currentTreasuryValue the current treasury value.
   */
  setCurrentTreasuryValue(currentTreasuryValue: Cardano.Lovelace): void {
    this.#currentTreasuryValue = currentTreasuryValue;
    this.#originalBytes = undefined;
  }

  /**
   * Gets the current treasury value of this sub transaction.
   *
   * @returns the current treasury value.
   */
  currentTreasuryValue(): Cardano.Lovelace | undefined {
    return this.#currentTreasuryValue;
  }

  /**
   * Sets the current treasury donation of this sub transaction.
   *
   * A zero donation is left out of the encoding, as the ledger does.
   *
   * @param donation The treasury donation.
   */
  setDonation(donation: Cardano.Lovelace): void {
    this.#donation = donation;
    this.#originalBytes = undefined;
  }

  /**
   * Gets the current treasury donation of this sub transaction.
   *
   * @returns The treasury donation.
   */
  donation(): Cardano.Lovelace | undefined {
    return this.#donation;
  }

  /**
   * Sets the required top level guards (body key 24). Each entry names a guard the enclosing
   * transaction must carry, mapped to the plutus datum it must be supplied with, or null when
   * the guard carries no datum (CBOR nil on the wire, used for key hash and native script
   * guards).
   *
   * @param requiredTopLevelGuards The map of guard credentials to their optional datum.
   */
  setRequiredTopLevelGuards(
    requiredTopLevelGuards: Map<Credential, PlutusData | null>,
  ): void {
    this.#requiredTopLevelGuards = requiredTopLevelGuards;
    this.#originalBytes = undefined;
  }

  /**
   * Gets the required top level guards (body key 24). Each entry names a guard the enclosing
   * transaction must carry, mapped to the plutus datum it must be supplied with, or null when
   * the guard carries no datum.
   *
   * @returns The map of guard credentials to their optional datum.
   */
  requiredTopLevelGuards(): Map<Credential, PlutusData | null> | undefined {
    return this.#requiredTopLevelGuards;
  }

  /**
   * Sets the direct deposits (body key 25). Each entry deposits coin directly into a reward
   * account without a withdrawal-style witness.
   *
   * @param directDeposits The map of reward accounts to deposited coin.
   */
  setDirectDeposits(
    directDeposits: Map<Cardano.RewardAccount, Cardano.Lovelace>,
  ): void {
    this.#directDeposits = directDeposits;
    this.#originalBytes = undefined;
  }

  /**
   * Gets the direct deposits (body key 25). Each entry deposits coin directly into a reward
   * account without a withdrawal-style witness.
   *
   * @returns The map of reward accounts to deposited coin.
   */
  directDeposits(): Map<Cardano.RewardAccount, Cardano.Lovelace> | undefined {
    return this.#directDeposits;
  }

  /**
   * Sets the account balance intervals (body key 26). Each entry asserts that the balance of the
   * reward account lies in a half-open range, or equals an exact balance, at validation time.
   *
   * @param accountBalanceIntervals The map of reward accounts to balance intervals.
   */
  setAccountBalanceIntervals(
    accountBalanceIntervals: Map<Cardano.RewardAccount, AccountBalanceInterval>,
  ): void {
    this.#accountBalanceIntervals = accountBalanceIntervals;
    this.#originalBytes = undefined;
  }

  /**
   * Gets the account balance intervals (body key 26). Each entry asserts that the balance of the
   * reward account lies in a half-open range, or equals an exact balance, at validation time.
   *
   * @returns The map of reward accounts to balance intervals.
   */
  accountBalanceIntervals():
    | Map<Cardano.RewardAccount, AccountBalanceInterval>
    | undefined {
    return this.#accountBalanceIntervals;
  }

  /**
   * Gets the size of the serialized map.
   *
   * @private
   */
  #getMapSize(): number {
    let mapSize = 2;

    if (this.#ttl !== undefined) ++mapSize;
    if (this.#certs !== undefined && this.#certs.size() > 0) ++mapSize;
    if (this.#withdrawals !== undefined && this.#withdrawals.size > 0)
      ++mapSize;
    if (this.#auxiliaryDataHash !== undefined) ++mapSize;
    if (this.#validityStartInterval !== undefined) ++mapSize;
    if (this.#mint !== undefined && this.#mint.size > 0) ++mapSize;
    if (this.#scriptDataHash !== undefined) ++mapSize;
    if (this.#guards !== undefined && this.#guards.size() > 0) ++mapSize;
    if (this.#networkId !== undefined) ++mapSize;
    if (this.#referenceInputs !== undefined && this.#referenceInputs.size() > 0)
      ++mapSize;
    if (this.#votingProcedures !== undefined) ++mapSize;
    if (
      this.#proposalProcedures !== undefined &&
      this.#proposalProcedures.size() > 0
    )
      ++mapSize;
    if (this.#currentTreasuryValue !== undefined) ++mapSize;
    if (this.#donation !== undefined && this.#donation > 0n) ++mapSize;
    if (
      this.#requiredTopLevelGuards !== undefined &&
      this.#requiredTopLevelGuards.size > 0
    )
      ++mapSize;
    if (this.#directDeposits !== undefined && this.#directDeposits.size > 0)
      ++mapSize;
    if (
      this.#accountBalanceIntervals !== undefined &&
      this.#accountBalanceIntervals.size > 0
    )
      ++mapSize;

    return mapSize;
  }
}
