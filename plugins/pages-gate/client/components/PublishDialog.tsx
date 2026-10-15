import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import Button from "~/components/Button";
import Flex from "~/components/Flex";
import Input from "~/components/Input";
import Text from "~/components/Text";
import useStores from "~/hooks/useStores";
import { PagesGateType } from "../../shared/accessCode";
import type { AccessCodeChoice } from "../accessCodeForm";
import {
  GENERATED_CODE,
  accessCodeChoiceProblem,
  newAccessCode,
} from "../accessCodeForm";
import { publishSite, rotateSite } from "../pagesApi";
import type { PublishFailure } from "../publishErrors";
import { classifyPublishFailure } from "../publishErrors";
import type { PagesSiteData, PublishResult, SourceChoice } from "../types";
import { canSubmitForm } from "../submitGuard";
import { AccessCodeFields } from "./AccessCodeFields";
import { OneTimeCode } from "./OneTimeCode";
import { RotateNotice } from "./RotateNotice";
import SourcePicker from "./SourcePicker";

interface Props {
  site: PagesSiteData;
  /** "rotate" opens on the rotation confirmation instead of the publish form. */
  mode: "publish" | "rotate";
  /** Called after any change on the server so the list can refetch. */
  onChanged: () => void;
}

/**
 * Publishes or rotates a site and then shows the one-time access code. The
 * code, and any code the administrator types, lives only in this component's
 * state, never in a store or a prop, so it is gone once the dialog closes.
 */
export function PublishDialog({ site, mode, onChanged }: Props) {
  const { t } = useTranslation();
  const { dialogs } = useStores();
  const isRepublish = mode === "publish" && site.status === "published";
  const isProtected = site.gateType !== PagesGateType.None;
  // A new code is issued on a first publish and on every rotation.
  const issuesCode = isProtected && (mode === "rotate" || !isRepublish);
  const [sources, setSources] = useState<SourceChoice[]>([]);
  const [pickerOpen, setPickerOpen] = useState(
    mode === "publish" && !isRepublish
  );
  const [code, setCode] = useState("");
  const [codeChoice, setCodeChoice] =
    useState<AccessCodeChoice>(GENERATED_CODE);
  const [customCode, setCustomCode] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<PublishFailure | null>(null);
  const [result, setResult] = useState<PublishResult | null>(null);
  const [rotated, setRotated] = useState(false);
  const [confirmingRotate, setConfirmingRotate] = useState(false);
  const inFlight = useRef(false);

  // A 404 on the stored sources means they must be chosen again.
  const needsSources =
    (!isRepublish && (mode === "publish" || pickerOpen)) ||
    failure?.kind === "sources_missing";
  const codeChoiceReady = !accessCodeChoiceProblem(codeChoice);
  const canSubmit = canSubmitForm({
    pending,
    needsSources,
    sourceCount: sources.length,
    needsCode: isRepublish && isProtected && mode === "publish",
    codeLength: code.length,
    codeChoiceReady: !issuesCode || codeChoiceReady,
  });

  const run = useCallback(
    async (action: "publish" | "rotate") => {
      if (inFlight.current) {
        return;
      }
      // A rotation needs no current code, only a complete choice of the new
      // one; every other call must pass the form guard.
      if (action === "publish" ? !canSubmit : !codeChoiceReady) {
        return;
      }
      const sendsNewCode = action === "rotate" || issuesCode;
      const chosenCode = sendsNewCode ? newAccessCode(codeChoice) : undefined;
      inFlight.current = true;
      setPending(true);
      setFailure(null);
      try {
        const response =
          action === "rotate"
            ? await rotateSite({
                id: site.id,
                sources,
                newAccessCode: chosenCode,
              })
            : await publishSite({
                id: site.id,
                sources,
                accessCode: isRepublish && isProtected ? code : undefined,
                newAccessCode: chosenCode,
              });
        setCode("");
        setCodeChoice(GENERATED_CODE);
        setCustomCode(chosenCode !== undefined);
        setRotated(action === "rotate");
        setResult(response);
        toast.success(
          action === "rotate" ? t("Access code rotated") : t("Site published")
        );
        onChanged();
      } catch (err) {
        const classified = classifyPublishFailure(err, {
          action,
          sentSources: sources.length > 0,
          sentCode:
            action === "publish" &&
            isRepublish &&
            isProtected &&
            code.length > 0,
        });
        setConfirmingRotate(false);
        if (classified.kind === "sources_missing") {
          setPickerOpen(true);
        }
        if (classified.kind === "incorrect_code") {
          setCode("");
        }
        setFailure(classified);
      } finally {
        inFlight.current = false;
        setPending(false);
      }
    },
    [
      site.id,
      sources,
      isRepublish,
      isProtected,
      issuesCode,
      code,
      codeChoice,
      codeChoiceReady,
      canSubmit,
      onChanged,
      t,
    ]
  );

  const handleSubmit = useCallback(
    (ev: React.FormEvent) => {
      ev.preventDefault();
      if (!canSubmit) {
        return;
      }
      void run(mode === "rotate" ? "rotate" : "publish");
    },
    [run, mode, canSubmit]
  );

  const handleRotateInstead = useCallback(() => setConfirmingRotate(true), []);
  const handleCancelRotate = useCallback(() => setConfirmingRotate(false), []);
  const handleConfirmRotate = useCallback(() => void run("rotate"), [run]);

  const handleDone = useCallback(() => {
    setResult(null);
    dialogs.closeAllModals();
  }, [dialogs]);

  if (result) {
    return (
      <OneTimeCode
        result={result}
        rotated={rotated}
        customCode={customCode}
        onDone={handleDone}
      />
    );
  }

  if (confirmingRotate && mode === "publish") {
    return (
      <Flex column gap={16}>
        <RotateNotice />
        <AccessCodeFields
          value={codeChoice}
          onChange={setCodeChoice}
          disabled={pending}
        />
        <span role="status" aria-live="polite">
          {pending && (
            <Text type="secondary">
              {t("Working on it. This can take several seconds.")}
            </Text>
          )}
        </span>
        <Flex justify="flex-end" gap={8}>
          <Button
            type="button"
            neutral
            onClick={handleCancelRotate}
            disabled={pending}
          >
            {t("Cancel")}
          </Button>
          <Button
            type="button"
            onClick={handleConfirmRotate}
            disabled={pending || !codeChoiceReady}
            aria-busy={pending}
          >
            {pending ? `${t("Working")}…` : t("Rotate code")}
          </Button>
        </Flex>
      </Flex>
    );
  }

  return (
    <form onSubmit={handleSubmit}>
      <Flex column gap={16}>
        {mode === "rotate" ? <RotateNotice /> : null}

        {isRepublish && isProtected && mode === "publish" && (
          <div>
            <Input
              type="password"
              label={t("Access code")}
              autoComplete="off"
              value={code}
              onChange={(ev) => setCode(ev.target.value)}
              disabled={pending}
              autoFocus
            />
            <Text as="p" type="tertiary" size="small">
              {t(
                "Enter the current access code to republish, or rotate the code instead."
              )}
            </Text>
          </div>
        )}

        {pickerOpen ? (
          <div>
            <Text weight="bold">{t("Pages to publish")}</Text>
            {isRepublish || mode === "rotate" ? (
              <Text as="p" type="tertiary" size="small">
                {t(
                  "Leave this empty to use the pages the site was published from."
                )}
              </Text>
            ) : null}
            <SourcePicker chosen={sources} onChange={setSources} />
          </div>
        ) : (
          <div>
            <Button
              type="button"
              neutral
              onClick={() => setPickerOpen(true)}
              disabled={pending}
            >
              {t("Choose pages again")}
            </Button>
            <Text as="p" type="tertiary" size="small">
              {t(
                "Without a new choice, the pages the site was published from are used."
              )}
            </Text>
          </div>
        )}

        {failure && (
          <div role="alert">
            <Text type="danger">{failureMessage(failure, t)}</Text>
            {(failure.kind === "incorrect_code" ||
              failure.kind === "state_conflict" ||
              (failure.kind === "message" && failure.offerRotate)) &&
              mode === "publish" &&
              isProtected && (
                <div>
                  <Button
                    type="button"
                    neutral
                    onClick={handleRotateInstead}
                    disabled={pending}
                  >
                    {t("Rotate the code instead")}
                  </Button>
                </div>
              )}
          </div>
        )}

        {issuesCode && (
          <AccessCodeFields
            value={codeChoice}
            onChange={setCodeChoice}
            disabled={pending}
          />
        )}

        <span role="status" aria-live="polite">
          {pending && (
            <Text type="secondary">
              {t("Working on it. This can take several seconds.")}
            </Text>
          )}
        </span>

        <Flex justify="flex-end">
          <Button type="submit" disabled={!canSubmit} aria-busy={pending}>
            {pending
              ? `${t("Working")}…`
              : mode === "rotate"
                ? t("Rotate code")
                : isRepublish
                  ? t("Republish")
                  : t("Publish")}
          </Button>
        </Flex>
      </Flex>
    </form>
  );
}

function failureMessage(
  failure: PublishFailure,
  t: (key: string) => string
): string {
  switch (failure.kind) {
    case "access_code_required":
      return t("Enter the current access code to republish.");
    case "incorrect_code":
      return t("That access code does not match the live site.");
    case "sources_missing":
      return t(
        "A page this site was built from can no longer be found. Choose what to publish again."
      );
    case "source_not_found":
      return t(
        "One of the chosen pages could not be found. Remove it and try again."
      );
    case "state_conflict":
      return t(
        "The live site could not be read. Rotate the access code to publish again."
      );
    case "nothing_to_rotate":
      return t(
        "This site has no live access code to rotate. Publish it instead."
      );
    case "rate_limited":
      return t("Too many attempts. Wait a minute and try again.");
    default:
      return failure.message || t("The request failed. Try again.");
  }
}
