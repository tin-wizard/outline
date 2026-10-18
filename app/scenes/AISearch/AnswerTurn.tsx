import { ArrowIcon, CheckmarkIcon, SparklesIcon } from "outline-icons";
import * as React from "react";
import { Trans, useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { transparentize } from "polished";
import styled, { keyframes } from "styled-components";
import { breakpoints, s } from "@shared/styles";
import Button from "~/components/Button";
import PlaceholderText from "~/components/PlaceholderText";
import {
  answerParts,
  followUpSuggestions,
  gapBlocks,
  isNotCovered,
  verificationOf,
} from "./answerInsights";
import { AnswerActions } from "./AnswerActions";
import { AnswerBody } from "./AnswerBody";
import { AnswerMeta } from "./AnswerMeta";
import type { CitationPreviewData } from "./CitationPreview";
import { CitationQuote } from "./CitationQuote";
import { isDocPath } from "./docPath";
import { turnToMarkdown } from "./exportMarkdown";
import { GapNotice, NotCoveredNotice } from "./GapNotice";
import type { CitedSection, Rating, ReportReason, Turn } from "./model";
import { citedSources, isActive, sectionHeading } from "./model";
import { ProblemNotice } from "./ProblemNotice";

export { isDocPath } from "./docPath";

interface Props {
  turn: Turn;
  /** Whether this is the newest turn: it gets Stop, retry and focus handling. */
  isLast: boolean;
  /** Names of the collection and document the question was scoped to. */
  scopeLabels: string[];
  onStop: () => void;
  onRetry: (turn: Turn) => void;
  /** Asks again without the scope, after the server refused the scope. */
  onRetryUnscoped?: (turn: Turn) => void;
  /** Sets or clears helpful / not helpful for a finished answer. */
  onRate?: (turnId: number, rating: Rating) => void;
  /** Reports an answer as not helpful with a reason; resolves true when saved. */
  onReport?: (
    turnId: number,
    reason: ReportReason,
    comment?: string
  ) => Promise<boolean>;
  /**
   * Opens the Sources drawer for this answer (optionally at one source). When
   * given, citation markers open the drawer instead of scrolling to the inline
   * list, which is then only shown in print.
   */
  onOpenSources?: (turnId: number, n?: number, opener?: HTMLElement) => void;
  /** The Sources drawer is open on this answer. */
  sourcesOpen?: boolean;
  /** Closes the Sources drawer; the sources button toggles with it. */
  onCloseSources?: () => void;
  /** Receives a follow-up suggestion to place in the composer. */
  onFollowUp?: (text: string) => void;
}

/**
 * One question with its streamed answer: progress, verification, verified
 * blocks, actions and any problem shown next to what was verified.
 *
 * @param props.turn the turn to show.
 * @param props.isLast whether it is the newest turn.
 * @param props.scopeLabels names of the scope searched.
 * @param props.onStop stops the running turn.
 * @param props.onRetry asks the question again.
 * @param props.onRetryUnscoped asks again without the scope.
 * @param props.onRate sends helpful / not helpful feedback.
 * @param props.onReport sends a report of an inaccurate answer.
 * @param props.onOpenSources opens the Sources drawer.
 * @param props.sourcesOpen whether the drawer shows this answer.
 * @param props.onCloseSources closes the drawer.
 * @param props.onFollowUp fills the composer with a suggestion.
 * @returns the turn.
 */
export function AnswerTurn({
  turn,
  isLast,
  scopeLabels,
  onStop,
  onRetry,
  onRetryUnscoped,
  onRate,
  onReport,
  onOpenSources,
  sourcesOpen,
  onCloseSources,
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
        cited.map((source) => {
          const section = source.sections.find((x) => x.quote);
          return [
            source.n,
            {
              title: source.title,
              collectionName: source.collectionName,
              collectionColor: source.collectionColor,
              updatedAt: source.updatedAt,
              updatedByName: source.updatedByName,
              quote: section?.quote,
              heading: section ? sectionHeading(section) : undefined,
              url: section?.url,
              count: source.count,
            },
          ];
        })
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

  const handleToggleSources = (event: React.MouseEvent<HTMLButtonElement>) => {
    if (sourcesOpen && onCloseSources) {
      onCloseSources();
    } else {
      onOpenSources?.(turn.id, undefined, event.currentTarget);
    }
  };

  const handleFollowUp = (event: React.MouseEvent<HTMLButtonElement>) =>
    onFollowUp?.(event.currentTarget.value);

  const hasBlocks = turn.blocks.length > 0;
  const notCovered = isNotCovered(turn);
  const parts = React.useMemo(
    () => answerParts(turn, notCovered),
    [turn, notCovered]
  );
  const gaps = React.useMemo(() => gapBlocks(turn), [turn]);
  const verification = notCovered ? undefined : verificationOf(turn);
  const followUps = React.useMemo(
    // Only the newest answer suggests follow-ups; older ones would repeat.
    () => (notCovered || !isLast ? [] : followUpSuggestions(turn)),
    [turn, notCovered, isLast]
  );
  const searched = turn.status !== "searching" || turn.sources !== null;
  const read = turn.sources?.length ?? 0;

  return (
    <Section aria-label={turn.question}>
      <Question>{turn.question}</Question>
      <Layout>
        <Avatar aria-hidden>
          <SparklesIcon size={18} />
        </Avatar>
        <Content>
          {/* Progress lives outside the aria-busy answer region so it is announced. */}
          {active && (
            <Progress>
              <Steps>
                {searched && (
                  <li>
                    <CheckmarkIcon size={18} />
                    {scopeLabels.length
                      ? t("Searched your documents in {{ scope }}", {
                          scope: scopeLabels.join(", "),
                        })
                      : t("Searched your documents")}
                  </li>
                )}
                {read > 0 && (
                  <li>
                    <CheckmarkIcon size={18} />
                    {read === 1
                      ? t("Read 1 document")
                      : t("Read {{ count }} documents", { count: read })}
                  </li>
                )}
                <li data-now>
                  <span role="status">
                    {turn.status === "searching"
                      ? t("Searching your documents")
                      : t("Writing and checking each statement")}
                  </span>
                  <Dots />
                </li>
              </Steps>
              {isLast && (
                <Button type="button" neutral onClick={onStop}>
                  {t("Stop")}
                </Button>
              )}
            </Progress>
          )}
          {!active && (
            <AnswerMeta
              verification={verification}
              cited={cited}
              sourcesOpen={sourcesOpen}
              onToggleSources={onOpenSources ? handleToggleSources : undefined}
            />
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
                        count={0}
                      />
                    </li>
                  ))}
                </SourceList>
              </Details>
            )}
            {parts.map((part, i) => {
              switch (part.type) {
                case "hidden":
                  return (
                    <Hidden key={`hidden-${i}`} role="note">
                      {t(
                        "This part is no longer available because a source changed or you no longer have access."
                      )}
                    </Hidden>
                  );
                case "gap":
                  return (
                    <GapNotice
                      key={`gap-${part.block.index}`}
                      turn={turn}
                      block={part.block}
                      withActions={part.block === gaps[0]}
                    />
                  );
                default:
                  return (
                    <AnswerBody
                      key={`blocks-${i}`}
                      blocks={part.blocks}
                      previews={previews}
                      onCitationClick={handleCitationClick}
                    />
                  );
              }
            })}
            {active && hasBlocks && <Caret aria-hidden />}
            {active && (
              <Skeleton aria-hidden>
                <PlaceholderText />
                <PlaceholderText delay={0.2} />
              </Skeleton>
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
              <NotCoveredNotice
                turn={turn}
                scopeLabels={scopeLabels}
                gaps={gaps}
              />
            )}
            {turn.problem && !notCovered && (
              <ProblemNotice
                turn={turn}
                isLast={isLast}
                onRetry={onRetry}
                onRetryUnscoped={onRetryUnscoped}
              />
            )}
          </Answer>
          {active && isLast && (
            <Footnote data-print-hidden>
              <Trans
                defaults="Only statements that pass verification are shown. Press <1>Esc</1> to stop."
                components={{ 1: <Kbd /> }}
              />
            </Footnote>
          )}
          {turn.status === "done" && hasBlocks && (
            <AnswerActions
              turn={turn}
              markdown={turnToMarkdown(turn, {
                includeQuestion: false,
                includeSources: true,
              })}
              onRate={onRate}
              onReport={onReport}
            />
          )}
          {onFollowUp && followUps.length > 0 && (
            <AskNext data-print-hidden>
              <AskNextLabel id={`ask-next-${turn.id}`}>
                {t("Ask next")}
              </AskNextLabel>
              <Chips aria-labelledby={`ask-next-${turn.id}`}>
                {followUps.map((followUp) => {
                  const label =
                    followUp.kind === "more"
                      ? t("Tell me more about {{ heading }}", {
                          heading: followUp.heading,
                        })
                      : t("Compare these documents");
                  return (
                    <li key={label}>
                      <Chip
                        type="button"
                        value={label}
                        onClick={handleFollowUp}
                      >
                        <ArrowIcon size={16} />
                        {label}
                      </Chip>
                    </li>
                  );
                })}
              </Chips>
            </AskNext>
          )}
        </Content>
      </Layout>
    </Section>
  );
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
  /** Accepted so a `CitedSource` can be spread; not shown here. */
  count?: number;
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
          sectionHeading(section) ??
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

// An article, not a section: a long chat would add one landmark per answer.
const Section = styled.article`
  margin: 28px 0;
`;

const Question = styled.p`
  margin: 0 0 14px auto;
  padding: 10px 16px;
  max-width: 85%;
  width: fit-content;
  border-radius: 16px;
  background: ${s("backgroundSecondary")};
  color: ${s("text")};
  overflow-wrap: anywhere;
  white-space: pre-wrap;
`;

const Layout = styled.div`
  display: flex;
  align-items: flex-start;
  gap: 14px;
`;

const Avatar = styled.span`
  flex: none;
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: 8px;
  background: ${(props) => transparentize(0.88, props.theme.accent)};
  color: ${s("accent")};

  svg {
    fill: currentColor;
  }

  @media (max-width: ${breakpoints.tablet - 1}px) {
    display: none;
  }
`;

const Content = styled.div`
  flex: 1;
  min-width: 0;
`;

const Answer = styled.div`
  color: ${s("text")};
`;

// Visually hidden, but still the focus target and the landmark heading.
const Heading = styled.h2`
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;

  &:focus {
    outline: none;
  }
`;

const Progress = styled.div`
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin: 4px 0 12px;
  color: ${s("textSecondary")};
`;

const Steps = styled.ol`
  display: grid;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: 13.5px;

  li {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  svg {
    fill: ${(props) => props.theme.success};
  }

  li[data-now] {
    color: ${s("text")};
    font-weight: 500;
  }
`;

const blink = keyframes`
  0%, 80%, 100% { opacity: 0.25; }
  40% { opacity: 1; }
`;

/** Three dots that pulse in turn; static when the user prefers less motion. */
const DotsWrap = styled.span`
  display: inline-flex;
  gap: 3px;

  i {
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: currentColor;
  }

  @media (prefers-reduced-motion: no-preference) {
    i {
      animation: ${blink} 1.2s infinite;
    }

    i:nth-child(2) {
      animation-delay: 0.2s;
    }

    i:nth-child(3) {
      animation-delay: 0.4s;
    }
  }
`;

function Dots() {
  return (
    <DotsWrap aria-hidden>
      <i />
      <i />
      <i />
    </DotsWrap>
  );
}

const caretBlink = keyframes`
  50% { opacity: 0; }
`;

const Caret = styled.span`
  display: inline-block;
  width: 8px;
  height: 17px;
  margin-top: 4px;
  border-radius: 2px;
  background: ${s("accent")};

  @media (prefers-reduced-motion: no-preference) {
    animation: ${caretBlink} 1s steps(2) infinite;
  }
`;

const Skeleton = styled.div`
  max-width: 520px;
  margin-top: 14px;
`;

const Footnote = styled.p`
  margin: 14px 0 0;
  color: ${s("textTertiary")};
  font-size: 12.5px;
`;

const Kbd = styled.kbd`
  padding: 0 5px;
  border-radius: 4px;
  box-shadow: inset 0 0 0 1px ${s("inputBorder")};
  font: inherit;
  font-size: 11.5px;
`;

const AskNext = styled.div`
  margin-top: 18px;
`;

const AskNextLabel = styled.div`
  margin-bottom: 8px;
  color: ${s("textTertiary")};
  font-size: 12.5px;
`;

const Chips = styled.ul`
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
`;

const Chip = styled.button`
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border: 0;
  border-radius: 16px;
  box-shadow: inset 0 0 0 1px ${s("inputBorder")};
  background: none;
  color: ${s("textSecondary")};
  font: inherit;
  font-size: 13.5px;
  text-align: start;
  cursor: var(--pointer);

  svg {
    flex: none;
    fill: currentColor;
  }

  &:hover,
  &:focus-visible {
    background: ${s("backgroundSecondary")};
    color: ${s("text")};
  }
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
  color: ${s("textSecondary")};
  font-size: 14px;
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
