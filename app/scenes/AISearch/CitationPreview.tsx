import { DocumentIcon } from "outline-icons";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import styled from "styled-components";
import { depths, s } from "@shared/styles";
import { CitationQuote } from "./CitationQuote";
import { formatWhen } from "./dates";
import { isDocPath } from "./docPath";

/** Plain data for a citation preview, taken from the stream's events. */
export interface CitationPreviewData {
  title: string;
  collectionName?: string;
  /** Hex colour of the collection, already validated. */
  collectionColor?: string;
  updatedAt?: string;
  updatedByName?: string;
  /** The cited passage. */
  quote?: string;
  /** Heading of the cited section, plain text. */
  heading?: string;
  /** Link to the cited section; only linked when it passes `isDocPath`. */
  url?: string;
  /** In how many blocks of the answer the source is cited. */
  count?: number;
}

interface Props {
  /** Id referenced by the marker's aria-describedby. */
  id: string;
  preview: CitationPreviewData;
}

/**
 * Card shown while a citation marker is hovered or focused: the section
 * heading, the document with its collection and last update, the cited
 * passage highlighted, how often it is cited and a link to the section. Built
 * only from data already received (no document fetch); everything is text.
 *
 * @param props.id the element id.
 * @param props.preview what to show.
 * @returns the card.
 */
export function CitationPreview({ id, preview }: Props) {
  const { t, i18n } = useTranslation();
  const ref = React.useRef<HTMLSpanElement>(null);
  const [shift, setShift] = React.useState(0);

  // Keep the card inside the viewport on narrow screens.
  React.useLayoutEffect(() => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect || !rect.width) {
      return;
    }
    const margin = 8;
    if (rect.left < margin) {
      setShift(margin - rect.left);
    } else if (rect.right > window.innerWidth - margin) {
      setShift(window.innerWidth - margin - rect.right);
    }
  }, []);

  const when = formatWhen(preview.updatedAt, i18n.language);
  const updated = when
    ? preview.updatedByName
      ? t("Updated {{ date }} by {{ name }}", {
          date: when,
          name: preview.updatedByName,
        })
      : t("Updated {{ date }}", { date: when })
    : undefined;
  const count = preview.count ?? 0;

  return (
    // A non-modal dialog: it holds a link, so a tooltip role would be wrong.
    <Card
      ref={ref}
      id={id}
      role="dialog"
      aria-label={preview.title}
      style={shift ? { transform: `translateX(${shift}px)` } : undefined}
    >
      <Title>
        <DocumentIcon size={18} />
        <span>{preview.title}</span>
      </Title>
      {(preview.collectionName || updated) && (
        <Meta>
          {preview.collectionColor && (
            <Dot style={{ background: preview.collectionColor }} />
          )}
          {preview.collectionName}
          {preview.collectionName && updated && " · "}
          {updated}
        </Meta>
      )}
      {preview.quote && (
        <Passage>
          {preview.heading && <Heading>§ {preview.heading}</Heading>}
          <CitationQuote quote={preview.quote} lines={4} highlight />
        </Passage>
      )}
      <Footer>
        <span>
          {count > 1
            ? t("Cited {{ count }}× in this answer", { count })
            : t("Cited once in this answer")}
        </span>
        {preview.url && isDocPath(preview.url) && (
          <Link to={preview.url}>{t("Open at section")} ↗</Link>
        )}
      </Footer>
    </Card>
  );
}

const Card = styled.span`
  position: absolute;
  z-index: ${depths.hoverPreview};
  top: 100%;
  left: -12px;
  display: block;
  width: 320px;
  max-width: calc(100vw - 32px);
  margin-top: 4px;
  padding: 12px 14px;
  border: 1px solid ${s("divider")};
  border-radius: 8px;
  background: ${s("menuBackground")};
  box-shadow: ${s("menuShadow")};
  color: ${s("text")};
  font-size: 13px;
  font-weight: normal;
  line-height: 1.45;
  text-align: left;
  vertical-align: baseline;
  white-space: normal;

  /* The title and meta carry the context; the quote sits in its own box. */
  blockquote {
    border-left: 0;
    padding: 0;
    color: ${s("text")};
  }
`;

const Title = styled.span`
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 600;
  overflow-wrap: anywhere;

  svg {
    flex: none;
    fill: ${s("textSecondary")};
  }
`;

const Meta = styled.span`
  display: block;
  margin-top: 2px;
  color: ${s("textTertiary")};
  font-size: 12px;
  overflow-wrap: anywhere;
`;

const Dot = styled.span`
  display: inline-block;
  width: 8px;
  height: 8px;
  margin-inline-end: 5px;
  border-radius: 50%;
`;

const Passage = styled.span`
  display: block;
  margin-top: 10px;
  padding: 8px 10px;
  border-left: 3px solid ${s("divider")};
  border-radius: 0 6px 6px 0;
  background: ${s("backgroundSecondary")};
`;

const Heading = styled.span`
  display: block;
  margin-bottom: 2px;
  color: ${s("textSecondary")};
  font-size: 12px;
  font-weight: 600;
  overflow-wrap: anywhere;
`;

const Footer = styled.span`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 10px;
  color: ${s("textTertiary")};
  font-size: 12px;

  a {
    color: ${s("accent")};
    font-weight: 500;
    white-space: nowrap;
  }
`;
