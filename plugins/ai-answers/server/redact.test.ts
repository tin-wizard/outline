import { redactSecrets } from "./redact";

// Every secret here is synthetic and assembled at runtime so the repository
// never contains a literal that looks like a real credential.
const a = (n: number) => "a".repeat(n);
const fake = {
  anthropic: "sk-ant-" + "api03-" + a(30),
  openai: "sk-" + "Ab1".repeat(10),
  aws: "AKIA" + "ABCDEFGH" + "IJKLMNOP",
  google: "AIza" + "Sy" + "b".repeat(33),
  slack: "xox" + "b-" + "1234-5678-" + a(12),
  stripe: "sk_" + "live_" + "c".repeat(24),
  github: "gh" + "p_" + "d".repeat(36),
  githubPat: "github_" + "pat_" + "e".repeat(22) + "_" + "f".repeat(20),
  gitlab: "gl" + "pat-" + "g".repeat(20),
  npm: "np" + "m_" + "h".repeat(36),
  outline: ["api", "at", "rt", "sk", "rat", "ac"].map(
    (kind) => "ol" + `_${kind}_` + "Ab1".repeat(10)
  ),
  jwt: [
    "ey" + "J" + "hbGciOiJIUzI1NiJ9",
    "eyJzdWIiOiIxMjM0NTY3ODkw",
    "x".repeat(20),
  ].join("."),
  privateKey: [
    "-----BEGIN " + "RSA PRIVATE KEY-----",
    "MIIEpAIBAAKCAQEA" + "z".repeat(40),
    "q".repeat(40),
    "-----END " + "RSA PRIVATE KEY-----",
  ].join("\n"),
};

describe("redactSecrets", () => {
  it.each([
    ["provider_key", fake.anthropic],
    ["provider_key", fake.openai],
    ["provider_key", fake.aws],
    ["provider_key", fake.google],
    ["provider_key", fake.slack],
    ["provider_key", fake.stripe],
    ["vcs_token", fake.github],
    ["vcs_token", fake.githubPat],
    ["vcs_token", fake.gitlab],
    ["vcs_token", fake.npm],
    ["jwt", fake.jwt],
    ...fake.outline.map((key) => ["provider_key", key]),
  ])("redacts a %s", (cls, secret) => {
    const result = redactSecrets(`before ${secret} after`);
    expect(result.text).toEqual(`before [REDACTED:${cls}] after`);
    expect(result.counts).toEqual({ [cls]: 1 });
  });

  it("redacts a whole private key block", () => {
    const result = redactSecrets(`Key:\n${fake.privateKey}\nDone.`);
    expect(result.text).toEqual("Key:\n[REDACTED:private_key]\nDone.");
    expect(result.counts).toEqual({ private_key: 1 });
  });

  it("redacts an unterminated private key to the end of the text", () => {
    const opened = fake.privateKey.split("\n").slice(0, 3).join("\n");
    const result = redactSecrets(`Key:\n${opened}\nmore text`);
    expect(result.text).toEqual("Key:\n[REDACTED:private_key]");
  });

  it("redacts a private key escaped by the markdown serializer", () => {
    const result = redactSecrets(`\\${fake.privateKey}`);
    expect(result.text).not.toContain("z".repeat(40));
    expect(result.counts).toEqual({ private_key: 1 });
  });

  it("redacts a PGP private key block", () => {
    const block = [
      "-----BEGIN PGP " + "PRIVATE KEY BLOCK-----",
      "lQOYBF" + "p".repeat(40),
      "-----END PGP " + "PRIVATE KEY BLOCK-----",
    ].join("\n");
    const result = redactSecrets(`a\n${block}\nb`);
    expect(result.text).toEqual("a\n[REDACTED:private_key]\nb");
  });

  it("redacts a bearer token and keeps the prefix", () => {
    const token = "abc123" + "._~+/-" + "Q".repeat(20) + "==";
    const result = redactSecrets(`Authorization: Bearer ${token}\nnext`);
    expect(result.text).toEqual(
      "Authorization: Bearer [REDACTED:bearer_token]\nnext"
    );
    expect(result.counts).toEqual({ bearer_token: 1 });
  });

  it("matches Bearer case-insensitively", () => {
    const token = "abc123" + "._~+/-" + "Q".repeat(20);
    expect(redactSecrets(`authorization: bearer ${token}`).text).toEqual(
      "authorization: bearer [REDACTED:bearer_token]"
    );
  });

  it.each([
    "authToken",
    "clientSecret",
    "apiKey",
    "accessToken",
    "privateKey",
    "refreshToken",
  ])("redacts the value of camelCase key %s", (key) => {
    const result = redactSecrets(`${key}: "${"v1".repeat(8)}" end`);
    expect(result.text).toEqual(`${key}: "[REDACTED:assignment]" end`);
  });

  it("strips zero-width characters that would split a secret", () => {
    const split = fake.github.slice(0, 10) + "\u200B" + fake.github.slice(10);
    expect(redactSecrets(split).text).toEqual("[REDACTED:vcs_token]");
  });

  it("redacts only the password of a URL", () => {
    const result = redactSecrets(
      "Connect to postgres://admin:" +
        "hunter2pass" +
        "@db.example.com:5432/app"
    );
    expect(result.text).toEqual(
      "Connect to postgres://admin:[REDACTED:url_password]@db.example.com:5432/app"
    );
    expect(result.counts).toEqual({ url_password: 1 });
  });

  it.each([
    ["password: ", "s3cretValue!", ""],
    ["DB_PASSWORD=", "s3cretValue!", ""],
    ['"api_key": "', "abcd1234efgh", '"'],
    ["access_token = '", "abcd1234efgh", "'"],
    ["private_key: ", "abcd1234efgh", ""],
    ["SECRET=", "abcd1234efgh", ""],
    ["SECRET_KEY_BASE=", "abcd1234efgh", ""],
    ["api_key_id: ", "abcd1234efgh", ""],
    ["passphrase: ", "abcd1234efgh", ""],
    ["credentials=", "abcd1234efgh", ""],
    ["Token: '", "allletterswords", "'"],
    ['password = "', "correct horse battery", '"'],
  ])("redacts only the value of %s", (key, value, close) => {
    const result = redactSecrets(`${key}${value}${close} end`);
    expect(result.text).toEqual(`${key}[REDACTED:assignment]${close} end`);
    expect(result.counts).toEqual({ assignment: 1 });
  });

  it.each([
    "Reset your password in settings.",
    "The token is explained below.",
    "password: hunter1",
    "secret = short",
    "See https://example.com:8080/path?x=1 for details.",
    "Email me at someone@example.com or visit https://user@example.com.",
    "Use the sk-learn library and AKIA prefixes in docs.",
    "Token: authentication is handled by the gateway.",
    "The secret: understanding customers",
    "tokenizer=whitespace_split_rules",
    "Secretary: Margaret Hamilton",
    "Bearer responsibilities include reporting.",
    "",
  ])("leaves %j unchanged", (text) => {
    expect(redactSecrets(text)).toEqual({ text, counts: {} });
  });

  it("counts several matches and classes", () => {
    const result = redactSecrets(
      `${fake.github} and ${fake.gitlab}, token: ${fake.anthropic}, password=abcdefgh1`
    );
    expect(result.counts).toEqual({
      vcs_token: 2,
      provider_key: 1,
      assignment: 1,
    });
    expect(result.text).toEqual(
      "[REDACTED:vcs_token] and [REDACTED:vcs_token], token: [REDACTED:provider_key], password=[REDACTED:assignment]"
    );
  });

  it("is idempotent", () => {
    const input = [
      fake.privateKey,
      `token: ${fake.jwt}`,
      "https://bob:" + "pa55word" + "@example.com",
      "password=abcdefgh1",
      fake.aws,
    ].join("\n");
    const once = redactSecrets(input);
    const twice = redactSecrets(once.text);
    expect(twice.text).toEqual(once.text);
    expect(twice.counts).toEqual({});
  });

  it("finishes quickly on adversarial input", () => {
    const inputs = [
      "a.".repeat(50_000),
      "-----BEGIN PRIVATE KEY-----".repeat(5_000),
      "password=".repeat(20_000),
      "x://" + "u:".repeat(50_000),
      "eyJ" + "a".repeat(50_000) + "." + "b".repeat(50_000),
      "sk-" + "-".repeat(100_000),
      "token" + " ".repeat(100_000) + ":",
      "Bearer " + "a".repeat(100_000),
      "Bearer ".repeat(20_000),
      "token: " + "a".repeat(100_000),
      "password_" + "-".repeat(100_000) + "=",
      "secret=".repeat(20_000) + "x",
    ];
    const started = Date.now();
    for (const input of inputs) {
      redactSecrets(input);
    }
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
