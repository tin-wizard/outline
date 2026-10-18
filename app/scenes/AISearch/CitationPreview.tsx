import * as React from "react";
import styled from "styled-components";
import { depths, s } from "@shared/styles";
import { CitationQuote } from "./CitationQuote";

/** Plain data for a citation preview, taken from the stream's events. */
export interface CitationPreviewData {
  title: string;
  collectionName?: string;
  quote?: string;
}

interface Props {
  /** Id referenced by the marker's aria-describedby. */
  id: string;
  preview: CitationPreviewData;
}

/**
 * Small card shown while a citation marker is hovered or focused. Built only
 * from data already received (no document fetch); everything is text.
 *
 * @param props.id the element id.
 * @param props.preview title, collection and quote excerpt.
 * @returns the tooltip.
 */
export function CitationPreview({ id, preview }: Props) {
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

  return (
    <Card
      ref={ref}
      id={id}
      role="tooltip"
      style={shift ? { transform: `translateX(${shift}px)` } : undefined}
    >
      <Title>{preview.title}</Title>
      {preview.collectionName && <Meta>{preview.collectionName}</Meta>}
      {preview.quote && <CitationQuote quote={preview.quote} lines={4} />}
    </Card>
  );
}

const Card = styled.span`
  position: absolute;
  z-index: ${depths.hoverPreview};
  top: 100%;
  left: 0;
  display: block;
  width: 280px;
  max-width: calc(100vw - 32px);
  margin-top: 4px;
  padding: 8px 10px;
  border: 1px solid ${s("divider")};
  border-radius: 8px;
  background: ${s("menuBackground")};
  box-shadow: ${s("menuShadow")};
  color: ${s("text")};
  font-size: 13px;
  font-weight: normal;
  line-height: 1.4;
  text-align: left;
  vertical-align: baseline;
`;

const Title = styled.span`
  display: block;
  font-weight: 600;
  overflow-wrap: anywhere;
`;

const Meta = styled.span`
  display: block;
  color: ${s("textSecondary")};
  overflow-wrap: anywhere;
`;
