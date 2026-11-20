import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AttioClient, type AttioRecord } from "~/services/attioClient.server";
import {
  isCreatorMembership,
  joinMethodTitle,
  membershipChanges,
  roleTitle,
  syncAttioMember,
  syncAttioWorkspaceMembers,
} from "~/services/attioMembers.server";

vi.setConfig({ testTimeout: 120_000 });

describe("membership values", () => {
  it("maps roles the way the RBAC plugin does", () => {
    expect(roleTitle({ name: "Developer", isSystem: true }, "MEMBER")).toBe("Developer");
    expect(roleTitle({ name: "Billing viewer", isSystem: false }, "MEMBER")).toBe("Custom");
    expect(roleTitle(null, "ADMIN")).toBe("Owner");
    expect(roleTitle(null, "MEMBER")).toBe("Admin");
  });

  it("names join methods, unknown before they were recorded", () => {
    expect(joinMethodTitle("sso_jit")).toBe("SSO");
    expect(joinMethodTitle("manual")).toBe("Admin added");
    expect(joinMethodTitle(null)).toBe("Unknown");
  });

  it("finds the creator by join method, or by joining with the org", () => {
    const org = new Date("2026-01-01T00:00:00Z");
    expect(isCreatorMembership("created", new Date("2026-05-01"), org)).toBe(true);
    expect(isCreatorMembership("invite", org, org)).toBe(false);
    expect(isCreatorMembership(null, new Date(org.getTime() + 200), org)).toBe(true);
    expect(isCreatorMembership(null, new Date(org.getTime() + 60_000), org)).toBe(false);
  });

  const desired = {
    userRecordId: "u_rec",
    workspaceRecordId: "w_rec",
    role: "Admin",
    joinedAt: new Date("2026-03-01T10:00:00Z"),
    joinMethod: "Invite",
    isCreator: false,
    invitedByRecordId: "inviter_rec",
  };
  const matching: AttioRecord = {
    id: { record_id: "m_rec" },
    values: {
      user: [{ target_record_id: "u_rec" }],
      workspace: [{ target_record_id: "w_rec" }],
      role: [{ option: { title: "Admin" } }],
      joined_at: [{ value: "2026-03-01T10:00:00.000000000Z" }],
      join_method: [{ option: { title: "Invite" } }],
      is_creator: [{ value: false }],
      invited_by: [{ target_record_id: "inviter_rec" }],
      left_at: [],
    },
  };

  it("writes nothing when Attio already matches", () => {
    expect(membershipChanges(matching, desired)).toEqual({});
  });

  it("writes only what changed", () => {
    expect(membershipChanges(matching, { ...desired, role: "Owner" })).toEqual({ role: "Owner" });
  });

  it("never blanks a known inviter", () => {
    expect(membershipChanges(matching, { ...desired, invitedByRecordId: undefined })).toEqual({});
  });

  it("reopens a membership on rejoin", () => {
    const left = {
      ...matching,
      values: { ...matching.values, left_at: [{ value: "2026-04-01T00:00:00Z" }] },
    };
    const rejoinedAt = new Date("2026-05-01T00:00:00Z");
    expect(membershipChanges(left, { ...desired, joinedAt: rejoinedAt })).toEqual({
      joined_at: rejoinedAt.toISOString(),
      left_at: [],
    });
  });
});

type Call = { method: string; path: string; body: any };

// A local server standing in for Attio: records live in memory and every request is recorded.
describe("Attio member sync", () => {
  let server: Server;
  let client: AttioClient;
  let calls: Call[];
  let records: Record<string, AttioRecord[]>;
  // Runs before a write is answered, to change the database mid-sync.
  let beforeWriteReply: ((call: Call) => Promise<void>) | undefined;

  const writes = () => calls.filter((c) => c.method === "PUT" || c.method === "PATCH");
  const value = (v: unknown) =>
    Array.isArray(v)
      ? v
      : typeof v === "string"
        ? [{ value: v, option: { title: v } }]
        : [{ value: v }];

  function matches(record: AttioRecord, filter: Record<string, any>) {
    return Object.entries(filter).every(([attr, want]) => {
      const have = record.values?.[attr]?.[0]?.value;
      return want && typeof want === "object" && "$in" in want
        ? want.$in.includes(have)
        : have === want;
    });
  }

  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", async () => {
        const body = raw ? JSON.parse(raw) : undefined;
        const url = new URL(req.url!, "http://x");
        calls.push({ method: req.method!, path: url.pathname, body });
        const [, , object, , recordId] = url.pathname.split("/");
        records[object] ??= [];
        const list = records[object];
        let reply: unknown = {};

        if (url.pathname.endsWith("/records/query")) {
          reply = { data: list.filter((r) => matches(r, body.filter)).slice(0, body.limit) };
        } else if (req.method === "PUT" && url.searchParams.get("matching_attribute")) {
          const attr = url.searchParams.get("matching_attribute")!;
          const values = body.data.values;
          let record = list.find((r) => r.values?.[attr]?.[0]?.value === values[attr]);
          // Attio requires an email to create a user.
          if (!record && object === "users" && !values.primary_email_address) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status_code: 400, code: "missing_value" }));
            return;
          }
          if (!record) {
            record = { id: { record_id: `${object}_${list.length + 1}` }, values: {} };
            list.push(record);
          }
          for (const [k, v] of Object.entries(values)) record.values![k] = value(v);
          reply = { data: record };
        } else if (req.method === "PUT" && recordId) {
          const record = list.find((r) => r.id?.record_id === recordId)!;
          for (const [k, v] of Object.entries(body.data.values)) record.values![k] = value(v);
          reply = { data: record };
        }
        if (req.method === "PUT") await beforeWriteReply?.(calls[calls.length - 1]);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(reply));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    client = new AttioClient({ apiKey: "key", isTest: false, baseUrl: `http://127.0.0.1:${port}` });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    calls = [];
    beforeWriteReply = undefined;
  });

  async function seed(prisma: PrismaClient) {
    const suffix = Math.random().toString(36).slice(2, 8);
    const owner = await prisma.user.create({
      data: { email: `owner-${suffix}@test.local`, authenticationMethod: "MAGIC_LINK" },
    });
    const invitee = await prisma.user.create({
      data: { email: `invitee-${suffix}@test.local`, authenticationMethod: "MAGIC_LINK" },
    });
    const org = await prisma.organization.create({
      data: {
        title: `org-${suffix}`,
        slug: `org-${suffix}`,
        members: { create: { userId: owner.id, role: "ADMIN", joinMethod: "created" } },
      },
    });
    await prisma.orgMember.create({
      data: {
        organizationId: org.id,
        userId: invitee.id,
        role: "MEMBER",
        joinMethod: "invite",
        invitedById: owner.id,
      },
    });
    records = {
      workspaces: [
        {
          id: { record_id: "ws_1" },
          values: {
            workspace_id: [{ value: org.id }],
            users: [{ target_record_id: "someone_else" }],
          },
        },
      ],
      users: [{ id: { record_id: "owner_rec" }, values: { user_id: [{ value: owner.id }] } }],
    };
    return { owner, invitee, org };
  }

  const noRole = async () => null;

  postgresTest("opens a membership, then a rerun writes nothing", async ({ prisma }) => {
    const { owner, invitee, org } = await seed(prisma);
    const payload = { organizationId: org.id, userId: invitee.id };

    await syncAttioMember(payload, client, prisma, noRole);

    const [membership] = records.workspace_memberships;
    expect(membership.values).toMatchObject({
      membership_key: [{ value: `${invitee.id}:${org.id}` }],
      role: [{ option: { title: "Admin" } }],
      join_method: [{ option: { title: "Invite" } }],
      invited_by: [{ target_record_id: "owner_rec" }],
      workspace: [{ target_record_id: "ws_1" }],
    });
    // An unset checkbox reads as false in Attio.
    expect(membership.values?.is_creator?.[0]?.value ?? false).toBe(false);
    // The invitee had no Attio user, so it was created with their email.
    expect(records.users.map((u) => u.values?.primary_email_address?.[0]?.value)).toContain(
      invitee.email
    );

    calls = [];
    await syncAttioMember(payload, client, prisma, noRole);
    expect(writes().filter((c) => c.path.includes("workspace_memberships"))).toEqual([]);

    // The creator's membership is marked as the creator's.
    await syncAttioMember({ organizationId: org.id, userId: owner.id }, client, prisma, noRole);
    const creator = records.workspace_memberships.find(
      (m) => m.values?.membership_key?.[0]?.value === `${owner.id}:${org.id}`
    );
    expect(creator?.values).toMatchObject({
      is_creator: [{ value: true }],
      role: [{ option: { title: "Owner" } }],
    });
  });

  postgresTest("closes the membership once the member has left", async ({ prisma }) => {
    const { invitee, org } = await seed(prisma);
    const payload = { organizationId: org.id, userId: invitee.id };
    await syncAttioMember(payload, client, prisma, noRole);

    await prisma.orgMember.deleteMany({ where: { organizationId: org.id, userId: invitee.id } });
    await syncAttioMember(payload, client, prisma, noRole);

    const [membership] = records.workspace_memberships;
    expect(membership.values?.left_at?.[0]?.value).toBeTruthy();

    calls = [];
    await syncAttioMember(payload, client, prisma, noRole);
    expect(writes()).toEqual([]);
  });

  postgresTest(
    "writes nothing for a user who was never synced and isn't a member",
    async ({ prisma }) => {
      const { org } = await seed(prisma);
      await syncAttioMember(
        { organizationId: org.id, userId: "user_gone" },
        client,
        prisma,
        noRole
      );
      expect(writes()).toEqual([]);
    }
  );

  postgresTest("closes memberships with the org's deletion time", async ({ prisma }) => {
    const { invitee, org } = await seed(prisma);
    const payload = { organizationId: org.id, userId: invitee.id };
    await syncAttioMember(payload, client, prisma, noRole);

    const deletedAt = new Date("2026-11-01T00:00:00Z");
    await prisma.organization.update({ where: { id: org.id }, data: { deletedAt } });
    await syncAttioMember(payload, client, prisma, noRole);

    expect(records.workspace_memberships[0].values?.left_at?.[0]?.value).toBe(
      deletedAt.toISOString()
    );
  });

  postgresTest("retries while the workspace isn't in Attio yet", async ({ prisma }) => {
    const { invitee, org } = await seed(prisma);
    records.workspaces = [];
    await expect(
      syncAttioMember({ organizationId: org.id, userId: invitee.id }, client, prisma, noRole)
    ).rejects.toThrow(/not synced yet/);
  });

  it("leaves Workspace users to the member sync when it's on", async () => {
    records = {};
    const port = (server.address() as AddressInfo).port;
    const owned = new AttioClient({
      apiKey: "key",
      isTest: false,
      baseUrl: `http://127.0.0.1:${port}`,
      memberSyncEnabled: true,
    });
    const workspace = {
      orgId: "org_x",
      title: "Acme",
      slug: "acme",
      createdAt: new Date("2026-10-26T12:00:00Z"),
      adminUserId: "user_x",
    };

    await owned.upsertWorkspace(workspace, "a@acme.dev");
    const put = calls.find((c) => c.path.includes("/workspaces/"));
    expect(put?.body.data.values).not.toHaveProperty("users");

    calls = [];
    await client.upsertWorkspace(workspace, "a@acme.dev");
    expect(calls.find((c) => c.path.includes("/workspaces/"))?.body.data.values).toHaveProperty(
      "users"
    );
  });

  postgresTest(
    "rewrites a membership that changed while it was being written",
    async ({ prisma }) => {
      const { invitee, org } = await seed(prisma);
      beforeWriteReply = async (call) => {
        if (call.path.includes("workspace_memberships")) {
          beforeWriteReply = undefined;
          await prisma.orgMember.deleteMany({
            where: { organizationId: org.id, userId: invitee.id },
          });
        }
      };

      await syncAttioMember({ organizationId: org.id, userId: invitee.id }, client, prisma, noRole);

      expect(records.workspace_memberships[0].values?.left_at?.[0]?.value).toBeTruthy();
    }
  );

  postgresTest("retries when the membership keeps changing mid-write", async ({ prisma }) => {
    const { invitee, org } = await seed(prisma);
    // Every membership write lands after another role change.
    beforeWriteReply = async (call) => {
      if (!call.path.includes("workspace_memberships")) return;
      const member = await prisma.orgMember.findFirstOrThrow({
        where: { organizationId: org.id, userId: invitee.id },
      });
      await prisma.orgMember.update({
        where: { id: member.id },
        data: { role: member.role === "ADMIN" ? "MEMBER" : "ADMIN" },
      });
    };

    await expect(
      syncAttioMember({ organizationId: org.id, userId: invitee.id }, client, prisma, noRole)
    ).rejects.toThrow(/still changing/);
  });

  postgresTest("rewrites the users list when a member leaves mid-write", async ({ prisma }) => {
    const { invitee, org } = await seed(prisma);
    beforeWriteReply = async (call) => {
      if (call.path.includes("/workspaces/")) {
        beforeWriteReply = undefined;
        await prisma.orgMember.deleteMany({
          where: { organizationId: org.id, userId: invitee.id },
        });
      }
    };

    await syncAttioWorkspaceMembers({ organizationId: org.id }, client, prisma);

    expect(records.workspaces[0].values?.users?.map((u: any) => u.target_record_id)).toEqual([
      "owner_rec",
    ]);
  });

  postgresTest("replaces the workspace's users with its current members", async ({ prisma }) => {
    const { org } = await seed(prisma);

    await syncAttioWorkspaceMembers({ organizationId: org.id }, client, prisma);

    const users = records.workspaces[0].values?.users?.map((u: any) => u.target_record_id).sort();
    expect(users).toEqual(["owner_rec", "users_2"]);

    calls = [];
    await syncAttioWorkspaceMembers({ organizationId: org.id }, client, prisma);
    expect(writes()).toEqual([]);
  });
});
