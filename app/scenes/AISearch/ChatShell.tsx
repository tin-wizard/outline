import {
  ClockIcon,
  EditIcon,
  PadlockIcon,
  SidebarIcon,
  SparklesIcon,
} from "outline-icons";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import styled from "styled-components";
import { breakpoints, ellipsis, s } from "@shared/styles";
import { createInternalLinkAction } from "~/actions";
import { NavigationSection } from "~/actions/sections";
import Badge from "~/components/Badge";
import Breadcrumb from "~/components/Breadcrumb";
import Button from "~/components/Button";
import Tooltip from "~/components/Tooltip";
import { aiPath } from "~/utils/routeHelpers";

interface BreadcrumbProps {
  /** The chat title, or "New chat". */
  title: string;
  /** Drops the "AI Search" root, leaving the title alone (phones). */
  titleOnly?: boolean;
}

/**
 * Header trail "AI Search › <chat title>". Shown at rest, unlike the Scene
 * title which Header only reveals after scrolling.
 *
 * @param props.title the current chat's title.
 * @param props.titleOnly show just the title.
 * @returns the trail.
 */
export function ChatBreadcrumb({ title, titleOnly }: BreadcrumbProps) {
  const { t } = useTranslation();
  const actions = React.useMemo(
    () =>
      titleOnly
        ? []
        : [
            createInternalLinkAction({
              name: t("AI Search"),
              section: NavigationSection,
              icon: <SparklesIcon size={18} />,
              to: aiPath(),
            }),
          ],
    [titleOnly, t]
  );
  return (
    <Breadcrumb actions={actions}>
      <Current aria-current="page">{title}</Current>
    </Breadcrumb>
  );
}

/**
 * Says that stored chats are only visible to their owner.
 *
 * @returns the badge.
 */
export function PrivateBadge() {
  const { t } = useTranslation();
  return (
    <Tooltip content={t("Chats are only visible to you")}>
      <PrivateTag>
        <PadlockIcon size={14} />
        {t("Private")}
      </PrivateTag>
    </Tooltip>
  );
}

interface ToggleProps {
  open: boolean;
  disabled?: boolean;
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
}

/**
 * Icon button that shows or hides the Sources drawer. Hidden below desktop
 * width, where the drawer is a sheet opened from an answer.
 *
 * @param props.open whether the drawer is open.
 * @param props.disabled true when there is nothing to show.
 * @param props.onClick toggles the drawer.
 * @returns the button.
 */
export function SourcesToggle({ open, disabled, onClick }: ToggleProps) {
  const { t } = useTranslation();
  return (
    <DesktopOnly>
      <Tooltip content={t("Toggle sources")}>
        <Button
          type="button"
          neutral
          borderOnHover
          aria-label={t("Toggle sources")}
          aria-pressed={open}
          disabled={disabled}
          onClick={onClick}
          icon={<FlippedSidebar />}
        />
      </Tooltip>
    </DesktopOnly>
  );
}

interface NewChatProps {
  onClick: () => void;
}

/**
 * Pencil icon link to a new chat, for phones where the sidebar is closed.
 *
 * @param props.onClick called when the link is followed.
 * @returns the link.
 */
export function NewChatIconLink({ onClick }: NewChatProps) {
  const { t } = useTranslation();
  return (
    <PhoneOnly>
      <Button
        as={Link}
        to={aiPath()}
        neutral
        borderOnHover
        aria-label={t("New chat")}
        icon={<EditIcon />}
        onClick={onClick}
      />
    </PhoneOnly>
  );
}

/**
 * Divider above a resumed chat: "Resumed · started Fri, Oct 16".
 *
 * @param props.date the already formatted start date.
 * @returns the divider.
 */
export function ResumedDivider({ date }: { date: string }) {
  const { t } = useTranslation();
  return (
    <Resumed data-resumed>
      <ClockIcon size={16} />
      <span>{t("Resumed · started {{ date }}", { date })}</span>
    </Resumed>
  );
}

const Current = styled.span`
  ${ellipsis()}
  min-width: 0;
  /* Header crumbs stop shrinking from tablet up, so a long title needs a cap. */
  max-width: min(40vw, 560px);

  @media (min-width: ${breakpoints.tablet}px) and (max-width: ${breakpoints.desktop - 1}px) {
    max-width: 26vw;
  }

  padding-inline: 4px;
  color: ${s("text")};
  font-size: 15px;
  font-weight: 500;
`;

const PrivateTag = styled(Badge)`
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  gap: 4px;
  margin: 0 0 0 8px;

  svg {
    fill: currentColor;
  }

  @media (max-width: ${breakpoints.tablet - 1}px) {
    display: none;
  }
`;

const DesktopOnly = styled.span`
  display: none;

  @media (min-width: ${breakpoints.desktop}px) {
    display: inline-flex;
  }
`;

const PhoneOnly = styled.span`
  display: inline-flex;

  @media (min-width: ${breakpoints.tablet}px) {
    display: none;
  }
`;

/** The sidebar glyph points left; the Sources drawer is on the right. */
const FlippedSidebar = styled(SidebarIcon)`
  transform: scaleX(-1);
`;

const Resumed = styled.div`
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 4px 0 24px;
  color: ${s("textTertiary")};
  font-size: 12.5px;

  svg {
    flex-shrink: 0;
    fill: currentColor;
  }

  &::before,
  &::after {
    content: "";
    flex: 1;
    height: 1px;
    background: ${s("divider")};
  }
`;
