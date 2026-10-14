import { CheckmarkIcon, CopyIcon } from "outline-icons";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import styled from "styled-components";
import { s } from "@shared/styles";
import Button from "~/components/Button";
import CopyToClipboard from "~/components/CopyToClipboard";
import Flex from "~/components/Flex";
import Text from "~/components/Text";
import { isStaleCleanupWarning } from "../publishErrors";
import type { PublishResult } from "../types";

interface Props {
  /** The publish or rotate response. Its access code is never copied out. */
  result: PublishResult;
  /** Whether the result came from a rotation. */
  rotated: boolean;
  /** Called when the administrator has finished with the dialog. */
  onDone: () => void;
}

/**
 * Shows the outcome of a publish or rotation. When the response holds an
 * access code it is displayed here only and is gone when this unmounts.
 */
export function OneTimeCode({ result, rotated, onDone }: Props) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const { accessCode, publishedUrl, pageCount, warnings } = result;

  // The core CopyToClipboard calls onCopy whether or not the copy worked,
  // so this only says a copy was requested; the code stays selectable.
  const handleCopy = useCallback(() => {
    setCopied(true);
    toast.message(t("Copy requested"));
  }, [t]);

  const showStaleNote = rotated && warnings.some(isStaleCleanupWarning);

  return (
    <Flex column gap={16}>
      <Text as="p" type="secondary">
        {t("Pages published: {{ pageCount }}", { pageCount })}
      </Text>

      {publishedUrl && (
        <Text as="p">
          <a href={publishedUrl} target="_blank" rel="noopener noreferrer">
            {publishedUrl}
          </a>
        </Text>
      )}

      {accessCode !== undefined && (
        <Flex column gap={8}>
          <Text weight="bold">{t("Access code")}</Text>
          <CodeBlock aria-label={t("Access code")}>{accessCode}</CodeBlock>
          <Flex align="center" gap={8}>
            <CopyToClipboard text={accessCode} onCopy={handleCopy}>
              <Button type="button" neutral icon={<CopyIcon />}>
                {t("Copy code")}
              </Button>
            </CopyToClipboard>
            <span role="status">
              {copied && (
                <Text type="secondary">
                  <CheckmarkIcon size={18} /> {t("Copy requested")}
                </Text>
              )}
            </span>
          </Flex>
          <Text as="p" type="danger">
            {t(
              "This code is shown once. Anyone with it can read this site. Share it only through a private channel."
            )}{" "}
            {t("Closing this window discards the code.")}
          </Text>
        </Flex>
      )}

      {warnings.length > 0 && (
        <div>
          <Text weight="bold">{t("Warnings")}</Text>
          <ul>
            {warnings.map((warning, index) => (
              <li key={index}>{warning}</li>
            ))}
          </ul>
          {showStaleNote && (
            <Text as="p" type="secondary">
              {t(
                "Pages that were removed from the site may still open with the previous code until the next publish or rotation. Publish or rotate again to finish."
              )}
            </Text>
          )}
        </div>
      )}

      <Flex justify="flex-end">
        <Button type="button" onClick={onDone} autoFocus>
          {t("Done")}
        </Button>
      </Flex>
    </Flex>
  );
}

const CodeBlock = styled.code`
  display: block;
  padding: 12px 16px;
  border-radius: 6px;
  background: ${s("backgroundSecondary")};
  font-family: ${s("fontFamilyMono")};
  font-size: 20px;
  letter-spacing: 0.08em;
  white-space: nowrap;
  overflow-x: auto;
  user-select: all;
`;
