import { GlobeIcon, PlusIcon } from "outline-icons";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Action } from "~/components/Actions";
import Button from "~/components/Button";
import ConfirmationDialog from "~/components/ConfirmationDialog";
import Heading from "~/components/Heading";
import PlaceholderList from "~/components/List/Placeholder";
import Scene from "~/components/Scene";
import Text from "~/components/Text";
import useRequest from "~/hooks/useRequest";
import useStores from "~/hooks/useStores";
import { CreateSiteDialog } from "./components/CreateSiteDialog";
import { DeleteSiteDialog } from "./components/DeleteSiteDialog";
import { InsightsDialog } from "./components/InsightsDialog";
import { PublishDialog } from "./components/PublishDialog";
import { SitesTable } from "./components/SitesTable";
import { listSites, unpublishSite } from "./pagesApi";
import type { PagesSiteData } from "./types";

function Pages() {
  const { t } = useTranslation();
  const { dialogs } = useStores();
  const { data, error, request } = useRequest(listSites, true);
  const sites = data ?? [];
  const load = request;

  const handleRetry = useCallback(() => void request(), [request]);

  const handleCreate = useCallback(() => {
    dialogs.openModal({
      title: t("New site"),
      content: <CreateSiteDialog onCreated={load} />,
    });
  }, [dialogs, load, t]);

  const handlePublish = useCallback(
    (site: PagesSiteData) => {
      dialogs.openModal({
        title:
          site.status === "published" ? t("Republish site") : t("Publish site"),
        content: <PublishDialog site={site} mode="publish" onChanged={load} />,
      });
    },
    [dialogs, load, t]
  );

  const handleInsights = useCallback(
    (site: PagesSiteData) => {
      dialogs.openModal({
        title: t("Insights"),
        content: (
          <InsightsDialog
            site={site}
            onPublish={() => {
              dialogs.closeAllModals();
              handlePublish(site);
            }}
          />
        ),
      });
    },
    [dialogs, handlePublish, t]
  );

  const handleRotate = useCallback(
    (site: PagesSiteData) => {
      dialogs.openModal({
        title: t("Rotate access code"),
        content: <PublishDialog site={site} mode="rotate" onChanged={load} />,
      });
    },
    [dialogs, load, t]
  );

  const handleUnpublish = useCallback(
    (site: PagesSiteData) => {
      dialogs.openModal({
        title: t("Unpublish site"),
        content: (
          <ConfirmationDialog
            submitText={t("Unpublish")}
            savingText={`${t("Unpublishing")}…`}
            danger
            onSubmit={async () => {
              try {
                await unpublishSite(site.id);
              } catch (_err) {
                toast.error(
                  t(
                    "The site could not be fully removed. Some published files may remain; try again."
                  )
                );
                return false;
              }
              toast.success(t("Site unpublished"));
              await load();
              return true;
            }}
          >
            {t(
              "{{ title }} will go offline and its access code stops working. Publishing it again issues a new code.",
              { title: site.title }
            )}
          </ConfirmationDialog>
        ),
      });
    },
    [dialogs, load, t]
  );

  const handleDelete = useCallback(
    (site: PagesSiteData) => {
      dialogs.openModal({
        title: t("Delete site"),
        content: <DeleteSiteDialog site={site} onDeleted={load} />,
      });
    },
    [dialogs, load, t]
  );

  return (
    <Scene
      title={t("Pages")}
      icon={<GlobeIcon />}
      actions={
        <Action>
          <Button type="button" onClick={handleCreate} icon={<PlusIcon />}>
            {`${t("New site")}…`}
          </Button>
        </Action>
      }
      wide
    >
      <Heading>{t("Pages")}</Heading>
      <Text as="p" type="secondary">
        {t(
          "Publish pages from your documents to Cloudflare R2. Protected sites need an access code to read them."
        )}
      </Text>
      {!data && !error ? (
        <PlaceholderList count={3} />
      ) : error && !data ? (
        <div role="alert">
          <Text as="p" type="danger">
            {t("Could not load sites.")}
          </Text>
          <Button type="button" neutral onClick={handleRetry}>
            {t("Retry")}
          </Button>
        </div>
      ) : sites.length === 0 ? (
        <Text as="p" type="secondary">
          {t(
            "A site is a set of pages from your documents, published outside the workspace. A protected site opens with a single access code; anyone with the code can read it, so share it only with the people it is meant for."
          )}
        </Text>
      ) : (
        <SitesTable
          sites={sites}
          onPublish={handlePublish}
          onRotate={handleRotate}
          onUnpublish={handleUnpublish}
          onDelete={handleDelete}
          onInsights={handleInsights}
        />
      )}
    </Scene>
  );
}

export default Pages;
