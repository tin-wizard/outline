import * as React from "react";
import { isUUID } from "validator";
import { client } from "~/utils/ApiClient";

/** How long typing must pause before the picker searches. */
export const PICKER_DEBOUNCE_MS = 250;

/** A document the picker offers. */
export interface PickerDocument {
  id: string;
  title: string;
  collectionName?: string;
}

interface PickerState {
  /** Asks again for the current query, after an error. */
  reload: () => void;
  results: PickerDocument[];
  /** A request for the current query is pending. */
  loading: boolean;
  /** The last request failed; results are cleared. */
  error: boolean;
}

function clean(row: PickerDocument): PickerDocument[] {
  if (!row || typeof row.id !== "string" || !isUUID(row.id)) {
    return [];
  }
  return [
    {
      id: row.id,
      title: typeof row.title === "string" ? row.title : "",
      collectionName:
        typeof row.collectionName === "string" ? row.collectionName : undefined,
    },
  ];
}

/**
 * Searches the documents that can be picked as a scope (`ai.documents`):
 * published, readable and not excluded from AI answers. Typing is debounced,
 * and a request for an older query is aborted so a slow answer can never
 * replace a newer one.
 *
 * @param query the text typed in the picker; empty lists recent documents.
 * @param enabled false while the picker is closed: nothing is requested.
 * @returns the results with loading and error flags, and `reload`.
 */
export function useDocumentPicker(
  query: string,
  enabled: boolean
): PickerState {
  const [nonce, setNonce] = React.useState(0);
  const reload = React.useCallback(() => setNonce((n) => n + 1), []);
  const [state, setState] = React.useState<Omit<PickerState, "reload">>({
    results: [],
    loading: false,
    error: false,
  });

  React.useEffect(() => {
    if (!enabled) {
      return;
    }
    const controller = new AbortController();
    setState((prev) => ({ ...prev, loading: true, error: false }));
    const timer = setTimeout(
      async () => {
        try {
          const res = await client.post<{ data: PickerDocument[] }>(
            "/ai.documents",
            { ...(query.trim() ? { query: query.trim() } : {}), limit: 20 },
            { signal: controller.signal }
          );
          if (!controller.signal.aborted) {
            setState({
              results: (Array.isArray(res?.data) ? res.data : []).flatMap(
                clean
              ),
              loading: false,
              error: false,
            });
          }
        } catch (_err) {
          if (!controller.signal.aborted) {
            setState({ results: [], loading: false, error: true });
          }
        }
      },
      query ? PICKER_DEBOUNCE_MS : 0
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, enabled, nonce]);

  return { ...state, reload };
}
