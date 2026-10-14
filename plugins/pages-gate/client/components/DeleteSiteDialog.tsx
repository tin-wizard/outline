import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import ConfirmationDialog from "~/components/ConfirmationDialog";
import Input from "~/components/Input";
import { deleteSite } from "../pagesApi";
import type { PagesSiteData } from "../types";

interface Props {
  site: PagesSiteData;
  /** Called after the site is deleted so the list can refetch. */
  onDeleted: () => void;
}

/** Deletes a site once its address has been typed back. */
export function DeleteSiteDialog({ site, onDeleted }: Props) {
  const { t } = useTranslation();
  const [typed, setTyped] = useState("");

  const handleSubmit = useCallback(async () => {
    try {
      await deleteSite(site.id);
    } catch (_err) {
      toast.error(
        t(
          "The site could not be fully removed. Some published files may remain; try again."
        )
      );
      return false;
    }
    toast.success(t("Site deleted"));
    onDeleted();
    return true;
  }, [site.id, onDeleted, t]);

  return (
    <ConfirmationDialog
      onSubmit={handleSubmit}
      submitText={t("Delete site")}
      savingText={`${t("Deleting")}…`}
      disabled={typed !== site.slug}
      danger
    >
      <p>
        {t(
          "This permanently removes the site and its published files. The access code stops working and cannot be recovered."
        )}
      </p>
      <Input
        label={t("Type {{ slug }} to confirm", { slug: site.slug })}
        value={typed}
        onChange={(ev) => setTyped(ev.target.value)}
        autoComplete="off"
        autoFocus
      />
    </ConfirmationDialog>
  );
}
