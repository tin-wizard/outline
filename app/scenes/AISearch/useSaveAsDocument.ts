import * as React from "react";
import { useTranslation } from "react-i18next";
import { useHistory } from "react-router-dom";
import { toast } from "sonner";
import useCurrentTeam from "~/hooks/useCurrentTeam";
import usePolicy from "~/hooks/usePolicy";
import { client } from "~/utils/ApiClient";
import type { Draft } from "./draft";
import { isDocPath } from "./docPath";

interface Created {
  data: { id: string; url: string };
}

/**
 * Saves an AI answer as a draft document through `documents.create`, in no
 * collection (like a new blank draft), and offers to open it.
 *
 * @returns whether the user may create documents, and the save function.
 */
export function useSaveAsDocument(): {
  canSave: boolean;
  save: (draft: Draft) => Promise<void>;
} {
  const { t } = useTranslation();
  const history = useHistory();
  const can = usePolicy(useCurrentTeam());
  const saving = React.useRef(false);

  const save = React.useCallback(
    async (draft: Draft) => {
      if (saving.current) {
        return;
      }
      saving.current = true;
      try {
        const res = await client.post<Created>("/documents.create", {
          title: draft.title,
          text: draft.text,
          publish: false,
        });
        const url = res?.data?.url ?? "";
        toast.success(t("Saved as a draft"), {
          action: {
            label: t("Open draft"),
            onClick: () => history.push(isDocPath(url) ? url : "/drafts"),
          },
        });
      } catch (_err) {
        toast.error(t("Couldn't save the draft. Try again."));
      } finally {
        saving.current = false;
      }
    },
    [history, t]
  );

  return { canSave: !!can.createDocument, save };
}
