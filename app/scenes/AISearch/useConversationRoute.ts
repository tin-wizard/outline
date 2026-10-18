import * as React from "react";
import { useHistory } from "react-router-dom";
import { isUUID } from "validator";
import type { StoredTurn } from "~/models/AIConversation";
import useStores from "~/hooks/useStores";
import { AuthorizationError, NotFoundError } from "~/utils/errors";
import { aiPath } from "~/utils/routeHelpers";
import type { ChatState } from "./model";

/** What the page shows while the route's conversation is resolved. */
export type RouteStatus = "idle" | "loading" | "notFound" | "error";

interface Params {
  /** The `:conversationId` of the route, if any. */
  routeId: string | undefined;
  /** False when history is off: the route is ignored. */
  enabled: boolean;
  state: ChatState;
  hydrate: (conversationId: string, turns: StoredTurn[]) => void;
  reset: () => void;
}

/**
 * Keeps the page and the `/ai/:conversationId` route in step: loads and
 * hydrates a stored conversation when the route names one, resets when the
 * user goes back to `/ai`, and after a new chat's first answer moves the URL
 * to `/ai/:id` (replace, without re-submitting) and refreshes the sidebar list.
 *
 * @param params the route id, gate and chat state.
 * @returns the load status and a retry for a failed load.
 */
export function useConversationRoute({
  routeId,
  enabled,
  state,
  hydrate,
  reset,
}: Params): { status: RouteStatus; retry: () => void } {
  const { aiConversations } = useStores();
  const history = useHistory();
  const [status, setStatus] = React.useState<RouteStatus>(
    routeId && enabled ? "loading" : "idle"
  );
  const [attempt, setAttempt] = React.useState(0);
  const stateRef = React.useRef(state);
  const previousRouteId = React.useRef(routeId);
  /** Turns already stored when the sidebar was last refreshed, for the latest conversation. */
  const known = React.useRef<{ id: string; turns: number } | null>(null);
  React.useEffect(() => {
    stateRef.current = state;
  });

  React.useEffect(() => {
    const previous = previousRouteId.current;
    previousRouteId.current = routeId;
    if (!enabled) {
      return;
    }
    if (!routeId) {
      setStatus("idle");
      if (previous) {
        reset();
      }
      return;
    }
    if (stateRef.current.conversationId === routeId) {
      setStatus("idle");
      return;
    }
    if (!isUUID(routeId)) {
      setStatus("notFound");
      return;
    }
    let cancelled = false;
    setStatus("loading");
    aiConversations
      .fetch(routeId, { force: true })
      .then((conversation) => {
        if (cancelled) {
          return;
        }
        const turns = conversation.turns ?? [];
        known.current = { id: routeId, turns: turns.length };
        hydrate(routeId, turns);
        setStatus("idle");
      })
      .catch((err) => {
        if (!cancelled) {
          setStatus(
            err instanceof NotFoundError || err instanceof AuthorizationError
              ? "notFound"
              : "error"
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [routeId, attempt, enabled, aiConversations, hydrate, reset]);

  const { conversationId, turns } = state;
  const lastStatus = turns[turns.length - 1]?.status;
  React.useEffect(() => {
    if (!enabled || !conversationId || lastStatus !== "done") {
      return;
    }
    // Only answers given in this session are new; a hydrated conversation,
    // or a stale state just before a reset, was already handled.
    if (
      known.current?.id === conversationId &&
      known.current.turns >= turns.length
    ) {
      return;
    }
    if (!routeId) {
      history.replace({
        pathname: aiPath({ conversationId }),
        search: history.location.search,
        hash: history.location.hash,
      });
    }
    known.current = { id: conversationId, turns: turns.length };
    // Brings the new chat, or the bumped one, into the sidebar list.
    void aiConversations
      .fetch(conversationId, { force: true })
      .catch(() => undefined);
  }, [
    enabled,
    conversationId,
    lastStatus,
    turns.length,
    routeId,
    history,
    aiConversations,
  ]);

  const retry = React.useCallback(() => setAttempt((n) => n + 1), []);
  return { status, retry };
}
