import type * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { Composer } from "./Composer";

// The real Button needs the action context provider.
vi.mock("~/components/Button", () => ({
  default: ({
    children,
    disabled,
    type,
  }: {
    children?: React.ReactNode;
    disabled?: boolean;
    type?: "submit" | "button";
  }) => (
    <button type={type} disabled={disabled}>
      {children}
    </button>
  ),
}));

beforeAll(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

function setup(props: { value?: string; busy?: boolean } = {}) {
  const onSubmit = vi.fn();
  const onStop = vi.fn();
  const onChange = vi.fn();
  const ref: React.RefObject<HTMLTextAreaElement> = { current: null };
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() =>
    root.render(
      <Composer
        value={props.value ?? "hello"}
        busy={props.busy ?? false}
        onChange={onChange}
        onSubmit={onSubmit}
        onStop={onStop}
        textareaRef={ref}
      />
    )
  );
  const textarea = host.querySelector("textarea");
  if (!textarea) {
    throw new Error("no textarea");
  }
  const key = (init: KeyboardEventInit) => {
    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      ...init,
    });
    act(() => {
      textarea.dispatchEvent(event);
    });
    return event;
  };
  return { host, textarea, key, onSubmit, onStop, root };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("Composer keyboard", () => {
  it("Enter submits and does not insert a newline", () => {
    const { key, onSubmit } = setup();
    const event = key({ key: "Enter" });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("Shift+Enter does not submit", () => {
    const { key, onSubmit } = setup();
    const event = key({ key: "Enter", shiftKey: true });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("Enter during IME composition does not submit", () => {
    const { key, onSubmit } = setup();
    key({ key: "Enter", isComposing: true });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("Escape stops only while busy", () => {
    const idle = setup();
    idle.key({ key: "Escape" });
    expect(idle.onStop).not.toHaveBeenCalled();
    document.body.innerHTML = "";
    const busy = setup({ busy: true });
    busy.key({ key: "Escape" });
    expect(busy.onStop).toHaveBeenCalledTimes(1);
  });

  it("is read-only, not disabled, while busy and announces the Escape shortcut", () => {
    const { textarea, host } = setup({ busy: true });
    expect(textarea.readOnly).toBe(true);
    expect(textarea.disabled).toBe(false);
    expect(textarea.getAttribute("aria-keyshortcuts")).toBe("Escape");
    const hint = host.querySelector(
      `#${textarea.getAttribute("aria-describedby")}`
    );
    expect(hint?.textContent).toContain("Escape");
    expect(host.querySelector("button")?.hasAttribute("aria-label")).toBe(
      false
    );
    expect(host.querySelector("button")?.disabled).toBe(true);
  });

  it("limits the question to 500 characters", () => {
    expect(setup().textarea.maxLength).toBe(500);
  });
});
