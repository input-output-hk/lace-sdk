let edits = 0;

/**
 * Records an edit to a Plutus data or metadatum container. A decoded container that was found
 * unchanged before the latest edit has to check its children again before it reuses its
 * decoded bytes.
 */
export const recordContainerEdit = (): void => {
  ++edits;
};

/**
 * Gets the number of container edits recorded so far.
 *
 * @returns The number of edits made to Plutus data and metadatum containers.
 */
export const containerEdits = (): number => edits;
