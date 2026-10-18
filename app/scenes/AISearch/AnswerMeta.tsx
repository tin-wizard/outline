import { InfoIcon, ShieldIcon } from "outline-icons";
import { readableColor } from "polished";
import * as React from "react";
import { useTranslation } from "react-i18next";
import styled from "styled-components";
import { s } from "@shared/styles";
import type { Verification } from "./answerInsights";
import type { CitedSource } from "./model";
import { toneColors } from "./tones";

interface Props {
  /** What can be claimed about the answer; nothing shows without it. */
  verification?: Verification;
  /** The sources cited by the answer. */
  cited: CitedSource[];
  /** The Sources panel is open on this answer. */
  sourcesOpen?: boolean;
  /** Toggles the Sources panel; without it there is no sources button. */
  onToggleSources?: (event: React.MouseEvent<HTMLButtonElement>) => void;
}

const STACK_SIZE = 3;

/**
 * The line above an answer: the verification pill and the button that toggles
 * the Sources panel, with a stack of the first source numbers.
 *
 * @param props see Props.
 * @returns the row, or null when there is nothing to show.
 */
export function AnswerMeta({
  verification,
  cited,
  sourcesOpen,
  onToggleSources,
}: Props) {
  const { t } = useTranslation();
  const showSources = !!onToggleSources && cited.length > 0;
  if (!verification && !showSources) {
    return null;
  }
  return (
    <Row data-print-hidden>
      {verification && (
        <Pill $tone={verification.state === "verified" ? "ok" : "warn"}>
          {verification.state === "verified" ? (
            <ShieldIcon size={16} />
          ) : (
            <InfoIcon size={16} />
          )}
          {verification.state === "verified" &&
            (verification.everyCited
              ? t("Verified · every statement cited")
              : t("Verified"))}
          {verification.state === "partial" && t("Not fully verified")}
          {verification.state === "trimmed" &&
            t("Some statements could not be verified and were left out.")}
        </Pill>
      )}
      {showSources && (
        <SourcesButton
          type="button"
          aria-expanded={!!sourcesOpen}
          onClick={onToggleSources}
        >
          <Stack aria-hidden>
            {cited.slice(0, STACK_SIZE).map((source) => (
              <Square key={source.n} $color={source.collectionColor}>
                {source.n}
              </Square>
            ))}
          </Stack>
          {cited.length === 1
            ? t("1 source")
            : t("{{ count }} sources", { count: cited.length })}
        </SourcesButton>
      )}
    </Row>
  );
}

const Row = styled.div`
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  min-height: 28px;
  margin-bottom: 6px;
  color: ${s("textTertiary")};
  font-size: 13px;
`;

const Pill = styled.span<{ $tone: "ok" | "warn" }>`
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-height: 22px;
  padding: 0 8px 0 5px;
  border-radius: 11px;
  background: ${(props) => toneColors(props.theme, props.$tone).background};
  color: ${(props) => toneColors(props.theme, props.$tone).text};
  font-size: 12px;
  font-weight: 500;

  svg {
    flex: none;
    fill: currentColor;
  }
`;

const SourcesButton = styled.button`
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 24px;
  padding: 0 8px 0 4px;
  border: 0;
  border-radius: 12px;
  box-shadow: inset 0 0 0 1px ${s("inputBorder")};
  background: none;
  color: ${s("textSecondary")};
  font: inherit;
  font-size: 12.5px;
  cursor: var(--pointer);

  &:hover,
  &:focus-visible,
  &[aria-expanded="true"] {
    background: ${s("backgroundSecondary")};
  }
`;

const Stack = styled.span`
  display: inline-flex;
`;

const Square = styled.i<{ $color?: string }>`
  display: grid;
  place-items: center;
  width: 16px;
  height: 16px;
  border-radius: 4px;
  background: ${(props) => props.$color ?? props.theme.textTertiary};
  box-shadow: 0 0 0 1.5px ${s("background")};
  color: ${(props) =>
    readableColor(
      props.$color ?? props.theme.textTertiary,
      props.theme.black,
      props.theme.white
    )};
  font-size: 9.5px;
  font-style: normal;
  font-weight: 600;
  line-height: 1;

  & + & {
    margin-inline-start: -4px;
  }
`;
