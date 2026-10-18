import * as Dialog from "@radix-ui/react-dialog";
import * as React from "react";
import { useTranslation } from "react-i18next";
import styled from "styled-components";
import { depths, s } from "@shared/styles";
import Button from "~/components/Button";
import type { ReportReason } from "./model";
import { MAX_REPORT_COMMENT, REPORT_REASONS } from "./model";

interface Props {
  /** Sends the report; resolves true when it was saved. */
  onSubmit: (reason: ReportReason, comment: string) => Promise<boolean>;
  /** Closes the dialog without sending. */
  onClose: () => void;
}

/**
 * A small dialog for reporting an answer: one reason from a fixed list and an
 * optional comment. Closes after a successful send; on failure it stays open
 * with a message so the text is not lost.
 *
 * @param props.onSubmit sends the report.
 * @param props.onClose closes the dialog.
 * @returns the dialog.
 */
export function ReportDialog({ onSubmit, onClose }: Props) {
  const { t } = useTranslation();
  const [reason, setReason] = React.useState<ReportReason>("inaccurate");
  const [comment, setComment] = React.useState("");
  const [sending, setSending] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const labels: Record<ReportReason, string> = {
    inaccurate: t("Something in it is wrong"),
    incomplete: t("It leaves out something important"),
    outdated: t("It uses out-of-date information"),
    off_topic: t("It doesn't answer my question"),
    other: t("Something else"),
  };

  const handleOpenChange = (open: boolean) => {
    if (!open && !sending) {
      onClose();
    }
  };
  const handleReason = (event: React.ChangeEvent<HTMLInputElement>) => {
    const next = REPORT_REASONS.find((r) => r === event.target.value);
    if (next) {
      setReason(next);
    }
  };
  const handleComment = (event: React.ChangeEvent<HTMLTextAreaElement>) =>
    setComment(event.target.value);
  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSending(true);
    setFailed(false);
    const saved = await onSubmit(reason, comment);
    setSending(false);
    if (!saved) {
      setFailed(true);
    }
  };

  return (
    <Dialog.Root open onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Overlay />
        <Content aria-describedby={undefined}>
          <form onSubmit={handleSubmit}>
            <Title>{t("Report this answer")}</Title>
            <Fieldset>
              <legend>{t("What's wrong with it?")}</legend>
              {REPORT_REASONS.map((value) => (
                <Radio key={value}>
                  <input
                    type="radio"
                    name="report-reason"
                    value={value}
                    checked={reason === value}
                    onChange={handleReason}
                  />
                  {labels[value]}
                </Radio>
              ))}
            </Fieldset>
            <Label>
              {t("Add a comment (optional)")}
              <textarea
                value={comment}
                maxLength={MAX_REPORT_COMMENT}
                rows={3}
                onChange={handleComment}
              />
            </Label>
            {failed && (
              <Error role="alert">
                {t("Couldn't send your report. Try again.")}
              </Error>
            )}
            <Buttons>
              <Button
                type="button"
                neutral
                onClick={onClose}
                disabled={sending}
              >
                {t("Cancel")}
              </Button>
              <Button type="submit" disabled={sending}>
                {t("Send report")}
              </Button>
            </Buttons>
          </form>
        </Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

const Overlay = styled(Dialog.Overlay)`
  position: fixed;
  inset: 0;
  z-index: ${depths.overlay};
  background: ${s("modalBackdrop")};
`;

const Content = styled(Dialog.Content)`
  position: fixed;
  z-index: ${depths.modal};
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: min(440px, calc(100vw - 32px));
  padding: 20px;
  border-radius: 12px;
  background: ${s("background")};
  box-shadow: ${s("menuShadow")};
  color: ${s("text")};
`;

const Title = styled(Dialog.Title)`
  margin: 0 0 12px;
  font-size: 17px;
  font-weight: 600;
`;

const Fieldset = styled.fieldset`
  margin: 0 0 12px;
  padding: 0;
  border: 0;

  legend {
    margin-bottom: 6px;
    color: ${s("textSecondary")};
    font-size: 13px;
  }
`;

const Radio = styled.label`
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
  font-size: 14px;
`;

const Label = styled.label`
  display: block;
  color: ${s("textSecondary")};
  font-size: 13px;

  textarea {
    display: block;
    width: 100%;
    margin-top: 6px;
    padding: 8px 10px;
    border: 1px solid ${s("inputBorder")};
    border-radius: 8px;
    background: ${s("background")};
    color: ${s("text")};
    font: inherit;
    font-size: 14px;
    resize: vertical;
  }
`;

const Error = styled.p`
  margin: 10px 0 0;
  color: ${s("danger")};
  font-size: 13px;
`;

const Buttons = styled.div`
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
`;
