import { InfoIcon } from "outline-icons";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { searchPath } from "~/utils/routeHelpers";
import { AnswerBody } from "./AnswerBody";
import { isDocPath } from "./docPath";
import type { Turn } from "./model";
import { citedSources } from "./model";
import { ActionLink, Detail, NoticeCard } from "./NoticeCard";

type Block = Turn["blocks"][number];

interface GapProps {
  turn: Turn;
  /** The gap statement the verifier released; shown as text. */
  block: Block;
  /** Show the actions (open the cited document, search): once per answer. */
  withActions?: boolean;
}

/**
 * A gap statement ("The documents do not cover …") in the calm notice style
 * instead of normal prose. The text is the model's sentence, released by the
 * verifier, rendered like any answer block.
 *
 * @param props see GapProps.
 * @returns the card.
 */
export function GapNotice({ turn, block, withActions }: GapProps) {
  const { t } = useTranslation();
  const [first] = citedSources(turn);
  const openable =
    first && isDocPath(first.sections[0]?.url ?? "") ? first : undefined;
  return (
    <NoticeCard
      gap
      role="note"
      icon={<InfoIcon size={20} />}
      actions={
        withActions ? (
          <>
            {openable && (
              <ActionLink to={openable.sections[0].url}>
                {t("Open {{ title }}", { title: openable.title })}
              </ActionLink>
            )}
            <ActionLink to={searchPath({ query: turn.question })}>
              {t("Search instead")}
            </ActionLink>
          </>
        ) : undefined
      }
    >
      <AnswerBody blocks={[block]} />
    </NoticeCard>
  );
}

interface NotCoveredProps {
  turn: Turn;
  /** Names of the scope the question was sent with (this session). */
  scopeLabels: string[];
  /** Gap statements the answer carried, shown inside the card. */
  gaps: Block[];
}

/**
 * The card for an answer the documents do not cover: what was searched, a
 * tip and a way to search instead. It never claims how many documents were
 * checked.
 *
 * @param props see NotCoveredProps.
 * @returns the card.
 */
export function NotCoveredNotice({ turn, scopeLabels, gaps }: NotCoveredProps) {
  const { t } = useTranslation();
  const stored = turn.storedScope;
  const names = [
    ...scopeLabels,
    ...(stored?.collections.flatMap((c) => (c.name ? [c.name] : [])) ?? []),
    ...(stored?.documents.flatMap((d) => (d.title ? [d.title] : [])) ?? []),
  ];
  const hidden =
    !!stored &&
    !names.length &&
    stored.collections.length + stored.documents.length > 0;
  return (
    <NoticeCard
      gap
      role="note"
      icon={<InfoIcon size={20} />}
      actions={
        <ActionLink to={searchPath({ query: turn.question })}>
          {t("Search instead")}
        </ActionLink>
      }
    >
      <p>
        <b>{t("Not covered by your documents")}</b>
      </p>
      {gaps.length > 0 && <AnswerBody blocks={gaps} />}
      <Detail>
        {names.length
          ? t("Searched in: {{ scope }}.", { scope: names.join(", ") })
          : hidden
            ? t("Searched in: the scope you chose.")
            : t("Searched in: all documents.")}
      </Detail>
      <Detail>
        {t("Try rephrasing, or widen the search by removing a filter.")}
      </Detail>
    </NoticeCard>
  );
}
