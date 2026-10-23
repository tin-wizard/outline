import { act } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "styled-components";
import theme from "@shared/styles/theme";
import { OfflineError, RateLimitExceededError } from "~/utils/errors";
import { SearchError } from "./SearchError";

vi.mock("~/components/Button", () => ({
  default: ({
    children,
    onClick,
  }: {
    children?: React.ReactNode;
    onClick?: () => void;
  }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
}));

beforeAll(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

function setup(error: unknown) {
  const onRetry = vi.fn();
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() =>
    root.render(
      <ThemeProvider theme={theme}>
        <SearchError error={error} onRetry={onRetry} />
      </ThemeProvider>
    )
  );
  return { host, onRetry, unmount: () => act(() => root.unmount()) };
}

describe("SearchError", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("says the user is offline", () => {
    const { host, unmount } = setup(new OfflineError("x"));
    expect(host.textContent).toContain("You're offline.");
    unmount();
  });

  it("shows the wait for a rate limit", () => {
    const { host, unmount } = setup(
      new RateLimitExceededError("x", { status: 429, retryAfter: 12 })
    );
    expect(host.textContent).toContain("Try again in 12 seconds.");
    unmount();
  });

  it("shows generic copy for other errors without leaking the message", () => {
    const { host, unmount } = setup(new Error("secret"));
    expect(host.textContent).toContain("Something went wrong.");
    expect(host.textContent).not.toContain("secret");
    unmount();
  });

  it("re-runs the search from the Try again button", () => {
    const { host, onRetry, unmount } = setup(new Error("x"));
    const button = host.querySelector("button");
    expect(button?.textContent).toContain("Try again");
    act(() => button?.click());
    expect(onRetry).toHaveBeenCalledTimes(1);
    unmount();
  });
});
