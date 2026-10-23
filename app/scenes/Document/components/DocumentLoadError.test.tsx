import { act } from "react";
import { createRoot } from "react-dom/client";
import {
  AuthorizationError,
  NotFoundError,
  OfflineError,
  PaymentRequiredError,
  RequestError,
} from "~/utils/errors";
import { DocumentLoadError } from "./DocumentLoadError";

vi.mock("~/scenes/Errors/Error402", () => ({
  default: () => <div data-testid="402" />,
}));
vi.mock("~/scenes/Errors/Error403", () => ({
  default: () => <div data-testid="403" />,
}));
vi.mock("~/scenes/Errors/Error404", () => ({
  default: () => <div data-testid="404" />,
}));
vi.mock("~/scenes/Errors/ErrorOffline", () => ({
  default: () => <div data-testid="offline" />,
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
  act(() =>
    root.render(
      <DocumentLoadError error={error} documentSlug="a-b" onRetry={onRetry} />
    )
  );
  return { host, onRetry, unmount: () => act(() => root.unmount()) };
}

describe("DocumentLoadError", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it.each([
    ["offline", new OfflineError("x")],
    ["402", new PaymentRequiredError("x")],
    ["403", new AuthorizationError("x")],
    ["404", new NotFoundError("x")],
  ])("keeps the existing %s page", (id, error) => {
    const { host, unmount } = setup(error);
    expect(host.querySelector('[data-testid="' + id + '"]')).not.toBeNull();
    unmount();
  });

  it.each([
    ["a 500", new RequestError("x", { status: 500 })],
    ["a plain Error", new Error("x")],
  ])("renders ErrorUnknown with retry for %s", (_, error) => {
    const { host, onRetry, unmount } = setup(error);
    const button = host.querySelector('[data-testid="unknown"]');
    expect(button).not.toBeNull();
    act(() => (button as HTMLElement).click());
    expect(onRetry).toHaveBeenCalledTimes(1);
    unmount();
  });
});
