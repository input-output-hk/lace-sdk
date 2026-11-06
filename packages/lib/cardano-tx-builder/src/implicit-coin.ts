import { Cardano } from '@lace-lib/cardano-core';

/**
 * The ids of the pools `certificates` register, each once.
 *
 * @param certificates - The certificates of a transaction or sub transaction body.
 * @returns The ids of the registered pools.
 */
export const registeredPoolIds = (
  certificates: readonly Cardano.Certificate[] = [],
): Set<Cardano.PoolId> =>
  new Set(
    certificates.flatMap(certificate =>
      certificate.__typename === Cardano.CertificateType.PoolRegistration
        ? [certificate.poolParameters.id]
        : [],
    ),
  );

/**
 * The certificates of `certificates` that the ledger charges or refunds a
 * deposit for within the transaction. A pool registration is charged the
 * pool deposit only when its pool is not registered yet: a registration of
 * a pool already registered on chain updates its parameters, and a later
 * registration of a pool the transaction registers does too, so both are
 * left out. A pool retirement refunds nothing within the transaction, so it
 * is left out as well.
 *
 * @param certificates - The certificates of a transaction or sub transaction body.
 * @param registeredPools - The pools already registered on chain.
 * @returns The certificates that carry a deposit or refund.
 */
const depositCertificates = (
  certificates: readonly Cardano.Certificate[],
  registeredPools: ReadonlySet<Cardano.PoolId>,
): Cardano.Certificate[] => {
  const chargedPools = new Set<Cardano.PoolId>(registeredPools);
  return certificates.filter(certificate => {
    if (certificate.__typename === Cardano.CertificateType.PoolRetirement)
      return false;
    if (certificate.__typename !== Cardano.CertificateType.PoolRegistration)
      return true;
    const { id } = certificate.poolParameters;
    if (chargedPools.has(id)) return false;
    chargedPools.add(id);
    return true;
  });
};

/**
 * The implicit coin of `body`, its withdrawals, deposits and refunded
 * deposits, as the ledger counts it within the transaction. A pool
 * registration is charged the pool deposit once per pool the body
 * registers, and not at all for a pool already registered on chain, whose
 * registration only updates its parameters. A pool retirement refunds the
 * pool deposit at the epoch boundary it names, not in the transaction, so
 * it refunds nothing here.
 *
 * @param protocolParameters - The deposits the certificates are priced with.
 * @param body - The transaction or sub transaction body.
 * @param registeredPools - The pools already registered on chain.
 * @returns The implicit coin of `body`.
 */
export const transactionImplicitCoin = (
  protocolParameters: Pick<
    Cardano.ProtocolParameters,
    'poolDeposit' | 'stakeKeyDeposit'
  >,
  body: Pick<
    Cardano.HydratedTxBody,
    'certificates' | 'proposalProcedures' | 'withdrawals'
  >,
  registeredPools: ReadonlySet<Cardano.PoolId> = new Set(),
): Cardano.util.ImplicitCoin =>
  Cardano.util.computeImplicitCoin(protocolParameters, {
    ...body,
    certificates:
      body.certificates &&
      depositCertificates(body.certificates, registeredPools),
  });
