import { ComposableError } from '@lace-lib/cardano-util';

const formatMessage = (detail?: string) => {
  const messageDetail = detail ? `: ${detail}` : '';
  return `Proof generation failure${messageDetail}`;
};

export class ProofGenerationError<
  InnerError = unknown,
> extends ComposableError<InnerError> {
  constructor(detail?: string, innerError?: InnerError) {
    super(formatMessage(detail), innerError);
  }
}
