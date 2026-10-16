import { observer } from "mobx-react";
import { SparklesIcon } from "outline-icons";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { Redirect } from "react-router-dom";
import { isUUID } from "validator";
import styled from "styled-components";
import { s } from "@shared/styles";
import Button from "~/components/Button";
import Scene from "~/components/Scene";
import useAIAnswersEnabled from "~/hooks/useAIAnswersEnabled";
import useQuery from "~/hooks/useQuery";
import useStores from "~/hooks/useStores";
import { homePath } from "~/utils/routeHelpers";
import { AnswerTurn } from "./AnswerTurn";
import { Composer, MAX_QUERY_LENGTH } from "./Composer";
import type { ScopeChip } from "./ScopeChips";
import { ScopeChips } from "./ScopeChips";
import type { Scope } from "./model";
import { useAISearch } from "./useAISearch";
import { useAutoSubmitQuery } from "./useAutoSubmitQuery";

/**
 * The AI Search page (`/ai`): a conversation with streamed, cited answers
 * built only from documents the user can read. `q`, `collectionId` and
 * `documentId` query parameters prefill the question and scope; a `q` is
 * submitted once on load.
 *
 * @returns the page, or a redirect to home when AI answers are unavailable.
 */
const AISearch = observer(function AISearch() {
  const enabled = useAIAnswersEnabled();
  return enabled ? <Page /> : <Redirect to={homePath()} />;
});

/** Query-string ids are untrusted: only well-formed UUIDs are used as scope. */
function validId(value: string | null): string | undefined {
  return value && isUUID(value) ? value : undefined;
}

const Page = observer(function Page() {
  const { t } = useTranslation();
  const { collections, documents } = useStores();
  const params = useQuery();
  const { state, streaming, ask, stop, reset, rate } = useAISearch();
  const [text, setText] = React.useState(params.get("q") ?? "");
  const [scope, setScope] = React.useState<Scope>(() => ({
    collectionId: validId(params.get("collectionId")),
    documentId: validId(params.get("documentId")),
  }));
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);

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

  useAutoSubmitQuery(submit);

  const handleSubmit = () => submit(text);

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
            onRemove: () =>
              setScope((prev) => ({ ...prev, collectionId: undefined })),
          },
        ]
      : []),
    ...(documentId
      ? [
          {
            key: "document",
            kind: t("Document"),
            label: documentTitle(documentId),
            onRemove: () =>
              setScope((prev) => ({ ...prev, documentId: undefined })),
          },
        ]
      : []),
  ];

  const suggestions = [
    t("How do we onboard a new team member?"),
    t("What are the steps to request access to a tool?"),
    t("Summarize our most recent project updates"),
  ];

  const { turns } = state;
  const last = turns[turns.length - 1];

  return (
    <Scene
      title={t("AI Search")}
      icon={<SparklesIcon />}
      textTitle={t("AI Search")}
      actions={
        turns.length > 0 ? (
          <Button type="button" neutral onClick={handleNewConversation}>
            {t("New conversation")}
          </Button>
        ) : undefined
      }
    >
      <ScopeChips chips={chips} disabled={streaming} />
      {turns.length === 0 ? (
        <Idle>
          <p>
            {t(
              "Ask a question and get an answer built from your documents, with sources."
            )}
          </p>
          <Suggestions aria-label={t("Example questions")}>
            {suggestions.map((suggestion) => (
              <li key={suggestion}>
                <Suggestion type="button" onClick={() => submit(suggestion)}>
                  {suggestion}
                </Suggestion>
              </li>
            ))}
          </Suggestions>
        </Idle>
      ) : (
        turns.map((turn) => (
          <AnswerTurn
            key={turn.id}
            turn={turn}
            isLast={turn === last}
            scopeLabels={scopeLabels(turn.scope)}
            onStop={stop}
            onRate={rate}
            onRetry={(failed) => submit(failed.question, failed.scope)}
          />
        ))
      )}
      <Composer
        value={text}
        onChange={setText}
        onSubmit={handleSubmit}
        onStop={stop}
        busy={streaming}
        textareaRef={textareaRef}
      />
    </Scene>
  );
});

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

export default AISearch;
