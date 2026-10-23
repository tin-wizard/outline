import { act } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "styled-components";
import theme from "@shared/styles/theme";
import { OfflineError, RateLimitExceededError } from "~/utils/errors";
import LoadingError from "./Error";

beforeAll(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

function setup(error: Error) {
  const retry = vi.fn();
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() =>
    root.render(
      <ThemeProvider theme={theme}>
        <LoadingError error={error} retry={retry} />
      </ThemeProvider>
    )
  );
  return { host, retry, unmount: () => act(() => root.unmount()) };
}

describe("List LoadingError", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("keeps the offline copy", () => {
    const { host, unmount } = setup(new OfflineError("x"));
    expect(host.textContent).toContain("offline");
    unmount();
  });

  it("describes a rate limit instead of the generic line", () => {
    const { host, unmount } = setup(
      new RateLimitExceededError("x", { status: 429, retryAfter: 5 })
    );
    expect(host.textContent).toContain("Too many requests.");
    expect(host.textContent).toContain("Try again in 5 seconds.");
    expect(host.textContent).not.toContain("Sorry, an error occurred.");
    unmount();
  });

  it("never shows the message of an unknown error, and can retry", () => {
    const { host, retry, unmount } = setup(new Error("secret"));
    expect(host.textContent).toContain("Something went wrong.");
    expect(host.textContent).not.toContain("secret");
    const button = host.querySelector("button");
    expect(button?.textContent).toContain("Click to retry");
    act(() => button?.click());
    expect(retry).toHaveBeenCalledTimes(1);
    unmount();
  });
});
