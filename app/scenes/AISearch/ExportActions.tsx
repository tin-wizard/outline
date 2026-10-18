import * as React from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import styled from "styled-components";
import Button from "~/components/Button";
import CopyToClipboard from "~/components/CopyToClipboard";
import { downloadMarkdown } from "./download";
import { conversationToMarkdown, exportFilename } from "./exportMarkdown";
import type { Turn } from "./model";

interface Props {
  turns: Turn[];
  /** Disables every action while an answer is streaming. */
  streaming: boolean;
  /** Heading of the exported Markdown, e.g. the chat title. */
  title?: string;
}

/**
 * Header actions to copy, download or print the conversation. Disabled while
 * streaming or when no turn has an answer to export.
 *
 * @param props.turns the conversation turns.
 * @param props.streaming whether an answer is being written.
 * @param props.title heading of the exported Markdown; "AI Search" by default.
 * @returns the button group.
 */
export function ExportActions({ turns, streaming, title }: Props) {
  const { t } = useTranslation();
  const disabled = streaming || !turns.some((turn) => turn.blocks.length > 0);
  const markdown = () =>
    conversationToMarkdown(turns, { title: title || t("AI Search") });

  const handleCopied = () => toast.success(t("Copied"));

  const handleDownload = () =>
    downloadMarkdown(
      markdown(),
      exportFilename(turns[0]?.question ?? "", new Date())
    );

  const handlePrint = () => window.print();

  return (
    <Group role="group" aria-label={t("Export conversation")} data-print-hidden>
      <CopyToClipboard text={disabled ? "" : markdown()} onCopy={handleCopied}>
        <Button type="button" neutral disabled={disabled}>
          {t("Copy conversation as Markdown")}
        </Button>
      </CopyToClipboard>
      <Button
        type="button"
        neutral
        disabled={disabled}
        onClick={handleDownload}
      >
        {t("Download as Markdown (.md)")}
      </Button>
      <Button type="button" neutral disabled={disabled} onClick={handlePrint}>
        {t("Print / Save as PDF")}
      </Button>
    </Group>
  );
}

const Group = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
`;
