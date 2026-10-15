import { webcrypto } from "node:crypto";
import { JSDOM, VirtualConsole } from "jsdom";

/** One request the beacon made through `fetch`. */
export interface BeaconRequest {
  url: unknown;
  init: Record<string, unknown>;
}

/** Options for one beacon run; each simulates a browser condition. */
export interface BeaconRunOptions {
  /** The page URL. */
  url?: string;
  /** `document.referrer`. */
  referrer?: string;
  /** The client clock at load, in ms. */
  now?: number;
  /** A sessionStorage backing map shared across runs, or "throws". */
  storage?: Map<string, string> | "throws";
  /** False makes `window.crypto` undefined. */
  crypto?: boolean;
  /** How `fetch` behaves. */
  fetch?: "ok" | "throws" | "rejects" | "missing";
  /** The visibility state at load. */
  visibility?: "visible" | "hidden";
}

/**
 * Runs a beacon `<script>` element in jsdom with a controllable clock,
 * visibility, storage, crypto and fetch. The script text itself is executed.
 *
 * @param script the element from buildBeaconScript.
 * @param options the simulated browser conditions.
 * @returns handles to drive the page and inspect what the script did.
 */
export function runBeacon(script: string, options: BeaconRunOptions = {}) {
  let now = options.now ?? 1_760_000_000_000;
  let visibility = options.visibility ?? "visible";
  const intervals: { fn: () => void; ms: number; next: number }[] = [];
  const requests: BeaconRequest[] = [];
  const errors: unknown[] = [];
  const touched: string[] = [];
  const sendBeacon = vi.fn(() => true);
  const storage = options.storage ?? new Map<string, string>();

  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (err) => errors.push(err));

  const dom = new JSDOM(
    `<!DOCTYPE html><html><head><title>Secret title</title></head><body><p>Secret body</p>${script}</body></html>`,
    {
      url: options.url ?? "https://pages.example.com/sites/acme/index.html",
      referrer: options.referrer,
      runScripts: "dangerously",
      pretendToBeVisual: true,
      virtualConsole,
      beforeParse(window) {
        window.Date.now = () => now;
        Object.defineProperty(window, "setInterval", {
          configurable: true,
          value: (fn: () => void, ms: number) => {
            intervals.push({ fn, ms, next: now + ms });
            return intervals.length;
          },
        });
        Object.defineProperty(window, "fetch", {
          configurable: true,
          value:
            options.fetch === "missing"
              ? undefined
              : (url: unknown, init: Record<string, unknown>) => {
                  requests.push({ url, init });
                  if (options.fetch === "throws") {
                    throw new TypeError("Failed to fetch");
                  }
                  return options.fetch === "rejects"
                    ? new window.Promise((_resolve, reject) =>
                        reject(new TypeError("Failed to fetch"))
                      )
                    : window.Promise.resolve({});
                },
        });
        Object.defineProperty(window.navigator, "sendBeacon", {
          configurable: true,
          value: sendBeacon,
        });
        Object.defineProperty(window, "crypto", {
          configurable: true,
          value:
            options.crypto === false
              ? undefined
              : {
                  getRandomValues: (array: Uint8Array) =>
                    webcrypto.getRandomValues(array),
                },
        });
        Object.defineProperty(window, "sessionStorage", {
          configurable: true,
          get() {
            if (storage === "throws") {
              throw new window.DOMException("denied", "SecurityError");
            }
            return {
              getItem: (key: string) => storage.get(key) ?? null,
              setItem: (key: string, value: string) => {
                storage.set(key, String(value));
              },
            };
          },
        });
        Object.defineProperty(window, "localStorage", {
          configurable: true,
          get() {
            touched.push("localStorage");
            return undefined;
          },
        });
        Object.defineProperty(window.document, "visibilityState", {
          configurable: true,
          get: () => visibility,
        });
        Object.defineProperty(window.document, "hidden", {
          configurable: true,
          get: () => visibility !== "visible",
        });
      },
    }
  );
  const { window } = dom;

  /** Moves the clock forward, firing intervals in order. */
  const advance = (ms: number) => {
    const target = now + ms;
    for (;;) {
      const due = intervals
        .filter((t) => t.next <= target)
        .sort((x, y) => x.next - y.next)[0];
      if (!due) {
        break;
      }
      now = due.next;
      due.next += due.ms;
      due.fn();
    }
    now = target;
  };

  const pageEvent = (type: "pagehide" | "pageshow", persisted: boolean) => {
    const event = new window.Event(type);
    Object.defineProperty(event, "persisted", { value: persisted });
    window.dispatchEvent(event);
  };

  return {
    dom,
    window,
    requests,
    errors,
    touched,
    sendBeacon,
    storage,
    /** The parsed JSON bodies sent, in order. */
    bodies: () =>
      requests.map(
        (r) => JSON.parse(String(r.init.body)) as Record<string, unknown>
      ),
    /** The raw string bodies sent, in order. */
    rawBodies: () => requests.map((r) => String(r.init.body)),
    advance,
    /** Dispatches a user interaction of the given type on the page body. */
    interact: (type = "mousemove") => {
      window.document.body.dispatchEvent(
        new window.Event(type, { bubbles: true })
      );
    },
    setVisibility: (state: "visible" | "hidden") => {
      visibility = state;
      window.document.dispatchEvent(new window.Event("visibilitychange"));
    },
    pagehide: (persisted = false) => pageEvent("pagehide", persisted),
    pageshow: (persisted = false) => pageEvent("pageshow", persisted),
    close: () => window.close(),
  };
}
