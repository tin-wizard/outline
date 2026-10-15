/** The facts the publish form's submit guard depends on. */
export interface SubmitState {
  pending: boolean;
  /** Whether at least one source must be chosen. */
  needsSources: boolean;
  sourceCount: number;
  /** Whether the current access code must be typed. */
  needsCode: boolean;
  codeLength: number;
}

/**
 * Whether the publish or rotate form may be submitted. Used both to enable the
 * button and as an early return in the submit handler, so Enter in any field
 * cannot publish or rotate when the button is disabled.
 *
 * @param state the form state.
 * @returns true when submitting is allowed.
 */
export function canSubmitForm(state: SubmitState): boolean {
  return (
    !state.pending &&
    (!state.needsSources || state.sourceCount > 0) &&
    (!state.needsCode || state.codeLength > 0)
  );
}
