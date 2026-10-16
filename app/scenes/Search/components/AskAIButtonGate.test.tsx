import type * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AskAIButton } from "./AskAIButton";

// Exercise the real useAIAnswersEnabled with controlled team, user and env.
const state = {
  envEnabled: true,
  preference: true,
  isGuest: false,
  isViewer: false,
};

vi.mock("~/env", () => ({
  default: {
    get AI_ANSWERS_ENABLED() {
      return state.envEnabled;
    },
  },
}));
vi.mock("~/hooks/useCurrentTeam", () => ({
  default: () => ({ getPreference: () => state.preference }),
}));
vi.mock("~/hooks/useCurrentUser", () => ({
  default: () => ({ isGuest: state.isGuest, isViewer: state.isViewer }),
}));
vi.mock("~/components/FilterOptions", () => ({
  StyledButton: ({
    to,
    children,
  }: {
    to?: string;
    children?: React.ReactNode;
  }) => <a href={to}>{children}</a>,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (s: string) => s }),
}));

const render = () => renderToStaticMarkup(<AskAIButton query="x" />);

describe("AskAIButton visibility", () => {
  beforeEach(() => {
    Object.assign(state, {
      envEnabled: true,
      preference: true,
      isGuest: false,
      isViewer: false,
    });
  });

  it("is shown for members when enabled", () => {
    expect(render()).toContain("Ask AI");
  });

  it.each([
    ["guest", { isGuest: true }],
    ["viewer", { isViewer: true }],
    ["preference off", { preference: false }],
    ["server disabled", { envEnabled: false }],
  ])("is hidden for %s", (_name, patch) => {
    Object.assign(state, patch);
    expect(render()).toBe("");
  });
});
