import * as React from "react";
import { useTranslation } from "react-i18next";
import styled from "styled-components";
import { s } from "@shared/styles";
import type { AskSource } from "~/utils/streamFetch";
import { formatWhen } from "./dates";
import { TAG_COLORS, tagColor } from "./compare";

interface Props {
  sources: AskSource[];
  /** Letter by source number, from `compareLetters`. */
  letters: ReadonlyMap<number, string>;
}

/**
 * The documents of a comparison side by side above its table: letter tag,
 * title, collection and last update of each. All text is shown as text.
 *
 * @param props see Props.
 * @returns the cards, or null when fewer than two documents are lettered.
 */
export function CompareCards({ sources, letters }: Props) {
  const { t, i18n } = useTranslation();
  const cards = sources
    .flatMap((source) => {
      const letter = letters.get(source.n);
      return letter ? [{ source, letter }] : [];
    })
    .sort((a, b) => a.letter.localeCompare(b.letter));
  if (cards.length < 2) {
    return null;
  }
  return (
    <List aria-label={t("Documents compared")}>
      {cards.map(({ source, letter }) => {
        const when = formatWhen(source.updatedAt, i18n.language);
        return (
          <Card key={source.n}>
            <Tag $color={tagColor(letter)} aria-hidden>
              {letter}
            </Tag>
            <Body>
              <Title>
                <span className="sr-only">
                  {t("Document {{ letter }}:", { letter })}{" "}
                </span>
                {source.title}
              </Title>
              {(source.collectionName || when) && (
                <Meta>
                  {source.collectionName && (
                    <span>{source.collectionName}</span>
                  )}
                  {when && (
                    <span>{t("Updated {{ date }}", { date: when })}</span>
                  )}
                </Meta>
              )}
            </Body>
          </Card>
        );
      })}
    </List>
  );
}

const List = styled.ul`
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 8px;
  margin: 0 0 10px;
  padding: 0;
  list-style: none;
`;

const Card = styled.li`
  display: flex;
  align-items: flex-start;
  gap: 8px;
  min-width: 0;
  padding: 10px 12px;
  border-radius: 10px;
  box-shadow: inset 0 0 0 1px ${s("divider")};
`;

export const Tag = styled.span<{ $color: (typeof TAG_COLORS)[number] }>`
  flex: none;
  display: inline-grid;
  place-items: center;
  width: 18px;
  height: 18px;
  margin-top: 2px;
  border-radius: 4px;
  background: ${(props) => props.theme[props.$color]};
  color: ${s("background")};
  font-size: 11px;
  font-weight: 700;
  line-height: 1;
`;

const Body = styled.div`
  min-width: 0;
`;

const Title = styled.b`
  display: block;
  overflow-wrap: anywhere;
  font-weight: 600;

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
`;

const Meta = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  color: ${s("textTertiary")};
  font-size: 12px;
`;
