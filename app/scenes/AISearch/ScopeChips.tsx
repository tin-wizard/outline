import { CloseIcon } from "outline-icons";
import * as React from "react";
import { useTranslation } from "react-i18next";
import styled from "styled-components";
import { s } from "@shared/styles";
import useMobile from "~/hooks/useMobile";

export interface ScopeChip {
  key: string;
  /** What the chip filters, such as "Collection". */
  kind: string;
  /** The collection or document name. */
  label: string;
  onRemove: () => void;
}

interface Props {
  chips: ScopeChip[];
  /** Chips cannot be changed while an answer is streaming. */
  disabled?: boolean;
}

/**
 * Removable chips for the collection and document the question is limited to.
 * On narrow screens they collapse into a single disclosure.
 *
 * @param props.chips the active scopes.
 * @param props.disabled locks removal.
 * @returns the chips, or null when unscoped.
 */
export function ScopeChips({ chips, disabled }: Props) {
  const { t } = useTranslation();
  const isMobile = useMobile();

  if (!chips.length) {
    return null;
  }

  const list = (
    <List role="list" aria-label={t("Search scope")}>
      {chips.map((chip) => (
        <li key={chip.key}>
          <Chip>
            <span>
              <Kind>{chip.kind}:</Kind> {chip.label}
            </span>
            <Remove
              type="button"
              disabled={disabled}
              aria-label={t("Remove {{ name }} from the scope", {
                name: chip.label,
              })}
              onClick={chip.onRemove}
            >
              <CloseIcon size={16} />
            </Remove>
          </Chip>
        </li>
      ))}
    </List>
  );

  if (!isMobile) {
    return list;
  }
  return (
    <Disclosure>
      <summary>{t("Scope ({{ count }})", { count: chips.length })}</summary>
      {list}
    </Disclosure>
  );
}

const List = styled.ul`
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 8px 0;
  padding: 0;
  list-style: none;
`;

const Chip = styled.span`
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 100%;
  padding: 2px 4px 2px 10px;
  border: 1px solid ${s("divider")};
  border-radius: 14px;
  background: ${s("backgroundSecondary")};
  color: ${s("text")};
  font-size: 13px;

  > span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
`;

const Kind = styled.span`
  color: ${s("textSecondary")};
`;

const Remove = styled.button`
  display: inline-flex;
  padding: 2px;
  border: 0;
  border-radius: 50%;
  background: none;
  color: ${s("textSecondary")};
  cursor: var(--pointer);

  &:hover:not(:disabled),
  &:focus-visible {
    color: ${s("text")};
    background: ${s("sidebarActiveBackground")};
  }

  &:disabled {
    opacity: 0.5;
    cursor: default;
  }
`;

const Disclosure = styled.details`
  margin: 8px 0;
  color: ${s("textSecondary")};
  font-size: 14px;

  summary {
    cursor: var(--pointer);
  }
`;
