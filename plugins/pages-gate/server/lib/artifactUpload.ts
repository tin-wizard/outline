import { ValidationError } from "@server/errors";
import type { Attachment } from "@server/models";
import FileStorage from "@server/storage/files";
import { BUNDLE_LIMITS } from "./artifactBundle";
import { ReadCapExceededError, readCapped } from "./readCapped";

/**
 * Reads an uploaded artifact's bytes from file storage, capped at the bundle
 * size limit. The caller must already have authorized access to the attachment.
 *
 * @param attachment the uploaded .html or .zip attachment.
 * @returns the attachment's bytes.
 * @throws ValidationError when the file is larger than the bundle limit.
 */
export async function readAttachmentBytes(
  attachment: Attachment
): Promise<Buffer> {
  // Refuse before loading an oversized upload into memory.
  if (Number(attachment.size) > BUNDLE_LIMITS.totalBytes) {
    throw ValidationError("The file is too large");
  }
  const stream = await FileStorage.getFileStream(attachment.key);
  if (!stream) {
    throw new Error("No stream available");
  }
  // The declared size is client-supplied, so cap the real read too.
  try {
    return await readCapped(stream, BUNDLE_LIMITS.totalBytes);
  } catch (err) {
    if (err instanceof ReadCapExceededError) {
      throw ValidationError("The file is too large");
    }
    throw err;
  }
}
