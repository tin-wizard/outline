import { act } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "styled-components";
import theme from "@shared/styles/theme";
import { client } from "~/utils/ApiClient";
import { NetworkError, RateLimitExceededError } from "~/utils/errors";
import AuthenticationProvider from "./AuthenticationProvider";

vi.mock("~/utils/urls", () => ({
  getRedirectUrl: (url: string) => url,
}));

vi.mock("~/components/ButtonLarge", () => ({
  default: ({
    children,
    type,
    disabled,
  }: {
    children?: React.ReactNode;
    type?: "submit" | "button";
    disabled?: boolean;
  }) => (
    <button type={type ?? "button"} disabled={disabled}>
      {children}
    </button>
  ),
}));

vi.mock("./PasskeyAuthenticationProvider", () => ({
  PasskeyAuthenticationProvider: () => null,
}));

beforeAll(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

function setup() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() =>
    root.render(
      <ThemeProvider theme={theme}>
        <AuthenticationProvider
          id="email"
          name="Email"
          authUrl="/auth/email"
          isCreate={false}
          preferOTP={false}
          onEmailSuccess={() => {}}
        />
      </ThemeProvider>
    )
  );

  const form = () => {
    const el = host.querySelector("form");
    if (!el) {
      throw new Error("no form");
    }
    return el;
  };
  const submit = async () => {
    await act(async () => {
      form().dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true })
      );
    });
  };
  const type = (value: string) => {
    const input = host.querySelector("input");
    if (!input) {
      throw new Error("no input");
    }
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set;
    act(() => {
      setter?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  return { host, submit, type, unmount: () => act(() => root.unmount()) };
}

describe("email sign-in failure", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.mocked(client.post).mockReset();
  });

  it("shows no notice before anything fails", async () => {
    const { host, submit, unmount } = setup();
    await submit();
    expect(host.textContent).not.toContain("Too many requests");
    expect(host.querySelector("input")).not.toBeNull();
    unmount();
  });

  it("shows the described title and hint when the submit is rejected", async () => {
    vi.mocked(client.post).mockRejectedValue(new NetworkError("boom"));
    const { host, submit, type, unmount } = setup();
    await submit();
    type("me@example.com");
    await submit();
    expect(host.textContent).toContain("You're offline.");
    expect(host.textContent).toContain("Check your connection and try again.");
    unmount();
  });

  it("shows the wait time for a rate limit", async () => {
    vi.mocked(client.post).mockRejectedValue(
      new RateLimitExceededError("x", { status: 429, retryAfter: 30 })
    );
    const { host, submit, type, unmount } = setup();
    await submit();
    type("me@example.com");
    await submit();
    expect(host.textContent).toContain("Too many requests.");
    expect(host.textContent).toContain("Try again in 30 seconds.");
    unmount();
  });

  it("never shows the raw message of an unknown failure", async () => {
    vi.mocked(client.post).mockRejectedValue(new Error("secret upstream text"));
    const { host, submit, type, unmount } = setup();
    await submit();
    type("me@example.com");
    await submit();
    expect(host.textContent).toContain("Something went wrong.");
    expect(host.textContent).not.toContain("secret upstream text");
    unmount();
  });

  it("clears the notice when the user edits the email", async () => {
    vi.mocked(client.post).mockRejectedValue(new NetworkError("boom"));
    const { host, submit, type, unmount } = setup();
    await submit();
    type("me@example.com");
    await submit();
    expect(host.textContent).toContain("You're offline.");
    type("me@example.co");
    expect(host.textContent).not.toContain("You're offline.");
    unmount();
  });

  it("clears the notice when the user retries", async () => {
    vi.mocked(client.post)
      .mockRejectedValueOnce(new NetworkError("boom"))
      .mockReturnValueOnce(new Promise(() => {}));
    const { host, submit, type, unmount } = setup();
    await submit();
    type("me@example.com");
    await submit();
    expect(host.textContent).toContain("You're offline.");
    await submit();
    expect(host.textContent).not.toContain("You're offline.");
    unmount();
  });
});
