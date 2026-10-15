import { customCodeProblem, normalizeCode } from "../shared/accessCode";

/** How a new access code is chosen, as entered in AccessCodeFields. */
export interface AccessCodeChoice {
  /** Whether the administrator sets the code instead of having one generated. */
  custom: boolean;
  /** The chosen code as typed. */
  code: string;
  /** The chosen code typed a second time. */
  confirm: string;
}

/** A choice that generates the code. */
export const GENERATED_CODE: AccessCodeChoice = {
  custom: false,
  code: "",
  confirm: "",
};

/** Why a chosen code cannot be used yet. */
export type AccessCodeChoiceProblem =
  | "length"
  | "characters"
  | "mismatch"
  | "unconfirmed";

/**
 * Checks a code choice. Codes are compared after normalisation because the
 * gate page normalises what readers type the same way.
 *
 * @param choice the choice.
 * @returns the first problem found, or undefined when the choice can be sent.
 */
export function accessCodeChoiceProblem(
  choice: AccessCodeChoice
): AccessCodeChoiceProblem | undefined {
  if (!choice.custom) {
    return undefined;
  }
  const problem = customCodeProblem(choice.code);
  if (problem) {
    return problem;
  }
  if (!choice.confirm) {
    return "unconfirmed";
  }
  if (normalizeCode(choice.confirm) !== normalizeCode(choice.code)) {
    return "mismatch";
  }
  return undefined;
}

/**
 * The code to send as `newAccessCode`.
 *
 * @param choice the choice, which must have no problem.
 * @returns the chosen code, or undefined to have one generated.
 */
export function newAccessCode(choice: AccessCodeChoice): string | undefined {
  return choice.custom ? choice.code : undefined;
}
