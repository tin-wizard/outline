import * as React from "react";
import { NetworkError, OfflineError } from "~/utils/errors";
import { StreamRequestError, streamFetch } from "~/utils/streamFetch";
import type { ChatState, Scope, TurnProblem } from "./model";
import { chatReducer, initialChatState, isActive } from "./model";

/**
 * Maps a request error to the problem shown to the user.
 *
 * @param err the thrown error.
 * @returns the problem.
 */
export function problemFor(err: unknown): TurnProblem {
  if (err instanceof StreamRequestError) {
    switch (err.status) {
      case 401:
        return "unauthorized";
      case 403:
        return "forbidden";
      case 429:
        return "rateLimited";
      default:
        return "error";
    }
  }
  if (err instanceof NetworkError || err instanceof OfflineError) {
    return "network";
  }
  return "error";
}

/**
 * Holds the conversation and runs `ai.ask` turns against it.
 *
 * @returns the state, whether a turn is streaming, and the actions.
 */
export function useAISearch(): {
  state: ChatState;
  streaming: boolean;
  ask: (question: string, scope: Scope) => void;
  stop: () => void;
  reset: () => void;
} {
  const [state, dispatch] = React.useReducer(chatReducer, initialChatState);
  const controllerRef = React.useRef<AbortController | null>(null);
  const mountedRef = React.useRef(true);
  const conversationRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    conversationRef.current = state.conversationId;
  }, [state.conversationId]);
  const streaming = isActive(state.turns[state.turns.length - 1]);

  const ask = React.useCallback((question: string, scope: Scope) => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    // A newer turn or a reset detaches this one so late events are dropped.
    const current = () => controllerRef.current === controller;

    dispatch({ type: "submit", question, scope });
    void (async () => {
      try {
        for await (const event of streamFetch(
          "ai.ask",
          {
            query: question,
            conversationId: conversationRef.current ?? undefined,
            collectionId: scope.collectionId,
            documentId: scope.documentId,
          },
          { signal: controller.signal }
        )) {
          if (!current()) {
            return;
          }
          dispatch({ type: "event", event });
        }
        if (current()) {
          dispatch({ type: controller.signal.aborted ? "stopped" : "ended" });
        }
      } catch (err) {
        if (current()) {
          dispatch({ type: "requestFailed", problem: problemFor(err) });
        }
      }
    })();
  }, []);

  const stop = React.useCallback(() => controllerRef.current?.abort(), []);

  const reset = React.useCallback(() => {
    const controller = controllerRef.current;
    controllerRef.current = null;
    controller?.abort();
    dispatch({ type: "reset" });
  }, []);

  // Abort on unmount, but not on the simulated unmount of StrictMode, which
  // remounts immediately.
  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      setTimeout(() => {
        if (!mountedRef.current) {
          controllerRef.current?.abort();
        }
      });
    };
  }, []);

  return { state, streaming, ask, stop, reset };
}
