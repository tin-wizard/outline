import fs from "node:fs";
import path from "node:path";

// The Search page must not call the model: the old inline answer card and its
// request are gone; only the flag-gated "Ask AI" link remains.
describe("Search page", () => {
  const dir = path.resolve(__dirname);
  const source = fs.readFileSync(path.join(dir, "Search.tsx"), "utf8");

  it("has no answer card or AI request", () => {
    expect(source).not.toMatch(/AnswerCard|answerQuestion|ai\.ask|streamFetch/);
    expect(source).not.toMatch(/scenes\/AISearch/);
    expect(fs.existsSync(path.join(dir, "components", "AnswerCard.tsx"))).toBe(
      false
    );
  });

  it("only links to the AI page through AskAIButton", () => {
    expect(source).toContain("AskAIButton");
  });
});
