import { Readable } from "node:stream";

/** Thrown when a stream yields more bytes than allowed. */
export class ReadCapExceededError extends Error {
  constructor(maxBytes: number) {
    super(`Stream exceeds ${maxBytes} bytes`);
    this.name = "ReadCapExceededError";
  }
}

/**
 * Reads a stream into memory, stopping as soon as it passes a size cap.
 *
 * @param stream the stream to read.
 * @param maxBytes the most bytes accepted.
 * @returns the bytes read.
 * @throws {ReadCapExceededError} when the stream yields more than `maxBytes`;
 * the stream is destroyed first.
 */
export async function readCapped(
  stream: NodeJS.ReadableStream | Readable,
  maxBytes: number
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    total += bytes.length;
    if (total > maxBytes) {
      if (stream instanceof Readable) {
        stream.destroy();
      }
      throw new ReadCapExceededError(maxBytes);
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, total);
}
