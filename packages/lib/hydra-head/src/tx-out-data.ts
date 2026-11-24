import { Cardano, Serialization } from '@lace-lib/cardano-core';

/** Builds constructor data from its alternative and fields. */
export const constr = (
  alternative: bigint,
  ...fields: Serialization.PlutusData[]
): Serialization.PlutusData => {
  const list = new Serialization.PlutusList();
  for (const field of fields) list.add(field);
  return Serialization.PlutusData.newConstrPlutusData(
    new Serialization.ConstrPlutusData(alternative, list),
  );
};

/** Builds bytes data from hex. */
const bytes = (hex: string): Serialization.PlutusData =>
  Serialization.PlutusData.newBytes(Uint8Array.from(Buffer.from(hex, 'hex')));

/** Builds map data from its entries, in the given order. */
const map = (
  entries: readonly (readonly [string, Serialization.PlutusData])[],
): Serialization.PlutusData => {
  const plutusMap = new Serialization.PlutusMap();
  for (const [key, value] of entries) plutusMap.insert(bytes(key), value);
  return Serialization.PlutusData.newMap(plutusMap);
};

/** Ledger API `Credential`: a key hash (0) or a script hash (1). */
const credentialData = ({
  type,
  hash,
}: Cardano.Credential): Serialization.PlutusData =>
  constr(type === Cardano.CredentialType.KeyHash ? 0n : 1n, bytes(hash));

/**
 * Ledger API `Address`: the payment credential and `Maybe StakingCredential`,
 * where a staking credential is a hash (0) or a pointer (1).
 */
const addressData = (
  address: Cardano.PaymentAddress,
): Serialization.PlutusData => {
  const { paymentPart, delegationPart, pointer } =
    Cardano.Address.fromBech32(address).getProps();
  if (!paymentPart) {
    throw new Error(`Address ${address} has no payment credential`);
  }
  let staking = constr(1n);
  if (delegationPart) {
    staking = constr(0n, constr(0n, credentialData(delegationPart)));
  } else if (pointer) {
    staking = constr(
      0n,
      constr(
        1n,
        Serialization.PlutusData.newInteger(BigInt(pointer.slot)),
        Serialization.PlutusData.newInteger(BigInt(pointer.txIndex)),
        Serialization.PlutusData.newInteger(BigInt(pointer.certIndex)),
      ),
    );
  }
  return constr(0n, credentialData(paymentPart), staking);
};

/**
 * Ledger API `Value`, ordered as the ledger translates it: lovelace first,
 * then policy ids and, under each, asset names in ascending byte order.
 * Lowercase hex sorts in the same order as the bytes it encodes.
 */
const valueData = ({
  coins,
  assets,
}: Cardano.Value): Serialization.PlutusData => {
  const byPolicy = new Map<string, [string, bigint][]>();
  for (const [assetId, quantity] of assets ?? []) {
    const policyId = Cardano.AssetId.getPolicyId(assetId);
    const tokens = byPolicy.get(policyId) ?? [];
    tokens.push([Cardano.AssetId.getAssetName(assetId), quantity]);
    byPolicy.set(policyId, tokens);
  }
  const byHex = <T>([a]: readonly [string, T], [b]: readonly [string, T]) =>
    a < b ? -1 : a > b ? 1 : 0;
  const lovelace = map([['', Serialization.PlutusData.newInteger(coins)]]);
  return map([
    ['', lovelace],
    ...[...byPolicy]
      .sort(byHex)
      .map(
        ([policyId, tokens]) =>
          [
            policyId,
            map(
              tokens
                .sort(byHex)
                .map(([name, quantity]) => [
                  name,
                  Serialization.PlutusData.newInteger(quantity),
                ]),
            ),
          ] as const,
      ),
  ]);
};

/** Ledger API `OutputDatum`: none (0), a datum hash (1) or an inline datum (2). */
const outputDatumData = ({
  datum,
  datumHash,
}: Cardano.TxOut): Serialization.PlutusData => {
  if (datum !== undefined) {
    return constr(2n, Serialization.PlutusData.fromCore(datum));
  }
  return datumHash === undefined ? constr(0n) : constr(1n, bytes(datumHash));
};

/**
 * Encodes a ledger output as the ledger API `TxOut` a Plutus V3 script sees:
 * address, value, datum and reference script. Hydra serializes each output
 * it commits in this encoding, so it tells whether an output rebuilt from a
 * commit is the one committed.
 *
 * @throws When the output carries a reference script, which this encoding
 * names by hash and is not needed for, or an address without a payment
 * credential.
 */
export const toPlutusTxOutData = (
  output: Cardano.TxOut,
): Serialization.PlutusData => {
  if (output.scriptReference) {
    throw new Error('Outputs with a reference script are not encoded');
  }
  return constr(
    0n,
    addressData(output.address),
    valueData(output.value),
    outputDatumData(output),
    constr(1n),
  );
};
