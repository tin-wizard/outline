import { runBeacon } from "../test/beaconHarness";
import { buildBeaconScript, injectBeacon, makeBeaconDecorator } from "./beacon";

const ENDPOINT = "https://app.example.com/api/pages.ingest";
const INGEST_KEY = "AbCdEfGhIjKlMnOpQrStUv";
const PAGE_KEY = "docs/handbook-1.html";
const CONTRACT_KEYS = ["a", "k", "p", "s", "st", "t"];

const script = (
  overrides: Partial<Parameters<typeof buildBeaconScript>[0]> = {}
) =>
  buildBeaconScript({
    endpoint: ENDPOINT,
    ingestKey: INGEST_KEY,
    pageKey: PAGE_KEY,
    ...overrides,
  });

/** The script text between the opening tag and the final closing tag. */
const inner = (element: string) => {
  const open = "<script data-pages-beacon>";
  expect(element.startsWith(open)).toBe(true);
  expect(element.endsWith("</script>")).toBe(true);
  return element.slice(open.length, -"</script>".length);
};

describe("buildBeaconScript", () => {
  it.each([
    ["javascript:", "javascript:alert(1)"],
    ["relative", "/api/pages.ingest"],
    ["empty", ""],
    ["data:", "data:text/plain,x"],
    ["ftp:", "ftp://app.example.com/api/pages.ingest"],
  ])("refuses a %s endpoint", (_name, endpoint) => {
    expect(() => script({ endpoint })).toThrow();
  });

  it.each([
    ["short", "abc"],
    ["quote", `${INGEST_KEY}"`],
    ["markup", `${INGEST_KEY}</script>`],
    ["empty", ""],
  ])("refuses a %s ingest key", (_name, ingestKey) => {
    expect(() => script({ ingestKey })).toThrow();
  });

  it.each([
    ["markup", "a</script><img>.html"],
    ["traversal", "../index.html"],
    ["quote", 'a".html'],
    ["empty", ""],
  ])("refuses a %s page key", (_name, pageKey) => {
    expect(() => script({ pageKey })).toThrow();
  });

  it.each([
    "https://app.example.com/a</script><img src=x onerror=alert(1)>",
    'https://app.example.com/"+alert(1)+"',
    "https://app.example.com/\u2028\u2029x",
    "https://app.example.com/<!--<script>",
    "https://app.example.com/?q=</SCRIPT >",
  ])(
    "never emits a forbidden sequence for %j and round-trips it",
    (endpoint) => {
      const element = script({ endpoint });
      const body = inner(element);
      expect(body.toLowerCase()).not.toContain("</script");
      expect(body).not.toContain("<!--");
      expect(body).not.toContain("<");
      expect(body).not.toContain("\u2028");
      expect(body).not.toContain("\u2029");

      const run = runBeacon(element);
      expect(run.requests.map((r) => r.url)).toEqual([endpoint]);
      expect(run.bodies()[0]).toMatchObject({ k: INGEST_KEY, p: PAGE_KEY });
      expect(run.errors).toEqual([]);
      run.close();
    }
  );

  it("stays under 2.5 KiB with no external source", () => {
    const element = script();
    expect(Buffer.byteLength(element)).toBeLessThan(2560);
    expect(element).not.toMatch(/\bsrc=|import|localStorage|cookie|sendBeacon/);
  });
});

describe("injectBeacon", () => {
  const tag = script();

  it("inserts before the last </body>, case-insensitively", () => {
    const html = "<html><body><p>&lt;/body&gt;</p></BODY >\n</BODY></html>";
    const out = injectBeacon(html, tag);
    const at = html.lastIndexOf("</BODY>");
    expect(out).toEqual(html.slice(0, at) + tag + html.slice(at));
  });

  it("appends when there is no </body>", () => {
    expect(injectBeacon("<p>x</p>", tag)).toEqual(`<p>x</p>${tag}`);
  });

  it("is idempotent and changes no other byte", () => {
    const html = "<!DOCTYPE html><html><body>héllo\u2028</body></html>";
    const once = injectBeacon(html, tag);
    expect(injectBeacon(once, tag)).toEqual(once);
    expect(once.replace(tag, "")).toEqual(html);
  });
});

describe("makeBeaconDecorator", () => {
  it("adds one beacon carrying the page key", () => {
    const decorate = makeBeaconDecorator({
      endpoint: ENDPOINT,
      ingestKey: INGEST_KEY,
    });
    const out = decorate("<html><body>x</body></html>", {
      pageKey: "index.html",
    });
    expect(out.match(/data-pages-beacon/g)).toHaveLength(1);
    expect(out).toContain('"index.html"');
    expect(decorate(out, { pageKey: "index.html" })).toEqual(out);
  });
});

describe("beacon behaviour", () => {
  it("sends a view at load with a: 0 and only contract keys", () => {
    const run = runBeacon(script(), { now: 1_760_000_123_456 });
    const [view] = run.bodies();
    expect(view).toEqual({
      k: INGEST_KEY,
      p: PAGE_KEY,
      s: expect.stringMatching(/^[a-z0-9]{20}$/),
      st: 1_760_000_123,
      t: "view",
      a: 0,
    });
    expect(run.requests).toHaveLength(1);
    run.close();
  });

  it("makes every request to the endpoint only, with credentials omitted", () => {
    const run = runBeacon(script());
    run.interact();
    run.advance(15_000);
    run.setVisibility("hidden");
    expect(run.requests).toHaveLength(3);
    for (const { url, init } of run.requests) {
      expect(url).toEqual(ENDPOINT);
      expect(init).toEqual({
        method: "POST",
        mode: "no-cors",
        credentials: "omit",
        keepalive: true,
        headers: { "Content-Type": "text/plain" },
        body: expect.any(String),
      });
    }
    for (const body of run.bodies()) {
      expect(Object.keys(body).sort()).toEqual(CONTRACT_KEYS);
    }
    expect(run.sendBeacon).not.toHaveBeenCalled();
    expect(run.window.document.cookie).toEqual("");
    expect(run.touched).toEqual([]);
    expect(run.errors).toEqual([]);
    run.close();
  });

  it("beats every 15 s of visible time with the cumulative active seconds", () => {
    const run = runBeacon(script());
    run.advance(10_000);
    run.interact();
    run.advance(5_000);
    expect(run.bodies().map((b) => [b.t, b.a])).toEqual([
      ["view", 0],
      ["beat", 15],
    ]);
    run.interact();
    run.advance(15_000);
    expect(run.bodies()[2]).toMatchObject({ t: "beat", a: 30 });
    const starts = new Set(run.bodies().map((b) => b.st));
    const sessions = new Set(run.bodies().map((b) => b.s));
    expect(starts.size).toBe(1);
    expect(sessions.size).toBe(1);
    run.close();
  });

  it("neither beats nor counts while hidden", () => {
    const run = runBeacon(script());
    run.advance(5_000);
    run.setVisibility("hidden");
    run.interact();
    run.advance(60_000);
    expect(run.bodies().map((b) => b.t)).toEqual(["view", "end"]);
    expect(run.bodies()[1].a).toBe(5);
    run.setVisibility("visible");
    run.interact();
    run.advance(10_000);
    // 5 + 10 visible seconds since load: the first beat, a = 15.
    expect(run.bodies()[2]).toMatchObject({ t: "beat", a: 15 });
    run.close();
  });

  it("does not count a page hidden at load until it is shown", () => {
    const run = runBeacon(script(), { visibility: "hidden" });
    run.advance(60_000);
    expect(run.bodies().map((b) => b.t)).toEqual(["view"]);
    run.setVisibility("visible");
    run.interact();
    run.advance(15_000);
    expect(run.bodies()[1]).toMatchObject({ t: "beat", a: 15 });
    run.close();
  });

  it("stops counting after 30 s idle and resumes on interaction", () => {
    const run = runBeacon(script());
    run.advance(60_000);
    // Flat after 30 s idle: the beats at 45 and 60 s are not sent.
    expect(run.bodies().map((b) => b.a)).toEqual([0, 15, 30]);
    run.interact("scroll");
    run.advance(15_000);
    expect(run.bodies().at(-1)).toMatchObject({ t: "beat", a: 45 });
    run.close();
  });

  it("sends nothing from an idle visible tab once its time stops changing", () => {
    const run = runBeacon(script());
    run.advance(10 * 60_000);
    expect(run.bodies().map((b) => [b.t, b.a])).toEqual([
      ["view", 0],
      ["beat", 15],
      ["beat", 30],
    ]);
    // The end is still sent, even with nothing new to report.
    run.setVisibility("hidden");
    expect(run.bodies().at(-1)).toMatchObject({ t: "end", a: 30 });
    run.close();
  });

  it.each(["scroll", "click", "keydown", "touchstart", "mousemove"])(
    "counts %s as an interaction",
    (type) => {
      const run = runBeacon(script());
      run.advance(40_000);
      run.interact(type);
      run.advance(5_000);
      run.setVisibility("hidden");
      expect(run.bodies().at(-1)).toMatchObject({ t: "end", a: 35 });
      run.close();
    }
  );

  it("sends exactly one end per hidden transition", () => {
    const run = runBeacon(script());
    run.setVisibility("hidden");
    run.pagehide();
    run.setVisibility("hidden");
    expect(run.bodies().filter((b) => b.t === "end")).toHaveLength(1);
    run.setVisibility("visible");
    run.pagehide();
    run.setVisibility("hidden");
    expect(run.bodies().filter((b) => b.t === "end")).toHaveLength(2);
    run.close();
  });

  it("resumes the same view after a back-forward cache restore", () => {
    const run = runBeacon(script());
    run.interact();
    run.advance(5_000);
    run.pagehide(true);
    run.setVisibility("hidden");
    run.setVisibility("visible");
    run.pageshow(true);
    run.advance(10_000);
    run.pagehide();
    const bodies = run.bodies();
    expect(bodies.map((b) => [b.t, b.a])).toEqual([
      ["view", 0],
      ["end", 5],
      ["beat", 15],
      ["end", 15],
    ]);
    expect(new Set(bodies.map((b) => b.st)).size).toBe(1);
    run.close();
  });

  it("keeps the session id stable across pages of one tab session", () => {
    const storage = new Map<string, string>();
    const first = runBeacon(script(), { storage });
    const second = runBeacon(script({ pageKey: "index.html" }), { storage });
    const s1 = first.bodies()[0].s;
    expect(s1).toMatch(/^[a-z0-9]{20}$/);
    expect(second.bodies()[0].s).toEqual(s1);
    expect([...storage.keys()]).toHaveLength(1);
    const third = runBeacon(script());
    expect(third.bodies()[0].s).not.toEqual(s1);
    for (const run of [first, second, third]) {
      run.close();
    }
  });

  it("namespaces the session id by ingest key", () => {
    const storage = new Map<string, string>();
    const first = runBeacon(script(), { storage });
    const other = runBeacon(script({ ingestKey: "ZyXwVuTsRqPoNmLkJiHgFe" }), {
      storage,
    });
    expect([...storage.keys()].sort()).toEqual([
      "pages-beacon-sid:AbCdEfGh",
      "pages-beacon-sid:ZyXwVuTs",
    ]);
    expect(other.bodies()[0].s).not.toEqual(first.bodies()[0].s);
    first.close();
    other.close();
  });

  it("works when sessionStorage throws and crypto is missing", () => {
    const run = runBeacon(script(), { storage: "throws", crypto: false });
    expect(run.bodies()[0].s).toMatch(/^[a-z0-9]{20}$/);
    run.advance(15_000);
    expect(run.bodies()).toHaveLength(2);
    expect(run.errors).toEqual([]);
    run.close();
  });

  it.each(["throws", "rejects", "missing"] as const)(
    "swallows a fetch that %s",
    async (mode) => {
      const run = runBeacon(script(), { fetch: mode });
      run.advance(15_000);
      run.setVisibility("hidden");
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(run.errors).toEqual([]);
      expect(run.sendBeacon).not.toHaveBeenCalled();
      expect(run.requests).toHaveLength(mode === "missing" ? 0 : 3);
      run.close();
    }
  );

  it.each([
    [
      "a full external URL",
      "https://News.YCombinator.com:8443/item?id=1#x",
      "news.ycombinator.com",
    ],
    ["an http URL", "http://blog.example.org/post", "blog.example.org"],
    [
      "the same host",
      "https://pages.example.com/sites/acme/other.html",
      undefined,
    ],
    ["no referrer", undefined, undefined],
    ["a non-http URL", "ftp://files.example.org/x", undefined],
    ["an IP address", "http://203.0.113.9/x", undefined],
    ["localhost", "http://localhost:3000/x", undefined],
    ["a .test host", "https://kb.dev.test/x", undefined],
    ["a .local host", "https://printer.local/x", undefined],
    ["a .internal host", "https://wiki.corp.internal/x", undefined],
    ["an .example host", "https://www.foo.example/x", undefined],
    ["a non-alphabetic last label", "https://shop.xn--p1ai/x", undefined],
    ["a label with a leading hyphen", "https://-bad.example.org/x", undefined],
  ])("reduces %s to its public host", (_name, referrer, expected) => {
    const run = runBeacon(script(), { referrer });
    const [view] = run.bodies();
    if (expected === undefined) {
      expect(view).not.toHaveProperty("r");
    } else {
      expect(view.r).toEqual(expected);
    }
    run.close();
  });

  it("sends r on the view only and keeps every body under 1 KiB", () => {
    const longKey = `${"a".repeat(500)}.html`;
    const longHost = `${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(63)}.${"e".repeat(57)}.org`;
    const run = runBeacon(
      script({ pageKey: longKey, ingestKey: "x".repeat(64) }),
      { referrer: `https://${longHost}/` }
    );
    run.interact();
    run.advance(15_000);
    run.pagehide();
    const bodies = run.bodies();
    expect(bodies[0].r).toEqual(longHost);
    expect(bodies.slice(1).every((b) => !("r" in b))).toBe(true);
    for (const raw of run.rawBodies()) {
      expect(Buffer.byteLength(raw)).toBeLessThan(1024);
    }
    run.close();
  });
});
