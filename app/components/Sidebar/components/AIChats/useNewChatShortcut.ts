import { useHistory } from "react-router-dom";
import useKeyDown from "~/hooks/useKeyDown";
import { aiPath } from "~/utils/routeHelpers";

/**
 * Binds Cmd/Ctrl+Shift+O to starting a new AI chat (navigates to `/ai`).
 *
 * @param enabled whether the shortcut is active, e.g. only on AI Search pages.
 */
export function useNewChatShortcut(enabled: boolean) {
  const history = useHistory();
  useKeyDown(
    "o",
    (event) => {
      if (!enabled) {
        return;
      }
      event.preventDefault();
      history.push(aiPath());
    },
    { metaKey: true, shiftKey: true }
  );
}
