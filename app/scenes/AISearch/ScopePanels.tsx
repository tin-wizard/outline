import { CloseIcon } from "outline-icons";
import * as React from "react";
import { useTranslation } from "react-i18next";
import styled from "styled-components";
import { s } from "@shared/styles";
import InputSearch from "~/components/InputSearch";
import type { DatePreset, Scope, ScopeDocument } from "./model";
import {
  DATE_PRESETS,
  MAX_SCOPE_COLLECTIONS,
  MAX_SCOPE_DOCUMENTS,
  rangeError,
  withCollections,
  withDates,
  withDocuments,
} from "./scope";
import { useDocumentPicker } from "./useDocumentPicker";

/** A collection the user can scope a question to. */
export interface PanelCollection {
  id: string;
  name: string;
  /** The collection's icon, drawn by the caller. */
  icon: React.ReactNode;
}

interface PanelProps {
  scope: Scope;
  onChange: (scope: Scope) => void;
}

/**
 * Multi-select list of collections ("Search in collections"). Choosing any
 * clears specific documents, as the two scopes replace each other.
 *
 * @param props.collections the readable collections not excluded from AI.
 * @param props.scope the current scope.
 * @param props.onChange receives the new scope.
 * @returns the panel.
 */
export function CollectionsPanel({
  collections,
  scope,
  onChange,
}: PanelProps & { collections: PanelCollection[] }) {
  const { t } = useTranslation();
  const [query, setQuery] = React.useState("");
  const selected = scope.collectionIds ?? [];
  const full = selected.length >= MAX_SCOPE_COLLECTIONS;
  const needle = query.trim().toLowerCase();
  const visible = needle
    ? collections.filter((c) => c.name.toLowerCase().includes(needle))
    : collections;

  const handleSearch = (event: React.ChangeEvent<HTMLInputElement>) =>
    setQuery(event.target.value);
  const handleAll = () => onChange(withCollections(scope, []));
  const handleToggle = (id: string) => {
    const next = selected.includes(id)
      ? selected.filter((x) => x !== id)
      : [...selected, id];
    onChange(withCollections(scope, next));
  };

  return (
    <Panel>
      <Heading id="ai-scope-collections">{t("Search in collections")}</Heading>
      {collections.length > 6 && (
        <InputSearch
          value={query}
          onChange={handleSearch}
          placeholder={t("Filter collections")}
          aria-label={t("Filter collections")}
        />
      )}
      <List role="group" aria-labelledby="ai-scope-collections">
        <Row>
          <input
            type="checkbox"
            checked={selected.length === 0}
            onChange={handleAll}
            // Unchecking "All" alone would leave nothing selected.
            disabled={selected.length === 0}
          />
          <span>{t("All collections")}</span>
        </Row>
        {visible.map((collection) => {
          const checked = selected.includes(collection.id);
          return (
            <Row key={collection.id}>
              <input
                type="checkbox"
                checked={checked}
                disabled={!checked && full}
                onChange={() => handleToggle(collection.id)}
              />
              <Icon aria-hidden>{collection.icon}</Icon>
              <span>{collection.name}</span>
            </Row>
          );
        })}
        {needle && visible.length === 0 && (
          <Empty>{t("No collections found")}</Empty>
        )}
      </List>
      <Hint>
        {full
          ? t("You can choose up to {{ count }} collections.", {
              count: MAX_SCOPE_COLLECTIONS,
            })
          : t("Choosing collections replaces any specific documents.")}
      </Hint>
    </Panel>
  );
}

/**
 * Search-and-pick list of documents ("Search in specific documents"). Choosing
 * any clears the collection scope.
 *
 * @param props.scope the current scope.
 * @param props.onChange receives the new scope.
 * @param props.open whether the panel is showing; nothing is requested otherwise.
 * @param props.titleOf resolves the title shown for a selected document.
 * @returns the panel.
 */
export function DocumentsPanel({
  scope,
  onChange,
  open = true,
  titleOf,
}: PanelProps & {
  open?: boolean;
  titleOf?: (doc: ScopeDocument) => string;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = React.useState("");
  const picker = useDocumentPicker(query, open);
  const selected = scope.documents ?? [];
  const full = selected.length >= MAX_SCOPE_DOCUMENTS;
  const label = (doc: ScopeDocument) =>
    (titleOf ? titleOf(doc) : doc.title) || t("Untitled");

  const handleSearch = (event: React.ChangeEvent<HTMLInputElement>) =>
    setQuery(event.target.value);
  const handleToggle = (doc: ScopeDocument) => {
    const next = selected.some((d) => d.id === doc.id)
      ? selected.filter((d) => d.id !== doc.id)
      : [...selected, doc];
    onChange(withDocuments(scope, next));
  };

  return (
    <Panel>
      <Heading id="ai-scope-documents">
        {t("Search in specific documents")}
      </Heading>
      {selected.length > 0 && (
        <Picked aria-label={t("Selected documents")}>
          {selected.map((doc) => (
            <li key={doc.id}>
              <Pill>
                <span>{label(doc)}</span>
                <PillRemove
                  type="button"
                  aria-label={t("Remove {{ name }} from the scope", {
                    name: label(doc),
                  })}
                  onClick={() => handleToggle(doc)}
                >
                  <CloseIcon size={16} />
                </PillRemove>
              </Pill>
            </li>
          ))}
        </Picked>
      )}
      <InputSearch
        value={query}
        onChange={handleSearch}
        placeholder={t("Search documents")}
        aria-label={t("Search documents")}
        autoFocus
      />
      <List role="group" aria-labelledby="ai-scope-documents">
        {picker.results.map((doc) => {
          const checked = selected.some((d) => d.id === doc.id);
          return (
            <Row key={doc.id}>
              <input
                type="checkbox"
                checked={checked}
                disabled={!checked && full}
                onChange={() => handleToggle({ id: doc.id, title: doc.title })}
              />
              <Grow>
                <span>{doc.title || t("Untitled")}</span>
                {doc.collectionName && <Meta>{doc.collectionName}</Meta>}
              </Grow>
            </Row>
          );
        })}
      </List>
      <Status role="status">
        {picker.loading
          ? t("Searching…")
          : picker.error
            ? undefined
            : picker.results.length === 0
              ? t("No documents found")
              : undefined}
      </Status>
      {picker.error && !picker.loading && (
        <ErrorLine role="alert">
          {t("Couldn't load documents.")}{" "}
          <LinkButton type="button" onClick={picker.reload}>
            {t("Try again")}
          </LinkButton>
        </ErrorLine>
      )}
      <Hint>
        {full
          ? t("You can choose up to {{ count }} documents.", {
              count: MAX_SCOPE_DOCUMENTS,
            })
          : t("Choosing documents replaces the collection scope.")}
      </Hint>
    </Panel>
  );
}

/**
 * Date window choice ("Updated"): any time, a preset, or a custom range of two
 * dates that must be in order.
 *
 * @param props.scope the current scope.
 * @param props.onChange receives the new scope.
 * @returns the panel.
 */
export function DatePanel({ scope, onChange }: PanelProps) {
  const { t } = useTranslation();
  const [from, setFrom] = React.useState(scope.dateFrom ?? "");
  const [to, setTo] = React.useState(scope.dateTo ?? "");
  const current: DatePreset | "any" = scope.datePreset ?? "any";
  const error = rangeError(from || undefined, to || undefined);
  const labels: Record<DatePreset | "any", string> = {
    any: t("Any time"),
    week: t("Past week"),
    month: t("Past month"),
    year: t("Past year"),
    custom: t("Custom range"),
  };

  const commit = (nextFrom: string, nextTo: string) => {
    if (!rangeError(nextFrom || undefined, nextTo || undefined)) {
      onChange(
        withDates(scope, "custom", {
          dateFrom: nextFrom || undefined,
          dateTo: nextTo || undefined,
        })
      );
    }
  };
  const handleChoose = (next: DatePreset | "any") => {
    if (next === "custom") {
      commit(from, to);
      return;
    }
    onChange(withDates(scope, next === "any" ? undefined : next));
  };
  const handleFrom = (event: React.ChangeEvent<HTMLInputElement>) => {
    setFrom(event.target.value);
    commit(event.target.value, to);
  };
  const handleTo = (event: React.ChangeEvent<HTMLInputElement>) => {
    setTo(event.target.value);
    commit(from, event.target.value);
  };

  return (
    <Panel>
      <Heading id="ai-scope-dates">{t("Updated")}</Heading>
      <List role="radiogroup" aria-labelledby="ai-scope-dates">
        {(["any", ...DATE_PRESETS, "custom"] as const).map((key) => (
          <Row key={key}>
            <input
              type="radio"
              name="ai-scope-date"
              checked={current === key}
              onChange={() => handleChoose(key)}
            />
            <span>{labels[key]}</span>
          </Row>
        ))}
      </List>
      {current === "custom" && (
        <Range>
          <label>
            <span>{t("From")}</span>
            <input
              type="date"
              value={from}
              max={to || undefined}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? "ai-scope-date-error" : undefined}
              onChange={handleFrom}
            />
          </label>
          <label>
            <span>{t("To")}</span>
            <input
              type="date"
              value={to}
              min={from || undefined}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? "ai-scope-date-error" : undefined}
              onChange={handleTo}
            />
          </label>
        </Range>
      )}
      {error && (
        <ErrorLine id="ai-scope-date-error" role="alert">
          {error === "order"
            ? t("The start date must be on or before the end date.")
            : t("Enter a valid date.")}
        </ErrorLine>
      )}
    </Panel>
  );
}

const Panel = styled.div`
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
  font-size: 14px;
`;

const Heading = styled.div`
  color: ${s("textTertiary")};
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.02em;
  text-transform: uppercase;
`;

const List = styled.div`
  display: flex;
  flex-direction: column;
  max-height: 260px;
  overflow-y: auto;
`;

const Row = styled.label`
  display: flex;
  /* Never squeezed by the scrolling list; two-line rows keep their height. */
  flex: none;
  align-items: center;
  gap: 8px;
  min-height: 32px;
  padding: 2px 4px;
  border-radius: 6px;
  color: ${s("text")};
  cursor: var(--pointer);

  &:hover {
    background: ${s("listItemHoverBackground")};
  }

  input {
    flex: none;
    margin: 0;
  }
`;

const Icon = styled.span`
  display: inline-flex;
  flex: none;
`;

const Grow = styled.span`
  display: flex;
  flex-direction: column;
  min-width: 0;

  > span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
`;

const Meta = styled.span`
  color: ${s("textTertiary")};
  font-size: 12px;
  line-height: 1.3;
`;

const Hint = styled.p`
  margin: 0;
  color: ${s("textTertiary")};
  font-size: 12px;
`;

const Empty = styled.p`
  margin: 4px;
  color: ${s("textTertiary")};
`;

const Status = styled.div`
  min-height: 1em;
  color: ${s("textTertiary")};
  font-size: 13px;
`;

const ErrorLine = styled.div`
  color: ${s("danger")};
  font-size: 13px;
`;

const LinkButton = styled.button`
  padding: 0;
  border: 0;
  background: none;
  color: ${s("accent")};
  font: inherit;
  cursor: var(--pointer);
  text-decoration: underline;
`;

const Picked = styled.ul`
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
`;

const Pill = styled.span`
  display: inline-flex;
  align-items: center;
  max-width: 100%;
  padding: 1px 2px 1px 10px;
  border-radius: 12px;
  background: ${s("backgroundSecondary")};
  font-size: 13px;

  > span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
`;

const PillRemove = styled.button`
  display: inline-flex;
  padding: 2px;
  border: 0;
  border-radius: 50%;
  background: none;
  color: ${s("textSecondary")};
  cursor: var(--pointer);

  &:hover,
  &:focus-visible {
    color: ${s("text")};
  }
`;

const Range = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 8px;

  label {
    display: flex;
    flex-direction: column;
    gap: 2px;
    color: ${s("textSecondary")};
    font-size: 12px;
  }

  input {
    padding: 4px 6px;
    border: 1px solid ${s("inputBorder")};
    border-radius: 6px;
    background: ${s("background")};
    color: ${s("text")};
    font: inherit;
    font-size: 14px;
  }
`;
