import { describe, it, expect } from "vitest";
import { postgresTest } from "@internal/testcontainers";
import {
  hasPrivateSlackSupport,
  isDowngradedLink,
  isPaidPlan,
  isCustomerSupportChannel,
  linkSupportChannel,
  pickExternalTeamId,
  proposeOrgMatches,
  provisionOrganizationSupportChannel,
  supportChannelName,
  unlinkSupportChannel,
  type ChannelCandidate,
  type OrgCandidate,
  type SupportSlackClient,
} from "~/services/supportSlackChannel.server";
import type { PrismaClientOrTransaction } from "~/db.server";

describe("hasPrivateSlackSupport", () => {
  it("gates on the supportChannel plan limit", () => {
    expect(hasPrivateSlackSupport(undefined)).toBe(false);
    expect(hasPrivateSlackSupport({})).toBe(false);
    expect(
      hasPrivateSlackSupport({ v3Subscription: { plan: { limits: { supportChannel: false } } } })
    ).toBe(false);
    expect(
      hasPrivateSlackSupport({ v3Subscription: { plan: { limits: { supportChannel: true } } } })
    ).toBe(true);
  });
});

describe("isPaidPlan", () => {
  it("gates on isPaying", () => {
    expect(isPaidPlan(undefined)).toBe(false);
    expect(isPaidPlan({})).toBe(false);
    expect(isPaidPlan({ v3Subscription: { isPaying: false } })).toBe(false);
    expect(isPaidPlan({ v3Subscription: { isPaying: true } })).toBe(true);
  });
});

describe("isDowngradedLink", () => {
  it("flags a linked channel on a non-paying org as downgraded", () => {
    expect(isDowngradedLink({ hasChannel: true, isPaying: false })).toBe(true);
  });
  it("does not flag a linked channel on a paying org", () => {
    expect(isDowngradedLink({ hasChannel: true, isPaying: true })).toBe(false);
  });
  it("does not flag an org with no channel regardless of plan", () => {
    expect(isDowngradedLink({ hasChannel: false, isPaying: false })).toBe(false);
    expect(isDowngradedLink({ hasChannel: false, isPaying: true })).toBe(false);
  });
});

describe("supportChannelName", () => {
  it("prefixes cus- and lowercases", () => {
    expect(supportChannelName("Acme-Corp")).toBe("cus-acme-corp");
  });
  it("replaces invalid characters and collapses dashes", () => {
    expect(supportChannelName("acme.co/team!")).toBe("cus-acme-co-team");
  });
  it("caps total length at 80 characters", () => {
    expect(supportChannelName("a".repeat(100)).length).toBe(80);
  });
});

describe("isCustomerSupportChannel", () => {
  it("identifies customer support channels", () => {
    expect(isCustomerSupportChannel({ name: "cus-acme", is_ext_shared: true })).toBe(true);
    expect(isCustomerSupportChannel({ name: "cus-acme", is_ext_shared: false })).toBe(false);
    expect(isCustomerSupportChannel({ name: "general", is_ext_shared: true })).toBe(false);
    expect(isCustomerSupportChannel({})).toBe(false);
  });
});

describe("pickExternalTeamId", () => {
  it("picks the external team id", () => {
    expect(pickExternalTeamId(["T_OWN", "T_EXT"], "T_OWN")).toBe("T_EXT");
    expect(pickExternalTeamId(["T_OWN"], "T_OWN")).toBeUndefined();
    expect(pickExternalTeamId(undefined, "T_OWN")).toBeUndefined();
  });
});

class FakeSupportSlackClient implements SupportSlackClient {
  public created: string[] = [];
  public invited: Array<{ channelId: string; email: string }> = [];
  public archived: string[] = [];
  public unarchived: string[] = [];
  constructor(private opts: { failInvite?: boolean; failUnarchive?: boolean } = {}) {}
  setFailInvite(failInvite: boolean) {
    this.opts = { ...this.opts, failInvite };
  }
  setFailUnarchive(failUnarchive: boolean) {
    this.opts = { ...this.opts, failUnarchive };
  }
  async createPrivateChannel(name: string) {
    this.created.push(name);
    return { channelId: "C123", channelName: name };
  }
  async inviteSharedByEmail(channelId: string, email: string) {
    this.invited.push({ channelId, email });
    if (this.opts.failInvite) throw new Error("no_external_invite_permission");
    return { inviteId: "I123", url: "https://join.slack.com/share/abc" };
  }
  async archiveChannel(channelId: string) {
    this.archived.push(channelId);
  }
  async unarchiveChannel(channelId: string) {
    this.unarchived.push(channelId);
    if (this.opts.failUnarchive) throw new Error("channel_not_found");
  }
}

async function seedOrg(
  prisma: PrismaClientOrTransaction,
  { withAdmin = true, slug = "acme" }: { withAdmin?: boolean; slug?: string } = {}
) {
  const email = slug === "acme" ? "owner@acme.com" : `owner-${slug}@acme.com`;
  const user = await prisma.user.create({
    data: { email, name: "Owner", authenticationMethod: "MAGIC_LINK" },
  });
  const org = await prisma.organization.create({ data: { title: "Acme", slug } });
  if (withAdmin) {
    await prisma.orgMember.create({
      data: { organizationId: org.id, userId: user.id, role: "ADMIN" },
    });
  }
  return { user, org };
}

describe("provisionOrganizationSupportChannel", () => {
  postgresTest(
    "provisions a channel and invites the owner",
    async ({ prisma }) => {
      const { org } = await seedOrg(prisma);
      const client = new FakeSupportSlackClient();

      const result = await provisionOrganizationSupportChannel({
        organizationId: org.id,
        prisma,
        slackClient: client,
      });

      expect(result.status).toBe("invited");
      expect(client.created).toEqual(["cus-acme"]);
      expect(client.invited).toEqual([{ channelId: "C123", email: "owner@acme.com" }]);

      const row = await prisma.organizationSupportChannel.findFirst({
        where: { organizationId: org.id },
      });
      expect(row?.status).toBe("INVITED");
      expect(row?.slackChannelId).toBe("C123");
      expect(row?.inviteUrl).toBe("https://join.slack.com/share/abc");
    },
    15000
  );

  postgresTest(
    "invites the longest-standing admin when an org has several",
    async ({ prisma }) => {
      const org = await prisma.organization.create({ data: { title: "Acme", slug: "acme" } });

      // Insertion order is deliberately the opposite of createdAt order: the
      // newer admin goes in first, so an unordered findFirst returns it. Seeding
      // them in the natural order would let the test pass without the orderBy.
      const newer = await prisma.user.create({
        data: { email: "newer@acme.com", name: "Newer", authenticationMethod: "MAGIC_LINK" },
      });
      await prisma.orgMember.create({
        data: {
          organizationId: org.id,
          userId: newer.id,
          role: "ADMIN",
          createdAt: new Date("2026-02-01T00:00:00Z"),
        },
      });

      const founder = await prisma.user.create({
        data: { email: "owner@acme.com", name: "Owner", authenticationMethod: "MAGIC_LINK" },
      });
      await prisma.orgMember.create({
        data: {
          organizationId: org.id,
          userId: founder.id,
          role: "ADMIN",
          createdAt: new Date("2026-01-01T00:00:00Z"),
        },
      });

      const client = new FakeSupportSlackClient();
      const result = await provisionOrganizationSupportChannel({
        organizationId: org.id,
        prisma,
        slackClient: client,
      });

      expect(result.status).toBe("invited");
      expect(client.invited).toEqual([{ channelId: "C123", email: "owner@acme.com" }]);
    },
    15000
  );

  postgresTest(
    "a failed unarchive stays ARCHIVED so the next attempt retries it",
    async ({ prisma }) => {
      const { org } = await seedOrg(prisma);
      await prisma.organizationSupportChannel.create({
        data: {
          organizationId: org.id,
          status: "ARCHIVED",
          slackChannelId: "C123",
          slackChannelName: "cus-acme",
        },
      });

      const client = new FakeSupportSlackClient({ failUnarchive: true });
      const failed = await provisionOrganizationSupportChannel({
        organizationId: org.id,
        prisma,
        slackClient: client,
      });

      expect(failed).toEqual({ status: "failed", retryable: true });
      // Dropping to FAILED here would send the retry down the reuse path, which
      // invites into a channel that is still archived — broken forever.
      const row = await prisma.organizationSupportChannel.findFirst({
        where: { organizationId: org.id },
      });
      expect(row?.status).toBe("ARCHIVED");

      client.setFailUnarchive(false);
      const retried = await provisionOrganizationSupportChannel({
        organizationId: org.id,
        prisma,
        slackClient: client,
      });

      expect(retried.status).toBe("invited");
      expect(client.unarchived).toEqual(["C123", "C123"]);
    },
    15000
  );

  postgresTest(
    "a missing owner is a permanent failure, Slack errors are retryable",
    async ({ prisma }) => {
      const { org: noOwner } = await seedOrg(prisma, { withAdmin: false, slug: "noowner" });
      const permanent = await provisionOrganizationSupportChannel({
        organizationId: noOwner.id,
        prisma,
        slackClient: new FakeSupportSlackClient(),
      });
      expect(permanent).toEqual({ status: "failed", retryable: false });

      const { org } = await seedOrg(prisma, { slug: "transient" });
      const transient = await provisionOrganizationSupportChannel({
        organizationId: org.id,
        prisma,
        slackClient: new FakeSupportSlackClient({ failInvite: true }),
      });
      expect(transient).toEqual({ status: "failed", retryable: true });
    },
    15000
  );

  postgresTest("is idempotent — existing channel makes no Slack calls", async ({ prisma }) => {
    const { org } = await seedOrg(prisma);
    await prisma.organizationSupportChannel.create({
      data: { organizationId: org.id, status: "INVITED", slackChannelId: "C999" },
    });
    const client = new FakeSupportSlackClient();

    const result = await provisionOrganizationSupportChannel({
      organizationId: org.id,
      prisma,
      slackClient: client,
    });

    expect(result).toEqual({ status: "exists", channelId: "C999" });
    expect(client.created).toEqual([]);
    expect(client.invited).toEqual([]);
  });

  postgresTest("fails when the org has no owner email", async ({ prisma }) => {
    const { org } = await seedOrg(prisma, { withAdmin: false });
    const client = new FakeSupportSlackClient();

    const result = await provisionOrganizationSupportChannel({
      organizationId: org.id,
      prisma,
      slackClient: client,
    });

    expect(result.status).toBe("failed");
    const row = await prisma.organizationSupportChannel.findFirst({
      where: { organizationId: org.id },
    });
    expect(row?.status).toBe("FAILED");
    expect(row?.lastError).toContain("owner");
  });

  postgresTest("records FAILED when the Slack invite throws", async ({ prisma }) => {
    const { org } = await seedOrg(prisma);
    const client = new FakeSupportSlackClient({ failInvite: true });

    const result = await provisionOrganizationSupportChannel({
      organizationId: org.id,
      prisma,
      slackClient: client,
    });

    expect(result.status).toBe("failed");
    const row = await prisma.organizationSupportChannel.findFirst({
      where: { organizationId: org.id },
    });
    expect(row?.status).toBe("FAILED");
    expect(row?.lastError).toContain("no_external_invite_permission");
  });

  postgresTest(
    "retrying after a failed invite reuses the persisted channel instead of recreating it",
    async ({ prisma }) => {
      const { org } = await seedOrg(prisma);
      const client = new FakeSupportSlackClient({ failInvite: true });

      const firstResult = await provisionOrganizationSupportChannel({
        organizationId: org.id,
        prisma,
        slackClient: client,
      });

      expect(firstResult.status).toBe("failed");
      const rowAfterFailure = await prisma.organizationSupportChannel.findFirst({
        where: { organizationId: org.id },
      });
      expect(rowAfterFailure?.status).toBe("FAILED");
      expect(rowAfterFailure?.slackChannelId).toBe("C123");
      expect(rowAfterFailure?.slackChannelName).toBe("cus-acme");
      expect(client.created).toEqual(["cus-acme"]);

      // Simulate a redis-worker retry: same organization, invite now succeeds.
      client.setFailInvite(false);
      const secondResult = await provisionOrganizationSupportChannel({
        organizationId: org.id,
        prisma,
        slackClient: client,
      });

      expect(secondResult).toEqual({ status: "invited", channelId: "C123" });
      // createPrivateChannel must not be called again across both runs.
      expect(client.created).toEqual(["cus-acme"]);
      expect(client.invited).toEqual([
        { channelId: "C123", email: "owner@acme.com" },
        { channelId: "C123", email: "owner@acme.com" },
      ]);

      const rowAfterRetry = await prisma.organizationSupportChannel.findFirst({
        where: { organizationId: org.id },
      });
      expect(rowAfterRetry?.status).toBe("INVITED");
      expect(rowAfterRetry?.slackChannelId).toBe("C123");
    }
  );

  postgresTest("LINKED row is treated as exists (no Slack calls)", async ({ prisma }) => {
    const { org } = await seedOrg(prisma);
    await prisma.organizationSupportChannel.create({
      data: { organizationId: org.id, status: "LINKED", slackChannelId: "C777" },
    });
    const client = new FakeSupportSlackClient();
    const result = await provisionOrganizationSupportChannel({
      organizationId: org.id,
      prisma,
      slackClient: client,
    });
    expect(result).toEqual({ status: "exists", channelId: "C777" });
    expect(client.created).toEqual([]);
  });

  postgresTest(
    "ARCHIVED row is unarchived and reused instead of creating a new channel",
    async ({ prisma }) => {
      const { org } = await seedOrg(prisma);
      await prisma.organizationSupportChannel.create({
        data: {
          organizationId: org.id,
          status: "ARCHIVED",
          slackChannelId: "C555",
          slackChannelName: "cus-acme",
        },
      });
      const client = new FakeSupportSlackClient();

      const result = await provisionOrganizationSupportChannel({
        organizationId: org.id,
        prisma,
        slackClient: client,
      });

      expect(result).toEqual({ status: "invited", channelId: "C555" });
      expect(client.created).toEqual([]);
      expect(client.unarchived).toEqual(["C555"]);
      expect(client.invited).toEqual([{ channelId: "C555", email: "owner@acme.com" }]);

      const row = await prisma.organizationSupportChannel.findFirst({
        where: { organizationId: org.id },
      });
      expect(row?.status).toBe("INVITED");
      expect(row?.slackChannelId).toBe("C555");
      expect(row?.slackChannelName).toBe("cus-acme");
    }
  );
});

describe("unlinkSupportChannel", () => {
  postgresTest("archives a LINKED row and keeps the channel id for history", async ({ prisma }) => {
    const { org } = await seedOrg(prisma);
    await prisma.organizationSupportChannel.create({
      data: {
        organizationId: org.id,
        status: "LINKED",
        slackChannelId: "C1",
        slackChannelName: "cus-acme",
      },
    });
    const client = new FakeSupportSlackClient();

    const result = await unlinkSupportChannel({
      organizationId: org.id,
      prisma,
      slackClient: client,
    });

    expect(result).toEqual({ status: "archived" });
    expect(client.archived).toEqual(["C1"]);

    const row = await prisma.organizationSupportChannel.findFirst({
      where: { organizationId: org.id },
    });
    expect(row?.status).toBe("ARCHIVED");
    expect(row?.slackChannelId).toBe("C1");
    expect(row?.slackChannelName).toBe("cus-acme");
  });

  postgresTest(
    "no row or no channel id returns not_found without calling Slack",
    async ({ prisma }) => {
      const { org } = await seedOrg(prisma);
      const client = new FakeSupportSlackClient();

      const result = await unlinkSupportChannel({
        organizationId: org.id,
        prisma,
        slackClient: client,
      });

      expect(result).toEqual({ status: "not_found" });
      expect(client.archived).toEqual([]);
    }
  );
});

function chan(overrides: Partial<ChannelCandidate> = {}): ChannelCandidate {
  return {
    channelId: "C1",
    channelName: "cus-acme",
    ...overrides,
  };
}

function org(overrides: Partial<OrgCandidate> = {}): OrgCandidate {
  return {
    organizationId: "org_1",
    slug: "acme-9dfd",
    title: "Acme",
    alreadyLinked: false,
    ...overrides,
  };
}

describe("proposeOrgMatches", () => {
  it("name exact match scores medium with a name reason", () => {
    const result = proposeOrgMatches(
      [chan({ channelName: "cus-acme" })],
      [org({ slug: "acme-9dfd" })]
    );
    expect(result).toEqual([
      { channelId: "C1", organizationId: "org_1", confidence: "medium", reasons: ["name"] },
    ]);
  });

  it("domain match only scores medium with a domain reason", () => {
    const result = proposeOrgMatches(
      [chan({ channelName: "cus-zzzqqq", externalTeamEmailDomain: "acme.com" })],
      [org({ slug: "widget-5555", title: "Widget Co", ownerEmailDomain: "acme.com" })]
    );
    expect(result).toEqual([
      { channelId: "C1", organizationId: "org_1", confidence: "medium", reasons: ["domain"] },
    ]);
  });

  it("name and domain match together score high", () => {
    const result = proposeOrgMatches(
      [chan({ channelName: "cus-acme", externalTeamEmailDomain: "acme.com" })],
      [org({ slug: "acme-9dfd", ownerEmailDomain: "acme.com" })]
    );
    expect(result).toEqual([
      {
        channelId: "C1",
        organizationId: "org_1",
        confidence: "high",
        reasons: ["name", "domain"],
      },
    ]);
  });

  it("contains-only match scores low", () => {
    const result = proposeOrgMatches(
      [chan({ channelName: "cus-acme-corp" })],
      [org({ slug: "acme-corp-holdings-9dfd", title: "Acme" })]
    );
    expect(result).toEqual([
      { channelId: "C1", organizationId: "org_1", confidence: "low", reasons: ["name"] },
    ]);
  });

  it("excludes already-linked orgs", () => {
    const result = proposeOrgMatches(
      [chan({ channelName: "cus-acme" })],
      [org({ slug: "acme-9dfd", alreadyLinked: true })]
    );
    expect(result).toEqual([]);
  });

  it("caps confidence to low and flags ambiguous on a tied top score", () => {
    const result = proposeOrgMatches(
      [chan({ channelName: "cus-acme" })],
      [
        org({ organizationId: "org_1", slug: "acme-1111", title: "Acme One" }),
        org({ organizationId: "org_2", slug: "acme-2222", title: "Acme Two" }),
      ]
    );
    expect(result).toEqual([
      {
        channelId: "C1",
        organizationId: "org_1",
        confidence: "low",
        reasons: ["name", "ambiguous"],
      },
    ]);
  });

  it("returns no proposal when nothing matches", () => {
    const result = proposeOrgMatches(
      [chan({ channelName: "cus-zzz" })],
      [org({ slug: "acme-9dfd", title: "Acme" })]
    );
    expect(result).toEqual([]);
  });
});

describe("linkSupportChannel", () => {
  postgresTest("fresh link creates a LINKED row", async ({ prisma }) => {
    const { org } = await seedOrg(prisma);

    const result = await linkSupportChannel({
      organizationId: org.id,
      prisma,
      channel: { channelId: "C1", channelName: "cus-acme" },
    });

    expect(result).toEqual({ status: "linked" });
    const row = await prisma.organizationSupportChannel.findFirst({
      where: { organizationId: org.id },
    });
    expect(row?.status).toBe("LINKED");
    expect(row?.slackChannelId).toBe("C1");
    expect(row?.slackChannelName).toBe("cus-acme");
  });

  postgresTest("linking the same channel again is idempotent", async ({ prisma }) => {
    const { org } = await seedOrg(prisma);
    await prisma.organizationSupportChannel.create({
      data: {
        organizationId: org.id,
        status: "LINKED",
        slackChannelId: "C1",
        slackChannelName: "cus-acme",
      },
    });

    const result = await linkSupportChannel({
      organizationId: org.id,
      prisma,
      channel: { channelId: "C1", channelName: "cus-acme" },
    });

    expect(result).toEqual({ status: "linked" });
    const row = await prisma.organizationSupportChannel.findFirst({
      where: { organizationId: org.id },
    });
    expect(row?.status).toBe("LINKED");
    expect(row?.slackChannelId).toBe("C1");
  });

  postgresTest(
    "org already linked to a different channel conflicts without reassign",
    async ({ prisma }) => {
      const { org } = await seedOrg(prisma);
      await prisma.organizationSupportChannel.create({
        data: {
          organizationId: org.id,
          status: "LINKED",
          slackChannelId: "C1",
          slackChannelName: "cus-acme",
        },
      });

      const result = await linkSupportChannel({
        organizationId: org.id,
        prisma,
        channel: { channelId: "C2", channelName: "cus-other" },
      });

      expect(result.status).toBe("conflict");
      const row = await prisma.organizationSupportChannel.findFirst({
        where: { organizationId: org.id },
      });
      expect(row?.slackChannelId).toBe("C1");
    }
  );

  postgresTest(
    "channel already linked to another org conflicts even with reassign",
    async ({ prisma }) => {
      const { org: orgA } = await seedOrg(prisma, { slug: "acme" });
      const { org: orgB } = await seedOrg(prisma, { slug: "widget" });
      await prisma.organizationSupportChannel.create({
        data: {
          organizationId: orgA.id,
          status: "LINKED",
          slackChannelId: "C1",
          slackChannelName: "cus-acme",
        },
      });

      const result = await linkSupportChannel({
        organizationId: orgB.id,
        prisma,
        channel: { channelId: "C1", channelName: "cus-acme" },
        reassign: true,
      });

      expect(result.status).toBe("conflict");
      const rowA = await prisma.organizationSupportChannel.findFirst({
        where: { organizationId: orgA.id },
      });
      expect(rowA?.slackChannelId).toBe("C1");
      const rowB = await prisma.organizationSupportChannel.findFirst({
        where: { organizationId: orgB.id },
      });
      expect(rowB?.slackChannelId ?? null).not.toBe("C1");
    }
  );

  postgresTest("reassign overwrites the org's own row to a new channel", async ({ prisma }) => {
    const { org } = await seedOrg(prisma);
    await prisma.organizationSupportChannel.create({
      data: {
        organizationId: org.id,
        status: "LINKED",
        slackChannelId: "C1",
        slackChannelName: "cus-acme",
      },
    });

    const result = await linkSupportChannel({
      organizationId: org.id,
      prisma,
      channel: { channelId: "C2", channelName: "cus-acme-new" },
      reassign: true,
    });

    expect(result).toEqual({ status: "linked" });
    const row = await prisma.organizationSupportChannel.findFirst({
      where: { organizationId: org.id },
    });
    expect(row?.status).toBe("LINKED");
    expect(row?.slackChannelId).toBe("C2");
    expect(row?.slackChannelName).toBe("cus-acme-new");
  });
});
