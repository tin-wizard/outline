import type MarkdownIt from "markdown-it";
import type StateCore from "markdown-it/lib/rules_core/state_core.mjs";

/**
 * The parsed base URL that published Pages artifacts are served from, or
 * undefined when Pages is not configured or the value is not a valid URL.
 * Read on each parse so the setting is picked up without a restart.
 */
function pagesBase(): URL | undefined {
  const value = process.env.PAGES_PUBLIC_BASE_URL;
  if (!value) {
    return undefined;
  }
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

/**
 * Whether a URL points at a published artifact on the Pages host. Compares
 * the parsed origin and the dot-resolved pathname, so `..` segments, lookalike
 * hosts and userinfo cannot escape the artifacts path.
 *
 * @param href the link target.
 * @param base the parsed Pages base URL.
 * @return true if the URL is under the base's /artifacts/ path.
 */
function isArtifactUrl(href: string, base: URL): boolean {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return false;
  }
  const basePath = base.pathname.replace(/\/+$/, "");
  return (
    u.origin === base.origin &&
    !u.username &&
    !u.password &&
    u.pathname.startsWith(`${basePath}/artifacts/`)
  );
}

/**
 * Turns a paragraph that consists only of a link to a published Pages
 * artifact, where the link text is the URL itself, into an `embed` token.
 * This is what `embed` nodes serialize to in markdown, so it also stops
 * `update_document` in replace mode from downgrading embeds to plain links.
 *
 * @param state the markdown-it core state.
 */
function embedArtifactLinks(state: StateCore) {
  const base = pagesBase();
  if (!base) {
    return;
  }
  const tokens = state.tokens;
  for (let i = 0; i < tokens.length - 2; i++) {
    const [open, inline, close] = [tokens[i], tokens[i + 1], tokens[i + 2]];
    if (
      open.type !== "paragraph_open" ||
      // Tight list items wrap their text in hidden paragraphs; leave those as links.
      open.hidden ||
      inline.type !== "inline" ||
      close.type !== "paragraph_close"
    ) {
      continue;
    }
    const children = inline.children ?? [];
    if (
      children.length !== 3 ||
      children[0].type !== "link_open" ||
      children[1].type !== "text" ||
      children[2].type !== "link_close"
    ) {
      continue;
    }
    const href = children[0].attrGet("href") ?? "";
    if (children[1].content !== href || !isArtifactUrl(href, base)) {
      continue;
    }
    const token = new state.Token("embed", "a", 0);
    token.attrSet("href", href);
    tokens.splice(i, 3, token);
  }
}

/**
 * markdown-it plugin: see embedArtifactLinks.
 *
 * @param md the markdown-it instance.
 */
export default function pagesEmbeds(md: MarkdownIt) {
  md.core.ruler.push("pages_embeds", embedArtifactLinks);
}
