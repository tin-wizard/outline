import { observer } from "mobx-react";
import { PlusIcon } from "outline-icons";
import * as React from "react";
import { useTranslation } from "react-i18next";
import styled from "styled-components";
import { s } from "@shared/styles";
import DelayedMount from "~/components/DelayedMount";
import Flex from "~/components/Flex";
import InputSearch from "~/components/InputSearch";
import { aiPath } from "~/utils/routeHelpers";
import Header from "../Header";
import PlaceholderCollections from "../PlaceholderCollections";
import SidebarLink from "../SidebarLink";
import { AIChatDeleteRow } from "./AIChatDeleteRow";
import { AIChatRow } from "./AIChatRow";
import type { ConversationGroupKey } from "./groupConversations";
import { groupConversations } from "./groupConversations";
import { useAIConversationList } from "./useAIConversationList";

interface Props {
  /**
   * History is turned off for the workspace: list saved chats only so they
   * can be deleted (no links, search, rename, pin or export), and render
   * nothing when there are none.
   */
  deleteOnly?: boolean;
}

/**
 * The "Chats" section of the sidebar: the user's AI Search conversations,
 * grouped by recency with pinned ones first, a search box and a New chat
 * link. Render it when AI answers are available; pass `deleteOnly` when
 * `useAIHistoryEnabled()` is false.
 *
 * @param props.deleteOnly show saved chats for deletion only.
 * @returns the section.
 */
export const AIChats = observer(function AIChats({ deleteOnly }: Props) {
  const { t } = useTranslation();
  const [query, setQuery] = React.useState("");
  const { items, loading, error, end, searching, loadMore, retry } =
    useAIConversationList(query);
  const groups = React.useMemo(() => groupConversations(items), [items]);

  if (deleteOnly) {
    if (!items.length) {
      return null;
    }
    return (
      <Flex column>
        <Header id="ai-chats" title={t("Chats")}>
          <Note>
            {t(
              "Chat history is turned off for your workspace. You can delete your saved chats here."
            )}
          </Note>
          {items.map((conversation) => (
            <AIChatDeleteRow
              key={conversation.id}
              conversation={conversation}
            />
          ))}
          {!loading && !end && (
            <SidebarLink
              onClick={loadMore}
              label={`${t("Show more")}…`}
              depth={0}
            />
          )}
        </Header>
      </Flex>
    );
  }

  const labels: Record<ConversationGroupKey, string> = {
    pinned: t("Pinned"),
    today: t("Today"),
    yesterday: t("Yesterday"),
    previous7Days: t("Previous 7 days"),
    previous30Days: t("Previous 30 days"),
    older: t("Older"),
  };

  const handleQueryChange = (event: React.ChangeEvent<HTMLInputElement>) =>
    setQuery(event.target.value);

  return (
    <Flex column>
      <Header id="ai-chats" title={t("Chats")}>
        <SidebarLink
          to={aiPath()}
          exact
          icon={<PlusIcon />}
          label={t("New chat")}
        />
        <SearchBox>
          <InputSearch
            value={query}
            onChange={handleQueryChange}
            placeholder={`${t("Search chats")}…`}
            aria-label={t("Search chats")}
            margin={0}
          />
        </SearchBox>
        {groups.map((group) => (
          <div role="group" key={group.key} aria-label={labels[group.key]}>
            <GroupTitle>{labels[group.key]}</GroupTitle>
            {group.items.map((conversation) => (
              <AIChatRow key={conversation.id} conversation={conversation} />
            ))}
          </div>
        ))}
        {loading && (
          <DelayedMount>
            <PlaceholderCollections />
          </DelayedMount>
        )}
        {error && (
          <Note role="alert">
            {t("Could not load chats")}{" "}
            <RetryButton type="button" onClick={retry}>
              {t("Try again")}
            </RetryButton>
          </Note>
        )}
        {!loading && !error && !groups.length && (
          <Note>{searching ? t("No chats found") : t("No chats yet")}</Note>
        )}
        {!loading && !error && !end && groups.length > 0 && (
          <SidebarLink
            onClick={loadMore}
            label={`${t("Show more")}…`}
            depth={0}
          />
        )}
      </Header>
    </Flex>
  );
});

const SearchBox = styled.div`
  padding: 4px 12px;
`;

const GroupTitle = styled.h4`
  margin: 8px 0 2px;
  padding-inline: 12px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.03em;
  text-transform: uppercase;
  color: ${s("textTertiary")};
`;

const Note = styled.p`
  margin: 4px 0;
  padding-inline: 12px;
  font-size: 13px;
  color: ${s("textTertiary")};
`;

const RetryButton = styled.button`
  padding: 0;
  border: 0;
  background: none;
  color: ${s("accent")};
  font: inherit;
  cursor: var(--pointer);
`;
