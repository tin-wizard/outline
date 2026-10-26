import { escape } from "es-toolkit/compat";
import type { Node } from "prosemirror-model";
import slugify from "slugify";

/**
 * Slugifies, escapes and removes periods from heading text so that it is
 * compatible with both url hashes AND dom ID's (querySelector does not like
 * ID's that begin with a number or a period, for example).
 *
 * @param text the heading text.
 * @returns the anchor of the first heading with this text.
 */
export function safeSlugify(text: string) {
  return `h-${escape(
    slugify(text, {
      remove: /[!"#$%&'.()*+,/:;<=>?@[\]\\^_`{|}~]/g,
      lower: true,
    })
  )}`;
}

// calculates a unique slug for this heading based on it's text and position
// in the document that is as stable as possible
export default function headingToSlug(node: Node, index = 0) {
  const slugified = safeSlugify(node.textContent);
  if (index === 0) {
    return slugified;
  }
  return `${slugified}-${index}`;
}
