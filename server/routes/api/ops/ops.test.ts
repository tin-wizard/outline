import { faker } from "@faker-js/faker";
import { User } from "@server/models";
import { UserRole } from "@shared/types";
import { UserFlag } from "@server/models/User";
import { buildAdmin, buildUser } from "@server/test/factories";
import { getTestServer } from "@server/test/support";

const server = getTestServer();

function buildPlatformAdmin(teamId?: string) {
  return buildAdmin({
    teamId,
    flags: { platformAdmin: 1 },
  });
}

describe("#ops.teams.list", () => {
  it("should deny non-platform admins", async () => {
    const admin = await buildAdmin();

    const res = await server.post("/api/ops.teams.list", admin, {
      body: {},
    });
    expect(res.status).toEqual(403);
  });

  it("should allow platform admins to list all tenants", async () => {
    const platformAdmin = await buildPlatformAdmin();
    await buildUser();

    const res = await server.post("/api/ops.teams.list", platformAdmin, {
      body: {},
    });
    const body = await res.json();
    expect(res.status).toEqual(200);
    expect(body.data.length).toBeGreaterThanOrEqual(2);
  });
});

describe("#ops.teams.create", () => {
  it("should deny non-platform admins", async () => {
    const admin = await buildAdmin();

    const res = await server.post("/api/ops.teams.create", admin, {
      body: {
        name: "Acme Corp",
        subdomain: "acme",
      },
    });
    expect(res.status).toEqual(403);
  });

  it("should allow platform admins to create a tenant with a subdomain", async () => {
    const platformAdmin = await buildPlatformAdmin();
    const subdomain = faker.internet.domainWord();

    const res = await server.post("/api/ops.teams.create", platformAdmin, {
      body: {
        name: "Acme Corp",
        subdomain,
      },
    });
    const body = await res.json();
    expect(res.status).toEqual(200);
    expect(body.data.name).toEqual("Acme Corp");
    expect(body.data.subdomain).toEqual(subdomain);
  });

  it("should start the invite lifecycle for a provisioned first admin", async () => {
    const platformAdmin = await buildPlatformAdmin();
    const adminEmail = "First.Admin@Example.com";
    const subdomain = faker.internet.domainWord();

    const res = await server.post("/api/ops.teams.create", platformAdmin, {
      body: {
        name: "Acme Corp",
        subdomain,
        adminEmail,
      },
    });
    const body = await res.json();
    expect(res.status).toEqual(200);

    const admin = await User.findOne({
      where: { teamId: body.data.id, email: adminEmail.toLowerCase() },
      rejectOnEmpty: true,
    });
    expect(admin.inviteLastSentAt).not.toBeNull();
    expect(admin.invitedById).toEqual(platformAdmin.id);
    expect(admin.getFlag(UserFlag.InviteSent)).toEqual(1);
  });
});

describe("#ops.users.list", () => {
  it("should deny non-platform admins", async () => {
    const admin = await buildAdmin();

    const res = await server.post("/api/ops.users.list", admin, {
      body: {},
    });
    expect(res.status).toEqual(403);
  });

  it("should list users across all workspaces for platform admins", async () => {
    const platformAdmin = await buildPlatformAdmin();
    const other = await buildUser();

    const res = await server.post("/api/ops.users.list", platformAdmin, {
      body: { teamId: other.teamId },
    });
    const body = await res.json();
    expect(res.status).toEqual(200);
    expect(body.data.map((u: { id: string }) => u.id)).toEqual([other.id]);
    expect(body.data[0].team.id).toEqual(other.teamId);
  });

  it("should filter users by role", async () => {
    const platformAdmin = await buildPlatformAdmin();
    const viewer = await buildUser({ role: UserRole.Viewer });
    await buildUser({ role: UserRole.Member });

    const res = await server.post("/api/ops.users.list", platformAdmin, {
      body: { role: UserRole.Viewer, teamId: viewer.teamId },
    });
    const body = await res.json();
    expect(res.status).toEqual(200);
    expect(body.data.map((u: { id: string }) => u.id)).toEqual([viewer.id]);
  });
});

describe("#ops.users.setRole", () => {
  it("should deny non-platform admins", async () => {
    const admin = await buildAdmin();
    const target = await buildUser();

    const res = await server.post("/api/ops.users.setRole", admin, {
      body: { userId: target.id, role: UserRole.Admin },
    });
    expect(res.status).toEqual(403);
  });

  it("should change the role of any user", async () => {
    const platformAdmin = await buildPlatformAdmin();
    const target = await buildUser({ role: UserRole.Member });

    const res = await server.post("/api/ops.users.setRole", platformAdmin, {
      body: { userId: target.id, role: UserRole.Viewer },
    });
    const body = await res.json();
    expect(res.status).toEqual(200);
    expect(body.data.role).toEqual(UserRole.Viewer);

    await target.reload();
    expect(target.role).toEqual(UserRole.Viewer);
  });

  it("should not allow a platform admin to lose the Admin role", async () => {
    const platformAdmin = await buildPlatformAdmin();
    const target = await buildPlatformAdmin();

    const res = await server.post("/api/ops.users.setRole", platformAdmin, {
      body: { userId: target.id, role: UserRole.Member },
    });
    expect(res.status).toEqual(400);
  });
});
