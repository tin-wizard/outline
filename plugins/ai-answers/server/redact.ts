/** Text with secrets replaced, and how many of each class were found. */
export interface RedactionResult {
  text: string;
  counts: Record<string, number>;
}

/**
 * Replaces secret-shaped text (API keys, tokens, private keys, JWTs, URL
 * passwords and `password = value` assignments) with `[REDACTED:<class>]`.
 * Pure and idempotent: redacting the output again changes nothing.
 *
 * @param text the text to redact.
 * @returns the redacted text and the number of matches per class.
 */
export function redactSecrets(text: string): RedactionResult {
  const counts: Record<string, number> = {};
  // Zero-width characters would otherwise split a secret past every pattern.
  let result = text.replace(/[\u200B-\u200D\uFEFF]/g, "");
  for (const rule of RULES) {
    // Without capture groups the second argument is the match offset.
    result = result.replace(
      rule.pattern,
      (match: string, group: string | number) => {
        counts[rule.cls] = (counts[rule.cls] ?? 0) + 1;
        const marker = `[REDACTED:${rule.cls}]`;
        if (!rule.keepPrefix) {
          return marker;
        }
        // Group 1 is the part kept in front of the secret (key name, URL user).
        const prefix = typeof group === "string" ? group : "";
        const value = match.slice(prefix.length);
        const quote = /^["']/.test(value) ? value[0] : "";
        return `${prefix}${quote}${marker}${quote}`;
      }
    );
  }
  return { text: result, counts };
}

interface Rule {
  cls: string;
  pattern: RegExp;
  /** When set, capture group 1 is kept and only the rest is replaced. */
  keepPrefix?: boolean;
}

// Every quantifier is bounded or runs over a class that excludes the token
// that follows it, so no pattern can backtrack catastrophically.
// Order matters: specific classes run before the generic assignment rule, and
// the prefix-keeping rules skip values that are already redacted.
// Known limits: values on the line after their key, Twilio SK keys, Stripe
// whsec_, Slack xapp-, JWTs with an empty signature, generic high-entropy text.
const RULES: Rule[] = [
  {
    cls: "private_key",
    pattern:
      /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----|$)/g,
  },
  {
    cls: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  },
  {
    cls: "provider_key",
    pattern: new RegExp(
      [
        String.raw`\bsk-[A-Za-z0-9_-]{20,}`, // Anthropic (sk-ant-), OpenAI
        String.raw`\b(?:AKIA|ASIA)[0-9A-Z]{16}\b`, // AWS access key id
        String.raw`\bAIza[0-9A-Za-z_-]{35}`, // Google
        String.raw`\bxox[abprs]-[A-Za-z0-9-]{10,}`, // Slack
        String.raw`\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}`, // Stripe
        String.raw`\bol_(?:api|at|rt|sk|rat|ac)_[A-Za-z0-9]{20,}`, // Outline API and OAuth
      ].join("|"),
      "g"
    ),
  },
  {
    cls: "vcs_token",
    pattern:
      /\bgh[pousr]_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{30,}|\bglpat-[A-Za-z0-9_-]{20,}|\bnpm_[A-Za-z0-9]{30,}/g,
  },
  {
    // Bearer <token>; the token must contain a non-letter so prose is kept.
    cls: "bearer_token",
    pattern:
      /(\bBearer[ \t]{1,5})(?!\[REDACTED:)(?=[A-Za-z]{0,500}[0-9._~+/=-])[A-Za-z0-9._~+/=-]{16,}/g,
    keepPrefix: true,
  },
  {
    // scheme://user:password@host, only the password is replaced.
    cls: "url_password",
    pattern:
      /(\b[a-z][a-z0-9+.-]{0,30}:\/\/[^\s:@/?#]+:)(?!\[REDACTED:)[^\s/?#]+(?=@)/gi,
    keepPrefix: true,
  },
  {
    // key = value, key: "value"; only the value (8+ chars) is replaced. A key
    // suffix needs a separator (SECRET_KEY_BASE, not Secretary), and an
    // unquoted value needs a non-letter so prose like "Token: authentication" is kept.
    cls: "assignment",
    pattern:
      /(?<![A-Za-z0-9])((?:password|passwd|passphrase|secret|api[_-]?key|token|private[_-]key|credentials?)(?:[_-][A-Za-z0-9_-]{0,30})?["']?[ \t]{0,5}[:=][ \t]{0,5})(?!["']?\[REDACTED:)(?:"[^"\n]{8,500}"|'[^'\n]{8,500}'|(?=[A-Za-z]{0,500}[^A-Za-z\s"'`,;])[^\s"'`,;]{8,})/gi,
    keepPrefix: true,
  },
];
