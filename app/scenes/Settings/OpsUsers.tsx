import { observer } from "mobx-react";
import { UserIcon } from "outline-icons";
import * as React from "react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import styled from "styled-components";
import { UserRole } from "@shared/types";
import { s } from "@shared/styles";
import Button from "~/components/Button";
import Empty from "~/components/Empty";
import Heading from "~/components/Heading";
import Input from "~/components/Input";
import { InputSelect } from "~/components/InputSelect";
import Scene from "~/components/Scene";
import Text from "~/components/Text";
import { client } from "~/utils/ApiClient";

const PAGE_SIZE = 50;

type OpsUser = {
  id: string;
  name: string;
  email?: string | null;
  role: UserRole;
  isPlatformAdmin?: boolean;
  team: { id: string; name: string; subdomain?: string | null };
};

/**
 * Platform console page for listing every user across all workspaces and
 * changing their workspace role.
 */
function OpsUsers() {
  const { t } = useTranslation();
  const [users, setUsers] = useState<OpsUser[] | undefined>();
  const [query, setQuery] = useState("");
  const [role, setRole] = useState<UserRole | "">("");
  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState(0);
  const [saving, setSaving] = useState<string | null>(null);

  const roleOptions = [
    { type: "item" as const, label: t("Any role"), value: "" },
    { type: "item" as const, label: t("Admin"), value: UserRole.Admin },
    { type: "item" as const, label: t("Member"), value: UserRole.Member },
    { type: "item" as const, label: t("Viewer"), value: UserRole.Viewer },
    { type: "item" as const, label: t("Guest"), value: UserRole.Guest },
  ];

  const load = React.useCallback(
    async (nextOffset: number) => {
      try {
        const res = await client.post<{
          data: OpsUser[];
          pagination: { total: number };
        }>("/ops.users.list", {
          query: query || undefined,
          role: role || undefined,
          limit: PAGE_SIZE,
          offset: nextOffset,
        });
        setUsers(res.data);
        setTotal(res.pagination.total);
        setOffset(nextOffset);
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : t("Failed to load users")
        );
      }
    },
    [query, role, t]
  );

  React.useEffect(() => {
    void load(0);
  }, [load]);

  const handleRoleChange = async (target: OpsUser, nextRole: string) => {
    setSaving(target.id);
    try {
      const res = await client.post<{ data: OpsUser }>("/ops.users.setRole", {
        userId: target.id,
        role: nextRole,
      });
      setUsers((prev) =>
        prev?.map((u) =>
          u.id === target.id ? { ...u, role: res.data.role } : u
        )
      );
      toast.success(t("Role updated"));
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : t("Failed to update role")
      );
    } finally {
      setSaving(null);
    }
  };

  const hasPrevious = offset > 0;
  const hasNext = offset + PAGE_SIZE < total;

  return (
    <Scene
      title={t("User management")}
      icon={<UserIcon color="currentColor" />}
    >
      <Heading>{t("User management")}</Heading>
      <Text type="secondary">
        {t(
          "Every user across all workspaces. Change a user's role within their workspace."
        )}
      </Text>

      <Filters>
        <Input
          label={t("Search")}
          placeholder={t("Name or email")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <InputSelect
          label={t("Role")}
          options={roleOptions}
          value={role}
          onChange={(value) => setRole(value as UserRole | "")}
        />
      </Filters>

      {users?.length === 0 ? (
        <Empty>{t("No users match these filters.")}</Empty>
      ) : (
        <Table>
          <thead>
            <tr>
              <th>{t("Name")}</th>
              <th>{t("Email")}</th>
              <th>{t("Workspace")}</th>
              <th>{t("Role")}</th>
            </tr>
          </thead>
          <tbody>
            {(users ?? []).map((target) => (
              <tr key={target.id}>
                <td>
                  {target.name}
                  {target.isPlatformAdmin && <Badge>{t("Platform")}</Badge>}
                </td>
                <td>{target.email ?? "—"}</td>
                <td>{target.team.name}</td>
                <td>
                  <InputSelect
                    label={t("Role")}
                    labelHidden
                    options={roleOptions.slice(1)}
                    value={target.role}
                    disabled={saving === target.id}
                    onChange={(value) => void handleRoleChange(target, value)}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
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

const Filters = styled.div`
  display: flex;
  gap: 16px;
  margin-top: 16px;
  align-items: flex-end;
`;

const Table = styled.table`
  width: 100%;
  margin-top: 16px;
  border-collapse: collapse;

  th,
  td {
    text-align: left;
    padding: 8px;
    border-bottom: 1px solid ${s("divider")};
  }
`;

const Badge = styled.span`
  margin-left: 8px;
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 12px;
  border: 1px solid ${s("accent")};
  color: ${s("accent")};
`;

const Pager = styled.div`
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 16px;
`;

export default observer(OpsUsers);
