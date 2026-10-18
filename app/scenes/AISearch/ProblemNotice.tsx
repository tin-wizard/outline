import {
  ClockIcon,
  CloudIcon,
  InfoIcon,
  PadlockIcon,
  WarningIcon,
} from "outline-icons";
import * as React from "react";
import { useTranslation } from "react-i18next";
import Button from "~/components/Button";
import { searchPath } from "~/utils/routeHelpers";
import { formatWhen } from "./dates";
import type { Turn, TurnProblem } from "./model";
import { ActionLink, Detail, NoticeCard } from "./NoticeCard";
import type { Tone } from "./tones";

const RETRYABLE: TurnProblem[] = [
  "error",
  "timeout",
  "unavailable",
  "network",
  "cancelled",
  "rateLimited",
];

interface Props {
  turn: Turn;
  /** Whether this is the newest turn; only it can be retried. */
  isLast: boolean;
  onRetry: (turn: Turn) => void;
  /** Asks again without the scope, for a scope the user may not use. */
  onRetryUnscoped?: (turn: Turn) => void;
}

interface Content {
  tone?: Tone;
  icon: React.ReactNode;
  title: string;
  body?: string;
  /** Offer a search with the same words. */
  search?: boolean;
}

/**
 * The calm card for a turn that did not produce a complete answer, with
 * actions that make sense for the problem: retry, search instead, or ask again
 * without the scope. Copy never claims more than is known (nothing about
 * charges, nothing naming a scope).
 *
 * @param props see Props.
 * @returns the card, or null when the turn has no problem.
 */
export function ProblemNotice({
  turn,
  isLast,
  onRetry,
  onRetryUnscoped,
}: Props) {
  const { t, i18n } = useTranslation();
  const { problem } = turn;
  if (!problem) {
    return null;
  }
  const partial = turn.blocks.length > 0;
  const content = contentFor(turn, partial, t, i18n.language);
  const handleRetry = () => onRetry(turn);
  const handleRetryUnscoped = () => onRetryUnscoped?.(turn);

  return (
    <NoticeCard
      tone={content.tone}
      icon={content.icon}
      actions={
        <>
          {isLast && RETRYABLE.includes(problem) && (
            <Button type="button" neutral onClick={handleRetry}>
              {t("Try again")}
            </Button>
          )}
          {isLast && problem === "scope_forbidden" && onRetryUnscoped && (
            <Button type="button" neutral onClick={handleRetryUnscoped}>
              {t("Ask again without a scope")}
            </Button>
          )}
          {content.search && (
            <ActionLink to={searchPath({ query: turn.question })}>
              {t("Search instead")}
            </ActionLink>
          )}
        </>
      }
    >
      <p>
        <b>{content.title}</b>
      </p>
      {content.body && <Detail>{content.body}</Detail>}
    </NoticeCard>
  );
}

type Translate = (key: string, options?: Record<string, unknown>) => string;

function contentFor(
  turn: Turn,
  partial: boolean,
  t: Translate,
  language: string
): Content {
  switch (turn.problem) {
    case "unverified":
      return {
        tone: "warn",
        icon: <WarningIcon size={20} />,
        title: partial
          ? t(
              "Couldn't fully verify this answer. The part shown above was verified, the rest was withheld."
            )
          : t(
              "Couldn't fully verify this answer. No part of it could be backed by your documents."
            ),
      };
    case "budget": {
      // Budgets reset at a UTC boundary, so the day is shown in UTC.
      const date = formatWhen(turn.resetsAt, language, { utc: true });
      return {
        icon: <ClockIcon size={20} />,
        title: t("Your workspace has used this month's AI answers."),
        body: date
          ? t(
              "The limit resets on {{ date }}. Search still works for every document.",
              { date }
            )
          : t(
              "Ask an admin or try again later. Search still works for every document."
            ),
        search: true,
      };
    }
    case "quota": {
      const date = formatWhen(turn.resetsAt, language, { time: true });
      return {
        icon: <ClockIcon size={20} />,
        title: t("You've reached your daily AI limit."),
        body: date
          ? t("It resets on {{ date }}.", { date })
          : t("It resets at midnight UTC."),
        search: true,
      };
    }
    case "no_answer":
      return {
        icon: <InfoIcon size={20} />,
        title: t("The documents don't answer this question."),
      };
    case "scope_forbidden":
      return {
        icon: <PadlockIcon size={20} />,
        title: t("That scope isn't available to you."),
        body: t(
          "Answers never use documents you can't open. Ask again without a scope."
        ),
      };
    case "forbidden":
      return {
        icon: <PadlockIcon size={20} />,
        title: t("AI answers aren't available to your account."),
      };
    case "unavailable":
      return {
        icon: <InfoIcon size={20} />,
        title: t("AI answers are temporarily unavailable."),
        search: true,
      };
    case "timeout":
      return {
        tone: "err",
        icon: <ClockIcon size={20} />,
        title: t("This took too long."),
        body: t("Try a narrower question."),
      };
    case "cancelled":
      return {
        icon: <InfoIcon size={20} />,
        title: t("The request was cancelled."),
      };
    case "unauthorized":
      return {
        icon: <PadlockIcon size={20} />,
        title: t("Your session has expired. Sign in again."),
      };
    case "rateLimited":
      return {
        icon: <ClockIcon size={20} />,
        title: t("Too many requests."),
        body: turn.retryAfter
          ? t("You can ask again in {{ seconds }} seconds.", {
              seconds: turn.retryAfter,
            })
          : t("You can ask again in a minute."),
      };
    case "network":
      return {
        tone: "err",
        icon: <CloudIcon size={20} />,
        title: t("Couldn't reach the server."),
        body: t("Check your connection. Your question is kept."),
      };
    default:
      return {
        tone: "err",
        icon: <WarningIcon size={20} />,
        title: t("Something went wrong while answering."),
      };
  }
}
