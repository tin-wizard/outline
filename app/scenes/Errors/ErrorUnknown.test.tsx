import { act } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "styled-components";
import theme from "@shared/styles/theme";
import ErrorUnknown from "./ErrorUnknown";

vi.mock("~/components/PageTitle", () => ({ default: () => null }));
vi.mock("~/components/CenteredContent", () => ({
  default: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));
vi.mock("~/actions/definitions/navigation", () => ({
  navigateToHome: {},
}));
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

function render(props: { onRetry?: () => void }) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() =>
    root.render(
      <ThemeProvider theme={theme}>
        <ErrorUnknown {...props} />
      </ThemeProvider>
    )
  );
  return { host, unmount: () => act(() => root.unmount()) };
}

describe("ErrorUnknown", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("has no Try again button without onRetry", () => {
    const { host, unmount } = render({});
    expect(host.textContent).not.toContain("Try again");
    unmount();
  });

  it("calls onRetry from the Try again button", () => {
    const onRetry = vi.fn();
    const { host, unmount } = render({ onRetry });
    const button = Array.from(host.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Try again")
    );
    expect(button).toBeDefined();
    act(() => button?.click());
    expect(onRetry).toHaveBeenCalledTimes(1);
    unmount();
  });
});
