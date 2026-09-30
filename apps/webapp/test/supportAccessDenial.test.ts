import { createStandalonePostgresContainer } from "@internal/testcontainers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type * as Database from "~/db.server";
import type * as Admin from "~/models/admin.server";
import type * as Session from "~/services/session.server";
import type * as SessionStorage from "~/services/sessionStorage.server";

vi.setConfig({ testTimeout: 30_000 });

let container: Awaited<ReturnType<typeof createStandalonePostgresContainer>>;
let database: typeof Database;
let admin: typeof Admin;
let session: typeof Session;
let sessionStorage: typeof SessionStorage;

beforeAll(async () => {
  container = await createStandalonePostgresContainer();
  vi.stubEnv("DATABASE_URL", container.url);
  vi.stubEnv("CONTROL_PLANE_DATABASE_URL", container.url);
  vi.stubEnv("DATABASE_READ_REPLICA_URL", container.url);
  vi.stubEnv("CONTROL_PLANE_DATABASE_READ_REPLICA_URL", container.url);

  database = await import("~/db.server");
  admin = await import("~/models/admin.server");
  session = await import("~/services/session.server");
  sessionStorage = await import("~/services/sessionStorage.server");
}, 120_000);

afterAll(async () => {
  await database?.$replica.$disconnect();
  await database?.prisma.$disconnect();
  await container?.container.stop();
  vi.unstubAllEnvs();
});

function suffix() {
  return Math.random().toString(36).slice(2, 10);
}

// A staff member in an Allow session for org A, whose customer also belongs to org B.
async function staffInSession() {
  const prisma = database.prisma;
  const staff = await prisma.user.create({
    data: {
      email: `admin-${suffix()}@test.local`,
      authenticationMethod: "MAGIC_LINK",
      admin: true,
    },
  });
  const customer = await prisma.user.create({
    data: { email: `member-${suffix()}@test.local`, authenticationMethod: "MAGIC_LINK" },
  });
  const [home, other] = await Promise.all(
    ["a", "b"].map((name) =>
      prisma.organization.create({
        data: {
          title: name,
          slug: `${name}-${suffix()}`,
          members: { create: [{ userId: customer.id }] },
        },
      })
    )
  );

  const started = await admin.redirectWithImpersonation(
    new Request("http://localhost:3030/admin", { method: "POST" }),
    { userId: customer.id, organizationSlug: home.slug, path: `/orgs/${home.slug}` },
    { id: staff.id, admin: true },
    prisma
  );
  const impersonation = (started.headers.get("set-cookie") ?? "").split(";")[0];

  const auth = await sessionStorage.getSession();
  auth.set("user", { userId: staff.id });
  const login = (await sessionStorage.commitSession(auth)).split(";")[0];

  return { home, other, cookie: `${login}; ${impersonation}` };
}

async function responseFor(cookie: string, path: string, method = "GET") {
  const result = await session
    .getUserId(new Request(`http://localhost:3030${path}`, { method, headers: { Cookie: cookie } }))
    .then(
      () => undefined,
      (thrown: unknown) => thrown
    );
  expect(result).toBeInstanceOf(Response);
  return result as Response;
}

describe("Support Access refusals", () => {
  it("sends a page outside the session back to the session's org", async () => {
    const { home, other, cookie } = await staffInSession();

    const response = await responseFor(cookie, `/orgs/${other.slug}/projects`);

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(`/orgs/${home.slug}`);
  });

  it("redirects client-side navigations too, instead of a 403", async () => {
    const { home, other, cookie } = await staffInSession();

    const response = await responseFor(
      cookie,
      `/orgs/${other.slug}?_data=routes%2F_app.orgs.%24organizationSlug`
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(`/orgs/${home.slug}`);
  });

  it("refuses resource fetches and form submissions with a 403", async () => {
    const { other, cookie } = await staffInSession();

    const fetched = await responseFor(cookie, "/resources/runs/run_1?_data=routes%2Fresources");
    const posted = await responseFor(cookie, `/orgs/${other.slug}/settings`, "POST");

    expect(fetched.status).toBe(403);
    expect(posted.status).toBe(403);
  });

  it("refuses never-allowed pages with a 403 so the session's org can't loop", async () => {
    const { cookie } = await staffInSession();

    const confirm = await responseFor(cookie, "/confirm-basic-details");
    const newOrg = await responseFor(cookie, "/orgs/new");

    expect(confirm.status).toBe(403);
    expect(newOrg.status).toBe(403);
  });

  it("refuses other orgs however the path is cased or encoded", async () => {
    const { home, other, cookie } = await staffInSession();

    for (const path of [`/ORGS/${other.slug}`, `/%6Frgs/${other.slug}`]) {
      const response = await responseFor(cookie, path);
      expect(response.headers.get("location")).toBe(`/orgs/${home.slug}`);
    }
  });
});
