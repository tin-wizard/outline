import * as React from "react";
import { useTranslation } from "react-i18next";
import styled from "styled-components";
import { s } from "@shared/styles";

/** Quotes longer than this get a show more toggle. */
const EXPAND_THRESHOLD = 180;

interface Props {
  /** The cited passage; untrusted, rendered as text only. */
  quote: string;
  /** Lines shown before the quote is clamped. */
  lines?: number;
  /** Whether long quotes can be expanded; previews stay clamped. */
  expandable?: boolean;
  /** Marks the quote as the cited passage. */
  highlight?: boolean;
}

/**
 * A cited passage as a blockquote, clamped with an optional expand toggle.
 *
 * @param props.quote the passage text.
 * @param props.lines clamp height in lines.
 * @param props.expandable whether a show more toggle is offered.
 * @param props.highlight whether the passage is marked.
 * @returns the excerpt.
 */
export function CitationQuote({
  quote,
  lines = 3,
  expandable,
  highlight,
}: Props) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = React.useState(false);
  const handleToggle = () => setExpanded((value) => !value);
  const long = quote.length > EXPAND_THRESHOLD;

  return (
    <>
      <Quote $lines={expanded ? 0 : lines}>
        {highlight ? <Mark>{quote}</Mark> : quote}
      </Quote>
      {expandable && long && (
        <Toggle type="button" aria-expanded={expanded} onClick={handleToggle}>
          {expanded ? t("Show less") : t("Show more")}
        </Toggle>
      )}
    </>
  );
}

const Quote = styled.blockquote<{ $lines: number }>`
  margin: 4px 0 0;
  padding: 0 0 0 10px;
  border-left: 3px solid ${s("divider")};
  color: ${s("textSecondary")};
  font-size: 13px;
  line-height: 1.45;
  overflow-wrap: anywhere;
  white-space: pre-wrap;

  ${(props) =>
    props.$lines
      ? `display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: ${props.$lines};
  overflow: hidden;`
      : ""}
`;

const Mark = styled.mark`
  background: ${s("textHighlight")};
  color: ${s("textHighlightForeground")};
  border-radius: 2px;
  padding: 0 1px;
`;

const Toggle = styled.button`
  margin: 2px 0 0 13px;
  padding: 0;
  border: 0;
  background: none;
  color: ${(props) => props.theme.accent};
  font-size: 12px;
  cursor: var(--pointer);

  &:focus-visible {
    outline: 2px solid ${s("accent")};
  }
`;
