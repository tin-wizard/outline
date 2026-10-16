import { EditIcon, GlobeIcon, TrashIcon } from "outline-icons";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import styled from "styled-components";
import { s } from "@shared/styles";
import { createAction } from "~/actions";
import { SettingsSection } from "~/actions/sections";
import { DropdownMenu } from "~/components/Menu/DropdownMenu";
import { OverflowMenuButton } from "~/components/Menu/OverflowMenuButton";
import Text from "~/components/Text";
import Time from "~/components/Time";
import { useMenuAction } from "~/hooks/useMenuAction";
import { PagesGateType } from "../../shared/accessCode";
import type { PagesSiteData } from "../types";

interface Props {
  sites: PagesSiteData[];
  onPublish: (site: PagesSiteData) => void;
  onRotate: (site: PagesSiteData) => void;
  onUnpublish: (site: PagesSiteData) => void;
  onDelete: (site: PagesSiteData) => void;
  onInsights: (site: PagesSiteData) => void;
}

/** A semantic table of gated sites with a row actions menu. */
export function SitesTable({ sites, ...handlers }: Props) {
  const { t } = useTranslation();
  const statusLabels = {
    draft: t("Draft"),
    published: t("Published"),
    unpublished: t("Unpublished"),
  };

  return (
    <Table>
      <thead>
        <tr>
          <th scope="col">{t("Title")}</th>
          <th scope="col">{t("Address")}</th>
          <th scope="col">{t("Status")}</th>
          <th scope="col">{t("Access")}</th>
          <th scope="col">{t("Measurement")}</th>
          <th scope="col">{t("Last updated")}</th>
          <th scope="col">
            <HiddenText>{t("Actions")}</HiddenText>
          </th>
        </tr>
      </thead>
      <tbody>
        {sites.map((site) => (
          <tr key={site.id}>
            <th scope="row">{site.title}</th>
            <td>
              <Text
                monospace
                selectable
              >{`${site.kind === "artifact" ? "/artifacts/" : "/sites/"}${site.slug}/`}</Text>
            </td>
            <td>{statusLabels[site.status] ?? site.status}</td>
            <td>
              {site.kind === "artifact"
                ? t("Artifact")
                : site.gateType === PagesGateType.None
                  ? t("Public")
                  : t("Protected")}
            </td>
            <td>{site.measurementEnabled ? t("On") : t("Off")}</td>
            <td>
              <Time dateTime={site.updatedAt} addSuffix shorten />
            </td>
            <td>
              <SiteMenu site={site} {...handlers} />
            </td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

function SiteMenu({
  site,
  onPublish,
  onRotate,
  onUnpublish,
  onDelete,
  onInsights,
}: Omit<Props, "sites"> & { site: PagesSiteData }) {
  const { t } = useTranslation();
  const isPublished = site.status === "published";
  const isProtected = site.gateType !== PagesGateType.None;
  const isArtifact = site.kind === "artifact";
  const { publishedUrl } = site;

  const actions = useMemo(
    () => [
      createAction({
        name: `${isPublished ? t("Republish") : t("Publish")}…`,
        icon: <EditIcon />,
        section: SettingsSection,
        visible: !isArtifact,
        perform: () => onPublish(site),
      }),
      createAction({
        name: `${t("Rotate code")}…`,
        icon: <EditIcon />,
        section: SettingsSection,
        visible: isPublished && isProtected && !isArtifact,
        perform: () => onRotate(site),
      }),
      createAction({
        name: t("Insights"),
        icon: <GlobeIcon />,
        section: SettingsSection,
        visible: !isArtifact,
        perform: () => onInsights(site),
      }),
      createAction({
        name: t("Open site"),
        icon: <GlobeIcon />,
        section: SettingsSection,
        visible: isPublished && !!publishedUrl,
        perform: () => {
          if (publishedUrl) {
            window.open(publishedUrl, "_blank", "noopener,noreferrer");
          }
        },
      }),
      createAction({
        name: `${t("Unpublish")}…`,
        icon: <TrashIcon />,
        section: SettingsSection,
        visible: isPublished,
        perform: () => onUnpublish(site),
      }),
      createAction({
        name: `${t("Delete")}…`,
        icon: <TrashIcon />,
        section: SettingsSection,
        dangerous: true,
        perform: () => onDelete(site),
      }),
    ],
    [
      t,
      site,
      isPublished,
      isProtected,
      isArtifact,
      publishedUrl,
      onPublish,
      onRotate,
      onUnpublish,
      onDelete,
      onInsights,
    ]
  );
  const rootAction = useMenuAction(actions);

  return (
    <DropdownMenu
      action={rootAction}
      align="end"
      ariaLabel={t("Actions for {{ title }}", { title: site.title })}
    >
      <OverflowMenuButton />
    </DropdownMenu>
  );
}

const Table = styled.table`
  width: 100%;
  border-collapse: collapse;

  th,
  td {
    padding: 10px 8px;
    text-align: left;
    font-weight: normal;
    border-bottom: 1px solid ${s("divider")};
  }

  thead th {
    font-size: 13px;
    color: ${s("textTertiary")};
  }

  tbody th {
    font-weight: 500;
  }
`;

const HiddenText = styled.span`
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
`;
