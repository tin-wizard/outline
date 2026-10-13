import { TeamPreference } from "@shared/types";
import { buildUser } from "@server/test/factories";
import { getTestServer } from "@server/test/support";

const server = getTestServer();

describe("#documents.answerQuestion", () => {
  it("requires authentication", async () => {
    const res = await server.post("/api/documents.answerQuestion", {
      body: { query: "holiday policy" },
    });
    expect(res.status).toEqual(401);
  });

  it("is refused when AI answers are not enabled for the workspace", async () => {
    const user = await buildUser();
    const res = await server.post("/api/documents.answerQuestion", user, {
      body: { query: "holiday policy" },
    });
    expect(res.status).toEqual(403);
  });

  it("rejects an empty query", async () => {
    const user = await buildUser();
    user.team.setPreference(TeamPreference.AIAnswers, true);
    await user.team.save();
    const res = await server.post("/api/documents.answerQuestion", user, {
      body: { query: "   " },
    });
    expect(res.status).toEqual(400);
  });
});
