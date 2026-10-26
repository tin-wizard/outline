import * as React from "react";
import useStores from "~/hooks/useStores";
import type AIConversation from "~/models/AIConversation";

const PAGE_SIZE = 20;
const SEARCH_DEBOUNCE_MS = 250;

/**
 * Loads the user's chats into the store a page at a time and, for a search,
 * the matching chats from the server. The unfiltered list is the store's own
 * ordered data, so created, renamed, pinned and deleted chats show up without
 * a refetch; a search keeps the server's order.
 *
 * @param query the text typed in the search box.
 * @returns the chats to show, load state and "show more".
 */
export function useAIConversationList(query: string): {
  items: AIConversation[];
  loading: boolean;
  error: boolean;
  end: boolean;
  searching: boolean;
  loadMore: () => void;
  retry: () => void;
} {
  const { aiConversations } = useStores();
  const text = query.trim();
  const [ids, setIds] = React.useState<string[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState(false);
  const [end, setEnd] = React.useState(false);
  const [attempt, setAttempt] = React.useState(0);
  const offset = React.useRef(0);
  const request = React.useRef(0);

  const load = React.useCallback(
    async (from: number) => {
      const current = ++request.current;
      setLoading(true);
      setError(false);
      try {
        const page = await aiConversations.fetchPage({
          offset: from,
          limit: PAGE_SIZE,
          ...(text ? { query: text } : {}),
        });
        if (current !== request.current) {
          return;
        }
        offset.current = from + page.length;
        setEnd(page.length < PAGE_SIZE);
        setIds((previous) => [
          ...(from ? previous : []),
          ...page.map((c) => c.id),
        ]);
      } catch {
        if (current === request.current) {
          setError(true);
        }
      } finally {
        if (current === request.current) {
          setLoading(false);
        }
      }
    },
    [aiConversations, text]
  );

  React.useEffect(() => {
    offset.current = 0;
    request.current++; // drops responses to the previous query
    setIds([]);
    setEnd(false);
    const timer = setTimeout(() => void load(0), text ? SEARCH_DEBOUNCE_MS : 0);
    return () => clearTimeout(timer);
  }, [load, text, attempt]);

  const loadMore = React.useCallback(() => {
    if (!loading && !end) {
      void load(offset.current);
    }
  }, [load, loading, end]);

  const retry = React.useCallback(() => {
    if (offset.current > 0) {
      void load(offset.current);
    } else {
      setAttempt((n) => n + 1);
    }
  }, [load]);

  const items = text
    ? ids.flatMap((id) => aiConversations.get(id) ?? [])
    : aiConversations.orderedData;

  return { items, loading, error, end, searching: !!text, loadMore, retry };
}
