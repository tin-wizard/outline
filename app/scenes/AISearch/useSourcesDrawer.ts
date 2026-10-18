import * as React from "react";
import { breakpoints } from "@shared/styles";

const STORAGE_KEY = "ai-search-sources-open";

function readOpen(): boolean {
  // Below tablet width the drawer is a modal sheet: never reopen it unasked.
  if (window.matchMedia?.(`(max-width: ${breakpoints.tablet - 1}px)`).matches) {
    return false;
  }
  try {
    return window.sessionStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeOpen(open: boolean) {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, open ? "1" : "0");
  } catch {
    // storage may be blocked; the state still works for this page view
  }
}

export interface SourcesDrawerState {
  open: boolean;
  /** The answer whose sources are shown; undefined means the latest one. */
  turnId?: number;
  /** Source number to bring into view. */
  selected?: number;
  /** Whether focus should move into the drawer (opened by a user action). */
  focusIn: boolean;
  /** Opens the drawer for an answer, remembering where focus returns. */
  show: (turnId: number, n?: number, opener?: HTMLElement | null) => void;
  /** Closes the drawer and returns focus to what opened it. */
  close: () => void;
}

/**
 * State of the Sources drawer: open/closed (remembered for the session),
 * which answer and source it shows, and focus hand-off on open and close.
 *
 * @returns the drawer state and actions.
 */
export function useSourcesDrawer(): SourcesDrawerState {
  const [open, setOpen] = React.useState(readOpen);
  const [turnId, setTurnId] = React.useState<number>();
  const [selected, setSelected] = React.useState<number>();
  const [focusIn, setFocusIn] = React.useState(false);
  const opener = React.useRef<HTMLElement | null>(null);

  const show = React.useCallback(
    (id: number, n?: number, from?: HTMLElement | null) => {
      // Keep the first opener while open: that is where focus should return.
      if (!open || !opener.current) {
        opener.current = from ?? null;
      }
      setTurnId(id);
      setSelected(n);
      setFocusIn(true);
      setOpen(true);
      writeOpen(true);
    },
    [open]
  );

  const close = React.useCallback(() => {
    setOpen(false);
    setSelected(undefined);
    setFocusIn(false);
    writeOpen(false);
    const target = opener.current;
    opener.current = null;
    if (target?.isConnected) {
      target.focus();
    }
  }, []);

  return { open, turnId, selected, focusIn, show, close };
}
