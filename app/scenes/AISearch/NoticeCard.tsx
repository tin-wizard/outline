import * as React from "react";
import { Link } from "react-router-dom";
import styled from "styled-components";
import { s } from "@shared/styles";
import type { Tone } from "./tones";
import { toneColors } from "./tones";

interface Props {
  /** Status tint; calm and neutral when omitted. */
  tone?: Tone;
  /** A dashed card for "the documents don't cover this". */
  gap?: boolean;
  icon: React.ReactNode;
  role?: "note" | "status";
  children: React.ReactNode;
  /** Buttons or links under the text. */
  actions?: React.ReactNode;
}

/**
 * A calm card with an icon, text and optional actions, used for gaps, withheld
 * statements and every error. Its tint comes from the theme's status colours.
 *
 * @param props see Props.
 * @returns the card.
 */
export function NoticeCard({
  tone,
  gap,
  icon,
  role,
  children,
  actions,
}: Props) {
  return (
    <Card $tone={tone} $gap={gap} role={role}>
      <IconSlot aria-hidden>{icon}</IconSlot>
      <div>
        {children}
        {actions && <Actions data-print-hidden>{actions}</Actions>}
      </div>
    </Card>
  );
}

/** A link styled like a small neutral button. */
export const ActionLink = styled(Link)`
  display: inline-flex;
  align-items: center;
  min-height: 28px;
  padding: 0 10px;
  border-radius: 6px;
  box-shadow: inset 0 0 0 1px ${s("inputBorder")};
  color: ${s("text")};
  font-size: 13px;
  font-weight: 500;

  &:hover,
  &:focus-visible {
    background: ${s("backgroundSecondary")};
  }
`;

const Card = styled.div<{ $tone?: Tone; $gap?: boolean }>`
  display: flex;
  gap: 10px;
  margin: 12px 0;
  padding: 12px 14px;
  border: 1px ${(props) => (props.$gap ? "dashed" : "solid")}
    ${(props) =>
      props.$tone
        ? toneColors(props.theme, props.$tone).border
        : props.$gap
          ? props.theme.inputBorderFocused
          : props.theme.divider};
  border-radius: 8px;
  background: ${(props) =>
    props.$tone
      ? toneColors(props.theme, props.$tone).background
      : props.theme.backgroundSecondary};
  color: ${s("text")};
  font-size: 14px;
  line-height: 1.5;

  p {
    margin: 0;
  }

  p + p {
    margin-top: 4px;
  }

  b {
    font-weight: 600;
  }
`;

const IconSlot = styled.span`
  flex: none;
  margin-top: 1px;
  color: ${s("textSecondary")};

  svg {
    fill: currentColor;
  }
`;

const Actions = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 10px;
`;

/** Secondary text inside a card. */
export const Detail = styled.p`
  color: ${s("textSecondary")};
`;
