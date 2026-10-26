import { act } from "react";
import { createRoot } from "react-dom/client";
import { client } from "~/utils/ApiClient";
import { useSaveAsDocument } from "./useSaveAsDocument";

interface Toast {
  action?: { label: string; onClick: () => void };
}

const { push, can, success, error } = vi.hoisted(() => ({
  push: vi.fn(),
  can: { createDocument: true },
  success: vi.fn((_message: string, _options?: Toast) => undefined),
  error: vi.fn((_message: string) => undefined),
}));

vi.mock("~/utils/ApiClient", () => ({ client: { post: vi.fn() } }));
vi.mock("sonner", () => ({
  toast: {
    success: (message: string, options?: Toast) => success(message, options),
    error: (message: string) => error(message),
  },
}));
vi.mock("react-router-dom", () => ({ useHistory: () => ({ push }) }));
vi.mock("~/hooks/useCurrentTeam", () => ({ default: () => ({}) }));
vi.mock("~/hooks/usePolicy", () => ({ default: () => can }));

const post = vi.mocked(client.post);
type Api = ReturnType<typeof useSaveAsDocument>;

function mount() {
  const ref: { current: Api | null } = { current: null };
  function Harness() {
    ref.current = useSaveAsDocument();
    return null;
  }
  const root = createRoot(document.createElement("div"));
  act(() => root.render(<Harness />));
  return () => ref.current as Api;
}

beforeAll(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.clearAllMocks();
  can.createDocument = true;
});

describe("useSaveAsDocument", () => {
  it("creates an unpublished draft in no collection and offers to open it", async () => {
    post.mockResolvedValue({ data: { id: "1", url: "/doc/draft-abc" } });
    const api = mount();
    await act(async () => api().save({ title: "T", text: "Body" }));
    expect(post).toHaveBeenCalledWith("/documents.create", {
      title: "T",
      text: "Body",
      publish: false,
    });
    const action = success.mock.calls[0][1]?.action;
    expect(action?.label).toBe("Open draft");
    action?.onClick();
    expect(push).toHaveBeenCalledWith("/doc/draft-abc");
  });

  it("falls back to Drafts for an unsafe url", async () => {
    post.mockResolvedValue({ data: { id: "1", url: "https://evil.example" } });
    const api = mount();
    await act(async () => api().save({ title: "T", text: "B" }));
    success.mock.calls[0][1]?.action?.onClick();
    expect(push).toHaveBeenCalledWith("/drafts");
  });

  it("reports an error without a success toast", async () => {
    post.mockRejectedValue(new Error("nope"));
    const api = mount();
    await act(async () => api().save({ title: "T", text: "B" }));
    expect(error).toHaveBeenCalledWith("Couldn't save the draft. Try again.");
    expect(success).not.toHaveBeenCalled();
  });

  it("is unavailable to users who cannot create documents", () => {
    can.createDocument = false;
    expect(mount()().canSave).toBe(false);
  });
});
