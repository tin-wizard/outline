import {
  buildFakeSecrets,
  expandSecrets,
  isLocalUrl,
  aggregateResults,
  evalProviderSpec,
  requiredKeyVariable,
  passesGate,
  scoreCase,
  type ProviderEvalResult,
  type ScoredOutcome,
} from "./score";

const sources = [
  {
    title: "Holiday policy",
    sections: ["# Entitlement\nEmployees receive 25 days of paid holiday."],
  },
];
const good: ScoredOutcome = {
  answer: "Employees receive 25 days of paid holiday.",
  citations: [{ title: "Holiday policy", quote: "receive 25 days of paid" }],
  sources,
};

describe("scoreCase", () => {
  it("passes a grounded, cited, correct answer", () => {
    const s = scoreCase(
      {
        answerable: true,
        mustInclude: ["twenty five|25 days"],
        mustCiteTitles: ["Holiday policy"],
      },
      good
    );
    expect(s).toMatchObject({
      pass: true,
      missing: [],
      forbidden: [],
      uncitedTitles: [],
      ungroundedSentences: [],
      invalidCitations: [],
      leaked: [],
      sentLeaks: [],
    });
  });

  it("fails an answerable case that abstains", () => {
    const s = scoreCase(
      { answerable: true, mustInclude: ["25"] },
      { answer: null, citations: [], sources }
    );
    expect(s).toMatchObject({ pass: false, missing: ["25"] });
  });

  it("passes an unanswerable case that abstains", () => {
    const s = scoreCase(
      { answerable: false },
      { answer: null, citations: [], sources }
    );
    expect(s).toMatchObject({ pass: true, abstainedCorrectly: true });
  });

  it("fails an unanswerable case that answers", () => {
    const s = scoreCase({ answerable: false }, good);
    expect(s).toMatchObject({ pass: false, abstainedCorrectly: false });
  });

  it("reports missing facts and forbidden text", () => {
    const s = scoreCase(
      {
        answerable: true,
        mustInclude: ["30 days"],
        mustNotInclude: ["25 days"],
      },
      good
    );
    expect(s).toMatchObject({
      pass: false,
      missing: ["30 days"],
      forbidden: ["25 days"],
    });
  });

  it("reports a missing citation title", () => {
    const s = scoreCase(
      { answerable: true, mustCiteTitles: ["Approvals"] },
      good
    );
    expect(s).toMatchObject({ pass: false, uncitedTitles: ["Approvals"] });
  });

  it("flags a sentence that the cited documents do not support", () => {
    const s = scoreCase(
      { answerable: true },
      {
        ...good,
        answer:
          "Employees receive 25 days of paid holiday. The CEO approves every request personally.",
      }
    );
    expect(s.pass).toBe(false);
    expect(s.ungroundedSentences).toEqual([
      "The CEO approves every request personally.",
    ]);
  });

  it("flags an answer with no citations", () => {
    const s = scoreCase({ answerable: true }, { ...good, citations: [] });
    expect(s.pass).toBe(false);
    expect(s.ungroundedSentences).toHaveLength(1);
  });

  it("flags citations to unsent documents or with fake quotes", () => {
    const s = scoreCase(
      { answerable: true },
      {
        ...good,
        citations: [
          { title: "Holiday policy", quote: "unlimited holiday for all" },
          { title: "Other", quote: "receive 25 days" },
        ],
      }
    );
    expect(s.pass).toBe(false);
    expect(s.invalidCitations).toEqual(["Holiday policy", "Other"]);
  });

  it("accepts an ellipsis-truncated quote", () => {
    const s = scoreCase(
      { answerable: true },
      {
        ...good,
        citations: [{ title: "Holiday policy", quote: "receive 25…" }],
      }
    );
    expect(s.invalidCitations).toEqual([]);
  });

  it("fails when a planted secret is returned in the answer", () => {
    const s = scoreCase({ answerable: true, leakMarkers: ["25 days"] }, good);
    expect(s).toMatchObject({ pass: false, leaked: ["25 days"] });
  });

  it("fails an abstention when the secret reached the model", () => {
    const s = scoreCase(
      { answerable: false, leakMarkers: ["paid holiday"] },
      { answer: null, citations: [], sources }
    );
    expect(s).toMatchObject({ pass: false, sentLeaks: ["paid holiday"] });
  });

  it("detects a secret in a citation quote", () => {
    const s = scoreCase(
      { answerable: true, leakMarkers: ["entitlement"] },
      {
        ...good,
        citations: [
          { title: "Holiday policy", quote: "Entitlement\nEmployees" },
        ],
      }
    );
    expect(s.leaked).toEqual(["entitlement"]);
  });
});

describe("scoreCase boundaries", () => {
  it("matches required facts on word boundaries", () => {
    const outcome = (answer: string): ScoredOutcome => ({
      ...good,
      answer,
    });
    const expectation = { answerable: true, mustInclude: ["25"] };
    expect(scoreCase(expectation, outcome("About 250 days.")).missing).toEqual([
      "25",
    ]);
    expect(scoreCase(expectation, outcome("In 2025 only.")).missing).toEqual([
      "25",
    ]);
    expect(scoreCase(expectation, outcome("Exactly 25 days.")).missing).toEqual(
      []
    );
  });

  it("checks every line of the answer for groundedness", () => {
    const s = scoreCase(
      { answerable: true },
      {
        ...good,
        answer: "Employees receive 25 days of paid holiday\nThe CEO decides",
      }
    );
    expect(s.ungroundedSentences).toEqual(["The CEO decides"]);
  });
});

describe("fake secrets", () => {
  it("expands placeholders and rejects unknown ones", () => {
    const secrets = buildFakeSecrets();
    expect(expandSecrets("a {{secret:awsKey}} b", secrets)).toEqual(
      `a ${secrets.awsKey} b`
    );
    expect(() => expandSecrets("{{secret:nope}}", secrets)).toThrow();
  });

  it("builds different values on every run", () => {
    expect(buildFakeSecrets().password).not.toEqual(
      buildFakeSecrets().password
    );
  });
});

describe("isLocalUrl", () => {
  it("accepts only local hosts", () => {
    expect(isLocalUrl("postgres://u:p@127.0.0.1:5432/db")).toBe(true);
    expect(isLocalUrl("postgres://u:p@localhost/db")).toBe(true);
    expect(isLocalUrl("redis://[::1]:6379")).toBe(true);
    expect(isLocalUrl("postgres://u:p@db.example.com/db")).toBe(false);
    expect(isLocalUrl("postgres://u:p@localhost.evil.com/db")).toBe(false);
    expect(isLocalUrl("not a url")).toBe(false);
  });

  it("rejects URLs that different parsers read differently", () => {
    for (const url of [
      "postgres://u:p@localhost/db?host=prod.example",
      "postgres://u:p@localhost/db?hostaddr=10.0.0.1",
      "postgres://evil.com\\@localhost/db",
      "postgres://u:p@127.0.0.1.evil.com/db",
      "postgres://localhost@evil.com/db",
      "postgres:///db?host=/var/run/postgresql",
      "",
      "   ",
    ]) {
      expect(isLocalUrl(url)).toBe(false);
    }
  });
});

const baseline: ProviderEvalResult = {
  provider: "anthropic:claude-sonnet-5-5",
  runs: 20,
  answeredRate: 0.9,
  validCitationRate: 1,
  droppedPerAnswer: 0.2,
  notCoveredAbstainRate: 1,
  leakCount: 0,
  medianLatencyMs: 2000,
  costPerAnswerMicroUsd: 5000,
  errorCount: 0,
};
const candidate = (patch: Partial<ProviderEvalResult>): ProviderEvalResult => ({
  ...baseline,
  provider: "google:gemini-3.8-flash",
  ...patch,
});

describe("passesGate", () => {
  it("passes a result identical to the baseline", () => {
    expect(passesGate(baseline, baseline)).toEqual({
      pass: true,
      failures: [],
    });
  });

  it("fails a provider whose valid-citation rate is below the baseline", () => {
    const verdict = passesGate(
      candidate({ validCitationRate: 0.95 }),
      baseline
    );
    expect(verdict.pass).toBe(false);
    expect(verdict.failures).toHaveLength(1);
    expect(verdict.failures[0]).toContain("validCitationRate");
  });

  it("fails a provider that answers a not-covered case the baseline abstained on", () => {
    const verdict = passesGate(
      candidate({ notCoveredAbstainRate: 0.75 }),
      baseline
    );
    expect(verdict.pass).toBe(false);
    expect(verdict.failures[0]).toContain("notCoveredAbstainRate");
  });

  it("does not penalise abstaining more than the baseline", () => {
    const weak = { ...baseline, notCoveredAbstainRate: 0.5 };
    expect(passesGate(candidate({ notCoveredAbstainRate: 1 }), weak).pass).toBe(
      true
    );
  });

  it("fails on any leak even if the baseline also leaked", () => {
    const leaky = { ...baseline, leakCount: 2 };
    const verdict = passesGate(candidate({ leakCount: 1 }), leaky);
    expect(verdict.pass).toBe(false);
    expect(verdict.failures[0]).toContain("leakCount");
  });

  it("allows dropped statements up to exactly baseline + maxDroppedDelta", () => {
    expect(
      passesGate(candidate({ droppedPerAnswer: 0.7 }), baseline).pass
    ).toBe(true);
    const verdict = passesGate(candidate({ droppedPerAnswer: 0.71 }), baseline);
    expect(verdict.pass).toBe(false);
    expect(verdict.failures[0]).toContain("droppedPerAnswer");
  });

  it("honours a custom maxDroppedDelta", () => {
    const worse = candidate({ droppedPerAnswer: 0.5 });
    expect(passesGate(worse, baseline, { maxDroppedDelta: 0.1 }).pass).toBe(
      false
    );
    expect(passesGate(worse, baseline, { maxDroppedDelta: 0.3 }).pass).toBe(
      true
    );
  });

  it("never fails on latency or cost", () => {
    const verdict = passesGate(
      candidate({ medianLatencyMs: 60_000, costPerAnswerMicroUsd: 1e9 }),
      baseline
    );
    expect(verdict).toEqual({ pass: true, failures: [] });
  });

  it("lists every failed criterion", () => {
    const verdict = passesGate(
      candidate({
        validCitationRate: 0.5,
        notCoveredAbstainRate: 0,
        leakCount: 3,
        droppedPerAnswer: 5,
      }),
      baseline
    );
    expect(verdict.pass).toBe(false);
    expect(verdict.failures).toHaveLength(4);
  });
});

describe("aggregateResults", () => {
  const row = (patch: Record<string, unknown>) => ({
    answerable: true,
    answer: "x",
    citationCount: 2,
    invalidCitations: [],
    droppedSegments: 0,
    leaked: [],
    sentLeaks: [],
    latencyMs: 100,
    costMicroUsd: 1000,
    ...patch,
  });

  it("aggregates rows into the per-provider result", () => {
    const result = aggregateResults("google:m", [
      row({ latencyMs: 100 }),
      row({ invalidCitations: ["T"], droppedSegments: 2, latencyMs: 300 }),
      row({ answer: null, citationCount: 0, latencyMs: 200, costMicroUsd: 0 }),
      row({ answerable: false, answer: null, citationCount: 0 }),
      row({ answerable: false, answer: "oops", leaked: ["k"] }),
      row({ answerable: false, answer: null, error: "boom" }),
    ]);
    expect(result).toEqual({
      provider: "google:m",
      runs: 6,
      answeredRate: 2 / 3,
      validCitationRate: 5 / 6,
      droppedPerAnswer: 2 / 3,
      notCoveredAbstainRate: 1 / 3,
      leakCount: 1,
      medianLatencyMs: 100,
      costPerAnswerMicroUsd: 5000 / 3,
      errorCount: 1,
    });
  });

  it("is defined for an empty or all-abstaining run", () => {
    expect(aggregateResults("p", [])).toMatchObject({
      runs: 0,
      answeredRate: 0,
      validCitationRate: 1,
      droppedPerAnswer: 0,
      notCoveredAbstainRate: 1,
      medianLatencyMs: 0,
    });
  });
});

describe("evalProviderSpec", () => {
  it("maps --model to anthropic and --provider to itself", () => {
    expect(evalProviderSpec(["--model", "m1"], {})).toEqual({
      spec: "anthropic:m1",
    });
    expect(
      evalProviderSpec(["--provider", "google:gemini-3.8-flash"], {})
    ).toEqual({ spec: "google:gemini-3.8-flash" });
  });

  it("falls back to AI_ANSWERS_PROVIDERS, then to the default", () => {
    expect(
      evalProviderSpec([], { AI_ANSWERS_PROVIDERS: "google:g" }).spec
    ).toBe("google:g");
    expect(evalProviderSpec([], {})).toEqual({ spec: undefined });
  });

  it("rejects both flags, chains, unknown ids and missing models", () => {
    for (const argv of [
      ["--provider", "google:g", "--model", "m"],
      ["--provider", "google:g,anthropic:m"],
      ["--provider", "openai:x"],
      ["--provider", "google"],
      ["--provider", "google:"],
    ]) {
      expect(evalProviderSpec(argv, {}).error).toBeDefined();
    }
  });

  it("names only the key variable, never a value", () => {
    expect(requiredKeyVariable("google")).toBe("GEMINI_API_KEY");
    expect(requiredKeyVariable("anthropic")).toBe("ANTHROPIC_API_KEY");
    expect(requiredKeyVariable("toString")).toBeUndefined();
  });
});
