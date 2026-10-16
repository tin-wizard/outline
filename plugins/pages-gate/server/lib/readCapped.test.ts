import { Readable } from "node:stream";
import { ReadCapExceededError, readCapped } from "./readCapped";

/** A stream of `count` chunks of `size` bytes that records how many it gave. */
function chunked(count: number, size: number) {
  const state = { pulled: 0 };
  const stream = Readable.from(
    (function* () {
      for (let i = 0; i < count; i++) {
        state.pulled++;
        yield Buffer.alloc(size, 0x61);
      }
    })()
  );
  return { stream, state };
}

describe("readCapped", () => {
  it("returns every byte when the stream is exactly at the cap", async () => {
    const { stream } = chunked(10, 7);

    const bytes = await readCapped(stream, 70);

    expect(bytes.length).toEqual(70);
    expect(bytes.equals(Buffer.alloc(70, 0x61))).toBe(true);
  });

  it("fails one byte over the cap", async () => {
    const { stream } = chunked(10, 7);

    await expect(readCapped(stream, 69)).rejects.toBeInstanceOf(
      ReadCapExceededError
    );
  });

  it("stops reading and destroys the source once over the cap", async () => {
    const { stream, state } = chunked(1000, 10);

    await expect(readCapped(stream, 25)).rejects.toBeInstanceOf(
      ReadCapExceededError
    );

    expect(stream.destroyed).toBe(true);
    // Readable.from may read ahead a little, never the whole source.
    expect(state.pulled).toBeLessThan(50);
  });

  it("accepts string chunks", async () => {
    const bytes = await readCapped(Readable.from(["ab", "cd"]), 4);

    expect(bytes.toString()).toEqual("abcd");
  });
});
