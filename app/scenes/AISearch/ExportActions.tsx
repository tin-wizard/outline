import { CopyIcon, DownloadIcon, PrintIcon } from "outline-icons";
import copy from "copy-to-clipboard";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { createAction } from "~/actions";
import Button from "~/components/Button";
import { DropdownMenu } from "~/components/Menu/DropdownMenu";
import Tooltip from "~/components/Tooltip";
import env from "~/env";
import { useMenuAction } from "~/hooks/useMenuAction";
import { download } from "~/utils/download";
import { conversationToMarkdown, exportFilename } from "./exportMarkdown";
import type { Turn } from "./model";

interface Props {
  turns: Turn[];
  /** Disables the menu while an answer is streaming. */
  streaming: boolean;
  /** Heading of the exported Markdown, e.g. the chat title. */
  title?: string;
}

const section = ({ t }: { t: (key: string) => string }) =>
  t("Export conversation");

/**
 * Header menu to copy, download or print the conversation: one icon button
 * instead of three labelled ones. Disabled while streaming or when no turn
 * has an answer to export.
 *
 * @param props.turns the conversation turns.
 * @param props.streaming whether an answer is being written.
 * @param props.title heading of the exported Markdown; "AI Search" by default.
 * @returns the menu button.
 */
export function ExportActions({ turns, streaming, title }: Props) {
  const { t } = useTranslation();
  const disabled = streaming || !turns.some((turn) => turn.blocks.length > 0);

  const handleCopy = React.useCallback(() => {
    copy(conversationToMarkdown(turns, { title: title || t("AI Search") }), {
      debug: env.ENVIRONMENT !== "production",
      format: "text/plain",
    });
    toast.success(t("Copied"));
  }, [turns, title, t]);

  const handleDownload = React.useCallback(
    () =>
      download(
        conversationToMarkdown(turns, { title: title || t("AI Search") }),
        exportFilename(turns[0]?.question ?? "", new Date()),
        "text/markdown;charset=utf-8"
      ),
    [turns, title, t]
  );

  const handlePrint = React.useCallback(() => window.print(), []);

  const actions = React.useMemo(
    () => [
      createAction({
        name: t("Copy conversation as Markdown"),
        analyticsName: "Copy AI conversation",
        section,
        icon: <CopyIcon />,
        perform: handleCopy,
      }),
      createAction({
        name: t("Download as Markdown (.md)"),
        analyticsName: "Download AI conversation",
        section,
        icon: <DownloadIcon />,
        perform: handleDownload,
      }),
      createAction({
        name: t("Print / Save as PDF"),
        analyticsName: "Print AI conversation",
        section,
        icon: <PrintIcon />,
        perform: handlePrint,
      }),
    ],
    [t, handleCopy, handleDownload, handlePrint]
  );
  const rootAction = useMenuAction(actions);

  return (
    <Tooltip content={t("Export conversation")}>
      <DropdownMenu
        action={rootAction}
        ariaLabel={t("Export conversation")}
        align="end"
      >
        <Button
          type="button"
          neutral
          borderOnHover
          disabled={disabled}
          icon={<DownloadIcon />}
        />
      </DropdownMenu>
    </Tooltip>
  );
}
