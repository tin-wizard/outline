import { vi } from "vitest";
import { askAIAboutDocument } from "./documents";
import env from "~/env";
import type { ActionContext } from "~/types";

vi.mock("~/stores", () => ({ default: {} }));

interface Overrides {
  preference?: boolean;
  isGuest?: boolean;
  isViewer?: boolean;
  active?: boolean;
  documentId?: string | undefined;
}

function context(o: Overrides = {}): ActionContext {
  const { preference = true, isGuest = false, isViewer = false } = o;
  const stores = {
    documents: { get: () => ({ isActive: o.active ?? true }) },
    auth: {
      user: { isGuest, isViewer },
      team: { getPreference: () => preference },
    },
  };
  return {
    stores,
    activeDocumentId: "documentId" in o ? o.documentId : "doc-1",
  } as unknown as ActionContext;
}

function visible(ctx: ActionContext) {
  const fn = askAIAboutDocument.visible;
  return typeof fn === "function" ? fn(ctx) : fn;
}

describe("askAIAboutDocument", () => {
  const original = env.AI_ANSWERS_ENABLED;
  beforeEach(() => {
    env.AI_ANSWERS_ENABLED = true;
  });
  afterAll(() => {
    env.AI_ANSWERS_ENABLED = original;
  });

  it("is visible for a member when enabled", () => {
    expect(visible(context())).toBe(true);
  });

  it.each([
    ["preference off", { preference: false }],
    ["guest", { isGuest: true }],
    ["viewer", { isViewer: true }],
    ["inactive document", { active: false }],
    ["no document", { documentId: undefined }],
  ])("is hidden for %s", (_name, patch) => {
    expect(visible(context(patch))).toBe(false);
  });

  it("is hidden when the server does not offer AI answers", () => {
    env.AI_ANSWERS_ENABLED = false;
    expect(visible(context())).toBe(false);
  });
});
