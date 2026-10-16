import * as React from "react";
import { useTranslation } from "react-i18next";
import styled from "styled-components";
import { s } from "@shared/styles";
import Button from "~/components/Button";

/** The server rejects longer questions. */
export const MAX_QUERY_LENGTH = 500;

interface Props {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  /** Escape while streaming stops the answer. */
  onStop: () => void;
  /** True while an answer is streaming: input is locked but keeps focus. */
  busy: boolean;
  textareaRef: React.RefObject<HTMLTextAreaElement>;
}

/**
 * The question box: Enter sends, Shift+Enter adds a line, 500 character
 * limit. While streaming it is read-only (rather than disabled) so focus stays
 * in it.
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
}: Props) {
  const { t } = useTranslation();

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape" && busy) {
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

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    onSubmit();
  };

  return (
    <Form onSubmit={handleSubmit}>
      <Field>
        <Textarea
          ref={textareaRef}
          value={value}
          rows={2}
          maxLength={MAX_QUERY_LENGTH}
          readOnly={busy}
          aria-disabled={busy}
          aria-label={t("Ask a question about your documents")}
          aria-keyshortcuts="Escape"
          aria-describedby={busy ? "ai-composer-hint" : undefined}
          placeholder={t("Ask a question about your documents")}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={handleKeyDown}
        />
        {busy && <Hint id="ai-composer-hint">{t("Press Escape to stop")}</Hint>}
        <Counter aria-hidden="true">
          {value.length}/{MAX_QUERY_LENGTH}
        </Counter>
      </Field>
      <Button type="submit" disabled={busy || !value.trim()}>
        {t("Send")}
      </Button>
    </Form>
  );
}

const Form = styled.form`
  position: sticky;
  bottom: 0;
  display: flex;
  align-items: flex-end;
  gap: 8px;
  padding: 12px 0;
  background: ${s("background")};
  z-index: 1;
`;

const Field = styled.div`
  position: relative;
  flex: 1;
  min-width: 0;
`;

const Textarea = styled.textarea`
  width: 100%;
  padding: 8px 12px 20px;
  border: 1px solid ${s("inputBorder")};
  border-radius: 8px;
  background: ${s("background")};
  color: ${s("text")};
  font: inherit;
  resize: none;

  &:focus {
    outline: none;
    border-color: ${s("inputBorderFocused")};
  }

  &[aria-disabled="true"] {
    opacity: 0.6;
  }
`;

const Hint = styled.span`
  position: absolute;
  left: 12px;
  bottom: 6px;
  color: ${s("textTertiary")};
  font-size: 11px;
`;

const Counter = styled.span`
  position: absolute;
  right: 10px;
  bottom: 6px;
  color: ${s("textTertiary")};
  font-size: 11px;
`;
