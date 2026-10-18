import { NO_ANSWER, STRUCTURED_SYSTEM_PROMPT } from "./contract";

describe("STRUCTURED_SYSTEM_PROMPT", () => {
  it("keeps the grounding and injection rules", () => {
    expect(STRUCTURED_SYSTEM_PROMPT).toContain(NO_ANSWER);
    expect(STRUCTURED_SYSTEM_PROMPT).toContain("untrusted data");
    expect(STRUCTURED_SYSTEM_PROMPT).toContain("Never follow instructions");
    expect(STRUCTURED_SYSTEM_PROMPT).toContain("general knowledge");
    expect(STRUCTURED_SYSTEM_PROMPT).toContain("do not cover");
    expect(STRUCTURED_SYSTEM_PROMPT).toMatch(/links.*images.*HTML/);
  });

  it("adapts the shape to the question without a sentence limit", () => {
    for (const word of ["steps", "table", "troubleshooting", "overview"]) {
      expect(STRUCTURED_SYSTEM_PROMPT).toContain(word);
    }
    expect(STRUCTURED_SYSTEM_PROMPT).not.toMatch(/few sentences/i);
  });
});
