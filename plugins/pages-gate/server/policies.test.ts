import { can } from "@server/policies";
import {
  buildAdmin,
  buildGuestUser,
  buildTeam,
  buildUser,
  buildViewer,
} from "@server/test/factories";
import "./policies";
import { buildPagesSite } from "./test/factories";

async function setup() {
  const team = await buildTeam();
  const site = await buildPagesSite({ teamId: team.id });
  return { team, site };
}

describe("pages-gate policies", () => {
  it("allows an admin every ability", async () => {
    const { team, site } = await setup();
    const admin = await buildAdmin({ teamId: team.id });

    expect(can(admin, "createPagesSite", team)).toBe(true);
    expect(can(admin, "listPagesSite", team)).toBe(true);
    expect(can(admin, "read", site)).toBe(true);
    expect(can(admin, "update", site)).toBe(true);
  });

  it("allows a platform admin without the admin role", async () => {
    const { team, site } = await setup();
    const platformAdmin = await buildUser({
      teamId: team.id,
      flags: { platformAdmin: 1 },
    });
    expect(platformAdmin.isAdmin).toBe(false);

    expect(can(platformAdmin, "createPagesSite", team)).toBe(true);
    expect(can(platformAdmin, "listPagesSite", team)).toBe(true);
    expect(can(platformAdmin, "read", site)).toBe(true);
    expect(can(platformAdmin, "update", site)).toBe(true);
  });

  it.each([
    ["member", buildUser],
    ["viewer", buildViewer],
    ["guest", buildGuestUser],
  ])("refuses a %s", async (_role, build) => {
    const { team, site } = await setup();
    const user = await build({ teamId: team.id });

    expect(can(user, "createPagesSite", team)).toBe(false);
    expect(can(user, "listPagesSite", team)).toBe(false);
    expect(can(user, "read", site)).toBe(false);
    expect(can(user, "update", site)).toBe(false);
  });

  it("refuses an admin of another team", async () => {
    const { team, site } = await setup();
    const outsider = await buildAdmin();

    expect(can(outsider, "createPagesSite", team)).toBe(false);
    expect(can(outsider, "listPagesSite", team)).toBe(false);
    expect(can(outsider, "read", site)).toBe(false);
    expect(can(outsider, "update", site)).toBe(false);
  });

  it("refuses a platform admin of another team", async () => {
    const { site } = await setup();
    const outsider = await buildUser({ flags: { platformAdmin: 1 } });

    expect(can(outsider, "read", site)).toBe(false);
    expect(can(outsider, "update", site)).toBe(false);
  });
});
