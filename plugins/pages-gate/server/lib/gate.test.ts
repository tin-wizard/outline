import crypto from "node:crypto";
import { JSDOM } from "jsdom";
import {
  ALPHABET,
  createGate,
  generateAccessCode,
  normalizeCode,
  parseGatePage,
  renderGatePage,
  verifyCode,
} from "./gate";
import { GATE_TEMPLATE } from "./gateTemplate";

// Real 600,000-iteration derivations; under a parallel run one can pass 5 s.
vi.setConfig({ testTimeout: 60_000 });

const CODE = "abcd-efgh-jkmn-pqrs";
const FIXED_SALT = new Uint8Array(16).map((_, i) => i + 1);
const SECRET =
  "<html><body><h1 id='secret'>Quarterly plan 7f3a</h1></body></html>";

/** Decrypts iv || ciphertext || tag with a key derived independently of the library. */
function referenceDecrypt(code: string, salt: Uint8Array, blob: Uint8Array) {
  const key = crypto.pbkdf2Sync(
    code.toLowerCase().replace(/\s+/g, ""),
    salt,
    600000,
    32,
    "sha256"
  );
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(blob.length - 16);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(blob.subarray(12, blob.length - 16)),
    decipher.final(),
  ]).toString("utf8");
}

/** A byte source that replays the given bytes in a loop. */
function cyclingSource(bytes: number[]) {
  let i = 0;
  return (n: number) => {
    const out = new Uint8Array(n);
    for (let j = 0; j < n; j++) {
      out[j] = bytes[i % bytes.length];
      i++;
    }
    return out;
  };
}

describe("generateAccessCode", () => {
  it("returns 16 alphabet characters grouped 4-4-4-4", () => {
    const code = generateAccessCode();
    expect(code).toMatch(/^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
    for (const ch of code.replace(/-/g, "")) {
      expect(ALPHABET).toContain(ch);
    }
  });

  it("uses a 31-character alphabet without look-alike characters", () => {
    expect(ALPHABET).toBe("abcdefghjkmnpqrstuvwxyz23456789");
    expect(ALPHABET).toHaveLength(31);
    for (const ch of ["0", "1", "i", "l", "o"]) {
      expect(ALPHABET).not.toContain(ch);
    }
  });

  it("skips bytes >= 248 and maps byte b to ALPHABET[b % 31]", () => {
    // One code per starting byte, so every byte value 0..255 is drawn first once.
    for (let start = 0; start < 256; start++) {
      const stream = Array.from({ length: 256 }, (_, i) => (start + i) % 256);
      const expected = stream
        .filter((b) => b < 248)
        .slice(0, 16)
        .map((b) => ALPHABET[b % 31])
        .join("");
      expect(generateAccessCode(cyclingSource(stream)).replace(/-/g, "")).toBe(
        expected
      );
    }
  });

  it("throws on a source that never yields an acceptable byte", () => {
    expect(() => generateAccessCode(cyclingSource([248, 255]))).toThrow();
  });

  it("produces 2000 distinct codes", () => {
    const codes = new Set(
      Array.from({ length: 2000 }, () => generateAccessCode())
    );
    expect(codes.size).toBe(2000);
  });
});

describe("normalizeCode", () => {
  it("lowercases and strips whitespace but keeps hyphens", () => {
    expect(normalizeCode("  ABCD-efgh \t-JKMN-\npqrs ")).toBe(
      "abcd-efgh-jkmn-pqrs"
    );
  });
});

describe("gate encryption", () => {
  it("encrypts so the reference key derivation decrypts it", async () => {
    const gate = await createGate(CODE, { salt: FIXED_SALT });
    expect(Array.from(gate.salt)).toEqual(Array.from(FIXED_SALT));
    const blob = gate.encryptPage(SECRET);
    expect(referenceDecrypt(CODE, FIXED_SALT, blob)).toBe(SECRET);
  });

  it("keeps the template's key derivation parameters", () => {
    expect(GATE_TEMPLATE).toContain("600000");
    expect(GATE_TEMPLATE).toContain("AES-GCM");
    expect(GATE_TEMPLATE).toContain('replace(/\\s+/g,"")');
    expect(GATE_TEMPLATE).toContain("noindex,nofollow");
  });

  it("uses a random 16-byte salt by default", async () => {
    const a = await createGate(CODE);
    expect(a.salt).toHaveLength(16);
  });

  it("refuses a code that is empty after normalisation", async () => {
    await expect(createGate(" \n ")).rejects.toThrow("Access code is empty");
  });

  describe("verifyCode and tampering", () => {
    let page: string;
    let blob: Uint8Array;
    let salt: Uint8Array;

    beforeAll(async () => {
      const gate = await createGate(CODE);
      salt = gate.salt;
      blob = gate.encryptPage(SECRET);
      page = renderGatePage({ title: "Plan", storageKey: "k", salt, blob });
    });

    it("accepts the right code typed with other case and spaces", async () => {
      expect(await verifyCode(CODE, page)).toBe(true);
      expect(await verifyCode("  ABCD-EFGH-\tJKMN-pqrs\n", page)).toBe(true);
    });

    it("rejects a wrong code", async () => {
      expect(await verifyCode("abcd-efgh-jkmn-pqrt", page)).toBe(false);
    });

    it("rejects a blob with any one bit flipped", async () => {
      for (const index of [0, 11, 12, blob.length - 17, blob.length - 1]) {
        const flipped = Uint8Array.from(blob);
        flipped[index] ^= 1;
        const tampered = renderGatePage({
          title: "Plan",
          storageKey: "k",
          salt,
          blob: flipped,
        });
        expect(await verifyCode(CODE, tampered)).toBe(false);
      }
    });

    it("rejects a truncated blob", async () => {
      for (const length of [blob.length - 1, 28, 12, 0]) {
        const tampered = renderGatePage({
          title: "Plan",
          storageKey: "k",
          salt,
          blob: blob.subarray(0, length),
        });
        expect(await verifyCode(CODE, tampered)).toBe(false);
      }
    });

    it("never throws on bad input", async () => {
      expect(await verifyCode(CODE, "<html>")).toBe(false);
      expect(await verifyCode("", page)).toBe(false);
    });

    it("does not leak the plaintext into the rendered page", () => {
      expect(page).not.toContain("Quarterly");
      expect(page).not.toContain("7f3a");
      expect(page).not.toContain(Buffer.from(SECRET).toString("base64"));
    });
  });

  it("uses a fresh IV for every page", async () => {
    const gate = await createGate(CODE, { salt: FIXED_SALT });
    const a = gate.encryptPage(SECRET);
    const b = gate.encryptPage(SECRET);
    expect(
      Buffer.from(a.subarray(0, 12)).equals(Buffer.from(b.subarray(0, 12)))
    ).toBe(false);
    expect(
      Buffer.from(a.subarray(12)).equals(Buffer.from(b.subarray(12)))
    ).toBe(false);
  });
});

describe("renderGatePage", () => {
  const salt = new Uint8Array(16).fill(7);
  const blob = new Uint8Array(40).fill(9);

  it("escapes the title and replaces every placeholder exactly once per site", () => {
    const title = `<script>"a" & b</title> $& $' $\` $$ __SALT__ __DATA__`;
    const html = renderGatePage({
      title,
      storageKey: "site:acme_1-x",
      salt,
      blob,
    });
    const escaped =
      "&lt;script&gt;&quot;a&quot; &amp; b&lt;/title&gt; $&amp; $&#39; $` $$ __SALT__ __DATA__";
    expect(html).toContain(`<title>${escaped}</title>`);
    expect(html).toContain(`<h1>${escaped}</h1>`);
    expect(html.split(escaped)).toHaveLength(3);
    expect(html).not.toContain('<script>"a"');
    expect(html).not.toContain("__TITLE__");
    expect(html).not.toContain("__STORAGE_KEY__");
    expect(html).toContain('KEY="site:acme_1-x"');
    expect(html).toContain(`SALT="${Buffer.from(salt).toString("base64")}"`);
    expect(html).toContain(`DATA="${Buffer.from(blob).toString("base64")}"`);
  });

  it.each(['a"b', "a<b", "Acme", "a".repeat(65), "", "a b"])(
    "rejects storage key %j",
    (storageKey) => {
      expect(() =>
        renderGatePage({ title: "t", storageKey, salt, blob })
      ).toThrow();
    }
  );

  it("round-trips salt and blob through parseGatePage", () => {
    const parsed = parseGatePage(
      renderGatePage({ title: "t", storageKey: "a".repeat(64), salt, blob })
    );
    expect(parsed).not.toBeNull();
    expect(Array.from(parsed?.salt ?? [])).toEqual(Array.from(salt));
    expect(Array.from(parsed?.blob ?? [])).toEqual(Array.from(blob));
  });

  it("returns null for a page it cannot parse", () => {
    expect(parseGatePage("<html>")).toBeNull();
    expect(parseGatePage('var SALT="!!!",DATA="AAAA"')).toBeNull();
  });
});

describe("the template's own client script", () => {
  let page: string;

  beforeAll(async () => {
    const gate = await createGate(CODE);
    page = renderGatePage({
      title: "Plan",
      storageKey: "pages:test",
      salt: gate.salt,
      blob: gate.encryptPage(SECRET),
    });
  });

  /** Loads the page in jsdom with Node's WebCrypto, submits a code, waits for an outcome. */
  async function submit(typed: string) {
    const dom = new JSDOM(page, {
      runScripts: "dangerously",
      url: "https://pages.example.test/acme/",
      beforeParse(window) {
        Object.defineProperty(window, "crypto", { value: globalThis.crypto });
        Object.defineProperty(window, "TextEncoder", { value: TextEncoder });
        Object.defineProperty(window, "TextDecoder", { value: TextDecoder });
      },
    });
    const { document } = dom.window;
    const input = document.getElementById("c") as HTMLInputElement;
    input.value = typed;
    document
      .getElementById("f")
      ?.dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (
        document.getElementById("secret") ||
        document.getElementById("msg")?.textContent
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return dom;
  }

  it("replaces the document with the decrypted page for the right code", async () => {
    const dom = await submit("  ABCD-efgh-JKMN-pqrs ");
    const { document } = dom.window;
    expect(document.getElementById("secret")?.textContent).toBe(
      "Quarterly plan 7f3a"
    );
    expect(document.getElementById("f")).toBeNull();
    expect(dom.window.localStorage.getItem("pages:test")).toContain('"k"');
    dom.window.close();
  }, 20000);

  it("keeps the form and shows the error for a wrong code", async () => {
    const dom = await submit("abcd-efgh-jkmn-pqrt");
    const { document } = dom.window;
    expect(document.getElementById("secret")).toBeNull();
    expect(document.getElementById("f")).not.toBeNull();
    expect(document.getElementById("msg")?.textContent).toBe(
      "That code did not work."
    );
    expect(dom.window.localStorage.getItem("pages:test")).toBeNull();
    dom.window.close();
  }, 20000);
});
