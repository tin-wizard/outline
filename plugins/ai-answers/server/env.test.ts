import { validate } from "class-validator";
import env from "./env";

describe("AI answers environment", () => {
  const original = {
    deadline: env.AI_ANSWERS_DEADLINE_MS,
    budget: env.AI_ANSWERS_MONTHLY_BUDGET_USD,
    model: env.AI_ANSWERS_MODEL,
  };
  afterEach(() => {
    env.AI_ANSWERS_DEADLINE_MS = original.deadline;
    env.AI_ANSWERS_MONTHLY_BUDGET_USD = original.budget;
    env.AI_ANSWERS_MODEL = original.model;
  });

  it("defaults to Sonnet 5.5", () => {
    expect(original.model).toEqual("claude-sonnet-5-5");
  });

  // A validation error makes the base Environment exit the process, so a
  // typo in these settings must never produce one.
  it.each([60_000, -5, NaN])(
    "does not fail validation for a deadline of %s",
    async (value) => {
      env.AI_ANSWERS_DEADLINE_MS = value;
      expect(await validate(env)).toEqual([]);
    }
  );

  it("does not fail validation for odd budget or model values", async () => {
    env.AI_ANSWERS_MONTHLY_BUDGET_USD = "not-a-number";
    env.AI_ANSWERS_MODEL = "";
    expect(await validate(env)).toEqual([]);
  });
});
