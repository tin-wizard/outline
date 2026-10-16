import * as React from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import styled from "styled-components";
import { s } from "@shared/styles";
import Button from "~/components/Button";
import { AnswerBody } from "./AnswerBody";
import type { Turn, TurnProblem } from "./model";
import { citedSources, isActive } from "./model";

interface Props {
  turn: Turn;
  /** Whether this is the newest turn: it gets Stop, retry and focus handling. */
  isLast: boolean;
  /** Names of the collection and document the question was scoped to. */
  scopeLabels: string[];
  onStop: () => void;
  onRetry: (turn: Turn) => void;
}

const RETRYABLE: TurnProblem[] = [
  "error",
  "timeout",
  "unavailable",
  "network",
  "cancelled",
];

/**
 * Whether a server-provided path may be linked. Only in-app document paths
 * are; anything else is shown as text.
 *
 * @param url the path from a source or citation.
 * @returns true for relative `/doc/...` paths.
 */
export function isDocPath(url: string): boolean {
  return /^\/doc\/[^\s\\]+$/.test(url) && !url.startsWith("//");
}

/**
 * One question with its streamed answer: status, verified blocks, sources and
 * any failure shown next to what was verified.
 *
 * @param props.turn the turn to show.
 * @param props.isLast whether it is the newest turn.
 * @param props.scopeLabels names of the scope searched.
 * @param props.onStop stops the running turn.
 * @param props.onRetry asks the question again.
 * @returns the turn.
 */
export function AnswerTurn({
  turn,
  isLast,
  scopeLabels,
  onStop,
  onRetry,
}: Props) {
  const { t } = useTranslation();
  const headingRef = React.useRef<HTMLHeadingElement>(null);
  const previous = React.useRef(turn.status);
  const active = isActive(turn);
  const cited = citedSources(turn);

  React.useEffect(() => {
    if (isLast && previous.current !== "done" && turn.status === "done") {
      headingRef.current?.focus();
    }
    previous.current = turn.status;
  }, [isLast, turn.status]);

  const handleCitationClick = React.useCallback(
    (n: number) => {
      const target = document.getElementById(`source-${turn.id}-${n}`);
      target?.scrollIntoView?.({ block: "nearest" });
      target?.focus();
    },
    [turn.id]
  );

  const hasBlocks = turn.blocks.length > 0;
  const noResults = turn.problem === "no_answer" && !hasBlocks;

  return (
    <Section aria-label={turn.question}>
      <Question>{turn.question}</Question>
      <Answer aria-live="polite" aria-busy={active}>
        <Heading ref={headingRef} tabIndex={-1}>
          {t("Answer")}
        </Heading>
        {turn.notice && <Muted>{turn.notice}</Muted>}
        {turn.status === "searching" && (
          <Status>{t("Searching your documents…")}</Status>
        )}
        {turn.status === "generating" && (
          <Status>
            {t("Writing answer…")}
            {isLast && (
              <Button type="button" neutral onClick={onStop}>
                {t("Stop")}
              </Button>
            )}
          </Status>
        )}
        {turn.status === "searching" && isLast && (
          <Button type="button" neutral onClick={onStop}>
            {t("Stop")}
          </Button>
        )}
        {!!turn.sources?.length && !cited.length && active && (
          <Details>
            <summary>
              {t("Sources")} ({turn.sources.length})
            </summary>
            <SourceList>
              {turn.sources.map((source) => (
                <li key={source.n}>
                  <SourceEntry
                    n={source.n}
                    title={source.title}
                    url={source.url}
                    collectionName={source.collectionName}
                  />
                </li>
              ))}
            </SourceList>
          </Details>
        )}
        {turn.problem && hasBlocks && (
          <Muted>{t("Partial answer, not fully verified")}</Muted>
        )}
        {hasBlocks && (
          <AnswerBody
            blocks={turn.blocks}
            onCitationClick={handleCitationClick}
          />
        )}
        {cited.length > 0 && (
          <div>
            <SourcesHeading>{t("Sources")}</SourcesHeading>
            <SourceList>
              {cited.map((source) => (
                <li
                  key={source.n}
                  id={`source-${turn.id}-${source.n}`}
                  tabIndex={-1}
                >
                  <SourceEntry {...source} />
                </li>
              ))}
            </SourceList>
          </div>
        )}
        {turn.status === "stopped" && <Message>{t("Stopped")}</Message>}
        {noResults && (
          <Message>
            <strong>{t("No relevant documents found")}</strong>
            <br />
            {scopeLabels.length
              ? t("Searched in: {{ scope }}.", {
                  scope: scopeLabels.join(", "),
                })
              : t("Searched in: all documents.")}{" "}
            {t("Try rephrasing, or widen the search by removing a filter.")}
          </Message>
        )}
        {turn.problem && !noResults && (
          <Message role="status">
            {problemMessage(turn.problem, hasBlocks, t)}
            {isLast && RETRYABLE.includes(turn.problem) && (
              <>
                {" "}
                <Button type="button" neutral onClick={() => onRetry(turn)}>
                  {t("Try again")}
                </Button>
              </>
            )}
          </Message>
        )}
      </Answer>
    </Section>
  );
}

function problemMessage(
  problem: TurnProblem,
  partial: boolean,
  t: (key: string) => string
): string {
  switch (problem) {
    case "unverified":
      return partial
        ? `${t("Couldn't fully verify this answer")}. ${t(
            "The part shown above was verified, the rest was withheld."
          )}`
        : `${t("Couldn't fully verify this answer")}. ${t(
            "No part of it could be backed by your documents."
          )}`;
    case "no_answer":
      return t("The documents don't answer this question.");
    case "budget":
      return t(
        "AI answers have reached this workspace's monthly limit. Ask an admin or try again later."
      );
    case "unavailable":
      return t("AI answers are temporarily unavailable.");
    case "timeout":
      return t("This took too long. Try a narrower question.");
    case "cancelled":
      return t("The request was cancelled.");
    case "unauthorized":
      return t("Your session has expired. Sign in again.");
    case "forbidden":
      return t("AI answers aren't available to your account.");
    case "rateLimited":
      return t("Too many requests, try again in a minute.");
    case "network":
      return t("Couldn't reach the server. Check your connection.");
    default:
      return t("Something went wrong while answering.");
  }
}

function SourceEntry({
  n,
  title,
  url,
  collectionName,
}: {
  n: number;
  title: string;
  url: string;
  collectionName?: string;
}) {
  return (
    <>
      <Number>[{n}]</Number>{" "}
      {isDocPath(url) ? <Link to={url}>{title}</Link> : <span>{title}</span>}
      {collectionName && <Muted as="span"> · {collectionName}</Muted>}
    </>
  );
}

const Section = styled.section`
  margin: 24px 0;
`;

const Question = styled.p`
  margin: 0 0 12px auto;
  padding: 8px 14px;
  max-width: 85%;
  width: fit-content;
  border-radius: 14px;
  background: ${s("backgroundSecondary")};
  color: ${s("text")};
  overflow-wrap: anywhere;
  white-space: pre-wrap;
`;

const Answer = styled.div`
  color: ${s("text")};
`;

const Heading = styled.h2`
  margin: 0 0 4px;
  font-size: 13px;
  font-weight: 600;
  color: ${s("textSecondary")};
  text-transform: uppercase;
  letter-spacing: 0.04em;

  &:focus {
    outline: none;
  }

  &:focus-visible {
    outline: 2px solid ${s("accent")};
    outline-offset: 2px;
  }
`;

const Status = styled.p`
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 8px 0;
  color: ${s("textSecondary")};
`;

const Muted = styled.p`
  margin: 4px 0;
  color: ${s("textSecondary")};
  font-size: 14px;
`;

const Message = styled.p`
  margin: 12px 0;
  padding: 10px 12px;
  border-radius: 6px;
  border: 1px solid ${s("divider")};
  background: ${s("backgroundSecondary")};
  color: ${s("text")};
`;

const Details = styled.details`
  margin: 8px 0;
  color: ${s("textSecondary")};
  font-size: 14px;

  summary {
    cursor: var(--pointer);
  }
`;

const SourcesHeading = styled.h3`
  margin: 16px 0 4px;
  font-size: 13px;
  color: ${s("textSecondary")};
`;

const SourceList = styled.ul`
  margin: 4px 0;
  padding: 0;
  list-style: none;
  font-size: 14px;

  li {
    padding: 2px 0;
    overflow-wrap: anywhere;
  }

  li:focus-visible {
    outline: 2px solid ${s("accent")};
  }
`;

const Number = styled.span`
  color: ${s("textSecondary")};
  font-variant-numeric: tabular-nums;
`;
