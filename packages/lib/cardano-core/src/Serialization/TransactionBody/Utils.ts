import { HexBlob } from '@lace-lib/cardano-util';

import { Address, RewardAddress } from '../../Cardano/Address';
import { AssetId } from '../../Cardano/types/Asset';
import { SerializationError, SerializationFailure } from '../../errors';
import { hexToBytes } from '../../util/misc';
import { CborReaderState } from '../CBOR';
import { Credential } from '../Common';
import { PlutusData } from '../PlutusData';

import { AccountBalanceInterval } from './AccountBalanceInterval';

import type * as Cardano from '../../Cardano';
import type { CborReader, CborWriter } from '../CBOR';
import type * as Crypto from '@lace-lib/cardano-crypto';

/**
 * Sorts the given map entry canonically.
 *
 * @param lhs The left hand side.
 * @param rhs The right hand side.
 */
export const sortCanonically = (
  lhs: [string, unknown],
  rhs: [string, unknown],
) => {
  if (lhs[0].length === rhs[0].length) {
    return lhs[0] > rhs[0] ? 1 : -1;
  } else if (lhs[0].length > rhs[0].length) return 1;
  return -1;
};

/**
 * transform a token map into a CDDL compatible multiasset structure.
 *
 * @param tokenMap The token map to be transformed.
 * @returns The multiasset map.
 */
export const tokenMapToMultiAsset = (
  tokenMap: Cardano.TokenMap,
): Map<Crypto.Hash28ByteBase16, Map<Cardano.AssetName, bigint>> => {
  const multiassets = new Map<
    Crypto.Hash28ByteBase16,
    Map<Cardano.AssetName, bigint>
  >();

  const sortedTokenMap = new Map([...tokenMap.entries()].sort(sortCanonically));

  for (const [assetId, quantity] of sortedTokenMap.entries()) {
    const policyId = AssetId.getPolicyId(
      assetId,
    ) as unknown as Crypto.Hash28ByteBase16;
    const assetName = AssetId.getAssetName(assetId);

    if (!multiassets.has(policyId))
      multiassets.set(policyId, new Map<Cardano.AssetName, bigint>());

    multiassets.get(policyId)!.set(assetName, quantity);
  }

  return multiassets;
};

/**
 * Transform a CDDL compatible multiasset structure into a token map.
 *
 * @param multiassets The multi asset structure to be converted to token map.
 * @returns The token map.
 */
export const multiAssetsToTokenMap = (
  multiassets: Map<Crypto.Hash28ByteBase16, Map<Cardano.AssetName, bigint>>,
): Cardano.TokenMap => {
  const tokenMap = new Map<Cardano.AssetId, bigint>();

  for (const [scriptHash, assets] of multiassets.entries()) {
    for (const [assetName, quantity] of assets.entries()) {
      const assetId = AssetId.fromParts(
        scriptHash as unknown as Cardano.PolicyId,
        assetName,
      );
      tokenMap.set(assetId, quantity);
    }
  }

  return tokenMap;
};

/**
 * Writes an account balance intervals map keyed by reward account, with the entries sorted by
 * the reward account bytes.
 *
 * @param writer The CBOR writer to write the map to.
 * @param intervals The map of reward accounts to balance intervals.
 */
export const writeAccountBalanceIntervals = (
  writer: CborWriter,
  intervals: Map<Cardano.RewardAccount, AccountBalanceInterval>,
): void => {
  const intervalsWithAddressBytes = new Map<HexBlob, AccountBalanceInterval>();

  for (const [rewardAccount, interval] of intervals) {
    const rewardAddress = RewardAddress.fromAddress(
      Address.fromBech32(rewardAccount),
    );
    if (!rewardAddress)
      throw new SerializationError(
        SerializationFailure.InvalidAddress,
        `Invalid account balance interval reward account: ${rewardAccount}`,
      );

    intervalsWithAddressBytes.set(
      rewardAddress.toAddress().toBytes(),
      interval,
    );
  }

  const sortedCanonically = [...intervalsWithAddressBytes].sort((a, b) =>
    a[0] > b[0] ? 1 : -1,
  );

  writer.writeStartMap(sortedCanonically.length);

  for (const [addressBytes, interval] of sortedCanonically) {
    writer.writeByteString(hexToBytes(addressBytes));
    writer.writeEncodedValue(hexToBytes(interval.toCbor()));
  }
};

/**
 * Reads a non-empty account balance intervals map keyed by reward account. A reward account
 * appears at most once.
 *
 * @param reader The CBOR reader positioned at the start of the map.
 * @param field The name of the field being read, used in error messages.
 * @returns The map of reward accounts to balance intervals.
 */
export const readAccountBalanceIntervals = (
  reader: CborReader,
  field: string,
): Map<Cardano.RewardAccount, AccountBalanceInterval> => {
  const intervals = new Map<Cardano.RewardAccount, AccountBalanceInterval>();

  reader.readStartMap();

  while (reader.peekState() !== CborReaderState.EndMap) {
    const address = Address.fromBytes(
      HexBlob.fromBytes(reader.readByteString()),
    );
    if (!RewardAddress.fromAddress(address))
      throw new SerializationError(
        SerializationFailure.InvalidAddress,
        `${field} must be keyed by reward accounts`,
      );

    const rewardAccount = address.toBech32() as Cardano.RewardAccount;

    if (intervals.has(rewardAccount))
      throw new SerializationError(
        SerializationFailure.InvalidType,
        `Duplicate reward account in ${field}: ${rewardAccount}`,
      );

    intervals.set(
      rewardAccount,
      AccountBalanceInterval.fromCbor(
        HexBlob.fromBytes(reader.readEncodedValue()),
      ),
    );
  }

  reader.readEndMap();

  if (intervals.size === 0)
    throw new SerializationError(
      SerializationFailure.InvalidType,
      `${field} must be a non-empty map`,
    );

  return intervals;
};

/**
 * Converts an account balance intervals map into its core form.
 *
 * @param intervals The map of reward accounts to balance intervals.
 * @returns The core account balance interval entries.
 */
export const accountBalanceIntervalsToCore = (
  intervals: Map<Cardano.RewardAccount, AccountBalanceInterval>,
): Cardano.AccountBalanceIntervalEntry[] =>
  [...intervals].map(([rewardAccount, interval]) => ({
    interval: interval.toCore(),
    rewardAccount,
  }));

/**
 * Converts core account balance interval entries into an account balance intervals map.
 *
 * @param entries The core account balance interval entries.
 * @returns The map of reward accounts to balance intervals.
 */
export const accountBalanceIntervalsFromCore = (
  entries: Cardano.AccountBalanceIntervalEntry[],
): Map<Cardano.RewardAccount, AccountBalanceInterval> =>
  new Map(
    entries.map(({ rewardAccount, interval }) => [
      rewardAccount,
      AccountBalanceInterval.fromCore(interval),
    ]),
  );

/**
 * Writes a required top level guards map, with the entries sorted by the credential bytes. A
 * guard without a datum is written as CBOR nil.
 *
 * @param writer The CBOR writer to write the map to.
 * @param guards The map of guard credentials to their optional datum.
 */
export const writeRequiredTopLevelGuards = (
  writer: CborWriter,
  guards: Map<Credential, PlutusData | null>,
): void => {
  const guardsWithCredentialBytes = new Map<HexBlob, PlutusData | null>();

  for (const [credential, datum] of guards)
    guardsWithCredentialBytes.set(credential.toCbor(), datum);

  const sortedCanonically = [...guardsWithCredentialBytes].sort((a, b) =>
    a[0] > b[0] ? 1 : -1,
  );

  writer.writeStartMap(sortedCanonically.length);

  for (const [credentialBytes, datum] of sortedCanonically) {
    writer.writeEncodedValue(hexToBytes(credentialBytes));

    if (datum === null) {
      writer.writeNull();
    } else {
      writer.writeEncodedValue(hexToBytes(datum.toCbor()));
    }
  }
};

/**
 * Reads a non-empty required top level guards map. A guard written as CBOR nil carries no datum.
 *
 * @param reader The CBOR reader positioned at the start of the map.
 * @param field The name of the field being read, used in error messages.
 * @returns The map of guard credentials to their optional datum.
 */
export const readRequiredTopLevelGuards = (
  reader: CborReader,
  field: string,
): Map<Credential, PlutusData | null> => {
  const guards = new Map<Credential, PlutusData | null>();

  reader.readStartMap();

  while (reader.peekState() !== CborReaderState.EndMap) {
    const credential = Credential.fromCbor(
      HexBlob.fromBytes(reader.readEncodedValue()),
    );

    if (reader.peekState() === CborReaderState.Null) {
      reader.readNull();
      guards.set(credential, null);
    } else {
      guards.set(
        credential,
        PlutusData.fromCbor(HexBlob.fromBytes(reader.readEncodedValue())),
      );
    }
  }

  reader.readEndMap();

  if (guards.size === 0)
    throw new SerializationError(
      SerializationFailure.InvalidType,
      `${field} must be a non-empty map`,
    );

  return guards;
};

/**
 * Converts a required top level guards map into its core form.
 *
 * @param guards The map of guard credentials to their optional datum.
 * @returns The core required top level guard entries.
 */
export const requiredTopLevelGuardsToCore = (
  guards: Map<Credential, PlutusData | null>,
): Cardano.RequiredTopLevelGuardEntry[] =>
  [...guards].map(([credential, datum]) => ({
    credential: credential.toCore(),
    datum: datum === null ? null : datum.toCore(),
  }));

/**
 * Converts core required top level guard entries into a required top level guards map.
 *
 * @param entries The core required top level guard entries.
 * @returns The map of guard credentials to their optional datum.
 */
export const requiredTopLevelGuardsFromCore = (
  entries: Cardano.RequiredTopLevelGuardEntry[],
): Map<Credential, PlutusData | null> =>
  new Map(
    entries.map(({ credential, datum }) => [
      Credential.fromCore(credential),
      datum === null ? null : PlutusData.fromCore(datum),
    ]),
  );
