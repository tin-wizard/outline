import { ArrowIcon } from "outline-icons";
import { VisuallyHidden } from "@radix-ui/react-visually-hidden";
import * as React from "react";
import { useTranslation } from "react-i18next";
import styled from "styled-components";
import { breakpoints, s } from "@shared/styles";

/** The server rejects longer questions. */
export const MAX_QUERY_LENGTH = 500;

/** The counter appears once the question is this close to the limit. */
export const COUNTER_FROM = 450;

const MAX_ROWS_PX = 200;

interface Props {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  /** Escape while streaming stops the answer. */
  onStop: () => void;
  /** True while an answer is streaming: input is locked but keeps focus. */
  busy: boolean;
  textareaRef: React.RefObject<HTMLTextAreaElement>;
  /** The scope chips, shown in the bar under the text. */
  chips?: React.ReactNode;
  /** The chat already has answers, so the box asks for a follow-up. */
  followUp?: boolean;
}

/**
 * The question box as a rounded card: the text on top, and a bar below with
 * the scope chips and a round send button. Enter sends, Shift+Enter adds a
 * line, 500 character limit. While streaming it is read-only (rather than
 * disabled) so focus stays in it, and the button becomes Stop.
 *
 * @param props see Props.
 * @returns the composer form.
 */
export function Composer({
  value,
  onChange,
  onSubmit,
  onStop,
  busy,
  textareaRef,
  chips,
  followUp,
}: Props) {
  const { t } = useTranslation();

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape" && busy) {
      // Handled: Escape here stops the answer and nothing else.
      event.preventDefault();
      onStop();
    } else if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      onSubmit();
    }
  };

  // Grow with the text, up to a few lines.
  React.useLayoutEffect(() => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, MAX_ROWS_PX)}px`;
    }
  }, [value, textareaRef]);

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    onSubmit();
  };

  const label = followUp
    ? t("Ask a follow-up about your documents")
    : t("Ask a question about your documents");

  return (
    <Form onSubmit={handleSubmit}>
      <Textarea
        ref={textareaRef}
        value={value}
        rows={1}
        maxLength={MAX_QUERY_LENGTH}
        readOnly={busy}
        aria-disabled={busy}
        aria-label={label}
        aria-keyshortcuts="Escape"
        aria-describedby="ai-composer-hint"
        placeholder={`${label}…`}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={handleKeyDown}
      />
      <Bar>
        {chips}
        {/* Read by screen readers only: the mockup's bar has no room for it next to four chips. */}
        <VisuallyHidden id="ai-composer-hint">
          {busy
            ? t("Press Escape to stop")
            : t("Enter to send · Shift+Enter for a new line")}
        </VisuallyHidden>
        {value.length >= COUNTER_FROM && (
          <Counter aria-hidden="true">
            {value.length}/{MAX_QUERY_LENGTH}
          </Counter>
        )}
        {busy ? (
          <Round type="button" aria-label={t("Stop")} onClick={onStop}>
            <StopSquare />
          </Round>
        ) : (
          <Round type="submit" aria-label={t("Send")} disabled={!value.trim()}>
            <Up size={20} />
          </Round>
        )}
      </Bar>
    </Form>
  );
}

const Form = styled.form`
  padding: 12px 10px 8px 16px;
  border: 1px solid ${s("inputBorder")};
  border-radius: 16px;
  background: ${s("background")};
  box-shadow:
    0 1px 2px rgb(0 0 0 / 4%),
    0 10px 30px rgb(0 0 0 / 6%);

  &:focus-within {
    border-color: ${s("inputBorderFocused")};
  }

  @media (max-width: ${breakpoints.tablet - 1}px) {
    border-radius: 20px;
    padding: 10px 8px 6px 14px;
  }
`;

const Textarea = styled.textarea`
  display: block;
  width: 100%;
  min-height: 26px;
  padding: 0;
  border: 0;
  outline: 0;
  background: transparent;
  color: ${s("text")};
  font: inherit;
  font-size: 16px;
  line-height: 1.5;
  resize: none;

  &::placeholder {
    color: ${s("placeholder")};
  }

  &[aria-disabled="true"] {
    opacity: 0.6;
  }
`;

const Bar = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 10px 0 0 -6px;
`;

const Counter = styled.span`
  flex: none;
  color: ${s("textTertiary")};
  font-size: 12px;
`;

const Round = styled.button`
  display: grid;
  flex: none;
  place-items: center;
  width: 32px;
  height: 32px;
  padding: 0;
  border: 0;
  border-radius: 16px;
  background: ${s("text")};
  color: ${s("background")};
  cursor: var(--pointer);

  svg {
    fill: currentColor;
  }

  &:disabled {
    background: ${s("textTertiary")};
    cursor: default;
    opacity: 0.5;
  }
`;

/** The send arrow points up. */
const Up = styled(ArrowIcon)`
  transform: rotate(-90deg);
`;

const StopSquare = styled.span`
  width: 12px;
  height: 12px;
  border-radius: 2px;
  background: currentColor;
`;
