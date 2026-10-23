import { act } from "react";
import { createRoot } from "react-dom/client";
import {
  AuthorizationError,
  BadGatewayError,
  NotFoundError,
  OfflineError,
  RequestError,
} from "~/utils/errors";
import { LoadError } from "./LoadError";

vi.mock("~/components/PageTitle", () => ({ default: () => null }));
vi.mock("~/components/CenteredContent", () => ({
  default: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));
vi.mock("~/actions/definitions/navigation", () => ({ navigateToHome: {} }));
vi.mock("~/components/Button", () => ({
  default: ({ children }: { children?: React.ReactNode }) => (
    <button type="button">{children}</button>
  ),
}));
vi.mock("~/scenes/Errors/Error404", () => ({
  default: () => <div data-testid="404">might have been deleted</div>,
}));
vi.mock("~/scenes/Errors/ErrorOffline", () => ({
  default: ({ onRetry }: { onRetry?: () => void }) => (
    <button data-testid="offline" onClick={onRetry}>
      Try again
    </button>
  ),
}));
vi.mock("~/scenes/Errors/ErrorUnknown", () => ({
  default: ({ onRetry }: { onRetry?: () => void }) => (
    <button data-testid="unknown" onClick={onRetry}>
      Try again
    </button>
  ),
}));

beforeAll(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

function setup(error: Error) {
  const onRetry = vi.fn();
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(<LoadError error={error} onRetry={onRetry} />));
  return { host, onRetry, unmount: () => act(() => root.unmount()) };
}

describe("collection LoadError", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders the 404 page only for NotFoundError", () => {
    const { host, unmount } = setup(new NotFoundError("gone"));
    expect(host.querySelector('[data-testid="404"]')).not.toBeNull();
    unmount();
  });

  it.each([
    ["a 500", new RequestError("x", { status: 500 })],
    ["a 502", new BadGatewayError("x", { status: 502 })],
    ["a plain Error", new Error("x")],
  ])("renders the unknown-error page with retry for %s", (_, error) => {
    const { host, onRetry, unmount } = setup(error);
    expect(host.textContent).not.toContain("might have been deleted");
    const button = host.querySelector('[data-testid="unknown"]');
    expect(button).not.toBeNull();
    act(() => (button as HTMLElement).click());
    expect(onRetry).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("renders the offline page with retry when offline", () => {
    const { host, onRetry, unmount } = setup(new OfflineError("x"));
    expect(host.textContent).not.toContain("might have been deleted");
    const button = host.querySelector('[data-testid="offline"]');
    act(() => (button as HTMLElement).click());
    expect(onRetry).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("explains a 403 with no retry", () => {
    const { host, unmount } = setup(
      new AuthorizationError("x", { status: 403 })
    );
    expect(host.textContent).toContain(
      "You don't have access to this collection."
    );
    expect(host.textContent).toContain(
      "Ask an admin or the collection's owner for access."
    );
    expect(host.textContent).not.toContain("Try again");
    expect(host.textContent).not.toContain("Something went wrong");
    expect(host.textContent).not.toContain("might have been deleted");
    unmount();
  });

  // A 401 means the session ended; it is not a permission problem.
  it("sends a 401 to the generic page with retry", () => {
    const { host, unmount } = setup(
      new AuthorizationError("x", { status: 401 })
    );
    expect(host.querySelector('[data-testid="unknown"]')).not.toBeNull();
    expect(host.textContent).not.toContain("don't have access");
    unmount();
  });
});
