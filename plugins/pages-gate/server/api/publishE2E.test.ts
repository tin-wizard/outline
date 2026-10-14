import crypto from "node:crypto";
import { buildAdmin, buildDocument, buildTeam } from "@server/test/factories";
import { getTestServer } from "@server/test/support";
import { normalizeCode, parseGatePage } from "../lib/gate";
import type { ObjectStore } from "../lib/objectStore";
import { buildPagesSite } from "../test/factories";
import { pbkdf2Calls } from "../test/fastPbkdf2";
import { createMemoryStore } from "../test/memoryStore";

// Passes every derivation through unchanged, only counting it: this is the
// one route test that runs the real 600000-iteration PBKDF2.
vi.mock("node:crypto", async (importOriginal) => {
  const { mockCryptoPbkdf2 } = await import("../test/fastPbkdf2");
  return mockCryptoPbkdf2(await importOriginal());
});

const holder = await vi.hoisted(async () => {
  const { PluginManager, Hook } = await import("@server/utils/PluginManager");
  const { createPagesRouter } = await import("./pages");
  const state: { store?: ObjectStore } = {};
  PluginManager.add({
    type: Hook.API,
    value: createPagesRouter({
      storeFactory: () => {
        if (!state.store) {
          throw new Error("test store not set");
        }
        return state.store;
      },
    }),
  });
  return state;
});

vi.setConfig({ testTimeout: 60_000 });

const server = getTestServer();
const MARKER = "E2E-PLAINTEXT-MARKER-w8Tn";

/** Decrypts a gate page with an independent, real-strength derivation. */
function unlock(code: string, gateHtml: string): string {
  const parsed = parseGatePage(gateHtml);
  if (!parsed) {
    throw new Error("not a gate page");
  }
  const key = crypto.pbkdf2Sync(
    normalizeCode(code),
    parsed.salt,
    600000,
    32,
    "sha256"
  );
  const { blob } = parsed;
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    blob.subarray(0, 12)
  );
  decipher.setAuthTag(blob.subarray(blob.length - 16));
  return Buffer.concat([
    decipher.update(blob.subarray(12, blob.length - 16)),
    decipher.final(),
  ]).toString("utf8");
}

describe("pages.publish end to end with the real key derivation", () => {
  it("publishes and republishes pages that unlock with the issued code", async () => {
    const store = createMemoryStore();
    holder.store = store;
    const team = await buildTeam();
    const admin = await buildAdmin({ teamId: team.id });
    const site = await buildPagesSite({
      teamId: team.id,
      createdById: admin.id,
    });
    const document = await buildDocument({
      teamId: team.id,
      userId: admin.id,
      text: `Hello ${MARKER}`,
    });
    const indexKey = `sites/${site.slug}/index.html`;

    const first = await server.post("/api/pages.publish", admin, {
      body: { id: site.id, sources: [{ type: "document", id: document.id }] },
    });
    expect(first.status).toEqual(200);
    const code: string = (await first.json()).data.accessCode;
    const firstPage = store.text(indexKey) ?? "";
    expect(firstPage).not.toContain(MARKER);
    expect(unlock(code, firstPage)).toContain(MARKER);

    const second = await server.post("/api/pages.publish", admin, {
      body: { id: site.id, accessCode: code },
    });
    expect(second.status).toEqual(200);
    expect(await second.json()).not.toHaveProperty("data.accessCode");
    const secondPage = store.text(indexKey) ?? "";
    expect(secondPage).not.toEqual(firstPage);
    expect(parseGatePage(secondPage)?.salt).toEqual(
      parseGatePage(firstPage)?.salt
    );
    expect(unlock(code, secondPage)).toContain(MARKER);

    // First publish: one derivation. Republish: verify plus gate rebuild.
    // Plus the two independent unlocks above. All at full strength.
    expect(pbkdf2Calls).toEqual([600000, 600000, 600000, 600000, 600000]);
  });
});
