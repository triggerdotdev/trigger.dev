import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { postgresTest } from "@internal/testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AttioClient, syncAttioWorkspace } from "~/services/attioClient.server";
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
describe("AttioClient.upsertWorkspace", () => {
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
  });

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
    });
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
