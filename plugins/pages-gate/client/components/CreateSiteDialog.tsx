import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import Button from "~/components/Button";
import Flex from "~/components/Flex";
import Input from "~/components/Input";
import Switch from "~/components/Switch";
import Text from "~/components/Text";
import useStores from "~/hooks/useStores";
import { createSite } from "../pagesApi";
import { createErrorField } from "../publishErrors";
import { SLUG_MAX_LENGTH, SLUG_MIN_LENGTH, slugProblem } from "../slug";

interface Props {
  /** Called after the site is created so the list can refetch. */
  onCreated: () => void;
}

/** Collects the fields of a new gated site and creates it as a draft. */
export function CreateSiteDialog({ onCreated }: Props) {
  const { t } = useTranslation();
  const { dialogs } = useStores();
  const [slug, setSlug] = useState("");
  const [title, setTitle] = useState("");
  const [measurementEnabled, setMeasurementEnabled] = useState(false);
  const [hostname, setHostname] = useState("");
  const [pending, setPending] = useState(false);
  const [serverError, setServerError] = useState<{
    field: "slug" | "hostname" | "form";
    message: string;
  } | null>(null);

  const problem = slug ? slugProblem(slug) : undefined;
  const slugError =
    problem === "length"
      ? t("Use {{ min }} to {{ max }} characters.", {
          min: SLUG_MIN_LENGTH,
          max: SLUG_MAX_LENGTH,
        })
      : problem === "pattern"
        ? t(
            "Use lowercase letters and digits, separated by single hyphens. No hyphen at the start or end."
          )
        : problem === "reserved"
          ? t("This address is reserved.")
          : serverError?.field === "slug"
            ? serverError.message
            : undefined;

  const canSubmit =
    !pending && slug.length > 0 && !problem && title.trim().length > 0;

  const handleSubmit = useCallback(
    async (ev: React.FormEvent) => {
      ev.preventDefault();
      if (!canSubmit) {
        return;
      }
      setPending(true);
      setServerError(null);
      try {
        await createSite({
          slug,
          title: title.trim(),
          measurementEnabled,
          hostname: hostname || undefined,
        });
        toast.success(t("Site created"));
        onCreated();
        dialogs.closeAllModals();
      } catch (err) {
        const message =
          err instanceof Error && err.message
            ? err.message
            : t("The site could not be created. Try again.");
        setServerError({ field: createErrorField(message), message });
        setPending(false);
      }
    },
    [
      canSubmit,
      slug,
      title,
      measurementEnabled,
      hostname,
      onCreated,
      dialogs,
      t,
    ]
  );

  return (
    <form onSubmit={handleSubmit}>
      <Flex column gap={16}>
        <div>
          <Input
            label={t("Address")}
            value={slug}
            onChange={(ev) => setSlug(ev.target.value)}
            error={slugError}
            maxLength={SLUG_MAX_LENGTH + 20}
            autoComplete="off"
            autoFocus
            required
          />
          <Text as="p" type="tertiary" size="small">
            {t(
              "Lowercase letters, digits and hyphens, {{ min }} to {{ max }} characters. The site is served at /sites/{{ slug }}/.",
              {
                min: SLUG_MIN_LENGTH,
                max: SLUG_MAX_LENGTH,
                slug: slug || t("address"),
              }
            )}
          </Text>
        </div>
        <Input
          label={t("Title")}
          value={title}
          onChange={(ev) => setTitle(ev.target.value)}
          maxLength={255}
          required
        />
        <Switch
          label={t("Measurement")}
          note={t("Record page views and time on page for this site.")}
          checked={measurementEnabled}
          onChange={setMeasurementEnabled}
        />
        <div>
          <Input
            label={t("Custom hostname (optional)")}
            value={hostname}
            onChange={(ev) => setHostname(ev.target.value)}
            error={
              serverError?.field === "hostname"
                ? serverError.message
                : undefined
            }
            autoComplete="off"
          />
          <Text as="p" type="tertiary" size="small">
            {t("Recorded now; serving a custom domain needs a later release.")}
          </Text>
        </div>
        {serverError?.field === "form" && (
          <Text type="danger" role="alert">
            {serverError.message}
          </Text>
        )}
        <Flex justify="flex-end">
          <Button type="submit" disabled={!canSubmit}>
            {pending ? `${t("Creating")}…` : t("Create site")}
          </Button>
        </Flex>
      </Flex>
    </form>
  );
}
