import * as React from "react";
import { useTranslation } from "react-i18next";
import styled from "styled-components";
import { s } from "@shared/styles";
import type { BlockInput, Group, Inline, ParsedItem } from "./markdown";
import { groupBlocks } from "./markdown";
import type { CitationPreviewData } from "./CitationPreview";
import { CitationPreview } from "./CitationPreview";

interface Props {
  /** The verified blocks received so far. */
  blocks: BlockInput[];
  /** Called when a citation marker is activated. */
  onCitationClick?: (n: number) => void;
  /** Preview card data by source number, built from the stream's events. */
  previews?: ReadonlyMap<number, CitationPreviewData>;
}

/**
 * Renders the verified blocks of an answer. Content comes from the server's
 * escaped Markdown subset and is shown only as React text nodes: no links,
 * images, HTML, autolinking or dangerouslySetInnerHTML. The only interactive
 * elements are the numbered citation markers.
 *
 * @param props.blocks the blocks to render.
 * @param props.onCitationClick called with the source number of a marker.
 * @param props.previews hover and focus preview data by source number.
 * @returns the rendered answer.
 */
export function AnswerBody({ blocks, onCitationClick, previews }: Props) {
  const groups = React.useMemo(() => groupBlocks(blocks), [blocks]);
  const marks = (citations: number[]) => (
    <Markers
      citations={citations}
      onClick={onCitationClick}
      previews={previews}
    />
  );

  return <Body>{groups.map((group, i) => renderGroup(group, i, marks))}</Body>;
}

const HEADING_TAGS = ["h3", "h4", "h5", "h6", "h6", "h6"] as const;

function renderGroup(
  group: Group,
  key: number,
  marks: (citations: number[]) => React.ReactNode
) {
  switch (group.type) {
    case "heading": {
      // The page title is the h1 and each answer has an h2.
      const Tag = HEADING_TAGS[Math.min(group.level, 6) - 1];
      return (
        <Tag key={key}>
          {renderInline(group.item.inline)}
          {marks(group.item.citations)}
        </Tag>
      );
    }
    case "list": {
      const Tag = group.ordered ? "ol" : "ul";
      return (
        <Tag key={key} start={group.ordered ? group.start : undefined}>
          {group.items.map((entry, j) => (
            <li key={j}>
              {renderInline(entry.inline)}
              {marks(entry.citations)}
            </li>
          ))}
        </Tag>
      );
    }
    case "table":
      return (
        <TableWrapper key={key}>
          <table>
            <thead>
              <tr>
                {group.header.map((cell, j) => (
                  <th key={j} scope="col">
                    {renderInline(cell.inline)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {group.rows.map((row, j) => (
                <tr key={j}>
                  {row.map((cell: ParsedItem, k) => (
                    <td key={k}>
                      {renderInline(cell.inline)}
                      {marks(cell.citations)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrapper>
      );
    case "code":
      return (
        <div key={key}>
          <pre tabIndex={0}>
            <code>{group.code}</code>
          </pre>
          {marks(group.citations)}
        </div>
      );
    default:
      return (
        <p key={key}>
          {renderInline(group.item.inline)}
          {marks(group.item.citations)}
        </p>
      );
  }
}

function renderInline(nodes: Inline[]): React.ReactNode {
  return nodes.map((node, i) => {
    switch (node.type) {
      case "code":
        return <code key={i}>{node.value}</code>;
      case "strong":
        return <strong key={i}>{renderInline(node.children)}</strong>;
      case "em":
        return <em key={i}>{renderInline(node.children)}</em>;
      default:
        return node.value.split("\n").map((line, j) => (
          <React.Fragment key={`${i}-${j}`}>
            {j > 0 && <br />}
            {line}
          </React.Fragment>
        ));
    }
  });
}

function Markers({
  citations,
  onClick,
  previews,
}: {
  citations: number[];
  onClick?: (n: number) => void;
  previews?: ReadonlyMap<number, CitationPreviewData>;
}) {
  return (
    <>
      {citations.map((n) => (
        <CitationMarker
          key={n}
          n={n}
          onClick={onClick}
          preview={previews?.get(n)}
        />
      ))}
    </>
  );
}

function CitationMarker({
  n,
  onClick,
  preview,
}: {
  n: number;
  onClick?: (n: number) => void;
  preview?: CitationPreviewData;
}) {
  const { t } = useTranslation();
  const id = React.useId();
  const [open, setOpen] = React.useState(false);
  const handleClick = () => onClick?.(n);
  const handleOpen = () => setOpen(true);
  const handleClose = () => setOpen(false);
  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape" && open) {
      event.stopPropagation();
      setOpen(false);
    }
  };
  const showing = open && !!preview;

  return (
    <MarkerWrap
      onMouseEnter={handleOpen}
      onMouseLeave={handleClose}
      onFocus={handleOpen}
      onBlur={handleClose}
      onKeyDown={handleKeyDown}
    >
      <Marker
        type="button"
        data-citation
        aria-label={t("Source {{ number }}", { number: n })}
        aria-describedby={showing ? id : undefined}
        onClick={handleClick}
      >
        {n}
      </Marker>
      {showing && <CitationPreview id={id} preview={preview} />}
    </MarkerWrap>
  );
}

const MarkerWrap = styled.span`
  position: relative;
`;

const Marker = styled.button`
  display: inline-block;
  min-width: 18px;
  height: 18px;
  margin: 0 0 0 3px;
  padding: 0 4px;
  border: 0;
  border-radius: 9px;
  background: ${s("backgroundSecondary")};
  color: ${s("textSecondary")};
  font-size: 11px;
  font-weight: 600;
  line-height: 18px;
  vertical-align: super;
  cursor: var(--pointer);

  &:hover,
  &:focus-visible {
    background: ${s("accent")};
    color: ${s("accentText")};
  }

  &::before {
    content: "[";
  }

  &::after {
    content: "]";
  }
`;

const TableWrapper = styled.div`
  overflow-x: auto;
  margin: 0.5em 0;

  table {
    border-collapse: collapse;
  }

  th,
  td {
    padding: 6px 10px;
    border: 1px solid ${s("divider")};
    text-align: left;
    vertical-align: top;
  }

  th {
    background: ${s("backgroundSecondary")};
  }
`;

const Body = styled.div`
  color: ${s("text")};
  line-height: 1.6;
  overflow-wrap: anywhere;

  p,
  ul,
  ol {
    margin: 0.5em 0;
  }

  h3,
  h4,
  h5,
  h6 {
    margin: 1em 0 0.25em;
    font-size: 1.05em;
  }

  ul,
  ol {
    padding-left: 1.5em;
  }

  code {
    padding: 1px 4px;
    border-radius: 4px;
    background: ${s("backgroundSecondary")};
    font-family: ${s("fontFamilyMono")};
    font-size: 0.9em;
  }

  pre {
    overflow-x: auto;
    margin: 0.5em 0;
    padding: 10px 12px;
    border-radius: 6px;
    background: ${s("backgroundSecondary")};
  }

  pre code {
    padding: 0;
    background: none;
    white-space: pre;
  }
`;
