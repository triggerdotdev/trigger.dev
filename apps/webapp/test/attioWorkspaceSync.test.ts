import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { postgresTest } from "@internal/testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AttioClient,
  signupAttributionFromUser,
  syncAttioUser,
  syncAttioWorkspace,
} from "~/services/attioClient.server";
import { Logger } from "@trigger.dev/core/logger";
import { createTestUser } from "./fixtures/environmentVariablesFixtures";

vi.setConfig({ testTimeout: 120_000 });

const payload = {
  orgId: "org_1",
  title: "Acme",
  slug: "acme-1234",
  companySize: "1-5",
  createdAt: new Date("2026-10-26T12:00:00Z"),
  adminUserId: "user_1",
};

const userPayload = {
  userId: "user_1",
  email: "Founder@Startup.io",
  marketingEmails: true,
  referralSource: "search",
  createdAt: new Date("2026-10-26T12:00:00Z"),
};

type AttioRequest = { object: string; values: Record<string, any> };
type AttioReply = { status: number; body: unknown };

const record = (recordId: string): AttioReply => ({
  status: 200,
  body: { data: { id: { record_id: recordId } } },
});
const rejection = (status: number, code: string): AttioReply => ({
  status,
  body: { status_code: status, code, message: code },
});

// A local server standing in for the Attio API: replies per object and records each request.
describe("Attio sync", () => {
  let server: Server;
  let client: AttioClient;
  let requests: AttioRequest[];
  let reply: (request: AttioRequest) => AttioReply;

  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        const object = req.url!.match(/objects\/(\w+)\/records/)![1];
        const request = { object, values: JSON.parse(raw).data.values };
        requests.push(request);
        const { status, body } = reply(request);
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
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
    requests = [];
    logs = [];
  });

  // Every structured log line, captured through the logger's own sink.
  let logs: Record<string, unknown>[];
  beforeAll(() => {
    Logger.onLog = (log) => logs.push(log);
  });
  afterAll(() => {
    Logger.onLog = undefined;
  });
  const attioWarnings = () =>
    logs.filter((l) => l.level === "warn" && String(l.message).startsWith("Attio sync"));
  const errors = () => logs.filter((l) => l.level === "error");

  it("links an existing Attio user without sending the email", async () => {
    reply = ({ object }) => record(`${object}_rec`);

    await client.upsertWorkspace(payload, "Admin@Example.com");

    expect(requests.map((r) => r.object)).toEqual(["users", "workspaces"]);
    expect(requests[0].values).not.toHaveProperty("primary_email_address");
    expect(requests[1].values).toMatchObject({
      workspace_id: "org_1",
      email_domain: "example.com",
      signup_date: "2026-10-26",
      users: [{ target_object: "users", target_record_id: "users_rec" }],
    });
  });

  it("creates a missing Attio user with the admin's email, then writes the workspace", async () => {
    reply = ({ object, values }) =>
      object === "users" && !values.primary_email_address
        ? rejection(400, "missing_value")
        : record(`${object}_rec`);

    await client.upsertWorkspace(payload, "Admin@Example.com");

    expect(requests.map((r) => r.object)).toEqual(["users", "users", "workspaces"]);
    expect(requests[1].values).toMatchObject({
      user_id: "user_1",
      primary_email_address: "Admin@Example.com",
    });
    expect(requests[2].values.users).toEqual([
      { target_object: "users", target_record_id: "users_rec" },
    ]);
  });

  it("still writes the workspace when Attio rejects the user", async () => {
    reply = ({ object, values }) => {
      if (object === "workspaces") return record("workspaces_rec");
      return values.primary_email_address
        ? rejection(400, "uniqueness_conflict")
        : rejection(400, "missing_value");
    };

    await client.upsertWorkspace(payload, "Admin@Example.com");

    const workspace = requests.find((r) => r.object === "workspaces");
    expect(workspace?.values).toMatchObject({ workspace_id: "org_1", signup_date: "2026-10-26" });
    expect(workspace?.values).not.toHaveProperty("users");
  });

  it("links the user when a concurrent user sync created it first", async () => {
    let created = false;
    reply = ({ object, values }) => {
      if (object === "workspaces") return record("workspaces_rec");
      if (values.primary_email_address) {
        // The other sync won the create; the user exists from now on.
        created = true;
        return rejection(400, "uniqueness_conflict");
      }
      return created ? record("users_rec") : rejection(400, "missing_value");
    };

    await client.upsertWorkspace(payload, "Admin@Example.com");

    expect(requests.map((r) => r.object)).toEqual(["users", "users", "users", "workspaces"]);
    expect(requests[3].values.users).toEqual([
      { target_object: "users", target_record_id: "users_rec" },
    ]);
  });

  it("skips the extra user lookup when the create is rejected for another reason", async () => {
    reply = ({ object, values }) => {
      if (object === "workspaces") return record("workspaces_rec");
      if (values.primary_email_address) return rejection(400, "validation_type");
      return rejection(400, "missing_value");
    };

    await client.upsertWorkspace(payload, "Admin@Example.com");

    expect(requests.map((r) => r.object)).toEqual(["users", "users", "workspaces"]);
    expect(requests[2].values).not.toHaveProperty("users");
  });

  it("throws on a transient user failure so the job retries", async () => {
    reply = () => rejection(503, "unavailable");

    await expect(client.upsertWorkspace(payload, "Admin@Example.com")).rejects.toMatchObject({
      status: 503,
      transient: true,
      logLevel: "warn",
    });
    expect(requests.map((r) => r.object)).toEqual(["users"]);
  });

  it("throws when the workspace write fails", async () => {
    reply = ({ object }) =>
      object === "users" ? record("users_rec") : rejection(400, "validation_type");

    await expect(client.upsertWorkspace(payload, "Admin@Example.com")).rejects.toMatchObject({
      status: 400,
      transient: false,
      logLevel: "warn",
    });
  });

  // Catches: workspace missing the creator's attribution.
  postgresTest(
    "puts the creator's signup attribution on their first workspace",
    async ({ prisma }) => {
      reply = ({ object }) => record(`${object}_rec`);
      const user = await prisma.user.create({
        data: {
          email: "founder@startup.io",
          authenticationMethod: "MAGIC_LINK",
          referralSource: "Other: a podcast",
          onboardingData: {
            role: "Other",
            roleOther: "CTO",
            firstTouch: { utmSource: "newsletter", referrer: "www.google.com" },
          },
        },
      });

      await syncAttioWorkspace({ ...payload, adminUserId: user.id }, client, prisma);

      const workspace = requests.find((r) => r.object === "workspaces")!;
      expect(workspace.values).toMatchObject({
        referral_source: "Other: a podcast",
        signup_role: "Other: CTO",
        first_touch_utm_source: "newsletter",
        first_touch_referrer: "www.google.com",
      });
      expect(workspace.values).not.toHaveProperty("first_touch_landing_page");
    }
  );

  // Catches: every later org repeating the first one's acquisition.
  postgresTest("leaves attribution off the creator's later workspaces", async ({ prisma }) => {
    reply = ({ object }) => record(`${object}_rec`);
    const user = await prisma.user.create({
      data: {
        email: "founder@startup.io",
        authenticationMethod: "MAGIC_LINK",
        referralSource: "YouTube",
        onboardingData: { role: "Founder" },
      },
    });
    const earlier = await prisma.organization.create({
      data: { title: "First", slug: "first-org", createdAt: new Date("2026-10-01T00:00:00Z") },
    });
    await prisma.orgMember.create({
      data: {
        organizationId: earlier.id,
        userId: user.id,
        role: "ADMIN",
        createdAt: new Date("2026-10-01T00:00:00Z"),
      },
    });

    await syncAttioWorkspace({ ...payload, adminUserId: user.id }, client, prisma);

    const workspace = requests.find((r) => r.object === "workspaces")!;
    expect(workspace.values).not.toHaveProperty("referral_source");
    expect(workspace.values).not.toHaveProperty("signup_role");
  });

  // Catches: an invited admin's older org hiding attribution on the first org they created.
  postgresTest("ignores orgs the creator joined by invitation", async ({ prisma }) => {
    reply = ({ object }) => record(`${object}_rec`);
    const owner = await createTestUser(prisma, "owner@other.io");
    const user = await prisma.user.create({
      data: {
        email: "founder@startup.io",
        authenticationMethod: "MAGIC_LINK",
        referralSource: "YouTube",
      },
    });
    const invited = await prisma.organization.create({
      data: { title: "Other", slug: "other-org", createdAt: new Date("2026-10-01T00:00:00Z") },
    });
    await prisma.orgMember.create({
      data: {
        organizationId: invited.id,
        userId: owner.id,
        role: "ADMIN",
        createdAt: new Date("2026-10-01T00:00:00Z"),
      },
    });
    await prisma.orgMember.create({
      data: {
        organizationId: invited.id,
        userId: user.id,
        role: "ADMIN",
        createdAt: new Date("2026-10-10T00:00:00Z"),
      },
    });

    await syncAttioWorkspace({ ...payload, adminUserId: user.id }, client, prisma);

    const workspace = requests.find((r) => r.object === "workspaces")!;
    expect(workspace.values).toMatchObject({ referral_source: "YouTube" });
  });

  // Catches: the oldest remaining member of an older org being taken for its creator.
  postgresTest(
    "ignores an older org the user joined after its founder left",
    async ({ prisma }) => {
      reply = ({ object }) => record(`${object}_rec`);
      const user = await prisma.user.create({
        data: {
          email: "bob@startup.io",
          authenticationMethod: "MAGIC_LINK",
          referralSource: "YouTube",
        },
      });
      const older = await prisma.organization.create({
        data: { title: "Alice's", slug: "alices-org", createdAt: new Date("2026-10-01T00:00:00Z") },
      });
      await prisma.orgMember.create({
        data: {
          organizationId: older.id,
          userId: user.id,
          role: "MEMBER",
          createdAt: new Date("2026-10-05T00:00:00Z"),
        },
      });

      await syncAttioWorkspace({ ...payload, adminUserId: user.id }, client, prisma);

      const workspace = requests.find((r) => r.object === "workspaces")!;
      expect(workspace.values).toMatchObject({ referral_source: "YouTube" });
    }
  );

  // Catches: an invitation accepted soon after an org's creation being taken for its creator.
  postgresTest("ignores an older org whose invite was accepted right away", async ({ prisma }) => {
    reply = ({ object }) => record(`${object}_rec`);
    const user = await prisma.user.create({
      data: {
        email: "bob@startup.io",
        authenticationMethod: "MAGIC_LINK",
        referralSource: "YouTube",
      },
    });
    const older = await prisma.organization.create({
      data: { title: "Alice's", slug: "alices-org", createdAt: new Date("2026-10-01T12:00:00Z") },
    });
    await prisma.orgMember.create({
      data: {
        organizationId: older.id,
        userId: user.id,
        role: "ADMIN",
        createdAt: new Date("2026-10-01T12:00:30Z"),
      },
    });

    await syncAttioWorkspace({ ...payload, adminUserId: user.id }, client, prisma);

    const workspace = requests.find((r) => r.object === "workspaces")!;
    expect(workspace.values).toMatchObject({ referral_source: "YouTube" });
  });

  // Catches: CLI-created orgs failing or writing blank attribution.
  postgresTest("writes no attribution for a creator who skipped the form", async ({ prisma }) => {
    reply = ({ object }) => record(`${object}_rec`);
    const user = await createTestUser(prisma, "cli@startup.io");

    await syncAttioWorkspace({ ...payload, adminUserId: user.id }, client, prisma);

    const workspace = requests.find((r) => r.object === "workspaces")!;
    expect(workspace.values).toMatchObject({ workspace_id: "org_1" });
    expect(
      Object.keys(workspace.values).filter((k) => /referral|role|first_touch/.test(k))
    ).toEqual([]);
  });

  it("tags a transient user sync failure warn so the job retries without paging", async () => {
    reply = () => rejection(503, "unavailable");

    await expect(syncAttioUser(userPayload, client)).rejects.toMatchObject({
      status: 503,
      transient: true,
      logLevel: "warn",
    });
  });

  it("tags a network failure warn so the job retries without paging", async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const { port } = closed.address() as AddressInfo;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const offline = new AttioClient({
      apiKey: "key",
      isTest: false,
      baseUrl: `http://127.0.0.1:${port}`,
    });

    const error = await syncAttioUser(userPayload, offline).catch((e) => e);
    expect(error).toMatchObject({ logLevel: "warn" });
    expect(error.message).toMatch(/^Attio user sync failed: /);
    expect(error.cause).toBeInstanceOf(Error);
  });

  it("finishes without retrying when the email belongs to another Attio user", async () => {
    reply = ({ values }) =>
      values.primary_email_address
        ? rejection(400, "uniqueness_conflict")
        : rejection(400, "missing_value");

    await expect(syncAttioUser(userPayload, client)).resolves.toBeUndefined();

    expect(requests).toHaveLength(2);
    expect(attioWarnings()).toEqual([
      expect.objectContaining({
        message: "Attio sync rejected, not retrying",
        job: "user",
        userId: "user_1",
        status: 400,
        code: "uniqueness_conflict",
      }),
    ]);
    expect(errors()).toEqual([]);
  });

  it("updates the user without the email when a concurrent workspace sync created it", async () => {
    reply = ({ values }) =>
      values.primary_email_address ? rejection(400, "uniqueness_conflict") : record("users_rec");

    await syncAttioUser(userPayload, client);

    expect(requests).toHaveLength(2);
    expect(requests[1].values).not.toHaveProperty("primary_email_address");
    expect(requests[1].values).toMatchObject({
      user_id: "user_1",
      marketing_opt_in: true,
      referral_source: "search",
    });
    expect(attioWarnings()).toEqual([]);
  });

  it("reports the retry's own rejection when the email-less update fails for another reason", async () => {
    reply = ({ values }) =>
      values.primary_email_address
        ? rejection(400, "uniqueness_conflict")
        : rejection(400, "validation_type");

    await expect(syncAttioUser(userPayload, client)).resolves.toBeUndefined();

    expect(attioWarnings()).toEqual([
      expect.objectContaining({
        message: "Attio sync rejected unexpectedly, not retrying",
        code: "validation_type",
      }),
    ]);
  });

  it("retries a request timeout", async () => {
    reply = () => rejection(408, "request_timeout");

    await expect(syncAttioUser(userPayload, client)).rejects.toMatchObject({
      status: 408,
      transient: true,
      logLevel: "warn",
    });
  });

  it("finishes with a separate warning on an unexpected rejection", async () => {
    reply = () => rejection(401, "unauthorized");

    await expect(syncAttioUser(userPayload, client)).resolves.toBeUndefined();

    expect(requests).toHaveLength(1);
    expect(attioWarnings()).toEqual([
      expect.objectContaining({
        message: "Attio sync rejected unexpectedly, not retrying",
        job: "user",
        userId: "user_1",
        status: 401,
        code: "unauthorized",
      }),
    ]);
    expect(errors()).toEqual([]);
  });

  postgresTest("finishes the workspace job without retrying on a rejection", async ({ prisma }) => {
    reply = ({ object }) =>
      object === "users" ? record("users_rec") : rejection(400, "validation_type");
    const user = await createTestUser(prisma, "Founder@Startup.io");

    await expect(
      syncAttioWorkspace({ ...payload, adminUserId: user.id }, client, prisma)
    ).resolves.toBeUndefined();

    expect(attioWarnings()).toEqual([
      expect.objectContaining({
        message: "Attio sync rejected unexpectedly, not retrying",
        job: "workspace",
        orgId: "org_1",
        status: 400,
        code: "validation_type",
      }),
    ]);
    expect(errors()).toEqual([]);
  });

  postgresTest("the worker job sends the admin's email from the database", async ({ prisma }) => {
    reply = ({ object, values }) =>
      object === "users" && !values.primary_email_address
        ? rejection(400, "missing_value")
        : record(`${object}_rec`);
    const user = await createTestUser(prisma, "Founder@Startup.io");

    await syncAttioWorkspace({ ...payload, adminUserId: user.id }, client, prisma);

    expect(requests[1].values).toMatchObject({
      user_id: user.id,
      primary_email_address: "Founder@Startup.io",
    });
    expect(requests[2].values).toMatchObject({ email_domain: "startup.io" });
  });
});

describe("AttioClient.upsertUser", () => {
  let server: Server;
  let client: AttioClient;
  let requests: AttioRequest[];
  let reply: (request: AttioRequest) => AttioReply;

  const user = {
    userId: "user_1",
    email: "dev@example.com",
    referralSource: "Other: a podcast",
    signupRole: "Founder",
    marketingEmails: true,
    createdAt: new Date("2026-10-26T12:00:00Z"),
  };

  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        const object = req.url!.match(/objects\/(\w+)\/records/)![1];
        const request = { object, values: JSON.parse(raw).data.values };
        requests.push(request);
        const { status, body } = reply(request);
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
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
    requests = [];
  });

  // Catches: form answers never reaching Attio, leaving referral_source empty.
  it("sends the onboarding answers", async () => {
    reply = () => record("users_rec");

    await client.upsertUser(user);

    expect(requests).toHaveLength(1);
    expect(requests[0].values).toMatchObject({
      user_id: "user_1",
      primary_email_address: "dev@example.com",
      referral_source: "Other: a podcast",
      signup_role: "Founder",
      signup_date: "2026-10-26",
    });
  });

  // Catches: first-touch values dropped or empty ones blanking Attio fields.
  it("sends the first touch", async () => {
    reply = () => record("users_rec");

    await client.upsertUser({
      ...user,
      firstTouch: { utmSource: "newsletter", referrer: "www.google.com", utmMedium: "" },
    });

    expect(requests[0].values).toMatchObject({
      first_touch_utm_source: "newsletter",
      first_touch_referrer: "www.google.com",
    });
    expect(requests[0].values).not.toHaveProperty("first_touch_utm_medium");
    expect(requests[0].values).not.toHaveProperty("first_touch_landing_page");
  });

  // Catches: the signup sync blanking answers written by the form sync.
  it("never sends empty answers, so existing Attio values are kept", async () => {
    reply = () => record("users_rec");

    await client.upsertUser({ ...user, referralSource: null, signupRole: "" });

    expect(requests[0].values).not.toHaveProperty("referral_source");
    expect(requests[0].values).not.toHaveProperty("signup_role");
  });

  // Catches: an email clash losing the attribution after the job dead-letters.
  it("writes the fields without the email when another Attio user has it", async () => {
    reply = ({ values }) =>
      values.primary_email_address ? rejection(400, "uniqueness_conflict") : record("users_rec");

    await client.upsertUser(user);

    expect(requests).toHaveLength(2);
    expect(requests[1].values).not.toHaveProperty("primary_email_address");
    expect(requests[1].values).toMatchObject({ user_id: "user_1", signup_role: "Founder" });
  });

  // Catches: Attio outages being swallowed instead of retried.
  it("throws on a transient failure so the job retries", async () => {
    reply = () => rejection(503, "unavailable");

    await expect(client.upsertUser(user)).rejects.toMatchObject({ status: 503, logLevel: "warn" });
  });

  // Catches: the email-clash fallback hiding unrelated rejections.
  it("throws on other rejections", async () => {
    reply = () => rejection(400, "validation_type");

    await expect(client.upsertUser(user)).rejects.toMatchObject({ status: 400 });
    expect(requests).toHaveLength(1);
  });
});

describe("signupAttributionFromUser", () => {
  // Catches: losing the free-text "Other" role.
  it("combines the role's Other text", () => {
    expect(
      signupAttributionFromUser({
        referralSource: "Word of mouth",
        onboardingData: { role: "Other", roleOther: "Designer" },
      })
    ).toEqual({
      referralSource: "Word of mouth",
      signupRole: "Other: Designer",
      firstTouch: undefined,
    });
  });

  // Catches: one bad onboarding value dropping the whole attribution.
  it("keeps the valid fields when one is malformed", () => {
    expect(
      signupAttributionFromUser({
        referralSource: null,
        onboardingData: { role: "Founder", firstTouch: "not an object" },
      })
    ).toEqual({ referralSource: null, signupRole: "Founder", firstTouch: undefined });
  });

  // Catches: users without onboarding data crashing the sync.
  it("handles missing onboarding data", () => {
    expect(signupAttributionFromUser({ referralSource: null, onboardingData: null })).toEqual({
      referralSource: null,
      signupRole: undefined,
      firstTouch: undefined,
    });
  });
});
