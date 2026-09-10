import { createStandalonePostgresContainer } from "@internal/testcontainers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { seedTestEnvironment } from "./helpers/seedTestEnvironment";
import { seedTestUser } from "./helpers/seedTestSession";
import { seedTestPAT } from "./helpers/seedTestPAT";

import type * as Route from "~/routes/resources.branches.archive";
import type * as ApiRoute from "~/routes/api.v1.projects.$projectRef.branches.archive";
import type * as Database from "~/db.server";
import type * as SessionStorage from "~/services/sessionStorage.server";
import type * as Messages from "~/models/message.server";

let container: Awaited<ReturnType<typeof createStandalonePostgresContainer>>;
let action: typeof Route.action;
let apiAction: typeof ApiRoute.action;
let database: typeof Database;
let sessionStorage: typeof SessionStorage;
let messages: typeof Messages;

beforeAll(async () => {
  container = await createStandalonePostgresContainer();
  vi.stubEnv("DATABASE_URL", container.url);
  vi.stubEnv("CONTROL_PLANE_DATABASE_URL", container.url);
  vi.stubEnv("DATABASE_READ_REPLICA_URL", container.url);
  vi.stubEnv("CONTROL_PLANE_DATABASE_READ_REPLICA_URL", container.url);
  vi.stubEnv("RBAC_FORCE_FALLBACK", "1");
  vi.stubEnv("ENCRYPTION_KEY", "test-encryption-key-for-e2e!!!!!");

  // Configure the real database before importing the route's singletons.
  database = await import("~/db.server");
  ({ action } = await import("~/routes/resources.branches.archive"));
  ({ action: apiAction } = await import("~/routes/api.v1.projects.$projectRef.branches.archive"));
  sessionStorage = await import("~/services/sessionStorage.server");
  messages = await import("~/models/message.server");
}, 120_000);

afterAll(async () => {
  await database?.$replica.$disconnect();
  await database?.prisma.$disconnect();
  await container?.container.stop();
  vi.unstubAllEnvs();
});

const LIST_PATH = "/orgs/o/projects/p/env/preview/branches?page=3&search=feat";

async function archive(redirectPath: string, isBranch = true, isMember = true) {
  const { organization, project, environment: parent } = await seedTestEnvironment(database.prisma);
  await database.prisma.runtimeEnvironment.update({
    where: { id: parent.id },
    data: { type: "PREVIEW", slug: "preview" },
  });
  const user = await seedTestUser(database.prisma);
  if (isMember) {
    await database.prisma.orgMember.create({
      data: { userId: user.id, organizationId: organization.id, role: "MEMBER" },
    });
  }
  const environment = await database.prisma.runtimeEnvironment.create({
    data: {
      type: "PREVIEW",
      slug: "feat-checkout",
      branchName: "feat/checkout",
      shortcode: user.id,
      apiKey: `tr_preview_${user.id}`,
      pkApiKey: `pk_preview_${user.id}`,
      organizationId: organization.id,
      projectId: project.id,
      parentEnvironmentId: isBranch ? parent.id : null,
    },
  });
  const session = await sessionStorage.getSession();
  session.set("user", { userId: user.id });
  const cookie = (await sessionStorage.commitSession(session)).split(";")[0];

  const response = await action({
    request: new Request("https://app.example.com/resources/branches/archive", {
      method: "POST",
      headers: { Cookie: cookie },
      body: new URLSearchParams({ environmentId: environment.id, redirectPath }),
    }),
    params: {},
    context: {},
  });

  const messageSession = await messages.getSession(response.headers.get("Set-Cookie"));
  const updated = await database.prisma.runtimeEnvironment.findFirstOrThrow({
    where: { id: environment.id },
    select: { archivedAt: true },
  });
  const shouldArchive = isBranch && isMember;
  expect(messageSession.get("toastMessage").type).toBe(shouldArchive ? "success" : "error");
  expect(updated.archivedAt !== null).toBe(shouldArchive);
  return response;
}

describe("branch archive credential boundaries without an RBAC plugin", () => {
  it.each([
    { key: "member-pat", env: "preview", status: 200 },
    { key: "foreign-pat", env: "preview", status: 404 },
    { key: "parent", env: "preview", status: 200 },
    { key: "branch", env: "preview", status: 403 },
    { key: "other-project", env: "preview", status: 404 },
    { key: "parent", env: "development", status: 403 },
  ])("returns $status for $key key targeting $env", async ({ key, env, status }) => {
    const {
      organization,
      project,
      environment: parent,
    } = await seedTestEnvironment(database.prisma);
    await database.prisma.runtimeEnvironment.update({
      where: { id: parent.id },
      data: { type: "PREVIEW", slug: "preview" },
    });
    const branch = await database.prisma.runtimeEnvironment.create({
      data: {
        type: "PREVIEW",
        slug: "feature",
        branchName: "feature",
        shortcode: `${parent.id}-branch`,
        apiKey: `tr_preview_${parent.id}`,
        pkApiKey: `pk_preview_${parent.id}`,
        organizationId: organization.id,
        projectId: project.id,
        parentEnvironmentId: parent.id,
      },
    });
    const projectRef =
      key === "other-project"
        ? (await seedTestEnvironment(database.prisma)).project.externalRef
        : project.externalRef;
    let token = parent.apiKey;
    if (key === "member-pat" || key === "foreign-pat") {
      const user = await seedTestUser(database.prisma);
      if (key === "member-pat") {
        await database.prisma.orgMember.create({
          data: { userId: user.id, organizationId: organization.id, role: "MEMBER" },
        });
      }
      ({ token } = await seedTestPAT(database.prisma, user.id));
    }
    const response = await apiAction({
      request: new Request(
        `https://app.example.com/api/v1/projects/${projectRef}/branches/archive`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            ...(key === "branch" ? { "x-trigger-branch": branch.branchName! } : {}),
          },
          body: JSON.stringify({ env, branch: branch.branchName }),
        }
      ),
      params: { projectRef },
      context: {},
    });
    expect(response.status).toBe(status);
    const updated = await database.prisma.runtimeEnvironment.findFirstOrThrow({
      where: { id: branch.id },
    });
    expect(updated.archivedAt !== null).toBe(status === 200);
  });
});

describe("archiving a branch returns to the page it was started from", () => {
  it("allows an OSS member to archive and preserves the query string", async () => {
    const response = await archive(LIST_PATH);
    expect(response.headers.get("Location")).toBe(LIST_PATH);
  });

  it("preserves the query string on failure", async () => {
    const response = await archive(LIST_PATH, false);
    expect(response.headers.get("Location")).toBe(LIST_PATH);
  });

  it("rejects a non-member without archiving the branch", async () => {
    const response = await archive(LIST_PATH, true, false);
    expect(response.headers.get("Location")).toBe(LIST_PATH);
  });

  it("keeps the redirect same-origin", async () => {
    const response = await archive("//evil.example.com/branches");
    expect(response.headers.get("Location")).toBe("/");
  });
});
