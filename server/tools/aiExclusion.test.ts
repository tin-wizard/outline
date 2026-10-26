import { randomUUID } from "node:crypto";
import {
  buildAttachment,
  buildCollection,
  buildComment,
  buildDocument,
  buildTemplate,
} from "@server/test/factories";
import { Document } from "@server/models";
import { getTestServer } from "@server/test/support";
import { buildOAuthUser, callMcpTool } from "@server/test/McpHelper";

const server = getTestServer();

type ToolResult = Awaited<ReturnType<typeof callMcpTool>>;

/** Every text block of a tool result, joined, so leaks anywhere are caught. */
function allText(res: ToolResult) {
  return (res?.result?.content ?? []).map((c) => c.text ?? "").join("\n");
}

function parsed(res: ToolResult) {
  return (res?.result?.content ?? []).map((c) => JSON.parse(c.text ?? "null"));
}

/**
 * A workspace with an admin and a member, an AI-excluded collection and a
 * normal one, each holding a document that matches the same keyword.
 */
async function setup() {
  const admin = await buildOAuthUser({ role: "admin" });
  const member = await buildOAuthUser({ teamId: admin.user.teamId });
  const teamId = admin.user.teamId;
  const excluded = await buildCollection({
    teamId,
    userId: admin.user.id,
    name: "Payroll vault",
    aiExcluded: true,
  });
  const normal = await buildCollection({ teamId, userId: admin.user.id });
  const hidden = await buildDocument({
    teamId,
    userId: admin.user.id,
    collectionId: excluded.id,
    title: "Hiddentitle salaries",
    text: "zebrafinch hiddenbody",
  });
  const visible = await buildDocument({
    teamId,
    userId: admin.user.id,
    collectionId: normal.id,
    title: "Visible handbook",
    text: "zebrafinch visiblebody",
  });
  return { admin, member, excluded, normal, hidden, visible };
}

/** Asserts nothing of the hidden document appears in the response. */
function expectNoLeak(res: ToolResult, hidden: Document) {
  const text = allText(res);
  expect(text).not.toContain(hidden.id);
  expect(text).not.toContain(hidden.urlId);
  expect(text).not.toContain("Hiddentitle");
  expect(text).not.toContain("hiddenbody");
}

describe("MCP tools and AI-excluded collections", () => {
  for (const role of ["admin", "member"] as const) {
    describe(`as ${role}`, () => {
      it("list_documents search never returns excluded documents", async () => {
        const ctx = await setup();
        const res = await callMcpTool(
          server,
          ctx[role].accessToken,
          "list_documents",
          { query: "zebrafinch" }
        );
        expect(allText(res)).toContain(ctx.visible.id);
        expectNoLeak(res, ctx.hidden);
      });

      it("list_documents recent never returns excluded documents", async () => {
        const ctx = await setup();
        const res = await callMcpTool(
          server,
          ctx[role].accessToken,
          "list_documents"
        );
        expect(allText(res)).toContain(ctx.visible.id);
        expectNoLeak(res, ctx.hidden);
      });

      it("fetch of an excluded document matches a missing one", async () => {
        const ctx = await setup();
        const missingId = randomUUID();
        const [hiddenRes, missingRes] = await Promise.all([
          callMcpTool(server, ctx[role].accessToken, "fetch", {
            resource: "document",
            id: ctx.hidden.id,
          }),
          callMcpTool(server, ctx[role].accessToken, "fetch", {
            resource: "document",
            id: missingId,
          }),
        ]);
        expect(hiddenRes?.result?.isError).toBe(true);
        expect(allText(hiddenRes).replace(ctx.hidden.id, "ID")).toEqual(
          allText(missingRes).replace(missingId, "ID")
        );
        expect(allText(hiddenRes)).not.toContain("hiddenbody");
      });
    });
  }

  it("list_documents exact id match and collection filter skip excluded documents", async () => {
    const { admin, excluded, hidden } = await setup();
    const byUrlId = await callMcpTool(
      server,
      admin.accessToken,
      "list_documents",
      { query: hidden.urlId }
    );
    expectNoLeak(byUrlId, hidden);

    const byCollection = await callMcpTool(
      server,
      admin.accessToken,
      "list_documents",
      { collectionId: excluded.id }
    );
    expect(parsed(byCollection)).toEqual([[]]);
  });

  it("list_collections keeps the excluded collection, flagged", async () => {
    const { admin, excluded, hidden } = await setup();
    const res = await callMcpTool(
      server,
      admin.accessToken,
      "list_collections"
    );
    const match = parsed(res).find(
      (c: { id: string }) => c.id === excluded.id
    ) as { aiExcluded: boolean };
    expect(match.aiExcluded).toBe(true);
    expectNoLeak(res, hidden);
  });

  it("list_collection_documents and fetch collection hide the document tree", async () => {
    const { admin, excluded, normal, hidden, visible } = await setup();
    const tree = await callMcpTool(
      server,
      admin.accessToken,
      "list_collection_documents",
      { collectionId: excluded.id }
    );
    expect(parsed(tree)).toEqual([[]]);

    const normalTree = await callMcpTool(
      server,
      admin.accessToken,
      "list_collection_documents",
      { collectionId: normal.id }
    );
    expect(allText(normalTree)).toContain(visible.id);

    const fetched = await callMcpTool(server, admin.accessToken, "fetch", {
      resource: "collection",
      id: excluded.id,
    });
    expect(allText(fetched)).toContain("Payroll vault");
    expectNoLeak(fetched, hidden);
  });

  it("a document moved out of an excluded collection becomes visible, moved in becomes hidden", async () => {
    const { admin, excluded, normal, hidden, visible } = await setup();
    await Document.update(
      { collectionId: normal.id },
      { where: { id: hidden.id } }
    );
    await Document.update(
      { collectionId: excluded.id },
      { where: { id: visible.id } }
    );

    const out = await callMcpTool(server, admin.accessToken, "fetch", {
      resource: "document",
      id: hidden.id,
    });
    expect(out?.result?.isError).toBeUndefined();
    expect(allText(out)).toContain("hiddenbody");

    const into = await callMcpTool(server, admin.accessToken, "fetch", {
      resource: "document",
      id: visible.id,
    });
    expect(into?.result?.isError).toBe(true);
    expect(allText(into)).not.toContain("visiblebody");
  });

  it("archived documents in excluded collections stay hidden", async () => {
    const { admin, hidden } = await setup();
    await hidden.update({ archivedAt: new Date() });
    const res = await callMcpTool(server, admin.accessToken, "list_documents", {
      query: "zebrafinch",
      includeArchived: true,
    });
    expectNoLeak(res, hidden);
  });

  it("templates in excluded collections are not listed or fetched", async () => {
    const { admin, excluded, normal } = await setup();
    const hiddenTemplate = await buildTemplate({
      teamId: admin.user.teamId,
      userId: admin.user.id,
      collectionId: excluded.id,
      title: "Hiddentitle template",
    });
    const visibleTemplate = await buildTemplate({
      teamId: admin.user.teamId,
      userId: admin.user.id,
      collectionId: normal.id,
    });

    const list = await callMcpTool(server, admin.accessToken, "list_templates");
    expect(allText(list)).toContain(visibleTemplate.id);
    expect(allText(list)).not.toContain(hiddenTemplate.id);

    const scoped = await callMcpTool(
      server,
      admin.accessToken,
      "list_templates",
      { collectionId: excluded.id }
    );
    expect(parsed(scoped)).toEqual([[]]);

    const missingId = randomUUID();
    const [hiddenRes, missingRes] = await Promise.all([
      callMcpTool(server, admin.accessToken, "fetch", {
        resource: "template",
        id: hiddenTemplate.id,
      }),
      callMcpTool(server, admin.accessToken, "fetch", {
        resource: "template",
        id: missingId,
      }),
    ]);
    expect(hiddenRes?.result?.isError).toBe(true);
    expect(allText(hiddenRes).replace(hiddenTemplate.id, "ID")).toEqual(
      allText(missingRes).replace(missingId, "ID")
    );

    const created = await callMcpTool(
      server,
      admin.accessToken,
      "create_document",
      { collectionId: normal.id, templateId: hiddenTemplate.id }
    );
    expect(created?.result?.isError).toBe(true);
    expect(allText(created)).not.toContain("Hiddentitle");
  });

  it("fetch of an attachment on an excluded document matches a missing one", async () => {
    const { admin, hidden } = await setup();
    const attachment = await buildAttachment({
      teamId: admin.user.teamId,
      userId: admin.user.id,
      documentId: hidden.id,
    });
    const missingId = randomUUID();
    const [hiddenRes, missingRes] = await Promise.all([
      callMcpTool(server, admin.accessToken, "fetch", {
        resource: "attachment",
        id: attachment.id,
      }),
      callMcpTool(server, admin.accessToken, "fetch", {
        resource: "attachment",
        id: missingId,
      }),
    ]);
    expect(hiddenRes?.result?.isError).toBe(true);
    expect(allText(hiddenRes).replace(attachment.id, "ID")).toEqual(
      allText(missingRes).replace(missingId, "ID")
    );
  });

  it("list_comments never returns comments on excluded documents", async () => {
    const { admin, member, excluded, hidden, visible } = await setup();
    const hiddenComment = await buildComment({
      userId: admin.user.id,
      documentId: hidden.id,
    });
    const visibleComment = await buildComment({
      userId: admin.user.id,
      documentId: visible.id,
    });

    for (const { accessToken } of [admin, member]) {
      const all = await callMcpTool(server, accessToken, "list_comments");
      expect(allText(all)).toContain(visibleComment.id);
      expect(allText(all)).not.toContain(hiddenComment.id);
    }

    const scoped = await callMcpTool(
      server,
      admin.accessToken,
      "list_comments",
      {
        collectionId: excluded.id,
      }
    );
    expect(parsed(scoped)).toEqual([[]]);

    const missingId = randomUUID();
    const [hiddenRes, missingRes] = await Promise.all([
      callMcpTool(server, admin.accessToken, "list_comments", {
        documentId: hidden.id,
      }),
      callMcpTool(server, admin.accessToken, "list_comments", {
        documentId: missingId,
      }),
    ]);
    expect(hiddenRes?.result?.isError).toBe(true);
    expect(allText(hiddenRes)).toEqual(allText(missingRes));
  });

  it("create_comment anchoring cannot probe excluded document text", async () => {
    const { admin, hidden } = await setup();
    const [present, absent] = await Promise.all([
      callMcpTool(server, admin.accessToken, "create_comment", {
        documentId: hidden.id,
        text: "probe",
        anchorText: "hiddenbody",
      }),
      callMcpTool(server, admin.accessToken, "create_comment", {
        documentId: hidden.id,
        text: "probe",
        anchorText: "notinthedocument",
      }),
    ]);
    expect(present?.result?.isError).toBe(true);
    expect(allText(present)).toEqual(allText(absent));
  });

  describe("writes", () => {
    it("update_document patch on an excluded document matches a missing one", async () => {
      const { admin, hidden } = await setup();
      const missingId = randomUUID();
      const [hiddenRes, missingRes] = await Promise.all([
        callMcpTool(server, admin.accessToken, "update_document", {
          id: hidden.id,
          editMode: "patch",
          findText: "hiddenbody",
          text: "x",
        }),
        callMcpTool(server, admin.accessToken, "update_document", {
          id: missingId,
          editMode: "patch",
          findText: "hiddenbody",
          text: "x",
        }),
      ]);
      expect(hiddenRes?.result?.isError).toBe(true);
      expect(allText(hiddenRes).replace(hidden.id, "ID")).toEqual(
        allText(missingRes).replace(missingId, "ID")
      );
      await hidden.reload();
      expect(hidden.text).toContain("hiddenbody");
    });

    it("other updates are allowed but return only the id", async () => {
      const { admin, hidden } = await setup();
      const res = await callMcpTool(
        server,
        admin.accessToken,
        "update_document",
        {
          id: hidden.id,
          text: "appended",
          editMode: "append",
        }
      );
      expect(res?.result?.isError).toBeUndefined();
      expect(parsed(res)).toEqual([{ success: true, id: hidden.id }]);
    });

    it("create_document into an excluded collection returns only the id", async () => {
      const { admin, excluded, hidden } = await setup();
      const res = await callMcpTool(
        server,
        admin.accessToken,
        "create_document",
        {
          parentDocumentId: hidden.id,
          title: "Child",
          text: "child body",
        }
      );
      expect(res?.result?.isError).toBeUndefined();
      const [body] = parsed(res) as [{ id: string }];
      expect(Object.keys(body).sort()).toEqual(["id", "success"]);
      expectNoLeak(res, hidden);
      const child = await Document.findByPk(body.id);
      expect(child?.collectionId).toEqual(excluded.id);
    });

    it("move_document into an excluded collection returns only the id, out of it the full result", async () => {
      const { admin, excluded, normal, hidden, visible } = await setup();
      const into = await callMcpTool(
        server,
        admin.accessToken,
        "move_document",
        {
          id: visible.id,
          collectionId: excluded.id,
        }
      );
      expect(parsed(into)).toEqual([{ success: true, id: visible.id }]);

      const out = await callMcpTool(
        server,
        admin.accessToken,
        "move_document",
        {
          id: hidden.id,
          collectionId: normal.id,
        }
      );
      expect(allText(out)).toContain("Hiddentitle");
    });

    it("restore_document into an excluded collection returns only the id", async () => {
      const { admin, hidden } = await setup();
      await hidden.destroy();
      const res = await callMcpTool(
        server,
        admin.accessToken,
        "restore_document",
        { id: hidden.id }
      );
      expect(res?.result?.isError).toBeUndefined();
      expect(parsed(res)).toEqual([{ success: true, id: hidden.id }]);
    });
  });
});
