import { observer } from "mobx-react";
import { CloseIcon } from "outline-icons";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import styled from "styled-components";
import type { NavigationNode } from "@shared/types";
import { NavigationNodeType } from "@shared/types";
import Button from "~/components/Button";
import DocumentExplorer from "~/components/DocumentExplorer";
import Flex from "~/components/Flex";
import NudeButton from "~/components/NudeButton";
import Text from "~/components/Text";
import useCollectionTrees from "~/hooks/useCollectionTrees";
import type { SourceChoice } from "../types";

/** The most sources the server accepts in one request. */
export const MAX_SOURCES = 20;

interface Props {
  /** The documents and collections chosen so far. */
  chosen: SourceChoice[];
  /** Called with the new list whenever a source is added or removed. */
  onChange: (chosen: SourceChoice[]) => void;
}

/**
 * Lets the administrator build a list of documents and collections by picking
 * them one at a time in the shared document explorer.
 */
function SourcePicker({ chosen, onChange }: Props) {
  const { t } = useTranslation();
  const items = useCollectionTrees();
  const [selected, setSelected] = useState<NavigationNode | null>(null);

  const handleAdd = useCallback(
    (node: NavigationNode | null = selected) => {
      if (!node || chosen.length >= MAX_SOURCES) {
        return;
      }
      const type: SourceChoice["type"] =
        node.type === NavigationNodeType.Collection ? "collection" : "document";
      if (chosen.some((source) => source.id === node.id)) {
        return;
      }
      onChange([
        ...chosen,
        { type, id: node.id, title: node.title || t("Untitled") },
      ]);
    },
    [selected, chosen, onChange, t]
  );

  const handleRemove = useCallback(
    (id: string) => onChange(chosen.filter((source) => source.id !== id)),
    [chosen, onChange]
  );

  // Enter in the explorer's search box must not submit a surrounding form.
  const handleKeyDown = useCallback((ev: React.KeyboardEvent) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
    }
  }, []);

  return (
    <Flex column gap={8}>
      <Explorer onKeyDown={handleKeyDown}>
        <DocumentExplorer
          items={items}
          onSelect={setSelected}
          onSubmit={handleAdd}
        />
      </Explorer>
      <Flex justify="space-between" align="center" gap={8}>
        <Text type="secondary" ellipsis>
          {selected ? selected.title || t("Untitled") : t("Select a page")}
        </Text>
        <Button
          type="button"
          neutral
          disabled={!selected || chosen.length >= MAX_SOURCES}
          onClick={() => handleAdd()}
        >
          {t("Add to site")}
        </Button>
      </Flex>
      {chosen.length > 0 && (
        <ul aria-label={t("Chosen pages")}>
          {chosen.map((source) => (
            <Item key={source.id}>
              <Text>
                {source.title}{" "}
                <Text type="tertiary">
                  ({source.type === "collection" ? t("Collection") : t("Page")})
                </Text>
              </Text>
              <NudeButton
                type="button"
                aria-label={t("Remove {{ title }}", { title: source.title })}
                onClick={() => handleRemove(source.id)}
              >
                <CloseIcon />
              </NudeButton>
            </Item>
          ))}
        </ul>
      )}
    </Flex>
  );
}

const Explorer = styled.div`
  margin: 0 -24px;
`;

const Item = styled.li`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
`;

export default observer(SourcePicker);
