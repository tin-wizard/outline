import * as React from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import styled from "styled-components";
import { s } from "@shared/styles";
import { ThumbsDownIcon, ThumbsUpIcon } from "outline-icons";
import Button from "~/components/Button";
import CopyToClipboard from "~/components/CopyToClipboard";
import Tooltip from "~/components/Tooltip";
import {
  followUpSuggestions,
  isNotCovered,
  verificationOf,
} from "./answerInsights";
import { AnswerBody } from "./AnswerBody";
import type { CitationPreviewData } from "./CitationPreview";
import { CitationQuote } from "./CitationQuote";
import { turnToMarkdown } from "./exportMarkdown";
import type { CitedSection, Rating, Turn, TurnProblem } from "./model";
import {
  answerSegments,
  canRate,
  citedSources,
  isActive,
  sectionLabel,
} from "./model";

interface Props {
  turn: Turn;
  /** Whether this is the newest turn: it gets Stop, retry and focus handling. */
  isLast: boolean;
  /** Names of the collection and document the question was scoped to. */
  scopeLabels: string[];
  onStop: () => void;
  onRetry: (turn: Turn) => void;
  /** Sets or clears helpful / not helpful for a finished answer. */
  onRate?: (turnId: number, rating: Rating) => void;
  /**
   * Opens the Sources drawer for this answer (optionally at one source). When
   * given, citation markers open the drawer instead of scrolling to the inline
   * list, which is then only shown in print.
   */
  onOpenSources?: (turnId: number, n?: number, opener?: HTMLElement) => void;
  /** Receives a follow-up suggestion to place in the composer. */
  onFollowUp?: (text: string) => void;
}

const RETRYABLE: TurnProblem[] = [
  "error",
  "timeout",
  "unavailable",
  "network",
  "cancelled",
  "rateLimited",
];

// Control characters and bidi overrides/isolates have no place in a path.
const UNSAFE_CHARS =
  // oxlint-disable-next-line no-control-regex
  /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/;

/**
 * Whether a server-provided path may be linked. Only `/doc/<slug>` with an
 * optional `#anchor` is: no extra segments, query, dot segments, encoded dots,
 * slashes or backslashes, and no control or bidi characters. Anything else is
 * shown as text.
 *
 * @param url the path from a source or citation.
 * @returns true for safe relative document paths.
 */
export function isDocPath(url: string): boolean {
  if (!/^\/doc\/[^\s\\/?#]+(#[^\s]*)?$/.test(url) || UNSAFE_CHARS.test(url)) {
    return false;
  }
  const slug = url.slice("/doc/".length).split("#")[0];
  return !/^\.+$/.test(slug) && !/%(2e|2f|5c)/i.test(slug);
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
 * @param props.onRate sends helpful / not helpful feedback.
 * @param props.onOpenSources opens the Sources drawer.
 * @param props.onFollowUp fills the composer with a suggestion.
 * @returns the turn.
 */
export function AnswerTurn({
  turn,
  isLast,
  scopeLabels,
  onStop,
  onRetry,
  onRate,
  onOpenSources,
  onFollowUp,
}: Props) {
  const { t } = useTranslation();
  const headingRef = React.useRef<HTMLHeadingElement>(null);
  const previous = React.useRef(turn.status);
  const active = isActive(turn);
  const cited = React.useMemo(() => citedSources(turn), [turn]);
  const previews = React.useMemo(
    () =>
      new Map<number, CitationPreviewData>(
        cited.map((source) => [
          source.n,
          {
            title: source.title,
            collectionName: source.collectionName,
            quote: source.sections.find((x) => x.quote)?.quote,
          },
        ])
      ),
    [cited]
  );
  const [highlighted, setHighlighted] = React.useState<number>();

  React.useEffect(() => {
    if (highlighted === undefined) {
      return;
    }
    const timer = setTimeout(() => setHighlighted(undefined), 2500);
    return () => clearTimeout(timer);
  }, [highlighted]);

  React.useEffect(() => {
    if (isLast && previous.current !== "done" && turn.status === "done") {
      headingRef.current?.focus();
    }
    previous.current = turn.status;
  }, [isLast, turn.status]);

  const handleRetry = () => onRetry(turn);

  const handleCopied = () => toast.success(t("Copied"));

  const handleCitationClick = React.useCallback(
    (n: number, marker?: HTMLElement) => {
      if (onOpenSources) {
        onOpenSources(turn.id, n, marker);
        return;
      }
      const target = document.getElementById(`source-${turn.id}-${n}`);
      target?.scrollIntoView?.({ block: "nearest" });
      target?.focus();
      setHighlighted(n);
    },
    [turn.id, onOpenSources]
  );

  const handleOpenSources = (event: React.MouseEvent<HTMLButtonElement>) =>
    onOpenSources?.(turn.id, undefined, event.currentTarget);

  const handleFollowUp = (event: React.MouseEvent<HTMLButtonElement>) =>
    onFollowUp?.(event.currentTarget.value);

  const hasBlocks = turn.blocks.length > 0;
  const segments = React.useMemo(() => answerSegments(turn), [turn]);
  const notCovered = isNotCovered(turn);
  const verification = notCovered ? undefined : verificationOf(turn);
  const followUps = React.useMemo(
    // Only the newest answer suggests follow-ups; older ones would repeat.
    () => (notCovered || !isLast ? [] : followUpSuggestions(turn)),
    [turn, notCovered, isLast]
  );

  return (
    <Section aria-label={turn.question}>
      <Question>{turn.question}</Question>
      {/* Phase text lives outside the aria-busy answer region so it is announced. */}
      {active && (
        <Phase>
          <span role="status">
            {turn.status === "searching"
              ? t("Searching your documents…")
              : t("Writing answer…")}
          </span>
          {isLast && (
            <Button type="button" neutral onClick={onStop}>
              {t("Stop")}
            </Button>
          )}
        </Phase>
      )}
      <Answer aria-live="polite" aria-busy={active}>
        <Heading ref={headingRef} tabIndex={-1}>
          {t("Answer")}
        </Heading>
        {turn.notice && <Muted>{noticeMessage(turn.notice, t)}</Muted>}
        {!!turn.sources?.length && !cited.length && active && (
          <Details>
            <summary>
              {t("Sources ({{ count }})", { count: turn.sources.length })}
            </summary>
            <SourceList>
              {turn.sources.map((source) => (
                <li key={source.n}>
                  <SourceEntry
                    n={source.n}
                    title={source.title}
                    sections={[{ url: source.url }]}
                    collectionName={source.collectionName}
                  />
                </li>
              ))}
            </SourceList>
          </Details>
        )}
        {segments.map((segment, i) =>
          segment.type === "hidden" ? (
            <Hidden key={`hidden-${i}`} role="note">
              {t(
                "This part is no longer available because a source changed or you no longer have access."
              )}
            </Hidden>
          ) : (
            <AnswerBody
              key={`blocks-${i}`}
              blocks={segment.blocks}
              previews={previews}
              onCitationClick={handleCitationClick}
            />
          )
        )}
        {verification && (
          <Meta data-state={verification.state}>
            {verification.state === "verified"
              ? verifiedText(verification.documents, verification.cited, t)
              : t("Not fully verified")}
          </Meta>
        )}
        {cited.length > 0 && (
          <div data-print-only={onOpenSources ? true : undefined}>
            <SourcesHeading>{t("Sources")}</SourcesHeading>
            <SourceList>
              {cited.map((source) => (
                <li
                  key={source.n}
                  id={`source-${turn.id}-${source.n}`}
                  tabIndex={-1}
                  data-highlighted={highlighted === source.n || undefined}
                >
                  <SourceEntry {...source} />
                </li>
              ))}
            </SourceList>
          </div>
        )}
        {turn.status === "stopped" && <Message>{t("Stopped")}</Message>}
        {notCovered && (
          <NotCovered role="note">
            <strong>{t("Not covered by your documents")}</strong>
            <span>
              {scopeLabels.length
                ? t("Searched in: {{ scope }}.", {
                    scope: scopeLabels.join(", "),
                  })
                : t("Searched in: all documents.")}
            </span>
            <span>
              {t("Try rephrasing, or widen the search by removing a filter.")}
            </span>
          </NotCovered>
        )}
        {turn.problem && !notCovered && (
          <Message>
            {problemMessage(turn, hasBlocks, t)}
            {isLast && RETRYABLE.includes(turn.problem) && (
              <>
                {" "}
                <Button type="button" neutral onClick={handleRetry}>
                  {t("Try again")}
                </Button>
              </>
            )}
          </Message>
        )}
      </Answer>
      {turn.status === "done" && hasBlocks && (
        <CopyActions data-print-hidden>
          {onOpenSources && cited.length > 0 && (
            <Button type="button" neutral onClick={handleOpenSources}>
              {t("Sources ({{ count }})", { count: cited.length })}
            </Button>
          )}
          <CopyToClipboard
            text={turnToMarkdown(turn, {
              includeQuestion: false,
              includeSources: true,
            })}
            onCopy={handleCopied}
          >
            <Button type="button" neutral>
              {t("Copy answer")}
            </Button>
          </CopyToClipboard>
        </CopyActions>
      )}
      {onFollowUp && followUps.length > 0 && (
        <Chips data-print-hidden aria-label={t("Follow-up suggestions")}>
          {followUps.map((followUp) => {
            const label =
              followUp.kind === "more"
                ? t("Tell me more about {{ heading }}", {
                    heading: followUp.heading,
                  })
                : t("Compare these documents");
            return (
              <li key={label}>
                <Chip type="button" value={label} onClick={handleFollowUp}>
                  {label}
                </Chip>
              </li>
            );
          })}
        </Chips>
      )}
      {onRate && canRate(turn) && <FeedbackBar turn={turn} onRate={onRate} />}
    </Section>
  );
}

function FeedbackBar({
  turn,
  onRate,
}: {
  turn: Turn;
  onRate: (turnId: number, rating: Rating) => void;
}) {
  const { t } = useTranslation();
  const feedback = turn.feedback;
  const handleHelpful = () => onRate(turn.id, "up");
  const handleNotHelpful = () => onRate(turn.id, "down");
  const pending = !!feedback?.pending;
  let message = "";
  if (feedback?.error === "rateLimited") {
    message = t("Too many requests, try again in a minute.");
  } else if (feedback?.error) {
    message = t("Couldn't save your feedback. Try again.");
  } else if (feedback?.saved && feedback.rating) {
    message = t("Thanks for the feedback");
  }

  return (
    <Feedback>
      <Rate
        label={t("Helpful")}
        pressed={feedback?.rating === "up"}
        disabled={pending}
        onClick={handleHelpful}
      >
        <ThumbsUpIcon size={20} />
      </Rate>
      <Rate
        label={t("Not helpful")}
        pressed={feedback?.rating === "down"}
        disabled={pending}
        onClick={handleNotHelpful}
      >
        <ThumbsDownIcon size={20} />
      </Rate>
      {/* Always rendered so announcements are reliable; outside the answer region. */}
      <Muted as="span" role="status">
        {message}
      </Muted>
    </Feedback>
  );
}

function Rate({
  label,
  pressed,
  disabled,
  onClick,
  children,
}: {
  label: string;
  pressed: boolean;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip content={label}>
      <RateButton
        type="button"
        aria-pressed={pressed}
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
      >
        {children}
      </RateButton>
    </Tooltip>
  );
}

function verifiedText(
  documents: number | undefined,
  cited: number,
  t: (key: string, options?: Record<string, unknown>) => string
): string {
  const parts = [t("Verified")];
  // Explicit singulars: the locale files carry no plural forms for these.
  if (documents === 1) {
    parts.push(t("Based on 1 document"));
  } else if (documents) {
    parts.push(t("Based on {{ count }} documents", { count: documents }));
  }
  parts.push(
    cited === 1
      ? t("1 source cited")
      : t("{{ count }} sources cited", { count: cited })
  );
  return parts.join(" · ");
}

/**
 * Localised text for a server notice code. The server's own English message
 * is never shown; unknown codes get a generic note.
 */
function noticeMessage(code: string, t: (key: string) => string): string {
  switch (code) {
    case "conversation_new":
      return t(
        "Started a new conversation: the earlier one is no longer available."
      );
    case "history_unavailable":
      return t(
        "Earlier messages in this conversation aren't available, so this answer doesn't use them."
      );
    default:
      return t("This conversation is continuing with limited context.");
  }
}

function problemMessage(
  turn: Turn,
  partial: boolean,
  t: (key: string, options?: Record<string, unknown>) => string
): string {
  switch (turn.problem) {
    case "unverified":
      return partial
        ? t(
            "Couldn't fully verify this answer. The part shown above was verified, the rest was withheld."
          )
        : t(
            "Couldn't fully verify this answer. No part of it could be backed by your documents."
          );
    case "no_answer":
      return t("The documents don't answer this question.");
    case "budget":
      return t(
        "AI answers have reached this workspace's monthly limit. Ask an admin or try again later."
      );
    case "quota":
      return t(
        "You've reached your daily AI limit. It resets at midnight UTC."
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
      return turn.retryAfter
        ? t("Too many requests, try again in {{ seconds }} seconds.", {
            seconds: turn.retryAfter,
          })
        : t("Too many requests, try again in a minute.");
    case "network":
      return t("Couldn't reach the server. Check your connection.");
    default:
      return t("Something went wrong while answering.");
  }
}

/**
 * One cited source: numbered title link, collection and the cited excerpts
 * with their section links. Used by the inline list and the Sources drawer.
 *
 * @param props.n the citation number.
 * @param props.title the source title (untrusted text).
 * @param props.sections cited sections.
 * @param props.collectionName the collection, if any.
 * @returns the entry content.
 */
export function SourceEntry({
  n,
  title,
  sections,
  collectionName,
}: {
  n: number;
  title: string;
  sections: CitedSection[];
  collectionName?: string;
}) {
  const { t } = useTranslation();
  const [first] = sections;
  const multiple = sections.length > 1;
  return (
    <>
      <SourceNumber>[{n}]</SourceNumber>{" "}
      {first !== undefined && isDocPath(first.url) ? (
        <Link to={first.url}>{title}</Link>
      ) : (
        <span>{title}</span>
      )}
      {collectionName && <Muted as="span"> · {collectionName}</Muted>}
      {sections.map((section, i) => {
        if (!section.quote && !multiple) {
          return null;
        }
        const label =
          sectionLabel(section.url) ??
          t("Section {{ number }}", { number: i + 1 });
        return (
          <SectionEntry key={section.url}>
            {multiple &&
              // The title already links to the first section.
              (i > 0 && isDocPath(section.url) ? (
                <Link to={section.url}>{label}</Link>
              ) : (
                <span>{label}</span>
              ))}
            {section.quote && (
              <CitationQuote quote={section.quote} expandable />
            )}
          </SectionEntry>
        );
      })}
    </>
  );
}

const SectionEntry = styled.div`
  margin: 4px 0 0 18px;
  font-size: 13px;
`;

const CopyActions = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 8px 0 0;
`;

const Meta = styled.p`
  margin: 12px 0 0;
  color: ${s("textSecondary")};
  font-size: 13px;

  &[data-state="verified"]::before {
    content: "✓ ";
    color: ${s("accent")};
  }
`;

const NotCovered = styled.p`
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 12px 0;
  padding: 12px 14px;
  border-inline-start: 3px solid ${s("divider")};
  border-radius: 6px;
  background: ${s("backgroundSecondary")};
  color: ${s("textSecondary")};
  font-size: 14px;

  strong {
    color: ${s("text")};
  }
`;

const Chips = styled.ul`
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 12px 0 0;
  padding: 0;
  list-style: none;
`;

const Chip = styled.button`
  padding: 6px 12px;
  border: 1px solid ${s("divider")};
  border-radius: 16px;
  background: ${s("background")};
  color: ${s("text")};
  font: inherit;
  font-size: 13px;
  text-align: start;
  cursor: var(--pointer);

  &:hover,
  &:focus-visible {
    background: ${s("backgroundSecondary")};
  }
`;

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

const Phase = styled.div`
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

const Hidden = styled.p`
  margin: 8px 0;
  padding: 8px 12px;
  border-inline-start: 3px solid ${s("divider")};
  color: ${s("textTertiary")};
  font-size: 14px;
  font-style: italic;
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

  li[data-highlighted] {
    background: ${s("backgroundSecondary")};
    border-radius: 6px;
  }
`;

const SourceNumber = styled.span`
  color: ${s("textSecondary")};
  font-variant-numeric: tabular-nums;
`;

const Feedback = styled.div`
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
  margin: 8px 0 0;
`;

const RateButton = styled.button`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: none;
  color: ${s("textSecondary")};
  cursor: var(--pointer);

  &:hover:not(:disabled),
  &:focus-visible {
    background: ${s("backgroundSecondary")};
    color: ${s("text")};
  }

  &[aria-pressed="true"] {
    border-color: ${s("accent")};
    color: ${s("accent")};
  }

  &:disabled {
    opacity: 0.5;
    cursor: default;
  }

  svg {
    fill: currentColor;
  }
`;
