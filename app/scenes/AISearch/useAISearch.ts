import * as React from "react";
import {
  AuthorizationError,
  NetworkError,
  NotFoundError,
  OfflineError,
  RateLimitExceededError,
} from "~/utils/errors";
import type { StoredTurn } from "~/models/AIConversation";
import { client } from "~/utils/ApiClient";
import { StreamRequestError, streamFetch } from "~/utils/streamFetch";
import type {
  ChatState,
  Rating,
  ReportReason,
  Scope,
  TurnProblem,
} from "./model";
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
 * Seconds the server asked us to wait, from a 429.
 *
 * @param err the thrown error.
 * @returns the delay in seconds, if known.
 */
export function retryAfterFor(err: unknown): number | undefined {
  return err instanceof StreamRequestError ? err.retryAfter : undefined;
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
  /** Replaces the page with a stored conversation, so follow-ups continue it. */
  hydrate: (conversationId: string, turns: StoredTurn[]) => void;
  /** Sets, switches or (when repeating the current rating) clears feedback. */
  rate: (turnId: number, rating: Rating) => void;
  /** Rates an answer not helpful with a reason; resolves true when saved. */
  report: (
    turnId: number,
    reason: ReportReason,
    comment?: string
  ) => Promise<boolean>;
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
          dispatch({
            type: "requestFailed",
            problem: problemFor(err),
            retryAfter: retryAfterFor(err),
          });
        }
      }
    })();
  }, []);

  const stateRef = React.useRef(state);
  React.useEffect(() => {
    stateRef.current = state;
  });

  const send = React.useCallback(
    async (
      turnId: number,
      usageId: string,
      body: {
        rating: Rating | "clear";
        reason?: ReportReason;
        comment?: string;
      }
    ): Promise<boolean> => {
      try {
        await client.post("/ai.feedback", { usageId, ...body });
        dispatch({ type: "feedbackDone", turnId });
        return true;
      } catch (err) {
        dispatch({
          type: "feedbackFailed",
          turnId,
          error:
            err instanceof AuthorizationError || err instanceof NotFoundError
              ? "refused"
              : err instanceof RateLimitExceededError
                ? "rateLimited"
                : "failed",
        });
        return false;
      }
    },
    []
  );

  const rate = React.useCallback(
    (turnId: number, rating: Rating) => {
      const turn = stateRef.current.turns.find((t) => t.id === turnId);
      if (!turn?.usageId || turn.feedback?.pending) {
        return;
      }
      const next = turn.feedback?.rating === rating ? null : rating;
      dispatch({ type: "feedbackStart", turnId, rating: next });
      void send(turnId, turn.usageId, { rating: next ?? "clear" });
    },
    [send]
  );

  const report = React.useCallback(
    async (turnId: number, reason: ReportReason, comment?: string) => {
      const turn = stateRef.current.turns.find((t) => t.id === turnId);
      if (!turn?.usageId || turn.feedback?.pending) {
        return false;
      }
      dispatch({ type: "feedbackStart", turnId, rating: "down" });
      const text = comment?.trim();
      return send(turnId, turn.usageId, {
        rating: "down",
        reason,
        ...(text ? { comment: text } : {}),
      });
    },
    [send]
  );

  const hydrate = React.useCallback(
    (conversationId: string, turns: StoredTurn[]) => {
      const controller = controllerRef.current;
      controllerRef.current = null;
      controller?.abort();
      dispatch({ type: "hydrate", conversationId, turns });
    },
    []
  );

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

  return { state, streaming, ask, stop, reset, hydrate, rate, report };
}
