import * as React from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import styled from "styled-components";
import { s } from "@shared/styles";
import { CitationQuote } from "./CitationQuote";
import { tagColor } from "./compare";
import { Tag } from "./CompareCards";
import { formatWhen, isStale } from "./dates";
import { isDocPath } from "./docPath";
import type { CitedSection } from "./model";
import { sectionHeading } from "./model";
import { toneColors } from "./tones";

/** What a card shows; a cited source, or one only retrieved so far. */
export interface CardSource {
  n: number;
  title: string;
  /** Link used when no section is cited yet. */
  url?: string;
  sections: CitedSection[];
  collectionName?: string;
  collectionColor?: string;
  updatedAt?: string;
  /** In how many blocks the source is cited; 0 while still streaming. */
  count: number;
}

interface Props {
  source: CardSource;
  /** DOM id, so a citation can bring the card into view. */
  id: string;
  selected?: boolean;
  /** The letter of a compared document, shown next to the number. */
  letter?: string;
}

/**
 * One source in the Sources panel: number badge, title, collection, last
 * update (flagged when old), the sections cited and the cited passages
 * highlighted. All text comes from the server and is rendered as text; links
 * only for safe document paths.
 *
 * @param props see Props.
 * @returns the card.
 */
export function SourceCard({ source, id, selected, letter }: Props) {
  const { t, i18n } = useTranslation();
  const href = source.sections[0]?.url ?? source.url ?? "";
  const when = formatWhen(source.updatedAt, i18n.language);
  const chips = source.sections.flatMap((section) => {
    const heading = sectionHeading(section);
    return heading ? [{ url: section.url, heading }] : [];
  });
  const quotes = source.sections.flatMap((section) =>
    section.quote ? [{ url: section.url, quote: section.quote }] : []
  );

  return (
    <Card
      id={id}
      tabIndex={-1}
      data-selected={selected || undefined}
      aria-current={selected || undefined}
    >
      <Top>
        <NumberBadge>{source.n}</NumberBadge>
        {letter && <Tag $color={tagColor(letter)}>{letter}</Tag>}
        {isDocPath(href) ? (
          <Link to={href}>{source.title}</Link>
        ) : (
          <span>{source.title}</span>
        )}
      </Top>
      {(source.collectionName || when) && (
        <MetaRow>
          {source.collectionName && (
            <span>
              {source.collectionColor && (
                <Dot style={{ background: source.collectionColor }} />
              )}
              {source.collectionName}
            </span>
          )}
          {when && <span>{t("Updated {{ date }}", { date: when })}</span>}
          {isStale(source.updatedAt) && (
            <Stale>{t("Not updated in 180+ days")}</Stale>
          )}
        </MetaRow>
      )}
      {chips.length > 0 && (
        <Chips>
          {chips.map((chip) =>
            isDocPath(chip.url) ? (
              <Link key={chip.url} to={chip.url}>
                § {chip.heading}
              </Link>
            ) : (
              <span key={chip.url}>§ {chip.heading}</span>
            )
          )}
        </Chips>
      )}
      {quotes.map((item) => (
        <Excerpt key={item.url}>
          <CitationQuote quote={item.quote} expandable highlight />
        </Excerpt>
      ))}
      {source.count > 0 && (
        <Count>
          {source.count === 1
            ? t("Cited once in this answer")
            : t("Cited {{ count }}× in this answer", { count: source.count })}
        </Count>
      )}
    </Card>
  );
}

const Card = styled.li`
  padding: 12px;
  border-radius: 8px;
  box-shadow: inset 0 0 0 1px ${s("divider")};
  overflow-wrap: anywhere;

  & + & {
    margin-top: 8px;
  }

  &:hover {
    background: ${s("backgroundSecondary")};
  }

  &:focus-visible {
    outline: 2px solid ${s("accent")};
    outline-offset: -2px;
  }

  &[data-selected] {
    box-shadow: inset 0 0 0 1.5px ${s("accent")};
  }
`;

const Top = styled.div`
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: 14px;
  font-weight: 600;
  line-height: 1.35;

  a {
    color: ${s("text")};
  }

  a:hover {
    text-decoration: underline;
  }
`;

const NumberBadge = styled.span`
  flex: none;
  display: grid;
  place-items: center;
  min-width: 20px;
  height: 20px;
  border-radius: 5px;
  background: ${s("backgroundSecondary")};
  color: ${s("textSecondary")};
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;

  [data-selected] > * > & {
    background: ${s("accent")};
    color: ${s("accentText")};
  }
`;

const MetaRow = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 10px;
  margin: 6px 0 0 28px;
  color: ${s("textTertiary")};
  font-size: 12.5px;

  span {
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }
`;

const Dot = styled.i`
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
`;

const Stale = styled.span`
  min-height: 18px;
  padding: 0 7px;
  border-radius: 9px;
  background: ${(props) => toneColors(props.theme, "warn").background};
  color: ${(props) => toneColors(props.theme, "warn").text};
  font-weight: 500;
`;

const Chips = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin: 8px 0 0 28px;

  a,
  span {
    padding: 1px 6px;
    border-radius: 4px;
    background: ${s("backgroundSecondary")};
    color: ${s("textSecondary")};
    font-size: 12px;
  }

  a:hover {
    color: ${s("text")};
  }
`;

const Excerpt = styled.div`
  margin: 10px 0 0 28px;
  padding: 8px 10px;
  border-radius: 6px;
  background: ${s("backgroundSecondary")};

  blockquote {
    margin: 0;
    padding: 0;
    border-left: 0;
    color: ${s("text")};
    font-size: 13.5px;
  }
`;

const Count = styled.p`
  margin: 8px 0 0 28px;
  color: ${s("textTertiary")};
  font-size: 12px;
`;
