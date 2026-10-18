import type * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { Composer } from "./Composer";

beforeAll(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

function setup(
  props: { value?: string; busy?: boolean; followUp?: boolean } = {}
) {
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
        followUp={props.followUp}
        chips={<button type="button">Chip</button>}
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
  });

  it("shows Stop instead of Send while busy, and Stop stops", () => {
    const { host, onStop, onSubmit } = setup({ busy: true });
    expect(host.querySelector('button[aria-label="Send"]')).toBeNull();
    const stop = host.querySelector<HTMLButtonElement>(
      'button[aria-label="Stop"]'
    );
    expect(stop?.type).toBe("button");
    act(() => stop?.click());
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("limits the question to 500 characters", () => {
    expect(setup().textarea.maxLength).toBe(500);
  });
});

describe("Composer card", () => {
  it("has a round Send button that is disabled for a blank question", () => {
    const filled = setup();
    const send = filled.host.querySelector<HTMLButtonElement>(
      'button[aria-label="Send"]'
    );
    expect(send?.type).toBe("submit");
    expect(send?.disabled).toBe(false);
    document.body.innerHTML = "";
    const blank = setup({ value: "  " });
    expect(
      blank.host.querySelector<HTMLButtonElement>('button[aria-label="Send"]')
        ?.disabled
    ).toBe(true);
  });

  it("submits the form on Send", () => {
    const { host, onSubmit } = setup();
    const form = host.querySelector("form");
    act(() => {
      form?.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true })
      );
    });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("describes the keys and keeps the chips in the bar", () => {
    const { host, textarea } = setup();
    const hint = host.querySelector(
      `#${textarea.getAttribute("aria-describedby")}`
    );
    expect(hint?.textContent).toBe(
      "Enter to send · Shift+Enter for a new line"
    );
    expect(host.textContent).toContain("Chip");
  });

  it("asks for a follow-up once there are answers", () => {
    expect(setup().textarea.placeholder).toBe(
      "Ask a question about your documents…"
    );
    document.body.innerHTML = "";
    expect(setup({ followUp: true }).textarea.placeholder).toBe(
      "Ask a follow-up about your documents…"
    );
  });

  it("shows the counter only near the limit", () => {
    expect(setup({ value: "a".repeat(449) }).host.textContent).not.toContain(
      "/500"
    );
    document.body.innerHTML = "";
    expect(setup({ value: "a".repeat(450) }).host.textContent).toContain(
      "450/500"
    );
  });
});
