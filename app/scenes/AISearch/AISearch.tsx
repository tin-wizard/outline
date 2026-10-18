import { observer } from "mobx-react";
import { SparklesIcon } from "outline-icons";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { Link, Redirect, useParams } from "react-router-dom";
import { toast } from "sonner";
import { isUUID } from "validator";
import { transparentize } from "polished";
import styled from "styled-components";
import { breakpoints, s } from "@shared/styles";
import Button from "~/components/Button";
import Scene from "~/components/Scene";
import PlaceholderText from "~/components/PlaceholderText";
import useAIAnswersEnabled from "~/hooks/useAIAnswersEnabled";
import useAIHistoryEnabled from "~/hooks/useAIHistoryEnabled";
import useMobile from "~/hooks/useMobile";
import useQuery from "~/hooks/useQuery";
import useStores from "~/hooks/useStores";
import { aiPath, homePath } from "~/utils/routeHelpers";
import { AnswerTurn } from "./AnswerTurn";
import {
  ChatBreadcrumb,
  NewChatIconLink,
  PrivateBadge,
  ResumedDivider,
  SourcesToggle,
} from "./ChatShell";
import { ExportActions } from "./ExportActions";
import { SourcesDrawer } from "./SourcesDrawer";
import { Composer, MAX_QUERY_LENGTH } from "./Composer";
import type { ScopeChip } from "./ScopeChips";
import { ScopeChips } from "./ScopeChips";
import type { Scope } from "./model";
import { citedSources } from "./model";
import { useAISearch } from "./useAISearch";
import { startedLabel } from "./startedLabel";
import { useAutoSubmitQuery } from "./useAutoSubmitQuery";
import { useConversationRoute } from "./useConversationRoute";
import { useSourcesDrawer } from "./useSourcesDrawer";

/**
 * The AI Search page (`/ai`): a conversation with streamed, cited answers
 * built only from documents the user can read. `q`, `collectionId` and
 * `documentId` query parameters prefill the question and scope; a `q` is
 * submitted once on load. `/ai/:conversationId` resumes a stored conversation
 * when workspace history is on, and otherwise returns to `/ai`.
 *
 * @returns the page, or a redirect when AI answers are unavailable.
 */
export const AISearch = observer(function AISearch() {
  const enabled = useAIAnswersEnabled();
  const historyEnabled = useAIHistoryEnabled();
  const { conversationId } = useParams<{ conversationId?: string }>();
  if (!enabled) {
    return <Redirect to={homePath()} />;
  }
  if (conversationId && !historyEnabled) {
    return <HistoryOff />;
  }
  return (
    <Page conversationId={conversationId} historyEnabled={historyEnabled} />
  );
});

/** Explains why a stored conversation cannot be opened, then shows a new chat. */
function HistoryOff() {
  const { t } = useTranslation();
  React.useEffect(() => {
    // A fixed id shows the notice once even when the effect runs twice.
    toast.info(t("Chat history is turned off for this workspace."), {
      id: "ai-history-off",
    });
  }, [t]);
  return <Redirect to={aiPath()} />;
}

/** Query-string ids are untrusted: only well-formed UUIDs are used as scope. */
function validId(value: string | null): string | undefined {
  return value && isUUID(value) ? value : undefined;
}

const Page = observer(function Page({
  conversationId,
  historyEnabled,
}: {
  conversationId?: string;
  historyEnabled: boolean;
}) {
  const { t, i18n } = useTranslation();
  const isMobile = useMobile();
  const { collections, documents, aiConversations } = useStores();
  const params = useQuery();
  const { state, streaming, ask, stop, reset, hydrate, rate } = useAISearch();
  const route = useConversationRoute({
    routeId: conversationId,
    enabled: historyEnabled,
    state,
    hydrate,
    reset,
  });
  const [text, setText] = React.useState(params.get("q") ?? "");
  const [scope, setScope] = React.useState<Scope>(() => ({
    collectionId: validId(params.get("collectionId")),
    documentId: validId(params.get("documentId")),
  }));
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const drawer = useSourcesDrawer();

  const { collectionId, documentId } = scope;
  React.useEffect(() => {
    if (collectionId && !collections.get(collectionId)) {
      void collections.fetch(collectionId).catch(() => undefined);
    }
    if (documentId && !documents.get(documentId)) {
      void documents.fetch(documentId).catch(() => undefined);
    }
  }, [collectionId, documentId, collections, documents]);

  const collectionName = (id: string) =>
    collections.get(id)?.name ?? t("Collection");
  const documentTitle = (id: string) =>
    documents.get(id)?.titleWithDefault ?? t("Document");

  const submit = React.useCallback(
    (question: string, forScope: Scope = scope) => {
      const trimmed = question.trim().slice(0, MAX_QUERY_LENGTH);
      if (!trimmed || streaming) {
        return;
      }
      ask(trimmed, forScope);
      setText("");
      textareaRef.current?.focus();
    },
    [ask, scope, streaming]
  );

  useAutoSubmitQuery(submit, !conversationId);

  const handleSubmit = () => submit(text);

  const handleRemoveCollection = () =>
    setScope((prev) => ({ ...prev, collectionId: undefined }));

  const handleRemoveDocument = () =>
    setScope((prev) => ({ ...prev, documentId: undefined }));

  // Suggestions only fill the composer: sending is always the user's action.
  const handleSuggestionClick = (
    event: React.MouseEvent<HTMLButtonElement>
  ) => {
    setText(event.currentTarget.value);
    textareaRef.current?.focus();
  };

  // Chips fill the composer like the idle suggestions: sending stays explicit.
  const handleFollowUp = (question: string) => {
    setText(question.slice(0, MAX_QUERY_LENGTH));
    textareaRef.current?.focus();
  };

  // The link to /ai starts a new chat; the stored one is kept, not deleted.
  const handleNewConversation = () => {
    reset();
    setText("");
    textareaRef.current?.focus();
  };

  const scopeLabels = (forScope: Scope) => [
    ...(forScope.collectionId ? [collectionName(forScope.collectionId)] : []),
    ...(forScope.documentId ? [documentTitle(forScope.documentId)] : []),
  ];

  const chips: ScopeChip[] = [
    ...(collectionId
      ? [
          {
            key: "collection",
            kind: t("Collection"),
            label: collectionName(collectionId),
            onRemove: handleRemoveCollection,
          },
        ]
      : []),
    ...(documentId
      ? [
          {
            key: "document",
            kind: t("Document"),
            label: documentTitle(documentId),
            onRemove: handleRemoveDocument,
          },
        ]
      : []),
  ];

  const suggestions = [
    t("How do we onboard a new team member?"),
    t("What are the steps to request access to a tool?"),
    t("What does our handbook say about time off?"),
    t("Where is our incident response process documented?"),
  ];

  const { turns } = state;
  const last = turns[turns.length - 1];
  const title =
    (conversationId && aiConversations.get(conversationId)?.title) ||
    t("AI Search");
  // The drawer shows the selected answer, else the newest one with sources.
  const drawerTurn =
    turns.find((turn) => turn.id === drawer.turnId) ??
    [...turns].reverse().find((turn) => citedSources(turn).length > 0) ??
    last;

  const stored = conversationId
    ? aiConversations.get(conversationId)
    : undefined;
  const crumbTitle = stored?.title || turns[0]?.question || t("New chat");
  // A chat opened from history; a chat begun in this session has no divider.
  const resumedOn = stored?.turns?.length
    ? startedLabel(
        stored.createdAt ?? stored.turns[0]?.createdAt,
        i18n.language
      )
    : undefined;
  const isStored = historyEnabled && !!(conversationId || state.conversationId);
  const empty = route.status === "idle" && turns.length === 0;

  const handleToggleSources = (event: React.MouseEvent<HTMLButtonElement>) => {
    if (drawer.open) {
      drawer.close();
    } else if (drawerTurn) {
      drawer.show(drawerTurn.id, undefined, event.currentTarget);
    }
  };

  return (
    <Scene
      textTitle={title}
      centered={false}
      left={
        <>
          <ChatBreadcrumb title={crumbTitle} titleOnly={isMobile} />
          {isStored && <PrivateBadge />}
        </>
      }
      actions={
        turns.length > 0 ? (
          <>
            <ExportActions turns={turns} streaming={streaming} title={title} />
            <SourcesToggle open={drawer.open} onClick={handleToggleSources} />
            <NewChatIconLink onClick={handleNewConversation} />
          </>
        ) : undefined
      }
    >
      <Root data-ai-search>
        <Panes>
          <Chat>
            <div data-print-hidden>
              <ScopeChips chips={chips} disabled={streaming} />
            </div>
            {route.status === "loading" ? (
              <Idle aria-busy="true">
                <span role="status">{t("Loading conversation…")}</span>
                <PlaceholderText />
                <PlaceholderText delay={0.2} />
              </Idle>
            ) : route.status === "notFound" ? (
              <Idle role="alert">
                <strong>{t("Conversation not found")}</strong>
                <p>
                  <Link to={aiPath()}>{t("New chat")}</Link>
                </p>
              </Idle>
            ) : route.status === "error" ? (
              <Idle role="alert">
                <p>{t("Could not load this conversation.")}</p>
                <Button type="button" neutral onClick={route.retry}>
                  {t("Try again")}
                </Button>
              </Idle>
            ) : turns.length === 0 ? (
              <Welcome data-print-hidden>
                <WelcomeMark>
                  <SparklesIcon size={26} />
                </WelcomeMark>
                <WelcomeTitle>{t("What do you want to know?")}</WelcomeTitle>
                <p>
                  {t(
                    "Answers come only from documents you can open, with a source for every statement."
                  )}
                </p>
              </Welcome>
            ) : (
              <>
                {resumedOn && <ResumedDivider date={resumedOn} />}
                {turns.map((turn) => (
                  <AnswerTurn
                    key={turn.id}
                    turn={turn}
                    isLast={turn === last}
                    scopeLabels={scopeLabels(turn.scope)}
                    onStop={stop}
                    onRate={rate}
                    onOpenSources={drawer.show}
                    onFollowUp={handleFollowUp}
                    onRetry={(failed) => submit(failed.question, failed.scope)}
                  />
                ))}
              </>
            )}
            <ComposerDock
              data-print-hidden
              hidden={route.status !== "idle"}
              $hero={empty}
            >
              <Composer
                value={text}
                onChange={setText}
                onSubmit={handleSubmit}
                onStop={stop}
                busy={streaming}
                textareaRef={textareaRef}
              />
              <Disclaimer>
                {t(
                  "Answers use only documents you can access and every statement links to its source."
                )}
              </Disclaimer>
            </ComposerDock>
            {empty && (
              <Suggestions
                aria-label={t("Example questions")}
                data-print-hidden
              >
                {suggestions.map((suggestion) => (
                  <li key={suggestion}>
                    <Suggestion
                      type="button"
                      value={suggestion}
                      onClick={handleSuggestionClick}
                    >
                      {suggestion}
                    </Suggestion>
                  </li>
                ))}
              </Suggestions>
            )}
          </Chat>
          {drawer.open && drawerTurn && (
            <SourcesDrawer
              turn={drawerTurn}
              selected={drawer.selected}
              autoFocus={drawer.focusIn}
              onClose={drawer.close}
            />
          )}
        </Panes>
      </Root>
    </Scene>
  );
});

const Root = styled.div`
  width: 100%;
  padding: 4px 16px 0;

  @media (min-width: ${breakpoints.tablet}px) {
    padding: 4px 44px 0;
  }

  [data-print-only] {
    display: none;
  }

  @media print {
    color: #000;
    background: #fff;

    [data-print-hidden],
    button:not([data-citation]) {
      display: none !important;
    }

    * {
      color: #000 !important;
      background: transparent !important;
      box-shadow: none !important;
    }

    a {
      text-decoration: underline;
    }

    a[href^="/doc/"]::after {
      content: " (" attr(href) ")";
      font-size: 0.85em;
    }

    [data-print-only] {
      display: block !important;
    }

    article {
      break-inside: avoid-page;
    }
  }
`;

const Panes = styled.div`
  display: flex;
  align-items: flex-start;
  justify-content: center;
  gap: 24px;
`;

const Chat = styled.div`
  flex: 1;
  min-width: 0;
  max-width: 46em;
`;

/** Keeps the composer in reach at the bottom while a long chat scrolls. */
const ComposerDock = styled.div<{ $hero?: boolean }>`
  position: ${(props) => (props.$hero ? "static" : "sticky")};
  bottom: 0;
  z-index: 1;
  padding: ${(props) =>
    props.$hero
      ? "24px 0 8px"
      : "8px 0 max(12px, env(safe-area-inset-bottom))"};
  background: ${s("background")};
`;

const Disclaimer = styled.p`
  margin: 8px 0 0;
  color: ${s("textTertiary")};
  font-size: 12px;
  text-align: center;

  @media (max-width: ${breakpoints.tablet - 1}px) {
    display: none;
  }
`;

const Welcome = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  margin: max(32px, 8vh) 0 0;
  color: ${s("textSecondary")};
  text-align: center;

  p {
    margin: 6px 0 0;
    font-size: 15px;
  }
`;

const WelcomeMark = styled.div`
  display: grid;
  place-items: center;
  width: 44px;
  height: 44px;
  margin-bottom: 14px;
  border-radius: 12px;
  background: ${(props) => transparentize(0.88, props.theme.accent)};

  svg {
    fill: ${s("accent")};
  }
`;

const WelcomeTitle = styled.h2`
  margin: 0;
  color: ${s("text")};
  font-size: 26px;
  font-weight: 600;
  letter-spacing: -0.01em;

  @media (max-width: ${breakpoints.tablet - 1}px) {
    font-size: 22px;
  }
`;

const Idle = styled.div`
  margin: 32px 0;
  color: ${s("textSecondary")};
`;

const Suggestions = styled.ul`
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  margin: 16px 0 32px;
  padding: 0;
  list-style: none;

  @media (max-width: ${breakpoints.tablet - 1}px) {
    grid-template-columns: minmax(0, 1fr);
  }
`;

const Suggestion = styled.button`
  width: 100%;
  height: 100%;
  padding: 12px 14px;
  border: 0;
  border-radius: 10px;
  box-shadow: inset 0 0 0 1px ${s("divider")};
  background: transparent;
  color: ${s("text")};
  font: inherit;
  font-size: 14.5px;
  line-height: 1.4;
  text-align: left;
  cursor: var(--pointer);

  &:hover,
  &:focus-visible {
    background: ${s("backgroundSecondary")};
  }
`;
