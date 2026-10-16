const MAX_PATH_LENGTH = 200;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

/**
 * Validates a relative file path from an uploaded artifact bundle.
 *
 * @param path the path as it appeared in the bundle.
 * @returns the same path, unchanged.
 * @throws when the path is empty, longer than 200 characters, absolute,
 * contains a backslash, `%` or a control character, or has an empty, `.` or
 * `..` segment.
 */
export function assertSafePath(path: string): string {
  if (!path || path.length > MAX_PATH_LENGTH) {
    throw new Error("Invalid artifact file path");
  }
  if (
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("%") ||
    CONTROL_CHARS.test(path)
  ) {
    throw new Error("Invalid artifact file path");
  }
  for (const segment of path.split("/")) {
    if (!segment || segment === "." || segment === "..") {
      throw new Error("Invalid artifact file path");
    }
  }
  return path;
}
