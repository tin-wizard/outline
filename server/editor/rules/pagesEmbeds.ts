import type MarkdownIt from "markdown-it";
import type StateCore from "markdown-it/lib/rules_core/state_core.mjs";

/**
 * The base URL that published Pages artifacts are served from, without a
 * trailing slash, or undefined when Pages is not configured. Read on each
 * parse so the setting is picked up without a restart of the parser.
 */
function artifactsPrefix(): string | undefined {
  const base = process.env.PAGES_PUBLIC_BASE_URL?.replace(/\/+$/, "");
  return base ? `${base}/artifacts/` : undefined;
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
  const prefix = artifactsPrefix();
  if (!prefix) {
    return;
  }
  const tokens = state.tokens;
  for (let i = 0; i < tokens.length - 2; i++) {
    const [open, inline, close] = [tokens[i], tokens[i + 1], tokens[i + 2]];
    if (
      open.type !== "paragraph_open" ||
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
    if (!href.startsWith(prefix) || children[1].content !== href) {
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
