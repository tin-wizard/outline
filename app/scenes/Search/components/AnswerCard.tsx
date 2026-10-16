import * as React from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import styled from "styled-components";
import { s } from "@shared/styles";
import type { DateFilter, StatusFilter } from "@shared/types";
import { TeamPreference } from "@shared/types";
import Text from "~/components/Text";
import useCurrentTeam from "~/hooks/useCurrentTeam";
import env from "~/env";
import { client } from "~/utils/ApiClient";

interface Props {
  /** The search query, asked as a question. */
  query: string;
  /** Limit the answer to documents in this collection. */
  collectionId?: string;
  /** Limit the answer to this document and its children. */
  documentId?: string;
  /** Limit the answer to documents edited by this user. */
  userId?: string;
  /** Limit the answer to documents updated within this period. */
  dateFilter?: DateFilter;
  /** Limit the answer to documents in these statuses. */
  statusFilter?: StatusFilter[];
}

interface Citation {
  documentId: string;
  title: string;
  url: string;
  heading?: string;
}

interface AnswerResponse {
  answer?: string | null;
  citations?: Citation[];
}

interface State {
  answer: string | null;
  citations: Citation[];
}

/**
 * Shows an AI generated answer, with its sources, above search results.
 * Renders nothing when AI answers are off, while loading, or when no answer
 * could be found.
 *
 * @param props.query the question.
 * @param props.collectionId optional collection scope.
 * @param props.documentId optional document scope.
 * @param props.userId optional author filter.
 * @param props.dateFilter optional recency filter.
 * @param props.statusFilter optional status filter.
 * @returns the card, or null.
 */
export function AnswerCard({
  query,
  collectionId,
  documentId,
  userId,
  dateFilter,
  statusFilter,
}: Props) {
  const { t } = useTranslation();
  const team = useCurrentTeam();
  const enabled =
    env.AI_ANSWERS_ENABLED === true &&
    team.getPreference(TeamPreference.AIAnswers);
  // Keyed on the serialized value so a new array with the same contents does
  // not refetch.
  const statusKey = statusFilter?.join(",") ?? "";
  const [state, setState] = React.useState<State | null>(null);

  React.useEffect(() => {
    setState(null);
    if (!enabled || !query) {
      return;
    }

    let cancelled = false;
    client
      .post<AnswerResponse>("/documents.answerQuestion", {
        query,
        collectionId,
        documentId,
        userId,
        dateFilter,
        statusFilter: statusKey
          ? (statusKey.split(",") as StatusFilter[])
          : undefined,
      })
      .then((res) => {
        if (!cancelled) {
          setState({
            answer: res.answer ?? null,
            citations: res.citations ?? [],
          });
        }
      })
      .catch(() => {
        // An answer is a bonus; search results stay usable without it.
      });

    return () => {
      cancelled = true;
    };
  }, [enabled, query, collectionId, documentId, userId, dateFilter, statusKey]);

  if (!state?.answer) {
    return null;
  }

  return (
    <Card role="region" aria-label={t("AI generated answer")}>
      <Text type="tertiary" size="xsmall">
        {t("AI generated answer based on related documents in your workspace")}
      </Text>
      <Answer as="p" selectable>
        {state.answer}
      </Answer>
      {state.citations.length > 0 ? (
        <>
          <Text type="secondary" size="small" weight="bold">
            {t("References")}
          </Text>
          <Sources>
            {state.citations.map((citation) => (
              <li key={`${citation.documentId}-${citation.heading ?? ""}`}>
                <Link to={citation.url}>
                  {citation.title}
                  {citation.heading ? ` › ${citation.heading}` : ""}
                </Link>
              </li>
            ))}
          </Sources>
        </>
      ) : null}
    </Card>
  );
}

const Card = styled.div`
  margin: 16px 0;
  padding: 16px;
  border: 1px solid ${s("divider")};
  border-radius: 8px;
`;

const Answer = styled(Text)`
  white-space: pre-wrap;
  margin: 8px 0 12px;
`;

const Sources = styled.ul`
  margin: 4px 0 0;
  padding-left: 20px;
`;
