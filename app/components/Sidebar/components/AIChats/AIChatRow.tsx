import { observer } from "mobx-react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import EditableTitle from "~/components/EditableTitle";
import type { RefHandle } from "~/components/EditableTitle";
import Fade from "~/components/Fade";
import useBoolean from "~/hooks/useBoolean";
import useStores from "~/hooks/useStores";
import type AIConversation from "~/models/AIConversation";
import { aiPath } from "~/utils/routeHelpers";
import SidebarLink from "../SidebarLink";
import { AIChatMenu } from "./AIChatMenu";

/** The longest title the server accepts. */
const MAX_TITLE_LENGTH = 80;

interface Props {
  conversation: AIConversation;
}

/**
 * One chat in the sidebar: a link to `/ai/:id` with the title (renamed in
 * place) and a menu on hover.
 *
 * @param props.conversation the chat.
 * @returns the row.
 */
export const AIChatRow = observer(function AIChatRow({ conversation }: Props) {
  const { t } = useTranslation();
  const { aiConversations } = useStores();
  const titleRef = React.useRef<RefHandle>(null);
  const [isEditing, setIsEditing] = React.useState(false);
  const [menuOpen, handleMenuOpen, handleMenuClose] = useBoolean();

  const handleRename = React.useCallback(() => {
    titleRef.current?.setIsEditing(true);
  }, []);

  const handleSubmit = React.useCallback(
    async (value: string) => {
      const title = value.trim();
      if (!title || title === conversation.title) {
        return;
      }
      try {
        await aiConversations.rename(conversation, title);
      } catch {
        toast.error(t("Could not rename the chat"));
      }
    },
    [aiConversations, conversation, t]
  );

  return (
    <SidebarLink
      // @ts-expect-error react-router type is wrong, string component is fine.
      component={isEditing ? "div" : undefined}
      depth={0}
      to={aiPath({ conversationId: conversation.id })}
      exact
      label={
        <EditableTitle
          title={conversation.title}
          onSubmit={handleSubmit}
          // The row remounts as a div while editing; keep the input open.
          isEditing={isEditing}
          onEditing={setIsEditing}
          canUpdate
          maxLength={MAX_TITLE_LENGTH}
          ref={titleRef}
        />
      }
      ellipsis={!isEditing}
      $showActions={menuOpen}
      menu={
        isEditing ? undefined : (
          <Fade>
            <AIChatMenu
              conversation={conversation}
              onRename={handleRename}
              onOpen={handleMenuOpen}
              onClose={handleMenuClose}
            />
          </Fade>
        )
      }
    />
  );
});
