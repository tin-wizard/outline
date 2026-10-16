/** How a site's pages are served. */
export enum PagesGateType {
  /** Every page is encrypted and opens only with the site's access code. */
  Code = "code",
  /** Pages are uploaded as plain HTML and anyone with the address can read them. */
  None = "none",
}

/** The shortest access code an administrator may choose, after normalisation. */
export const CUSTOM_CODE_MIN_LENGTH = 12;

/** The longest access code an administrator may choose, after normalisation. */
export const CUSTOM_CODE_MAX_LENGTH = 64;

/** Why a chosen access code is refused. */
export type CustomCodeProblem = "length" | "characters";

/**
 * Normalises a typed access code exactly as the gate page's script does before
 * key derivation: lowercase, all whitespace removed, hyphens kept.
 *
 * @param input the code as typed.
 * @returns the normalised code.
 */
export function normalizeCode(input: string): string {
  return input.toLowerCase().replace(/\s+/g, "");
}

/**
 * Checks an access code chosen by an administrator. The published pages are
 * public ciphertext, so a short code could be guessed offline; the length is
 * counted after normalisation. Only printable ASCII is accepted so the code
 * normalises identically in every browser and keyboard layout.
 *
 * @param code the code as typed.
 * @returns the first problem found, or undefined when the code is acceptable.
 */
export function customCodeProblem(code: string): CustomCodeProblem | undefined {
  const normalized = normalizeCode(code);
  if (
    normalized.length < CUSTOM_CODE_MIN_LENGTH ||
    normalized.length > CUSTOM_CODE_MAX_LENGTH
  ) {
    return "length";
  }
  if (!/^[\x21-\x7e]+$/.test(normalized)) {
    return "characters";
  }
  return undefined;
}
