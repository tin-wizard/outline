import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import Button from "~/components/Button";
import Flex from "~/components/Flex";
import Input from "~/components/Input";
import Switch from "~/components/Switch";
import Text from "~/components/Text";
import useStores from "~/hooks/useStores";
import { PagesGateType } from "../../shared/accessCode";
import type { AccessCodeChoice } from "../accessCodeForm";
import {
  GENERATED_CODE,
  accessCodeChoiceProblem,
  newAccessCode,
} from "../accessCodeForm";
import { createSite, publishSite } from "../pagesApi";
import { createErrorField } from "../publishErrors";
import { SLUG_MAX_LENGTH, SLUG_MIN_LENGTH, slugProblem } from "../slug";
import type { PagesSiteData, PublishResult, SourceChoice } from "../types";
import { AccessCodeFields } from "./AccessCodeFields";
import { OneTimeCode } from "./OneTimeCode";
import SourcePicker from "./SourcePicker";

interface Props {
  /** Called after the site is created or published so the list can refetch. */
  onCreated: () => void;
}

/**
 * Collects the fields of a new site and creates it. With pages chosen it is
 * published to storage straight away and any generated access code is shown
 * once; without, it is saved as a draft.
 */
export function CreateSiteDialog({ onCreated }: Props) {
  const { t } = useTranslation();
  const { dialogs } = useStores();
  const [slug, setSlug] = useState("");
  const [title, setTitle] = useState("");
  const [isProtected, setIsProtected] = useState(true);
  const [measurementEnabled, setMeasurementEnabled] = useState(false);
  const [hostname, setHostname] = useState("");
  const [sources, setSources] = useState<SourceChoice[]>([]);
  const [codeChoice, setCodeChoice] =
    useState<AccessCodeChoice>(GENERATED_CODE);
  const [pending, setPending] = useState(false);
  const [serverError, setServerError] = useState<{
    field: "slug" | "hostname" | "form";
    message: string;
  } | null>(null);
  // Set once the site exists but its first publish failed, so a retry only
  // publishes and never creates a second site.
  const [created, setCreated] = useState<PagesSiteData | null>(null);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [result, setResult] = useState<PublishResult | null>(null);
  const [customCode, setCustomCode] = useState(false);

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

  const publishesNow = sources.length > 0;
  const choosesCode = isProtected && publishesNow;
  const codeReady = !choosesCode || !accessCodeChoiceProblem(codeChoice);
  const canSubmit =
    !pending &&
    codeReady &&
    (created
      ? publishesNow
      : slug.length > 0 && !problem && title.trim().length > 0);

  const handleSubmit = useCallback(
    async (ev: React.FormEvent) => {
      ev.preventDefault();
      if (!canSubmit) {
        return;
      }
      setPending(true);
      setServerError(null);
      setPublishError(null);

      let site = created;
      if (!site) {
        try {
          site = await createSite({
            slug,
            title: title.trim(),
            measurementEnabled,
            hostname: hostname || undefined,
            gateType: isProtected ? PagesGateType.Code : PagesGateType.None,
          });
        } catch (err) {
          const message =
            err instanceof Error && err.message
              ? err.message
              : t("The site could not be created. Try again.");
          setServerError({ field: createErrorField(message), message });
          setPending(false);
          return;
        }
        onCreated();
        if (!publishesNow) {
          toast.success(t("Site created"));
          dialogs.closeAllModals();
          return;
        }
        setCreated(site);
      }

      const chosenCode = choosesCode ? newAccessCode(codeChoice) : undefined;
      try {
        const response = await publishSite({
          id: site.id,
          sources,
          newAccessCode: chosenCode,
        });
        setCodeChoice(GENERATED_CODE);
        setCustomCode(chosenCode !== undefined);
        setResult(response);
        toast.success(t("Site published"));
        onCreated();
      } catch (err) {
        setPublishError(
          err instanceof Error && err.message
            ? err.message
            : t("The request failed. Try again.")
        );
      } finally {
        setPending(false);
      }
    },
    [
      canSubmit,
      created,
      slug,
      title,
      measurementEnabled,
      hostname,
      isProtected,
      publishesNow,
      choosesCode,
      codeChoice,
      sources,
      onCreated,
      dialogs,
      t,
    ]
  );

  const handleDone = useCallback(() => {
    setResult(null);
    dialogs.closeAllModals();
  }, [dialogs]);

  if (result) {
    return (
      <OneTimeCode
        result={result}
        rotated={false}
        customCode={customCode}
        onDone={handleDone}
      />
    );
  }

  const locked = pending || created !== null;

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
            disabled={locked}
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
          disabled={locked}
          required
        />
        <Switch
          label={t("Protected")}
          note={
            isProtected
              ? t("Readers need an access code to open the site.")
              : t(
                  "Anyone with the address can read the site. Use this only for material that is safe to share publicly."
                )
          }
          checked={isProtected}
          onChange={setIsProtected}
          disabled={locked}
        />
        <Switch
          label={t("Measurement")}
          note={t("Record page views and time on page for this site.")}
          checked={measurementEnabled}
          onChange={setMeasurementEnabled}
          disabled={locked}
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
            disabled={locked}
          />
          <Text as="p" type="tertiary" size="small">
            {t("Recorded now; serving a custom domain needs a later release.")}
          </Text>
        </div>
        <div>
          <Text weight="bold">{t("Pages to publish")}</Text>
          <Text as="p" type="tertiary" size="small">
            {created
              ? t("Choose what to publish, then try again.")
              : t(
                  "Choose documents or collections to publish the site now, or leave this empty to save it as a draft."
                )}
          </Text>
          <SourcePicker chosen={sources} onChange={setSources} />
        </div>
        {choosesCode ? (
          <AccessCodeFields
            value={codeChoice}
            onChange={setCodeChoice}
            disabled={pending}
          />
        ) : isProtected && !created ? (
          <Text as="p" type="tertiary" size="small">
            {t("The access code is set when the site is published.")}
          </Text>
        ) : null}
        {serverError?.field === "form" && (
          <Text type="danger" role="alert">
            {serverError.message}
          </Text>
        )}
        {publishError && (
          <Text type="danger" role="alert">
            {t(
              "The site was saved as a draft but could not be published: {{ message }}",
              { message: publishError }
            )}
          </Text>
        )}
        <span role="status" aria-live="polite">
          {pending && publishesNow && (
            <Text type="secondary">
              {t("Working on it. This can take several seconds.")}
            </Text>
          )}
        </span>
        <Flex justify="flex-end">
          <Button type="submit" disabled={!canSubmit} aria-busy={pending}>
            {pending
              ? `${t("Working")}…`
              : created
                ? t("Try publishing again")
                : publishesNow
                  ? t("Create and publish")
                  : t("Create draft")}
          </Button>
        </Flex>
      </Flex>
    </form>
  );
}
