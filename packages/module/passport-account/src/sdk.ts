import './augmentations';

export { createPassportAccountModule } from './create-passport-account-module';
export type { CreatePassportAccountModuleProps } from './create-passport-account-module';
export { createPasskeyAuthoriser } from './ceremony/passkey';
export { createPasskeyEncryptionKey } from './ceremony/encryption-key';
export type {
  CreatePasskeyAuthoriserProps,
  PasskeyAuthoriser,
} from './ceremony/passkey';
export { createRemotePassportAuthoriser } from './remote/remote-authoriser';
export { createRemoteEncryptionKey } from './remote/remote-encryption-key';
export { createRemoteAccountRecordStore } from './remote/remote-account-records';
export { createPassportSignerHandlers } from './remote/signer-handlers';
export type {
  CreatePassportSignerHandlersProps,
  PassportSignerHandlers,
} from './remote/signer-handlers';
export { decodeSignerFlow } from './remote/flow-descriptor';
export type { DecodedSignerFlow } from './remote/flow-descriptor';
export { MalformedPayloadError } from './remote/codec';
export {
  assertIssueRules,
  circuitScope,
  granteePoint,
} from './acc/grant-rules';
export type { GrantCircuitScope } from './acc/grant-rules';
export { loadGrantDerivation } from './acc/signing-loader';
export type { GrantDerivation } from './acc/signing-loader';
export { createPasskeySessionKeySource } from '@lace-lib/passkey';
export type {
  CreatePasskeyKeySourceProps,
  PasskeyCredentialRef,
  PasskeySessionKeySource,
} from '@lace-lib/passkey';
export { devEncryptionKey } from './acc/dev-encryption-key';
export { createDevDeposit } from './infra/dev-deposit';
export { createDevSponsor } from './infra/dev-sponsor';
export type { DevSponsor, DevSponsorConfig } from './infra/dev-sponsor';
export { createHttpProver } from './infra/http-prover';
export type { HttpProverOptions } from './infra/http-prover';
export { midnightDevnetNetwork } from './infra/networks';
export type { MidnightDevnetNetworkProps } from './infra/networks';
