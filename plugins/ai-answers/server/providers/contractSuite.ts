import { randomUUID } from "node:crypto";
import { Document } from "@server/models";
import { BlockSplitter } from "../blocks";
import type {
  FinishReason,
  ProviderStreamEvent,
  StreamRequest,
  StreamingProvider,
  Usage,
} from "../contract";
import type { AnswerSource } from "../retrieve";
import { AnswerVerifier } from "../verify";

/**
 * What a fake transport plays back to an adapter under test. Adapters encode
 * it in their vendor's wire format.
 */
export interface FakeScript {
  /**
   * Raw model output in `PROMPT_CITATION_FORMAT` (JSON Lines), split into
   * transport chunks at arbitrary points, possibly mid-line. Source ids are
   * 1-based. Native-citation adapters convert each line into their own
   * citation events.
   */
  chunks: string[];
  /** Thrown by the transport after the last chunk, when set. */
  error?: Error;
  /** Final usage the transport reports; omitted when it never reports usage. */
  usage?: Usage;
}

/**
 * Registers the tests every `StreamingProvider` must pass. Uses the Vitest
 * globals, so call it only from a `.test.ts` file; the module itself imports
 * nothing from Vitest and is inert in the production build.
 *
 * @param name the suite name, e.g. the adapter id.
 * @param make builds the adapter under test on a fake transport that plays
 * the script back and honours `request.signal` between chunks.
 * @param billingError the vendor's credit-exhausted error, as the adapter's
 * SDK or transport throws it.
 */
export function describeProviderContract(
  name: string,
  make: (script: FakeScript) => StreamingProvider,
  billingError: Error
): void {
  describe(`${name} provider contract`, () => {
    it("yields text events, then exactly one end event", async () => {
      const events = await collect(make(scriptOf([VALID, VALID])));
      expect(events.length).toBeGreaterThan(1);
      expect(events.filter((e) => e.type === "end")).toHaveLength(1);
      expect(events[events.length - 1].type).toBe("end");
      expect(events.slice(0, -1).every((e) => e.type === "text")).toBe(true);
    });

    it("reports usage only when the transport does", async () => {
      const usage = { inputTokens: 12, outputTokens: 7 };
      expect(endOf(await collect(make(scriptOf([VALID]))))?.usage).toBeNull();
      expect(
        endOf(await collect(make({ ...scriptOf([VALID]), usage })))?.usage
      ).toEqual(usage);
    });

    it("stops the stream when the signal aborts", async () => {
      const controller = new AbortController();
      const provider = make(scriptOf([VALID, VALID, VALID]));
      const after: ProviderStreamEvent[] = [];
      let aborted = false;
      try {
        for await (const event of provider.stream({
          ...request(),
          signal: controller.signal,
        })) {
          if (aborted) {
            after.push(event);
          }
          controller.abort();
          aborted = true;
        }
      } catch {
        // Rejecting on abort is allowed; yielding more events is not.
      }
      expect(aborted).toBe(true);
      expect(after.filter((e) => e.type === "text")).toEqual([]);
      expect(endOf(after)?.usage ?? null).toBeNull();
    });

    it("releases a correctly cited answer (control)", async () => {
      const outcome = await verified(make(scriptOf([VALID])));
      expect(outcome.released).toBeGreaterThan(0);
      expect(outcome.final.ok).toBe(true);
    });

    it.each([
      ["an invented quote", INVENTED_QUOTE],
      ["an out-of-range id", OUT_OF_RANGE_ID],
      ["a quote from another source", WRONG_SOURCE],
    ])("withholds an answer citing %s", async (_label, line) => {
      const outcome = await verified(make(scriptOf([line])));
      expect(outcome.released).toBe(0);
      expect(outcome.final.ok).toBe(false);
    });

    it("classifies the vendor's credit-exhausted error as billing", () => {
      expect(make(scriptOf([])).classify(billingError)).toBe("billing");
    });
  });
}

const CLAIM = "Employees receive 25 days of paid holiday per year.";

const VALID = promptedLine(
  CLAIM,
  1,
  "Employees receive 25 days of paid holiday"
);
const INVENTED_QUOTE = promptedLine(
  "Employees receive 40 days of paid holiday per year.",
  1,
  "Employees receive 40 days of paid holiday"
);
const OUT_OF_RANGE_ID = promptedLine(
  CLAIM,
  3,
  "Employees receive 25 days of paid holiday"
);
const WRONG_SOURCE = promptedLine(
  CLAIM,
  2,
  "Employees receive 25 days of paid holiday"
);

function promptedLine(text: string, id: number, quote: string): string {
  return JSON.stringify({ text, cites: [{ id, quote }] });
}

/** Lines split mid-way, so adapters must buffer partial lines. */
function scriptOf(lines: string[]): FakeScript {
  const raw = lines.map((line) => `${line}\n`).join("");
  const cut = Math.floor(raw.length / 2);
  return { chunks: raw ? [raw.slice(0, cut), raw.slice(cut)] : [] };
}

function sources(): AnswerSource[] {
  const source = (title: string, sections: string[]): AnswerSource => ({
    document: Document.build({ id: randomUUID(), title }),
    sections,
  });
  return [
    source("Leave Policy", [`# Leave\n${CLAIM}`]),
    source("Security", ["# Security\nSSO is supported on every plan."]),
  ];
}

function request(): StreamRequest {
  return { question: "How much holiday?", sources: sources(), history: [] };
}

async function collect(
  provider: StreamingProvider,
  req: StreamRequest = request()
): Promise<ProviderStreamEvent[]> {
  const events: ProviderStreamEvent[] = [];
  for await (const event of provider.stream(req)) {
    events.push(event);
  }
  return events;
}

function endOf(
  events: ProviderStreamEvent[]
): Extract<ProviderStreamEvent, { type: "end" }> | undefined {
  const last = events[events.length - 1];
  return last?.type === "end" ? last : undefined;
}

/** Runs the stream through the real splitter and verifier, as `ai.ask` does. */
async function verified(provider: StreamingProvider) {
  const req = request();
  const verifier = new AnswerVerifier(req.sources);
  const splitter = new BlockSplitter();
  let text = "";
  let finishReason: FinishReason = "other";
  for (const event of await collect(provider, req)) {
    if (event.type === "text") {
      text += event.text;
      splitter
        .push(event.text, event.citations)
        .forEach((b) => verifier.verify(b));
    } else {
      finishReason = event.finishReason;
    }
  }
  splitter.flush().forEach((b) => verifier.verify(b));
  return {
    released: verifier.released.length,
    final: verifier.finish(finishReason, text),
  };
}
