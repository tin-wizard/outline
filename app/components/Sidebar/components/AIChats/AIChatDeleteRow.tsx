import { observer } from "mobx-react";
import { TrashIcon } from "outline-icons";
import { useTranslation } from "react-i18next";
import styled from "styled-components";
import { ellipsis, s } from "@shared/styles";
import NudeButton from "~/components/NudeButton";
import type AIConversation from "~/models/AIConversation";
import { useConfirmDeleteChat } from "./AIChatMenu";

interface Props {
  conversation: AIConversation;
}

/**
 * A saved chat while history is turned off: its title and a delete button,
 * without a link, rename, pin or export.
 *
 * @param props.conversation the chat.
 * @returns the row.
 */
export const AIChatDeleteRow = observer(function AIChatDeleteRow({
  conversation,
}: Props) {
  const { t } = useTranslation();
  const handleDelete = useConfirmDeleteChat(conversation);

  return (
    <Row>
      <Title title={conversation.title}>{conversation.title}</Title>
      <NudeButton
        type="button"
        aria-label={t("Delete chat “{{ title }}”", {
          title: conversation.title,
        })}
        onClick={handleDelete}
      >
        <TrashIcon />
      </NudeButton>
    </Row>
  );
});

const Row = styled.div`
  display: flex;
  align-items: center;
  gap: 4px;
  min-height: 32px;
  padding-inline: 12px 6px;
  color: ${s("sidebarText")};
  font-size: 14px;
`;

const Title = styled.span`
  flex: 1;
  min-width: 0;
  ${ellipsis()}
`;
