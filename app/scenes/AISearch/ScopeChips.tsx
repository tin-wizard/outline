import {
  CalendarIcon,
  CollectionIcon,
  DocumentIcon,
  ExpandedIcon,
} from "outline-icons";
import * as React from "react";
import { useTranslation } from "react-i18next";
import styled from "styled-components";
import { transparentize } from "polished";
import { s } from "@shared/styles";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "~/components/primitives/Popover";
import type { Scope, ScopeDocument } from "./model";
import type { PanelCollection } from "./ScopePanels";
import { CollectionsPanel, DatePanel, DocumentsPanel } from "./ScopePanels";
import { dateText } from "./scope";

interface Props {
  scope: Scope;
  onChange: (scope: Scope) => void;
  /** Collections the user can pick: readable and not excluded from AI. */
  collections: PanelCollection[];
  /** The workspace has Compare turned on. */
  compareEnabled: boolean;
  /** Chips cannot be changed while an answer is streaming. */
  disabled?: boolean;
  /** Title to show for a picked document whose own title is not known yet. */
  documentTitle?: (doc: ScopeDocument) => string;
}

/**
 * The scope chips inside the composer bar: collections, specific documents,
 * date window and (when the workspace allows it) Compare. They stay in a
 * single row that scrolls sideways on narrow screens.
 *
 * @param props see Props.
 * @returns the chip row.
 */
export function ScopeChips({
  scope,
  onChange,
  collections,
  compareEnabled,
  disabled,
  documentTitle,
}: Props) {
  const { t, i18n } = useTranslation();
  const [docsOpen, setDocsOpen] = React.useState(false);
  const selectedCollections = scope.collectionIds ?? [];
  const names = selectedCollections.map(
    (id) => collections.find((c) => c.id === id)?.name
  );
  const docs = scope.documents ?? [];
  const docLabel = (doc: ScopeDocument) =>
    (documentTitle ? documentTitle(doc) : doc.title) || t("Untitled");
  const dated = !!(scope.datePreset || scope.dateFrom || scope.dateTo);

  const collectionsLabel = !selectedCollections.length
    ? t("All collections")
    : selectedCollections.length <= 2 && names.every(Boolean)
      ? names.join(", ")
      : selectedCollections.length === 1
        ? t("1 collection")
        : t("{{ count }} collections", { count: selectedCollections.length });
  const documentsLabel = !docs.length
    ? t("Specific documents")
    : docs.length === 1
      ? docLabel(docs[0])
      : t("{{ count }} documents", { count: docs.length });

  const handleCompare = () =>
    onChange({
      ...scope,
      mode: scope.mode === "compare" ? undefined : "compare",
    });

  return (
    <Row role="group" aria-label={t("Search scope")}>
      <Popover>
        <PopoverTrigger>
          <Chip
            type="button"
            $on={selectedCollections.length > 0}
            disabled={disabled}
          >
            <CollectionIcon size={16} />
            <Label>{collectionsLabel}</Label>
            <ExpandedIcon size={16} />
          </Chip>
        </PopoverTrigger>
        <PopoverContent side="top" align="start" width={300} shrink>
          <CollectionsPanel
            collections={collections}
            scope={scope}
            onChange={onChange}
          />
        </PopoverContent>
      </Popover>
      <Popover open={docsOpen} onOpenChange={setDocsOpen}>
        <PopoverTrigger>
          <Chip type="button" $on={docs.length > 0} disabled={disabled}>
            <DocumentIcon size={16} />
            <Label>{documentsLabel}</Label>
          </Chip>
        </PopoverTrigger>
        <PopoverContent side="top" align="start" width={340} shrink>
          <DocumentsPanel
            scope={scope}
            onChange={onChange}
            open={docsOpen}
            titleOf={documentTitle}
          />
        </PopoverContent>
      </Popover>
      <Popover>
        <PopoverTrigger>
          <Chip type="button" $on={dated} disabled={disabled}>
            <CalendarIcon size={16} />
            <Label>{dateText(scope, t, i18n.language)}</Label>
            <ExpandedIcon size={16} />
          </Chip>
        </PopoverTrigger>
        <PopoverContent side="top" align="start" width={280} shrink>
          <DatePanel scope={scope} onChange={onChange} />
        </PopoverContent>
      </Popover>
      {compareEnabled && (
        <Chip
          type="button"
          $on={scope.mode === "compare"}
          aria-pressed={scope.mode === "compare"}
          disabled={disabled}
          onClick={handleCompare}
        >
          <Label>{t("Compare")}</Label>
        </Chip>
      )}
    </Row>
  );
}

const Row = styled.div`
  display: flex;
  flex: 1;
  gap: 6px;
  min-width: 0;
  /* Room for the focus ring, which overflow would clip. */
  margin: -2px;
  padding: 2px;
  overflow-x: auto;
  scrollbar-width: none;

  &::-webkit-scrollbar {
    display: none;
  }
`;

const Chip = styled.button<{ $on: boolean }>`
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 6px;
  max-width: 220px;
  height: 28px;
  padding: 0 10px;
  border: 0;
  border-radius: 14px;
  box-shadow: inset 0 0 0 1px
    ${(props) =>
      props.$on
        ? transparentize(0.65, props.theme.accent)
        : props.theme.buttonNeutralBorder};
  background: ${(props) =>
    props.$on
      ? transparentize(0.92, props.theme.accent)
      : props.theme.buttonNeutralBackground};
  color: ${(props) =>
    props.$on ? props.theme.text : props.theme.textSecondary};
  font: inherit;
  font-size: 13px;
  white-space: nowrap;
  cursor: var(--pointer);

  svg {
    flex: none;
    fill: currentColor;
  }

  &:hover:not(:disabled),
  &:focus-visible,
  &[data-state="open"] {
    background: ${s("buttonNeutralHoverBackground")};
    color: ${s("text")};
  }

  &:disabled {
    opacity: 0.5;
    cursor: default;
  }
`;

const Label = styled.span`
  overflow: hidden;
  text-overflow: ellipsis;
`;
