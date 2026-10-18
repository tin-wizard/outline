// Control characters and bidi overrides/isolates have no place in a path.
const UNSAFE_CHARS =
  // oxlint-disable-next-line no-control-regex
  /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/;

/**
 * Whether a server-provided path may be linked. Only `/doc/<slug>` with an
 * optional `#anchor` is: no extra segments, query, dot segments, encoded dots,
 * slashes or backslashes, and no control or bidi characters. Anything else is
 * shown as text.
 *
 * @param url the path from a source or citation.
 * @returns true for safe relative document paths.
 */
export function isDocPath(url: string): boolean {
  if (!/^\/doc\/[^\s\\/?#]+(#[^\s]*)?$/.test(url) || UNSAFE_CHARS.test(url)) {
    return false;
  }
  const slug = url.slice("/doc/".length).split("#")[0];
  return !/^\.+$/.test(slug) && !/%(2e|2f|5c)/i.test(slug);
}
