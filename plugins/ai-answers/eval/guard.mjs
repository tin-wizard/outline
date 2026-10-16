import { parse } from "node:url";

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * Whether a connection URL points at this machine. `new URL` and the legacy
 * `url.parse` (used by Sequelize) disagree on some inputs, so both must name a
 * local host; host overrides in the query string and backslashes are refused.
 *
 * @param {string} url a database or redis URL.
 * @returns {boolean} true only when every parser sees a local host.
 */
export function isLocalUrl(url) {
  if (typeof url !== "string" || !url.trim() || url.includes("\\")) {
    return false;
  }
  try {
    const modern = new URL(url);
    const legacy = parse(url, true);
    for (const key of ["host", "hostaddr", "socket", "socketPath"]) {
      if (modern.searchParams.has(key) || key in legacy.query) {
        return false;
      }
    }
    return (
      LOCAL_HOSTS.has(modern.hostname) && LOCAL_HOSTS.has(legacy.hostname ?? "")
    );
  } catch {
    return false;
  }
}
