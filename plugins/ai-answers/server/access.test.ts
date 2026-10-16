import { TeamPreference } from "@shared/types";
import { Team, type User } from "@server/models";
import {
  buildAdmin,
  buildGuestUser,
  buildUser,
  buildViewer,
} from "@server/test/factories";
import { assertAIAnswersAllowed } from "./access";

async function enable(user: User) {
  const team = await Team.findByPk(user.teamId, { rejectOnEmpty: true });
  team.setPreference(TeamPreference.AIAnswers, true);
  await team.save();
  user.team = team;
  return user;
}

describe("assertAIAnswersAllowed", () => {
  it("refuses everyone when the workspace preference is off", async () => {
    const admin = await buildAdmin();
    expect(() => assertAIAnswersAllowed(admin)).toThrow(/not enabled/);
  });

  it.each([
    ["guest", buildGuestUser],
    ["viewer", buildViewer],
  ])("refuses a %s", async (_, build) => {
    const user = await enable(await build());
    expect(() => assertAIAnswersAllowed(user)).toThrow(/your role/);
  });

  it.each([
    ["member", buildUser],
    ["admin", buildAdmin],
  ])("allows a %s", async (_, build) => {
    const user = await enable(await build());
    expect(() => assertAIAnswersAllowed(user)).not.toThrow();
  });
});
