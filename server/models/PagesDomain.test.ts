import { randomString } from "@shared/random";
import { PagesDomain } from "@server/models";
import { buildPagesSite } from "plugins/pages-gate/server/test/factories";

describe("PagesDomain", () => {
  it("stores the hostname lowercase and defaults statuses to pending", async () => {
    const site = await buildPagesSite();
    const name = randomString(10).toLowerCase();
    const domain = await PagesDomain.create({
      siteId: site.id,
      hostname: `${name}.Example.COM`,
    });
    expect(domain.hostname).toBe(`${name}.example.com`);
    expect(domain.verificationStatus).toBe("pending");
    expect(domain.certificateStatus).toBe("pending");
    expect(domain.activatedAt).toBeNull();
  });

  it("rejects a duplicate hostname", async () => {
    const site = await buildPagesSite();
    const name = randomString(10).toLowerCase();
    await PagesDomain.create({
      siteId: site.id,
      hostname: `${name}.example.com`,
    });
    await expect(
      PagesDomain.create({ siteId: site.id, hostname: `${name}.EXAMPLE.com` })
    ).rejects.toThrow();
  });

  it("rejects a mixed-case hostname written without hooks", async () => {
    const site = await buildPagesSite();
    const name = randomString(10).toLowerCase();
    await expect(
      PagesDomain.bulkCreate([
        { siteId: site.id, hostname: `${name}.Example.com` },
      ])
    ).rejects.toThrow(/pages_domains_hostname_lowercase/);
  });
});
