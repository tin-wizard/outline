import * as React from "react";
import { useHistory } from "react-router-dom";
import useQuery from "~/hooks/useQuery";

/**
 * Submits the `q` query parameter once on load, then removes it from the URL
 * (keeping the other parameters) so a refresh or back/forward does not send
 * another billed request. Safe under React StrictMode's double effect.
 *
 * @param submit sends the question.
 * @param enabled false to leave the parameter alone, such as on a stored conversation.
 */
export function useAutoSubmitQuery(
  submit: (question: string) => void,
  enabled = true
) {
  const history = useHistory();
  const params = useQuery();
  const done = React.useRef(false);
  const submitRef = React.useRef(submit);
  React.useEffect(() => {
    submitRef.current = submit;
  });

  React.useEffect(() => {
    const q = params.get("q")?.trim();
    if (!enabled || !q || done.current) {
      return;
    }
    done.current = true;
    const next = new URLSearchParams(history.location.search);
    next.delete("q");
    const search = next.toString();
    history.replace({
      pathname: history.location.pathname,
      search: search ? `?${search}` : "",
      hash: history.location.hash,
    });
    submitRef.current(q);
    // Runs once for the initial query only.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
