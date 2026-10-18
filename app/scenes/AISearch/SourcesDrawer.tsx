import { CloseIcon } from "outline-icons";
import * as React from "react";
import { useTranslation } from "react-i18next";
import styled, { css } from "styled-components";
import { breakpoints, depths, s } from "@shared/styles";
import { SourceEntry } from "./AnswerTurn";
import type { Turn } from "./model";
import { citedSources } from "./model";

interface Props {
  /** The answer whose cited sources are listed. */
  turn: Turn;
  /** Source number to bring into view, e.g. from a clicked citation marker. */
  selected?: number;
  /** Move focus into the drawer when it opens from a user action. */
  autoFocus: boolean;
  onClose: () => void;
}

/**
 * The Sources drawer: the sources cited by one answer with their excerpts and
 * section links. A right-hand pane on wide screens and a bottom sheet below
 * tablet width. Escape or the close button closes it.
 *
 * @param props see Props.
 * @returns the drawer.
 */
export function SourcesDrawer({ turn, selected, autoFocus, onClose }: Props) {
  const { t } = useTranslation();
  const closeRef = React.useRef<HTMLButtonElement>(null);
  const cited = React.useMemo(() => citedSources(turn), [turn]);

  React.useEffect(() => {
    const entry =
      selected === undefined
        ? null
        : document.getElementById(`drawer-source-${selected}`);
    if (entry) {
      entry.scrollIntoView?.({ block: "nearest" });
      entry.focus();
    } else if (autoFocus) {
      closeRef.current?.focus();
    }
  }, [selected, autoFocus, turn.id]);

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
    }
  };

  return (
    <Drawer
      aria-labelledby="ai-sources-title"
      data-print-hidden
      onKeyDown={handleKeyDown}
    >
      <Top>
        <Title id="ai-sources-title">
          {t("Sources ({{ count }})", { count: cited.length })}
        </Title>
        <CloseButton
          ref={closeRef}
          type="button"
          aria-label={t("Close sources")}
          onClick={onClose}
        >
          <CloseIcon />
        </CloseButton>
      </Top>
      <Question>{turn.question}</Question>
      {cited.length === 0 ? (
        <Empty>{t("This answer doesn't cite any sources.")}</Empty>
      ) : (
        <List>
          {cited.map((source) => (
            <Item
              key={source.n}
              id={`drawer-source-${source.n}`}
              tabIndex={-1}
              data-selected={selected === source.n || undefined}
            >
              <SourceEntry {...source} />
            </Item>
          ))}
        </List>
      )}
    </Drawer>
  );
}

const sheet = css`
  position: fixed;
  inset: auto 0 0 0;
  z-index: ${depths.modal};
  max-height: 70vh;
  border-inline-start: 0;
  border-top: 1px solid ${s("divider")};
  border-radius: 16px 16px 0 0;
  box-shadow: 0 -8px 24px rgba(0, 0, 0, 0.18);

  @media (prefers-reduced-motion: no-preference) {
    animation: ai-sheet-in 160ms ease-out;
  }

  @keyframes ai-sheet-in {
    from {
      transform: translateY(24px);
      opacity: 0;
    }
  }
`;

const Drawer = styled.aside`
  flex: none;
  width: 340px;
  align-self: flex-start;
  position: sticky;
  top: 72px;
  max-height: calc(100vh - 88px);
  overflow-y: auto;
  padding: 12px 16px 16px;
  border: 1px solid ${s("divider")};
  border-radius: 12px;
  background: ${s("background")};
  color: ${s("text")};

  @media (max-width: ${breakpoints.tablet - 1}px) {
    ${sheet}
    width: auto;
  }
`;

const Top = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
`;

const Title = styled.h2`
  margin: 0;
  font-size: 15px;
  font-weight: 600;
`;

const CloseButton = styled.button`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: 0;
  border-radius: 6px;
  background: none;
  color: ${s("textSecondary")};
  cursor: var(--pointer);

  &:hover,
  &:focus-visible {
    background: ${s("backgroundSecondary")};
    color: ${s("text")};
  }

  svg {
    fill: currentColor;
  }
`;

const Question = styled.p`
  margin: 4px 0 12px;
  color: ${s("textSecondary")};
  font-size: 13px;
  overflow-wrap: anywhere;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
`;

const Empty = styled.p`
  color: ${s("textSecondary")};
  font-size: 14px;
`;

const List = styled.ul`
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: 14px;
`;

const Item = styled.li`
  padding: 10px 8px;
  border-top: 1px solid ${s("divider")};
  overflow-wrap: anywhere;

  &:focus-visible {
    outline: 2px solid ${s("accent")};
    outline-offset: -2px;
  }

  &[data-selected] {
    background: ${s("backgroundSecondary")};
    border-radius: 6px;
  }
`;
