import crypto from "node:crypto";
import { promisify } from "node:util";
import { normalizeCode } from "../../shared/accessCode";
import { GATE_TEMPLATE } from "./gateTemplate";

export { normalizeCode };

/** The 31 characters access codes are drawn from; no 0, 1, i, l or o. */
export const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

/** A gate: one salt and one derived key, used to encrypt every page of a site. */
export interface Gate {
  /** The PBKDF2 salt embedded in every page of this gate. */
  salt: Uint8Array;
  /**
   * Encrypts one page with a fresh random IV.
   *
   * @param html the page's plaintext HTML.
   * @returns iv || ciphertext || tag, as the gate template expects.
   */
  encryptPage(html: string): Uint8Array;
}

/**
 * Generates a new access code: 16 characters from ALPHABET by rejection
 * sampling, grouped as xxxx-xxxx-xxxx-xxxx.
 *
 * @param randomBytesFn the byte source; injectable for tests only.
 * @returns the access code.
 * @throws {Error} if the byte source keeps yielding unusable bytes.
 */
export function generateAccessCode(
  randomBytesFn: (n: number) => Uint8Array = crypto.randomBytes
): string {
  let code = "";
  for (
    let attempt = 0;
    attempt < MAX_DRAWS && code.length < CODE_LENGTH;
    attempt++
  ) {
    for (const byte of randomBytesFn(32)) {
      // 248 = 8 * 31: accepting only bytes below it removes modulo bias.
      if (byte < 248 && code.length < CODE_LENGTH) {
        code += ALPHABET[byte % ALPHABET.length];
      }
    }
  }
  if (code.length < CODE_LENGTH) {
    throw new Error("Random source did not yield enough usable bytes");
  }
  return code.match(/.{4}/g)?.join("-") ?? code;
}

/**
 * Creates a gate for a code, deriving its key once (PBKDF2-HMAC-SHA-256,
 * 600000 iterations, 256-bit AES-GCM key). The derivation runs off the event
 * loop.
 *
 * @param code the access code.
 * @param options.salt a fixed 16-byte salt. Republishing passes the live
 * site's salt (from parseGatePage) so readers' derived keys keep working; tests
 * pass a fixed one. Omitted, a fresh random salt is generated.
 * @returns the gate.
 * @throws {Error} if the code is empty after normalisation.
 */
export async function createGate(
  code: string,
  options: { salt?: Uint8Array } = {}
): Promise<Gate> {
  const salt = options.salt ?? new Uint8Array(crypto.randomBytes(16));
  const key = await deriveKey(code, salt);
  return {
    salt,
    encryptPage(html: string): Uint8Array {
      const iv = crypto.randomBytes(IV_LENGTH);
      const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      return Buffer.concat([
        iv,
        cipher.update(html, "utf8"),
        cipher.final(),
        cipher.getAuthTag(),
      ]);
    },
  };
}

/**
 * Fills the gate template for one page.
 *
 * @param args.title the page title; HTML-escaped.
 * @param args.storageKey the localStorage key the browser keeps the derived key under.
 * @param args.salt the gate's salt.
 * @param args.blob the encrypted page from Gate.encryptPage.
 * @returns the gate page HTML.
 * @throws {Error} if storageKey does not match ^[a-z0-9:_-]{1,64}$.
 */
export function renderGatePage(args: {
  title: string;
  storageKey: string;
  salt: Uint8Array;
  blob: Uint8Array;
}): string {
  if (!/^[a-z0-9:_-]{1,64}$/.test(args.storageKey)) {
    throw new Error("Invalid gate storage key");
  }
  const values: Record<string, string> = {
    TITLE: escapeHtml(args.title),
    STORAGE_KEY: args.storageKey,
    SALT: Buffer.from(args.salt).toString("base64"),
    DATA: Buffer.from(args.blob).toString("base64"),
  };
  // One pass with a function replacer: "$&" in a title stays literal, and a
  // placeholder inside a replaced value is never expanded again.
  return GATE_TEMPLATE.replace(
    /__(TITLE|STORAGE_KEY|SALT|DATA)__/g,
    (_match, name: string) => values[name]
  );
}

/**
 * Extracts the salt and encrypted page embedded in a gate page.
 *
 * @param html a page produced by renderGatePage or the reference tool.
 * @returns the salt and blob, or null if the page does not parse.
 */
export function parseGatePage(
  html: string
): { salt: Uint8Array; blob: Uint8Array } | null {
  const match = /var SALT="([A-Za-z0-9+/=]+)",DATA="([A-Za-z0-9+/=]*)"/.exec(
    html
  );
  if (!match) {
    return null;
  }
  const salt = decodeBase64(match[1]);
  const blob = decodeBase64(match[2]);
  if (!salt || !blob) {
    return null;
  }
  return { salt, blob };
}

/**
 * Checks whether a code opens a gate page, i.e. the AES-GCM tag verifies.
 * Never throws.
 *
 * @param code the code as typed.
 * @param gatePageHtml the live gate page.
 * @returns true only if the code decrypts the embedded page.
 */
export async function verifyCode(
  code: string,
  gatePageHtml: string
): Promise<boolean> {
  try {
    const parsed = parseGatePage(gatePageHtml);
    if (!parsed || parsed.blob.length < IV_LENGTH + TAG_LENGTH) {
      return false;
    }
    const key = await deriveKey(code, parsed.salt);
    const { blob } = parsed;
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      key,
      blob.subarray(0, IV_LENGTH)
    );
    decipher.setAuthTag(blob.subarray(blob.length - TAG_LENGTH));
    decipher.update(blob.subarray(IV_LENGTH, blob.length - TAG_LENGTH));
    decipher.final();
    return true;
  } catch {
    return false;
  }
}

const CODE_LENGTH = 16;
const MAX_DRAWS = 16;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const pbkdf2 = promisify(crypto.pbkdf2);

/** Derives the AES-256 key exactly as the gate template does. */
async function deriveKey(code: string, salt: Uint8Array): Promise<Buffer> {
  const normalized = normalizeCode(code);
  if (!normalized) {
    throw new Error("Access code is empty");
  }
  return pbkdf2(Buffer.from(normalized, "utf8"), salt, 600000, 32, "sha256");
}

/** Decodes canonical standard base64 (as atob accepts it), else null. */
function decodeBase64(value: string): Uint8Array | null {
  const bytes = Buffer.from(value, "base64");
  return bytes.toString("base64") === value ? new Uint8Array(bytes) : null;
}

/** Escapes text for an HTML text node or attribute value. */
function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
