import { Cardano } from '@lace-lib/cardano-core';
import {
  classifyHydraTxByAddresses,
  decodeHydraDepositDatum,
  fromCardanoUtxo,
  HYDRA_HEAD_STATE_TOKEN_NAMES,
  isHydraDepositAddress,
  isHydraHeadAddress,
  parseHydraTxTag,
} from '@lace-lib/hydra-head';

import type { CardanoHydraActivityMetadata } from '../../augmentations';
import type { ExtensionActivityTx } from '../../types';
import type { HydraTxClassification, HydraTxName } from '@lace-lib/hydra-head';

/** Hex asset names of the head state token across every protocol generation. */
const HEAD_STATE_TOKEN_NAMES: ReadonlySet<string> = new Set(
  Object.values(HYDRA_HEAD_STATE_TOKEN_NAMES),
);

/**
 * The head steps the script addresses alone cannot tell apart here, by
 * whether the step leaves a head UTxO behind. The spent inputs carry no
 * datum on this stack, so a transaction spending a head UTxO is only known
 * to be one of these; the marker, when it names one that fits, picks it.
 */
const HEAD_STEPS_BY_HEAD_OUTPUT: Readonly<
  Record<'false' | 'true', ReadonlySet<string>>
> = {
  true: new Set<HydraTxName>([
    'CollectComTx',
    'CloseTx',
    'ContestTx',
    'DecrementTx',
    'PartialFanoutTx',
  ]),
  false: new Set<HydraTxName>(['AbortTx', 'FanoutTx', 'FinalPartialFanoutTx']),
};

/** The head id of the first head state token among the asset ids, if any. */
const findHeadId = (
  assetIds: Iterable<Cardano.AssetId>,
): string | undefined => {
  for (const assetId of assetIds) {
    if (HEAD_STATE_TOKEN_NAMES.has(Cardano.AssetId.getAssetName(assetId))) {
      return Cardano.AssetId.getPolicyId(assetId);
    }
  }
  return undefined;
};

/** The network id of a bech32 address, or undefined when it has none. */
const networkIdOf = (address: string): Cardano.NetworkId | undefined =>
  Cardano.Address.fromString(address)?.getNetworkId();

/**
 * The head id and deadline the first decodable deposit output commits to.
 * Only outputs at a deposit address with a datum are re-encoded and decoded,
 * and a deposit whose deadline is not a valid time is skipped.
 */
const readDeposit = ({
  id,
  body,
}: Pick<ExtensionActivityTx, 'body' | 'id'>): Pick<
  CardanoHydraActivityMetadata,
  'depositDeadline' | 'headId'
> => {
  for (const [index, output] of body.outputs.entries()) {
    if (output.datum === undefined || !isHydraDepositAddress(output.address)) {
      continue;
    }
    const networkId = networkIdOf(output.address);
    if (networkId === undefined) continue;
    const { inlineDatum } = fromCardanoUtxo([
      { txId: id, index, address: output.address },
      output,
    ]);
    const datum =
      inlineDatum && decodeHydraDepositDatum(inlineDatum, networkId);
    if (datum) {
      return {
        headId: datum.headId,
        depositDeadline: new Date(datum.deadline).toISOString(),
      };
    }
  }
  return {};
};

/**
 * The head id a head step reveals without decoding a datum: the head state
 * token on an output at a head address, or the one the transaction mints or
 * burns. The mint is read only when the transaction spends or pays a head
 * address, so a transaction that mints a lookalike token outside a head
 * cannot name a head.
 */
const readHeadId = ({
  body: { inputs, outputs, mint },
}: Pick<ExtensionActivityTx, 'body'>): Pick<
  CardanoHydraActivityMetadata,
  'headId'
> => {
  const hasHeadAddress =
    inputs.some(({ address }) => isHydraHeadAddress(address)) ||
    outputs.some(({ address }) => isHydraHeadAddress(address));
  if (!hasHeadAddress) return {};
  const headId =
    findHeadId(
      outputs.flatMap(({ address, value }) =>
        isHydraHeadAddress(address) ? [...(value.assets?.keys() ?? [])] : [],
      ),
    ) ?? findHeadId(mint?.keys() ?? []);
  return headId === undefined ? {} : { headId };
};

/**
 * The name of the step, refined by the marker where the addresses leave it
 * open: a head step the addresses only know as `HeadTx` takes the marker's
 * name when that names a head step that fits whether the transaction leaves
 * a head UTxO. Any other marker is ignored, so a sender can neither make a
 * transaction a Hydra step nor rename one the addresses already tell apart.
 */
const refineByMarker = (
  byAddresses: HydraTxClassification,
  markerName: string | undefined,
  hasHeadOutput: boolean,
): HydraTxClassification =>
  byAddresses === 'HeadTx' &&
  markerName !== undefined &&
  HEAD_STEPS_BY_HEAD_OUTPUT[hasHeadOutput ? 'true' : 'false'].has(markerName)
    ? (markerName as HydraTxName)
    : byAddresses;

/**
 * Recognises a Hydra Head layer 1 transaction and describes it for its
 * activity.
 *
 * A transaction is a Hydra step when it spends or pays a registered Hydra
 * head or deposit address, as `classifyHydraTxByAddresses` tells; the Hydra
 * metadata marker alone never makes it one, since anyone can attach the
 * marker. The spent inputs carry no datum on this stack, so a transaction
 * spending a head UTxO is known only as `HeadTx` from its addresses, and the
 * marker serves as a hint there: it names the step when it names a head step
 * that fits the transaction's outputs. A transaction that failed phase-2
 * validation performed no Hydra step and is never recognised.
 *
 * @returns the Hydra metadata, with the head id and the deposit deadline
 * decoded from the deposit datum for a deposit, or undefined when the
 * transaction is not a Hydra step.
 */
export const classifyTxAsHydra = (
  tx: ExtensionActivityTx,
): CardanoHydraActivityMetadata | undefined => {
  const { auxiliaryData, body, inputSource } = tx;
  if (inputSource === Cardano.InputSource.collaterals) return undefined;

  const byAddresses = classifyHydraTxByAddresses(
    body.inputs.map(({ address }) => ({ address })),
    body.outputs.map(({ address }) => ({ address })),
  );
  if (byAddresses === undefined) return undefined;

  const tag = parseHydraTxTag(auxiliaryData?.blob);
  const txName = refineByMarker(
    byAddresses,
    tag?.txName,
    body.outputs.some(({ address }) => isHydraHeadAddress(address)),
  );

  return {
    ...(tag && { protocol: tag.protocol }),
    txName,
    ...(txName === 'DepositTx' ? readDeposit(tx) : readHeadId(tx)),
  };
};
