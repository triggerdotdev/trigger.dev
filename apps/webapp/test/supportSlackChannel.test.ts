import { describe, it, expect } from "vitest";
import { postgresTest } from "@internal/testcontainers";
import {
  isPaidPlan,
  isCustomerSupportChannel,
  pickExternalTeamId,
  provisionOrganizationSupportChannel,
  supportChannelName,
  type SupportSlackClient,
} from "~/services/supportSlackChannel.server";
import type { PrismaClientOrTransaction } from "~/db.server";

describe("isPaidPlan", () => {
  it("gates on isPaying", () => {
    expect(isPaidPlan(undefined)).toBe(false);
    expect(isPaidPlan({})).toBe(false);
    expect(isPaidPlan({ v3Subscription: { isPaying: false } })).toBe(false);
    expect(isPaidPlan({ v3Subscription: { isPaying: true } })).toBe(true);
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
  constructor(private readonly opts: { failInvite?: boolean } = {}) {}
  async createPrivateChannel(name: string) {
    this.created.push(name);
    return { channelId: "C123", channelName: name };
  }
  async inviteSharedByEmail(channelId: string, email: string) {
    this.invited.push({ channelId, email });
    if (this.opts.failInvite) throw new Error("no_external_invite_permission");
    return { inviteId: "I123", url: "https://join.slack.com/share/abc" };
  }
}

async function seedOrg(
  prisma: PrismaClientOrTransaction,
  { withAdmin = true }: { withAdmin?: boolean } = {}
) {
  const user = await prisma.user.create({
    data: { email: "owner@acme.com", name: "Owner", authenticationMethod: "MAGIC_LINK" },
  });
  const org = await prisma.organization.create({ data: { title: "Acme", slug: "acme" } });
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
});
