import { act } from "react";
import { createRoot } from "react-dom/client";
import { client } from "~/utils/ApiClient";
import { PICKER_DEBOUNCE_MS, useDocumentPicker } from "./useDocumentPicker";

vi.mock("~/utils/ApiClient", () => ({ client: { post: vi.fn() } }));

const post = vi.mocked(client.post);
const ID1 = "0b8c7a4e-5b2f-4f5e-9d3a-1f2e3d4c5b6a";
const ID2 = "1c9d8b5f-6c3a-4a6f-8e4b-2a3f4e5d6c7b";

type Api = ReturnType<typeof useDocumentPicker>;

function mount(initial: { query: string; enabled?: boolean }) {
  const ref: { current: Api | null } = { current: null };
  function Harness({ query, enabled }: { query: string; enabled: boolean }) {
    ref.current = useDocumentPicker(query, enabled);
    return null;
  }
  const root = createRoot(document.createElement("div"));
  const render = (query: string, enabled = true) =>
    act(() => root.render(<Harness query={query} enabled={enabled} />));
  render(initial.query, initial.enabled ?? true);
  return {
    render,
    state: () => ref.current as Api,
    unmount: () => act(() => root.unmount()),
  };
}

beforeAll(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.useFakeTimers();
  post.mockReset();
});

afterEach(() => vi.useRealTimers());

describe("useDocumentPicker", () => {
  it("lists recent documents at once for an empty query", async () => {
    post.mockResolvedValue({
      data: [{ id: ID1, title: "A", collectionName: "Eng" }],
    });
    const picker = mount({ query: "" });
    expect(picker.state().loading).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(post).toHaveBeenCalledWith(
      "/ai.documents",
      { limit: 20 },
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(picker.state()).toMatchObject({
      loading: false,
      error: false,
      results: [{ id: ID1, title: "A", collectionName: "Eng" }],
    });
    picker.unmount();
  });

  it("debounces typing into one request", async () => {
    post.mockResolvedValue({ data: [] });
    const picker = mount({ query: "" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    post.mockClear();
    picker.render("t");
    picker.render("tr");
    picker.render("tra");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PICKER_DEBOUNCE_MS - 1);
    });
    expect(post).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][1]).toEqual({ query: "tra", limit: 20 });
    picker.unmount();
  });

  it("aborts the stale request and ignores its late answer", async () => {
    let resolveFirst: (v: unknown) => void = () => {};
    post.mockImplementationOnce(
      () => new Promise((resolve) => (resolveFirst = resolve))
    );
    const picker = mount({ query: "" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const firstSignal = post.mock.calls[0][2]?.signal;
    post.mockResolvedValueOnce({ data: [{ id: ID2, title: "New" }] });
    picker.render("new");
    expect(firstSignal?.aborted).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PICKER_DEBOUNCE_MS);
    });
    await act(async () => {
      resolveFirst({ data: [{ id: ID1, title: "Old" }] });
    });
    expect(picker.state().results.map((r) => r.title)).toEqual(["New"]);
    picker.unmount();
  });

  it("reports an error and clears results", async () => {
    post.mockRejectedValue(new Error("boom"));
    const picker = mount({ query: "x" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PICKER_DEBOUNCE_MS);
    });
    expect(picker.state()).toMatchObject({
      loading: false,
      error: true,
      results: [],
    });
    picker.unmount();
  });

  it("drops rows without a UUID and requests nothing while closed", async () => {
    post.mockResolvedValue({
      data: [
        { id: "nope", title: "Bad" },
        { id: ID1, title: "Good" },
      ],
    });
    const closed = mount({ query: "", enabled: false });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(post).not.toHaveBeenCalled();
    closed.render("", true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(closed.state().results.map((r) => r.title)).toEqual(["Good"]);
    closed.unmount();
  });
});
