import { readableColor, transparentize } from "polished";
import * as React from "react";
import { useTranslation } from "react-i18next";
import styled from "styled-components";
import type { CitationPreviewData } from "./CitationPreview";
import { CitationPreview } from "./CitationPreview";

/** How long the card stays once the pointer leaves, so its link can be reached. */
const CLOSE_DELAY_MS = 150;

interface Props {
  n: number;
  /** Shown instead of the number, e.g. the letter of a compared document. */
  label?: string;
  onClick?: (n: number, marker?: HTMLElement) => void;
  preview?: CitationPreviewData;
}

/**
 * A numbered citation chip. Hovering or focusing it shows the preview card,
 * Escape closes the card, and activating it (a tap on touch) opens the source
 * in the Sources drawer. The chip takes its colour from the source's
 * collection, and is neutral when that is unknown.
 *
 * @param props.n the source number.
 * @param props.label text for the chip instead of the number.
 * @param props.onClick called with the number and the chip when activated.
 * @param props.preview the card's data; no card without it.
 * @returns the chip.
 */
export function CitationMarker({ n, label, onClick, preview }: Props) {
  const { t } = useTranslation();
  const id = React.useId();
  const [open, setOpen] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout>>();
  const cancelClose = () => clearTimeout(timer.current);
  React.useEffect(() => cancelClose, []);

  const handleClick = (event: React.MouseEvent<HTMLButtonElement>) =>
    onClick?.(n, event.currentTarget);
  const handleOpen = () => {
    cancelClose();
    setOpen(true);
  };
  const handleLeave = () => {
    cancelClose();
    timer.current = setTimeout(() => setOpen(false), CLOSE_DELAY_MS);
  };
  const handleBlur = (event: React.FocusEvent<HTMLElement>) => {
    // Moving focus into the card (its link) keeps it open.
    if (!event.currentTarget.contains(event.relatedTarget)) {
      handleLeave();
    }
  };
  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape" && open) {
      event.stopPropagation();
      cancelClose();
      setOpen(false);
    }
  };
  const showing = open && !!preview;

  return (
    <MarkerWrap
      onMouseEnter={handleOpen}
      onMouseLeave={handleLeave}
      onFocus={handleOpen}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
    >
      <Marker
        type="button"
        data-citation
        $color={preview?.collectionColor}
        aria-label={t("Source {{ number }}", { number: label ?? n })}
        aria-describedby={showing ? id : undefined}
        onClick={handleClick}
      >
        {label ?? n}
      </Marker>
      {showing && <CitationPreview id={id} preview={preview} />}
    </MarkerWrap>
  );
}

const MarkerWrap = styled.span`
  position: relative;
`;

const Marker = styled.button<{ $color?: string }>`
  display: inline-grid;
  place-items: center;
  min-width: 18px;
  height: 18px;
  margin: 0 1px 0 3px;
  padding: 0 4px;
  border: 0;
  border-radius: 4px;
  background: ${(props) =>
    props.$color
      ? transparentize(0.88, props.$color)
      : props.theme.backgroundSecondary};
  box-shadow: inset 0 0 0 1px
    ${(props) =>
      props.$color
        ? transparentize(0.55, props.$color)
        : props.theme.inputBorder};
  color: ${(props) => props.theme.textSecondary};
  font-size: 11px;
  font-weight: 600;
  line-height: 1;
  vertical-align: 2px;
  cursor: var(--pointer);

  /* Touch: at least a 24px target (WCAG 2.5.8). */
  @media (pointer: coarse) {
    min-width: 24px;
    height: 24px;
  }

  &:hover,
  &:focus-visible,
  &[aria-describedby] {
    background: ${(props) => props.$color ?? props.theme.accent};
    box-shadow: none;
    color: ${(props) =>
      readableColor(
        props.$color ?? props.theme.accent,
        props.theme.black,
        props.theme.white
      )};
  }

  &:focus-visible {
    outline: 2px solid ${(props) => props.theme.accent};
    outline-offset: 1px;
  }
`;
