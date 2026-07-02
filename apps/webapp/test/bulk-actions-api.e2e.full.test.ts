import { randomBytes } from "node:crypto";
import {
  BulkActionStatus,
  BulkActionType,
  type PrismaClient,
  type Project,
  type RuntimeEnvironment,
} from "@trigger.dev/database";
import { describe, expect, it } from "vitest";
import { getTestServer } from "./helpers/sharedTestServer";
import { seedTestEnvironment } from "./helpers/seedTestEnvironment";

describe("Bulk actions API", () => {
  it("lists bulk actions with cursor pagination", async () => {
    const server = getTestServer();
    const { apiKey, project, environment } = await seedTestEnvironment(server.prisma);

    const oldest = await seedBulkAction(server.prisma, project, environment, {
      name: "Oldest",
      createdAt: new Date("2026-07-01T10:00:00.000Z"),
    });
    const middle = await seedBulkAction(server.prisma, project, environment, {
      name: "Middle",
      createdAt: new Date("2026-07-01T10:01:00.000Z"),
    });
    const latest = await seedBulkAction(server.prisma, project, environment, {
      name: "Latest",
      createdAt: new Date("2026-07-01T10:02:00.000Z"),
    });

    const firstResponse = await server.webapp.fetch("/api/v1/bulk-actions?page[size]=2", {
      headers: authHeaders(apiKey),
    });
    expect(firstResponse.status).toBe(200);
    const firstPage = await firstResponse.json();
    expect(firstPage.data.map((item: { id: string }) => item.id)).toEqual([
      latest.friendlyId,
      middle.friendlyId,
    ]);
    expect(firstPage.pagination.next).toEqual(expect.any(String));
    expect(firstPage.pagination.previous).toBeUndefined();

    const secondResponse = await server.webapp.fetch(
      `/api/v1/bulk-actions?page[size]=2&page[after]=${encodeURIComponent(
        firstPage.pagination.next
      )}`,
      { headers: authHeaders(apiKey) }
    );
    expect(secondResponse.status).toBe(200);
    const secondPage = await secondResponse.json();
    expect(secondPage.data.map((item: { id: string }) => item.id)).toEqual([oldest.friendlyId]);
    expect(secondPage.pagination.next).toBeUndefined();
    expect(secondPage.pagination.previous).toEqual(expect.any(String));

    const previousResponse = await server.webapp.fetch(
      `/api/v1/bulk-actions?page[size]=2&page[before]=${encodeURIComponent(
        secondPage.pagination.previous
      )}`,
      { headers: authHeaders(apiKey) }
    );
    expect(previousResponse.status).toBe(200);
    const previousPage = await previousResponse.json();
    expect(previousPage.data.map((item: { id: string }) => item.id)).toEqual([
      latest.friendlyId,
      middle.friendlyId,
    ]);
  });

  it("retrieves a bulk action in the authenticated environment", async () => {
    const server = getTestServer();
    const { apiKey, project, environment } = await seedTestEnvironment(server.prisma);
    const bulkAction = await seedBulkAction(server.prisma, project, environment, {
      name: "Retrieve me",
      type: BulkActionType.REPLAY,
      status: BulkActionStatus.COMPLETED,
      totalCount: 4,
      successCount: 3,
      failureCount: 1,
      completedAt: new Date("2026-07-01T10:05:00.000Z"),
    });

    const response = await server.webapp.fetch(`/api/v1/bulk-actions/${bulkAction.friendlyId}`, {
      headers: authHeaders(apiKey),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      id: bulkAction.friendlyId,
      name: "Retrieve me",
      type: "REPLAY",
      status: "COMPLETED",
      counts: { total: 4, success: 3, failure: 1 },
    });
    expect(body.createdAt).toEqual(expect.any(String));
    expect(body.completedAt).toEqual("2026-07-01T10:05:00.000Z");
  });

  it("does not retrieve bulk actions from another environment", async () => {
    const server = getTestServer();
    const a = await seedTestEnvironment(server.prisma);
    const b = await seedTestEnvironment(server.prisma);
    const bulkAction = await seedBulkAction(server.prisma, a.project, a.environment, {
      name: "Other environment",
    });

    const response = await server.webapp.fetch(`/api/v1/bulk-actions/${bulkAction.friendlyId}`, {
      headers: authHeaders(b.apiKey),
    });

    expect(response.status).toBe(404);
  });

  it("aborts a pending bulk action", async () => {
    const server = getTestServer();
    const { apiKey, project, environment } = await seedTestEnvironment(server.prisma);
    const bulkAction = await seedBulkAction(server.prisma, project, environment, {
      status: BulkActionStatus.PENDING,
    });

    const response = await server.webapp.fetch(
      `/api/v1/bulk-actions/${bulkAction.friendlyId}/abort`,
      { method: "POST", headers: authHeaders(apiKey) }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ id: bulkAction.friendlyId });

    const updated = await server.prisma.bulkActionGroup.findUniqueOrThrow({
      where: { id: bulkAction.id },
      select: { status: true },
    });
    expect(updated.status).toBe(BulkActionStatus.ABORTED);
  });

  it("returns a safe validation error when aborting a completed bulk action", async () => {
    const server = getTestServer();
    const { apiKey, project, environment } = await seedTestEnvironment(server.prisma);
    const bulkAction = await seedBulkAction(server.prisma, project, environment, {
      status: BulkActionStatus.COMPLETED,
      completedAt: new Date("2026-07-01T10:05:00.000Z"),
    });

    const response = await server.webapp.fetch(
      `/api/v1/bulk-actions/${bulkAction.friendlyId}/abort`,
      { method: "POST", headers: authHeaders(apiKey) }
    );

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).toEqual(expect.any(String));
    expect(body.error).toContain(bulkAction.friendlyId);
  });

  it("rejects create requests with both filter and runIds", async () => {
    const server = getTestServer();
    const { apiKey } = await seedTestEnvironment(server.prisma);

    const response = await server.webapp.fetch("/api/v1/bulk-actions", {
      method: "POST",
      headers: authHeaders(apiKey),
      body: JSON.stringify({ action: "cancel", filter: { status: "FAILED" }, runIds: ["run_123"] }),
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("Exactly one of filter or runIds must be provided");
  });

  it("rejects create requests with an empty filter", async () => {
    const server = getTestServer();
    const { apiKey } = await seedTestEnvironment(server.prisma);

    const response = await server.webapp.fetch("/api/v1/bulk-actions", {
      method: "POST",
      headers: authHeaders(apiKey),
      body: JSON.stringify({ action: "cancel", filter: {} }),
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("At least one filter must be provided");
  });

  it("returns a generic error for unexpected create failures", async () => {
    const server = getTestServer();
    const { apiKey } = await seedTestEnvironment(server.prisma);

    const response = await server.webapp.fetch("/api/v1/bulk-actions", {
      method: "POST",
      headers: authHeaders(apiKey),
      body: JSON.stringify({
        action: "cancel",
        filter: { status: "FAILED" },
        name: "No ClickHouse in this suite",
      }),
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "Failed to create bulk action" });
  });
});

function authHeaders(apiKey: string) {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
}

async function seedBulkAction(
  prisma: PrismaClient,
  project: Pick<Project, "id">,
  environment: Pick<RuntimeEnvironment, "id">,
  overrides: {
    name?: string;
    type?: BulkActionType;
    status?: BulkActionStatus;
    createdAt?: Date;
    completedAt?: Date;
    totalCount?: number;
    successCount?: number;
    failureCount?: number;
  } = {}
) {
  return prisma.bulkActionGroup.create({
    data: {
      friendlyId: `bulk_${randomHex(16)}`,
      projectId: project.id,
      environmentId: environment.id,
      name: overrides.name ?? "Test bulk action",
      type: overrides.type ?? BulkActionType.CANCEL,
      status: overrides.status ?? BulkActionStatus.PENDING,
      queryName: "bulk_action_v1",
      params: {},
      totalCount: overrides.totalCount ?? 1,
      successCount: overrides.successCount ?? 0,
      failureCount: overrides.failureCount ?? 0,
      createdAt: overrides.createdAt,
      completedAt: overrides.completedAt,
    },
  });
}

function randomHex(length: number) {
  return randomBytes(Math.ceil(length / 2))
    .toString("hex")
    .slice(0, length);
}
