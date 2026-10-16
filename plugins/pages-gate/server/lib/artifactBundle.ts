import yauzl from "yauzl";
import { assertSafePath } from "./artifactPaths";

/** Hard ceilings for an uploaded artifact. */
export const BUNDLE_LIMITS = {
  totalBytes: 25 * 1024 * 1024,
  files: 200,
  fileBytes: 10 * 1024 * 1024,
};

/** One validated file of an artifact version. */
export interface BundleFile {
  path: string;
  body: Buffer;
  contentType: string;
}

/** A validation failure whose message is safe to show the user. */
export class BundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BundleError";
  }
}

/**
 * Looks up the served content type for an allowed file extension.
 *
 * @param path a file path; only its extension is used, case-insensitively.
 * @returns the content type, or undefined when the extension is not allowed.
 */
export function contentTypeForPath(path: string): string | undefined {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return CONTENT_TYPES.get(ext);
}

/**
 * Validates an uploaded artifact and returns its files.
 *
 * MVP limitation: a zipped site is served under `/a/<token>/`, so assets must
 * be referenced relatively (build with base './'). Root-absolute URLs such as
 * Vite's default base "/" resolve to the sandbox root and 404.
 *
 * @param fileName the original upload name, used to pick html or zip.
 * @param bytes the file contents.
 * @returns the kind and the validated files, always including `index.html`.
 * @throws {BundleError} when the upload is not a non-empty HTML file or a zip
 * of allowed static files with a top-level `index.html`.
 */
export async function readBundle(
  fileName: string,
  bytes: Buffer
): Promise<{ kind: "html" | "bundle"; files: BundleFile[] }> {
  if (bytes.length > BUNDLE_LIMITS.totalBytes) {
    throw new BundleError("The file is too large");
  }
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".html") || lower.endsWith(".htm")) {
    if (bytes.length === 0) {
      throw new BundleError("The HTML file is empty");
    }
    return {
      kind: "html",
      files: [{ path: "index.html", body: bytes, contentType: HTML }],
    };
  }
  if (!lower.endsWith(".zip")) {
    throw new BundleError("Upload a .html file or a .zip of a static site");
  }
  let files: BundleFile[];
  try {
    files = await readEntries(bytes);
  } catch (err) {
    throw err instanceof BundleError
      ? err
      : new BundleError("The zip file could not be read");
  }
  if (!files.some((f) => f.path === "index.html")) {
    throw new BundleError("The zip must contain index.html at its top level");
  }
  return { kind: "bundle", files };
}

const HTML = "text/html; charset=utf-8";

// A Map, so extensions like "constructor" never hit Object.prototype.
const CONTENT_TYPES = new Map<string, string>([
  ["html", HTML],
  ["htm", HTML],
  ["css", "text/css; charset=utf-8"],
  ["js", "text/javascript; charset=utf-8"],
  ["mjs", "text/javascript; charset=utf-8"],
  ["json", "application/json"],
  ["txt", "text/plain; charset=utf-8"],
  ["svg", "image/svg+xml"],
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["gif", "image/gif"],
  ["webp", "image/webp"],
  ["avif", "image/avif"],
  ["ico", "image/x-icon"],
  ["woff", "font/woff"],
  ["woff2", "font/woff2"],
  ["ttf", "font/ttf"],
  ["mp3", "audio/mpeg"],
  ["mp4", "video/mp4"],
  ["webm", "video/webm"],
]);

// Unix file type bits from the high half of externalFileAttributes.
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;

function readEntries(bytes: Buffer): Promise<BundleFile[]> {
  return new Promise((resolve, reject) => {
    // strictFileNames: reject backslashes instead of rewriting them to "/".
    const options = { lazyEntries: true, strictFileNames: true };
    yauzl.fromBuffer(bytes, options, (openErr, zipfile) => {
      if (openErr || !zipfile) {
        reject(new BundleError("The zip file could not be read"));
        return;
      }
      const files: BundleFile[] = [];
      const seen = new Set<string>();
      let total = 0;
      let settled = false;
      const fail = (err: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        zipfile.close();
        reject(err);
      };

      zipfile.on("error", fail);
      zipfile.on("end", () => {
        if (!settled) {
          settled = true;
          resolve(files);
        }
      });
      zipfile.on("entry", (entry: yauzl.Entry) => {
        try {
          const type = (entry.externalFileAttributes >>> 16) & S_IFMT;
          if (type !== 0 && type !== S_IFREG && type !== S_IFDIR) {
            throw new BundleError("Links and special files are not allowed");
          }
          if (entry.fileName.endsWith("/")) {
            zipfile.readEntry();
            return;
          }
          if (files.length >= BUNDLE_LIMITS.files) {
            throw new BundleError("Too many files in the bundle");
          }
          const path = safePath(entry.fileName);
          const contentType = contentTypeForPath(path);
          if (!contentType) {
            throw new BundleError(`File type not allowed: ${path}`);
          }
          const key = path.toLowerCase();
          if (seen.has(key)) {
            throw new BundleError(`Duplicate file in the bundle: ${path}`);
          }
          seen.add(key);
          if (entry.uncompressedSize > BUNDLE_LIMITS.fileBytes) {
            throw new BundleError(`File too large: ${path}`);
          }
          if (total + entry.uncompressedSize > BUNDLE_LIMITS.totalBytes) {
            throw new BundleError("The bundle is too large");
          }
          zipfile.openReadStream(entry, (streamErr, stream) => {
            if (streamErr || !stream) {
              fail(new BundleError(`Could not read ${path}`));
              return;
            }
            const chunks: Buffer[] = [];
            let size = 0;
            stream.on("data", (chunk: Buffer) => {
              size += chunk.length;
              total += chunk.length;
              // Header sizes can lie; the streamed bytes decide.
              if (size > BUNDLE_LIMITS.fileBytes) {
                stream.destroy();
                fail(new BundleError(`File too large: ${path}`));
                return;
              }
              if (total > BUNDLE_LIMITS.totalBytes) {
                stream.destroy();
                fail(new BundleError("The bundle is too large"));
                return;
              }
              chunks.push(chunk);
            });
            stream.on("error", () =>
              fail(new BundleError(`Could not read ${path}`))
            );
            stream.on("end", () => {
              if (settled) {
                return;
              }
              files.push({ path, body: Buffer.concat(chunks), contentType });
              zipfile.readEntry();
            });
          });
        } catch (err) {
          fail(err);
        }
      });
      zipfile.readEntry();
    });
  });
}

function safePath(path: string): string {
  try {
    return assertSafePath(path);
  } catch {
    throw new BundleError("The zip contains an invalid file path");
  }
}
