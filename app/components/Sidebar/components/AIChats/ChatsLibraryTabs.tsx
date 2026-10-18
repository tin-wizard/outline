import * as React from "react";
import { useTranslation } from "react-i18next";
import styled from "styled-components";
import { s } from "@shared/styles";

/** Which content the AI Search sidebar shows. */
export type SidebarView = "chats" | "library";

const STORAGE_KEY = "ai-sidebar-view";
const VIEWS: SidebarView[] = ["chats", "library"];

/**
 * The id of a tab, for `aria-labelledby` on its panel.
 *
 * @param view the view.
 * @returns the element id.
 */
export const sidebarTabId = (view: SidebarView) => `ai-sidebar-tab-${view}`;

/**
 * The id of a tab's panel, for `aria-controls`.
 *
 * @param view the view.
 * @returns the element id.
 */
export const sidebarPanelId = (view: SidebarView) => `ai-sidebar-panel-${view}`;

/**
 * Reads the view chosen earlier in this browser session.
 *
 * @returns the remembered view, "chats" when none (or storage is blocked).
 */
export function readSidebarView(): SidebarView {
  try {
    const value = window.sessionStorage.getItem(STORAGE_KEY);
    return value === "library" ? "library" : "chats";
  } catch {
    return "chats";
  }
}

/**
 * Remembers the chosen view for this browser session; a no-op without storage.
 *
 * @param view the view to remember.
 */
export function writeSidebarView(view: SidebarView) {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, view);
  } catch {
    // storage may be blocked; the choice still holds while mounted
  }
}

/**
 * State of the Chats | Library switch, remembered for the session.
 *
 * @returns the current view and a setter.
 */
export function useSidebarView(): [SidebarView, (view: SidebarView) => void] {
  const [view, setView] = React.useState<SidebarView>(readSidebarView);
  const update = React.useCallback((next: SidebarView) => {
    setView(next);
    writeSidebarView(next);
  }, []);
  return [view, update];
}

interface Props {
  view: SidebarView;
  onChange: (view: SidebarView) => void;
}

/**
 * Segmented Chats | Library switch for the AI Search sidebar. A tablist with
 * roving focus: arrows, Home and End move between the tabs.
 *
 * @param props.view the selected view.
 * @param props.onChange called with the view the user picked.
 * @returns the switch.
 */
export function ChatsLibraryTabs({ view, onChange }: Props) {
  const { t } = useTranslation();
  const labels: Record<SidebarView, string> = {
    chats: t("Chats"),
    library: t("Library"),
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    const index = VIEWS.indexOf(view);
    const next =
      event.key === "ArrowRight"
        ? VIEWS[(index + 1) % VIEWS.length]
        : event.key === "ArrowLeft"
          ? VIEWS[(index + VIEWS.length - 1) % VIEWS.length]
          : event.key === "Home"
            ? VIEWS[0]
            : event.key === "End"
              ? VIEWS[VIEWS.length - 1]
              : undefined;
    if (!next) {
      return;
    }
    event.preventDefault();
    onChange(next);
    document.getElementById(sidebarTabId(next))?.focus();
  };

  return (
    <Tabs role="tablist" aria-label={t("Sidebar content")}>
      {VIEWS.map((value) => (
        <Tab
          key={value}
          id={sidebarTabId(value)}
          type="button"
          role="tab"
          aria-selected={view === value}
          aria-controls={sidebarPanelId(value)}
          tabIndex={view === value ? 0 : -1}
          $selected={view === value}
          onClick={() => onChange(value)}
          onKeyDown={handleKeyDown}
        >
          {labels[value]}
        </Tab>
      ))}
    </Tabs>
  );
}

const Tabs = styled.div`
  display: flex;
  flex-shrink: 0;
  gap: 2px;
  margin: 4px 8px 8px;
  padding: 2px;
  border-radius: 8px;
  background: ${s("sidebarControlHoverBackground")};
`;

const Tab = styled.button<{ $selected: boolean }>`
  flex: 1;
  height: 26px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: ${(props) =>
    props.$selected ? props.theme.sidebarBackground : "transparent"};
  box-shadow: ${(props) =>
    props.$selected ? "0 1px 2px rgb(0 0 0 / 8%)" : "none"};
  color: ${(props) =>
    props.$selected ? props.theme.text : props.theme.sidebarText};
  font: inherit;
  font-size: 13px;
  font-weight: ${(props) => (props.$selected ? 500 : "inherit")};
  cursor: var(--pointer);

  &:focus-visible {
    outline: 2px solid ${s("accent")};
    outline-offset: -2px;
  }
`;
