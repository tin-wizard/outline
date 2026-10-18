import { observer } from "mobx-react";
import { DownloadIcon, EditIcon, PinIcon, TrashIcon } from "outline-icons";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { useHistory, useRouteMatch } from "react-router-dom";
import { toast } from "sonner";
import { ActionSeparator, createAction } from "~/actions";
import ConfirmationDialog from "~/components/ConfirmationDialog";
import { DropdownMenu } from "~/components/Menu/DropdownMenu";
import { OverflowMenuButton } from "~/components/Menu/OverflowMenuButton";
import { ActionContextProvider } from "~/hooks/useActionContext";
import { useMenuAction } from "~/hooks/useMenuAction";
import useStores from "~/hooks/useStores";
import type AIConversation from "~/models/AIConversation";
import { downloadMarkdown } from "~/scenes/AISearch/download";
import {
  conversationToMarkdown,
  exportFilename,
} from "~/scenes/AISearch/exportMarkdown";
import { chatReducer, initialChatState } from "~/scenes/AISearch/model";
import { aiPath } from "~/utils/routeHelpers";

interface Props {
  conversation: AIConversation;
  /** Starts renaming the row in place. */
  onRename: () => void;
  onOpen?: () => void;
  onClose?: () => void;
}

const section = ({ t }: { t: (key: string) => string }) => t("AI Search");

/**
 * The overflow menu of a chat in the sidebar: rename, pin, export and delete.
 *
 * @param props.conversation the chat.
 * @param props.onRename starts inline renaming.
 * @returns the menu button.
 */
export const AIChatMenu = observer(function AIChatMenu({
  conversation,
  onRename,
  onOpen,
  onClose,
}: Props) {
  const { t } = useTranslation();
  const { aiConversations, dialogs } = useStores();
  const history = useHistory();
  const active = useRouteMatch<{ conversationId: string }>(
    "/ai/:conversationId"
  );

  const handleTogglePin = React.useCallback(async () => {
    try {
      await aiConversations.setPinned(conversation, !conversation.isPinned);
    } catch {
      toast.error(t("Could not update the chat"));
    }
  }, [aiConversations, conversation, t]);

  const handleExport = React.useCallback(async () => {
    try {
      const full = await aiConversations.fetch(conversation.id, {
        force: true,
      });
      const { turns } = chatReducer(initialChatState, {
        type: "hydrate",
        conversationId: conversation.id,
        turns: full.turns ?? [],
      });
      downloadMarkdown(
        conversationToMarkdown(turns, { title: conversation.title }),
        exportFilename(conversation.title, new Date())
      );
    } catch {
      toast.error(t("Could not export the chat"));
    }
  }, [aiConversations, conversation, t]);

  const handleDelete = React.useCallback(async () => {
    await aiConversations.delete(conversation);
    if (active?.params.conversationId === conversation.id) {
      history.push(aiPath());
    }
  }, [aiConversations, conversation, active, history]);

  const actions = React.useMemo(
    () => [
      createAction({
        name: `${t("Rename")}…`,
        analyticsName: "Rename AI chat",
        section,
        icon: <EditIcon />,
        perform: onRename,
      }),
      createAction({
        name: conversation.isPinned ? t("Unpin") : t("Pin"),
        analyticsName: "Pin AI chat",
        section,
        icon: <PinIcon />,
        perform: handleTogglePin,
      }),
      createAction({
        name: t("Export as Markdown"),
        analyticsName: "Export AI chat",
        section,
        icon: <DownloadIcon />,
        perform: handleExport,
      }),
      ActionSeparator,
      createAction({
        name: `${t("Delete")}…`,
        analyticsName: "Delete AI chat",
        section,
        icon: <TrashIcon />,
        dangerous: true,
        perform: () =>
          dialogs.openModal({
            title: t("Delete chat"),
            content: (
              <ConfirmationDialog
                onSubmit={handleDelete}
                submitText={t("Delete")}
                savingText={`${t("Deleting")}…`}
                danger
              >
                {t(
                  "Are you sure you want to delete this chat? The conversation will be permanently removed and cannot be recovered."
                )}
              </ConfirmationDialog>
            ),
          }),
      }),
    ],
    [
      t,
      conversation.isPinned,
      onRename,
      handleTogglePin,
      handleExport,
      handleDelete,
      dialogs,
    ]
  );

  const rootAction = useMenuAction(actions);

  return (
    <ActionContextProvider value={{ activeModels: [conversation] }}>
      <DropdownMenu
        action={rootAction}
        ariaLabel={t("Chat options")}
        onOpen={onOpen}
        onClose={onClose}
      >
        <OverflowMenuButton />
      </DropdownMenu>
    </ActionContextProvider>
  );
});
