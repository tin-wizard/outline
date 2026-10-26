import { observer } from "mobx-react";
import { CollectionIcon, TrashIcon, CloseIcon } from "outline-icons";
import * as React from "react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import styled from "styled-components";
import { s } from "@shared/styles";
import Button from "~/components/Button";
import ConfirmationDialog from "~/components/ConfirmationDialog";
import Empty from "~/components/Empty";
import Heading from "~/components/Heading";
import Input from "~/components/Input";
import NudeButton from "~/components/NudeButton";
import Scene from "~/components/Scene";
import Text from "~/components/Text";
import useStores from "~/hooks/useStores";
import { client } from "~/utils/ApiClient";

const PAGE_SIZE = 50;

type OpsCollection = {
  id: string;
  name: string;
  teamId: string;
  team: { id: string; name: string; subdomain?: string | null };
};

type OpsMembership = {
  id: string;
  userId: string;
  permission: string;
  user: { id: string; name: string; email?: string | null };
};

type OpsUser = {
  id: string;
  name: string;
  email?: string | null;
  team: { id: string; name: string };
};

/**
 * Platform console page for managing collections across all workspaces: list
 * them, view and change their members, and delete them.
 */
function OpsCollections() {
  const { t } = useTranslation();
  const { dialogs } = useStores();
  const [collections, setCollections] = useState<OpsCollection[] | undefined>();
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState(0);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [memberships, setMemberships] = useState<OpsMembership[]>([]);
  const [userQuery, setUserQuery] = useState("");
  const [userResults, setUserResults] = useState<OpsUser[]>([]);

  const load = React.useCallback(
    async (nextOffset: number) => {
      try {
        const res = await client.post<{
          data: OpsCollection[];
          pagination: { total: number };
        }>("/ops.collections.list", {
          query: query || undefined,
          limit: PAGE_SIZE,
          offset: nextOffset,
        });
        setCollections(res.data);
        setTotal(res.pagination.total);
        setOffset(nextOffset);
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : t("Failed to load collections")
        );
      }
    },
    [query, t]
  );

  React.useEffect(() => {
    void load(0);
  }, [load]);

  const loadMemberships = async (id: string) => {
    const res = await client.post<{ data: OpsMembership[] }>(
      "/ops.collections.memberships",
      { id }
    );
    setMemberships(res.data);
  };

  const handleToggle = async (collection: OpsCollection) => {
    if (expandedId === collection.id) {
      setExpandedId(null);
      return;
    }

    setExpandedId(collection.id);
    setMemberships([]);
    setUserQuery("");
    setUserResults([]);
    try {
      await loadMemberships(collection.id);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : t("Failed to load members")
      );
    }
  };

  const handleSearchUsers = async (collection: OpsCollection) => {
    if (!userQuery) {
      setUserResults([]);
      return;
    }

    try {
      const res = await client.post<{ data: OpsUser[] }>("/ops.users.list", {
        query: userQuery,
        teamId: collection.teamId,
        limit: 10,
      });
      setUserResults(res.data);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : t("Failed to search users")
      );
    }
  };

  const handleAddUser = async (collection: OpsCollection, userId: string) => {
    try {
      await client.post("/ops.collections.addUser", {
        id: collection.id,
        userId,
      });
      await loadMemberships(collection.id);
      toast.success(t("Member added"));
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : t("Failed to add member")
      );
    }
  };

  const handleRemoveUser = async (
    collection: OpsCollection,
    userId: string
  ) => {
    try {
      await client.post("/ops.collections.removeUser", {
        id: collection.id,
        userId,
      });
      await loadMemberships(collection.id);
      toast.success(t("Member removed"));
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : t("Failed to remove member")
      );
    }
  };

  const handleDelete = (collection: OpsCollection) => {
    dialogs.openModal({
      title: t("Delete collection"),
      content: (
        <ConfirmationDialog
          onSubmit={async () => {
            try {
              await client.post("/ops.collections.delete", {
                id: collection.id,
              });
              setCollections((prev) =>
                prev?.filter((c) => c.id !== collection.id)
              );
              setTotal((prev) => Math.max(0, prev - 1));
              if (expandedId === collection.id) {
                setExpandedId(null);
              }
              toast.success(t("Collection deleted"));
            } catch (err) {
              toast.error(
                err instanceof Error
                  ? err.message
                  : t("Failed to delete collection")
              );
            }
          }}
          submitText={t("Delete")}
          danger
        >
          {t(
            "Deleting {{ name }} will also delete all of its documents. This cannot be undone.",
            { name: collection.name }
          )}
        </ConfirmationDialog>
      ),
    });
  };

  const hasPrevious = offset > 0;
  const hasNext = offset + PAGE_SIZE < total;

  return (
    <Scene
      title={t("Collections")}
      icon={<CollectionIcon color="currentColor" />}
    >
      <Heading>{t("Collections")}</Heading>
      <Text type="secondary">
        {t(
          "Every collection across all workspaces. Manage members or delete a collection."
        )}
      </Text>

      <Input
        label={t("Search")}
        placeholder={t("Collection name")}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      {collections?.length === 0 ? (
        <Empty>{t("No collections match this search.")}</Empty>
      ) : (
        <List>
          {(collections ?? []).map((collection) => {
            const expanded = expandedId === collection.id;
            return (
              <Item key={collection.id}>
                <Row>
                  <Name onClick={() => void handleToggle(collection)}>
                    {collection.name}
                  </Name>
                  <Muted>{collection.team.name}</Muted>
                  <Actions>
                    <Button
                      neutral
                      onClick={() => void handleToggle(collection)}
                    >
                      {expanded ? t("Hide members") : t("Members")}
                    </Button>
                    <NudeButton
                      onClick={() => handleDelete(collection)}
                      title={t("Delete collection")}
                    >
                      <TrashIcon size={18} color="currentColor" />
                    </NudeButton>
                  </Actions>
                </Row>

                {expanded && (
                  <Panel>
                    <Heading as="h3">{t("Members")}</Heading>
                    {memberships.length === 0 ? (
                      <Muted>{t("No members yet.")}</Muted>
                    ) : (
                      <table>
                        <tbody>
                          {memberships.map((m) => (
                            <tr key={m.id}>
                              <td>{m.user.name}</td>
                              <Muted as="td">{m.user.email ?? "—"}</Muted>
                              <td>{m.permission}</td>
                              <td>
                                <NudeButton
                                  onClick={() =>
                                    void handleRemoveUser(collection, m.userId)
                                  }
                                  title={t("Remove member")}
                                >
                                  <CloseIcon size={18} color="currentColor" />
                                </NudeButton>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}

                    <Heading as="h3">{t("Add member")}</Heading>
                    <SearchRow>
                      <Input
                        label={t("Find user in this workspace")}
                        placeholder={t("Name or email")}
                        value={userQuery}
                        onChange={(e) => setUserQuery(e.target.value)}
                      />
                      <Button
                        neutral
                        onClick={() => void handleSearchUsers(collection)}
                      >
                        {t("Search")}
                      </Button>
                    </SearchRow>
                    {userResults.map((u) => (
                      <Row key={u.id}>
                        <span>{u.name}</span>
                        <Muted>{u.email ?? "—"}</Muted>
                        <Button
                          neutral
                          onClick={() => void handleAddUser(collection, u.id)}
                        >
                          {t("Add")}
                        </Button>
                      </Row>
                    ))}
                  </Panel>
                )}
              </Item>
            );
          })}
        </List>
      )}

      <Pager>
        <Button
          neutral
          disabled={!hasPrevious}
          onClick={() => void load(Math.max(0, offset - PAGE_SIZE))}
        >
          {t("Previous")}
        </Button>
        <Button
          neutral
          disabled={!hasNext}
          onClick={() => void load(offset + PAGE_SIZE)}
        >
          {t("Next")}
        </Button>
      </Pager>
    </Scene>
  );
}

const List = styled.div`
  margin-top: 16px;
`;

const Item = styled.div`
  border-bottom: 1px solid ${s("divider")};
  padding: 8px 0;
`;

const Row = styled.div`
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 4px 0;
`;

const Name = styled.span`
  flex: 1;
  font-weight: 500;
  cursor: pointer;
`;

const Muted = styled.span`
  color: ${s("textSecondary")};
`;

const Actions = styled.div`
  display: flex;
  gap: 8px;
  align-items: center;
`;

const Panel = styled.div`
  padding: 8px 0 8px 16px;

  table {
    width: 100%;
    border-collapse: collapse;
  }

  td {
    padding: 4px 8px;
  }
`;

const SearchRow = styled.div`
  display: flex;
  gap: 8px;
  align-items: flex-end;
`;

const Pager = styled.div`
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 16px;
`;

export default observer(OpsCollections);
