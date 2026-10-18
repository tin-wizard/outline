import { darken, lighten, transparentize } from "polished";
import type { DefaultTheme } from "styled-components";

/** Semantic tones, derived from the theme's status colours rather than new tokens. */
export type Tone = "ok" | "warn" | "err";

/**
 * Background, border and text colours for a calm status tint.
 *
 * @param theme the active theme.
 * @param tone which status.
 * @returns the three colours, readable in light and dark themes.
 */
export function toneColors(theme: DefaultTheme, tone: Tone) {
  const base =
    tone === "ok"
      ? theme.success
      : tone === "warn"
        ? theme.warning
        : theme.danger;
  return {
    background: transparentize(theme.isDark ? 0.86 : 0.88, base),
    border: transparentize(0.6, base),
    text: theme.isDark ? lighten(0.12, base) : darken(0.3, base),
  };
}
