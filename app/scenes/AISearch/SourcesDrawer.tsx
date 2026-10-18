import { CloseIcon, InfoIcon, ShieldIcon } from "outline-icons";
import * as React from "react";
import { useTranslation } from "react-i18next";
import styled, { css } from "styled-components";
import { HEADER_HEIGHT } from "@shared/constants";
import { depths, s } from "@shared/styles";
import PlaceholderText from "~/components/PlaceholderText";
import useMediaQuery from "~/hooks/useMediaQuery";
import { coverageOf } from "./answerInsights";
import type { Coverage } from "./answerInsights";
import type { Turn } from "./model";
import { citedSources, isActive } from "./model";
import { SourceCard } from "./SourceCard";
import { toneColors } from "./tones";
import { SHEET_QUERY } from "./useSourcesDrawer";

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
 * section links. A right-hand pane on desktop widths and a bottom sheet below
 * them, where it is modal (backdrop, focus kept inside). Escape
 * anywhere on the page, the close button or the backdrop closes it.
 *
 * @param props see Props.
 * @returns the drawer.
 */
export function SourcesDrawer({ turn, selected, autoFocus, onClose }: Props) {
  const { t } = useTranslation();
  const closeRef = React.useRef<HTMLButtonElement>(null);
  const drawerRef = React.useRef<HTMLElement>(null);
  // Too narrow for a side pane next to the answer: a modal bottom sheet.
  const isSheet = useMediaQuery(SHEET_QUERY);
  const cited = React.useMemo(() => citedSources(turn), [turn]);

  // Escape closes the drawer wherever focus is, unless something else on top
  // (a menu, dialog or popover) or the composer's Stop already handled it.
  React.useEffect(() => {
    const handleDocumentKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) {
        return;
      }
      const target = event.target instanceof Element ? event.target : null;
      if (
        target?.closest('[role="dialog"], [role="menu"], [role="listbox"]') &&
        !drawerRef.current?.contains(target)
      ) {
        return;
      }
      onClose();
    };
    document.addEventListener("keydown", handleDocumentKeyDown);
    return () => document.removeEventListener("keydown", handleDocumentKeyDown);
  }, [onClose]);

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
    } else if (event.key === "Tab" && isSheet && drawerRef.current) {
      // The bottom sheet is modal: keep focus inside it.
      const focusable = drawerRef.current.querySelectorAll<HTMLElement>(
        "a[href], button:not([disabled]), [tabindex]:not([tabindex='-1'])"
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
  };

  const coverage = coverageOf(turn);
  const uncited = (turn.sources ?? []).filter(
    (source) => !cited.some((c) => c.n === source.n)
  );
  const streaming = isActive(turn);
  const uncitedText =
    uncited.length === 1
      ? t("1 found but not cited")
      : t("{{ count }} found but not cited", { count: uncited.length });
  const retrievalText = turn.retrieval
    ? turn.retrieval.fetched === 1
      ? t("1 candidate · {{ used }} used", { used: turn.retrieval.used })
      : t("{{ fetched }} candidates · {{ used }} used", {
          fetched: turn.retrieval.fetched,
          used: turn.retrieval.used,
        })
    : undefined;

  return (
    <>
      {isSheet && <Backdrop aria-hidden onClick={onClose} data-print-hidden />}
      <Drawer
        ref={drawerRef}
        role={isSheet ? "dialog" : undefined}
        aria-modal={isSheet || undefined}
        aria-labelledby="ai-sources-title"
        data-print-hidden
        onKeyDown={handleKeyDown}
      >
        {isSheet && <Grab aria-hidden />}
        <Top>
          <Title id="ai-sources-title">{t("Sources")}</Title>
          <CloseButton
            ref={closeRef}
            type="button"
            aria-label={t("Close sources")}
            onClick={onClose}
          >
            <CloseIcon />
          </CloseButton>
        </Top>
        {coverage && <CoverageBanner coverage={coverage} />}
        {cited.length === 0 ? (
          streaming ? (
            <>
              <Hint>{t("Reading sources…")}</Hint>
              <List>
                {(turn.sources ?? []).map((source) => (
                  <SourceCard
                    key={source.n}
                    id={`drawer-source-${source.n}`}
                    source={{ ...source, sections: [], count: 0 }}
                  />
                ))}
              </List>
              <PlaceholderText />
              <PlaceholderText delay={0.2} />
            </>
          ) : (
            <Hint>{t("This answer doesn't cite any sources.")}</Hint>
          )
        ) : (
          <List>
            {cited.map((source) => (
              <SourceCard
                key={source.n}
                id={`drawer-source-${source.n}`}
                source={source}
                selected={selected === source.n}
              />
            ))}
          </List>
        )}
        {!streaming && (retrievalText || uncited.length > 0) && (
          <Foot>
            {uncited.length > 0 ? (
              <details>
                <summary>{retrievalText ?? uncitedText}</summary>
                {retrievalText && <p>{uncitedText}</p>}
                <ul>
                  {uncited.map((source) => (
                    <li key={source.n}>{source.title}</li>
                  ))}
                </ul>
              </details>
            ) : (
              <p>{retrievalText}</p>
            )}
          </Foot>
        )}
      </Drawer>
    </>
  );
}

function CoverageBanner({ coverage }: { coverage: Coverage }) {
  const { t } = useTranslation();
  const ok = coverage.kind === "all";
  let text: string;
  switch (coverage.kind) {
    case "all": {
      const { statements, documents } = coverage;
      text =
        statements === 1
          ? documents === 1
            ? t("The statement matches a passage in this document.")
            : t(
                "The statement matches a passage in these {{ documents }} documents.",
                { documents }
              )
          : documents === 1
            ? t(
                "All {{ statements }} statements match a passage in this document.",
                { statements }
              )
            : t(
                "All {{ statements }} statements match a passage in these {{ documents }} documents.",
                { statements, documents }
              );
      break;
    }
    case "gap":
      text = t("Part of your question isn't covered by these documents.");
      break;
    case "dropped":
      text = t("Some statements could not be verified and were left out.");
      break;
    default:
      text = t("This answer is incomplete, so not every part was verified.");
  }
  return (
    <Banner $tone={ok ? "ok" : "warn"} role="note">
      {ok ? <ShieldIcon size={18} /> : <InfoIcon size={18} />}
      <span>{text}</span>
    </Banner>
  );
}

const sheet = css`
  position: fixed;
  inset: auto 0 0 0;
  z-index: ${depths.modal + 1};
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

const Backdrop = styled.div`
  position: fixed;
  inset: 0;
  z-index: ${depths.modal};
  background: rgba(0, 0, 0, 0.35);
`;

const Drawer = styled.aside`
  flex: none;
  width: 320px;
  position: sticky;
  top: ${HEADER_HEIGHT}px;
  align-self: flex-start;
  height: calc(100vh - ${HEADER_HEIGHT}px);
  overflow-y: auto;
  /* Reaches the edge of the scene, whose content is padded. */
  margin: -4px -44px 0 0;
  padding: 12px 16px 16px;
  border-inline-start: 1px solid ${s("divider")};
  background: ${s("background")};
  color: ${s("text")};

  @media ${SHEET_QUERY} {
    ${sheet}
    width: auto;
    height: auto;
    margin: 0;
  }
`;

const Grab = styled.span`
  display: block;
  width: 36px;
  height: 4px;
  margin: 0 auto 8px;
  border-radius: 2px;
  background: ${s("divider")};
`;

const Top = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 12px;
`;

const Title = styled.h2`
  margin: 0;
  font-size: 16px;
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

const Banner = styled.div<{ $tone: "ok" | "warn" }>`
  display: flex;
  gap: 8px;
  margin: 0 0 12px;
  padding: 10px 12px;
  border: 1px solid ${(props) => toneColors(props.theme, props.$tone).border};
  border-radius: 8px;
  background: ${(props) => toneColors(props.theme, props.$tone).background};
  font-size: 13px;
  line-height: 1.45;

  svg {
    flex: none;
    margin-top: 1px;
    fill: ${(props) => toneColors(props.theme, props.$tone).text};
  }
`;

const Hint = styled.p`
  margin: 0 4px 10px;
  color: ${s("textSecondary")};
  font-size: 13px;
`;

const List = styled.ul`
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: 14px;
`;

const Foot = styled.div`
  margin: 14px 4px 0;
  color: ${s("textTertiary")};
  font-size: 12.5px;

  p {
    margin: 6px 0 0;
  }

  summary {
    color: ${s("textSecondary")};
    cursor: var(--pointer);
  }

  ul {
    margin: 6px 0 0;
    padding: 0;
    list-style: none;
    display: grid;
    gap: 4px;
  }
`;
