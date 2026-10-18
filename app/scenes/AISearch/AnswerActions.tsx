import {
  CopyIcon,
  NewDocumentIcon,
  ThumbsDownIcon,
  ThumbsUpIcon,
} from "outline-icons";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import styled from "styled-components";
import { s } from "@shared/styles";
import CopyToClipboard from "~/components/CopyToClipboard";
import Tooltip from "~/components/Tooltip";
import { ReportDialog } from "./ReportDialog";
import type { Rating, ReportReason, Turn } from "./model";
import { canRate } from "./model";

interface Props {
  turn: Turn;
  /** Saves the answer as a draft document; omitted when the user cannot create documents. */
  onSave?: (turn: Turn) => void;
  /** Markdown of the answer for the copy button. */
  markdown: string;
  onRate?: (turnId: number, rating: Rating) => void;
  /** Reports the answer; resolves true when it was saved. */
  onReport?: (
    turnId: number,
    reason: ReportReason,
    comment?: string
  ) => Promise<boolean>;
}

/**
 * The icon row under a finished answer: copy, save as draft, helpful, not
 * helpful and report,
 * with how long the answer took when the server said. Only actions that work
 * for this turn are shown.
 *
 * @param props see Props.
 * @returns the row.
 */
export function AnswerActions({
  turn,
  markdown,
  onSave,
  onRate,
  onReport,
}: Props) {
  const { t, i18n } = useTranslation();
  const [reporting, setReporting] = React.useState(false);
  const feedback = turn.feedback;
  const rateable = !!onRate && canRate(turn);
  const pending = !!feedback?.pending;
  const handleCopied = () => toast.success(t("Copied"));
  const handleSave = () => onSave?.(turn);
  const handleHelpful = () => onRate?.(turn.id, "up");
  const handleNotHelpful = () => onRate?.(turn.id, "down");
  const handleOpenReport = () => setReporting(true);
  const handleCloseReport = () => setReporting(false);
  const handleReport = async (reason: ReportReason, comment: string) => {
    const saved = (await onReport?.(turn.id, reason, comment)) ?? false;
    if (saved) {
      toast.success(t("Thanks, your report was sent"));
      setReporting(false);
    }
    return saved;
  };

  let message = "";
  if (feedback?.error === "rateLimited") {
    message = t("Too many requests, try again in a minute.");
  } else if (feedback?.error) {
    message = t("Couldn't save your feedback. Try again.");
  } else if (feedback?.saved && feedback.rating) {
    message = t("Thanks for the feedback");
  }
  const seconds =
    turn.timings === undefined
      ? undefined
      : new Intl.NumberFormat(i18n.language.replace("_", "-"), {
          minimumFractionDigits: 1,
          maximumFractionDigits: 1,
        }).format(turn.timings.totalMs / 1000);

  return (
    <Row data-print-hidden>
      <CopyToClipboard text={markdown} onCopy={handleCopied}>
        <IconButton type="button" aria-label={t("Copy answer")}>
          <CopyIcon size={20} />
        </IconButton>
      </CopyToClipboard>
      {onSave && (
        <Tooltip content={t("Save as draft document")}>
          <IconButton
            type="button"
            aria-label={t("Save as draft document")}
            onClick={handleSave}
          >
            <NewDocumentIcon size={20} />
          </IconButton>
        </Tooltip>
      )}
      {rateable && (
        <>
          <Separator aria-hidden />
          <Rate
            label={t("Helpful")}
            pressed={feedback?.rating === "up"}
            disabled={pending}
            onClick={handleHelpful}
          >
            <ThumbsUpIcon size={20} />
          </Rate>
          <Rate
            label={t("Not helpful")}
            pressed={feedback?.rating === "down"}
            disabled={pending}
            onClick={handleNotHelpful}
          >
            <ThumbsDownIcon size={20} />
          </Rate>
          {onReport && (
            <Tooltip content={t("Report inaccurate")}>
              <IconButton
                type="button"
                aria-label={t("Report inaccurate")}
                disabled={pending}
                onClick={handleOpenReport}
              >
                <FlagIcon />
              </IconButton>
            </Tooltip>
          )}
        </>
      )}
      {/* Always rendered so announcements are reliable; outside the answer region. */}
      <Status role="status">{message}</Status>
      {seconds !== undefined && (
        <Took>{t("Answered in {{ seconds }} s", { seconds })}</Took>
      )}
      {reporting && (
        <ReportDialog onSubmit={handleReport} onClose={handleCloseReport} />
      )}
    </Row>
  );
}

function Rate({
  label,
  pressed,
  disabled,
  onClick,
  children,
}: {
  label: string;
  pressed: boolean;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip content={label}>
      <IconButton
        type="button"
        aria-pressed={pressed}
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
      >
        {children}
      </IconButton>
    </Tooltip>
  );
}

function FlagIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden>
      <path d="M6 3h2v1h10l-2 4 2 4H8v9H6V3z" />
    </svg>
  );
}

const Row = styled.div`
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 2px;
  margin-top: 14px;
  color: ${s("textTertiary")};
`;

const IconButton = styled.button`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: none;
  color: ${s("textSecondary")};
  cursor: var(--pointer);

  &:hover:not(:disabled),
  &:focus-visible {
    background: ${s("backgroundSecondary")};
    color: ${s("text")};
  }

  &[aria-pressed="true"] {
    border-color: ${s("accent")};
    color: ${s("accent")};
  }

  &:disabled {
    opacity: 0.5;
    cursor: default;
  }

  svg {
    fill: currentColor;
  }
`;

const Separator = styled.span`
  width: 1px;
  height: 16px;
  margin: 0 6px;
  background: ${s("divider")};
`;

const Status = styled.span`
  margin-inline-start: 6px;
  font-size: 13px;
`;

const Took = styled.span`
  margin-inline-start: auto;
  font-size: 12px;
`;
