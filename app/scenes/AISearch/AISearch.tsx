import { observer } from "mobx-react";
import { SparklesIcon } from "outline-icons";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { Link, Redirect, useParams } from "react-router-dom";
import { toast } from "sonner";
import { isUUID } from "validator";
import styled from "styled-components";
import { breakpoints, s } from "@shared/styles";
import Button from "~/components/Button";
import Scene from "~/components/Scene";
import PlaceholderText from "~/components/PlaceholderText";
import useAIAnswersEnabled from "~/hooks/useAIAnswersEnabled";
import useAIHistoryEnabled from "~/hooks/useAIHistoryEnabled";
import useQuery from "~/hooks/useQuery";
import useStores from "~/hooks/useStores";
import { aiPath, homePath } from "~/utils/routeHelpers";
import { AnswerTurn } from "./AnswerTurn";
import { ExportActions } from "./ExportActions";
import { SourcesDrawer } from "./SourcesDrawer";
import { Composer, MAX_QUERY_LENGTH } from "./Composer";
import type { ScopeChip } from "./ScopeChips";
import { ScopeChips } from "./ScopeChips";
import type { Scope } from "./model";
import { citedSources } from "./model";
import { useAISearch } from "./useAISearch";
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
  const { t } = useTranslation();
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

  return (
    <Scene
      title={title}
      icon={<SparklesIcon />}
      textTitle={title}
      centered={false}
      actions={
        turns.length > 0 ? (
          <>
            <ExportActions turns={turns} streaming={streaming} title={title} />
            <Button
              as={Link}
              to={aiPath()}
              neutral
              onClick={handleNewConversation}
            >
              {t("New chat")}
            </Button>
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
              <Welcome>
                <SparklesIcon size={32} />
                <WelcomeTitle>{t("Ask your documents")}</WelcomeTitle>
                <p>
                  {t(
                    "Ask a question and get an answer built from your documents, with sources."
                  )}
                </p>
                <Suggestions aria-label={t("Example questions")}>
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
              </Welcome>
            ) : (
              turns.map((turn) => (
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
              ))
            )}
            <ComposerDock data-print-hidden hidden={route.status !== "idle"}>
              <Composer
                value={text}
                onChange={setText}
                onSubmit={handleSubmit}
                onStop={stop}
                busy={streaming}
                textareaRef={textareaRef}
              />
            </ComposerDock>
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

    section {
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
const ComposerDock = styled.div`
  position: sticky;
  bottom: 0;
  z-index: 1;
  padding: 8px 0 max(12px, env(safe-area-inset-bottom));
  background: ${s("background")};
`;

const Welcome = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  margin: 48px 0 32px;
  color: ${s("textSecondary")};
  text-align: center;

  svg {
    fill: ${s("accent")};
  }

  ul {
    width: 100%;
    text-align: start;
  }
`;

const WelcomeTitle = styled.h2`
  margin: 8px 0 0;
  color: ${s("text")};
  font-size: 20px;
`;

const Idle = styled.div`
  margin: 32px 0;
  color: ${s("textSecondary")};
`;

const Suggestions = styled.ul`
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 12px 0 0;
  padding: 0;
  list-style: none;
`;

const Suggestion = styled.button`
  width: 100%;
  padding: 10px 14px;
  border: 1px solid ${s("divider")};
  border-radius: 8px;
  background: ${s("background")};
  color: ${s("text")};
  font: inherit;
  text-align: left;
  cursor: var(--pointer);

  &:hover,
  &:focus-visible {
    background: ${s("backgroundSecondary")};
  }
`;
