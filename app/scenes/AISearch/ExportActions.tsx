import { CopyIcon, DownloadIcon, PrintIcon } from "outline-icons";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import styled from "styled-components";
import { breakpoints } from "@shared/styles";
import Button from "~/components/Button";
import CopyToClipboard from "~/components/CopyToClipboard";
import useMediaQuery from "~/hooks/useMediaQuery";
import { download } from "~/utils/download";
import { conversationToMarkdown, exportFilename } from "./exportMarkdown";
import type { Turn } from "./model";

const COMPACT_QUERY = `(max-width: ${breakpoints.desktop - 1}px)`;

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
  // Below desktop width the labels wrap the header onto several rows: icons.
  const compact = useMediaQuery(COMPACT_QUERY);
  const label = (text: string) =>
    compact ? { "aria-label": text } : { children: text };
  const disabled = streaming || !turns.some((turn) => turn.blocks.length > 0);
  const markdown = () =>
    conversationToMarkdown(turns, { title: title || t("AI Search") });

  const handleCopied = () => toast.success(t("Copied"));

  const handleDownload = () =>
    download(
      markdown(),
      exportFilename(turns[0]?.question ?? "", new Date()),
      "text/markdown;charset=utf-8"
    );

  const handlePrint = () => window.print();

  return (
    <Group role="group" aria-label={t("Export conversation")} data-print-hidden>
      <CopyToClipboard text={disabled ? "" : markdown()} onCopy={handleCopied}>
        <Button
          type="button"
          neutral
          disabled={disabled}
          icon={compact ? <CopyIcon /> : undefined}
          {...label(t("Copy conversation as Markdown"))}
        />
      </CopyToClipboard>
      <Button
        type="button"
        neutral
        disabled={disabled}
        onClick={handleDownload}
        icon={compact ? <DownloadIcon /> : undefined}
        {...label(t("Download as Markdown (.md)"))}
      />
      <Button
        type="button"
        neutral
        disabled={disabled}
        onClick={handlePrint}
        icon={compact ? <PrintIcon /> : undefined}
        {...label(t("Print / Save as PDF"))}
      />
    </Group>
  );
}

const Group = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 8px;

  @media ${COMPACT_QUERY} {
    flex-shrink: 0;
    flex-wrap: nowrap;
    gap: 4px;
  }
`;
