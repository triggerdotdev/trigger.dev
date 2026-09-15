import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({
  userId: "user_attacker",
  projectId: "proj_shared",
  environmentId: "env_attacker",
}));

const waitpointHolder = vi.hoisted(() => ({
  waitpoint: undefined as { id: string; projectId: string; environmentId: string } | undefined,
  replicaCalls: [] as Array<{ where: Record<string, string> }>,
  primaryCalls: [] as Array<{ where: Record<string, string> }>,
}));

const engineHolder = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>> }));

function matchesWaitpoint(where: Record<string, string>) {
  const waitpoint = waitpointHolder.waitpoint;
  if (!waitpoint || where.id !== waitpoint.id) return undefined;
  if (where.projectId !== undefined && where.projectId !== waitpoint.projectId) return undefined;
  if (where.environmentId !== undefined && where.environmentId !== waitpoint.environmentId) {
    return undefined;
  }
  return waitpoint;
}

vi.mock("~/v3/runStore.server", () => ({
  runStore: {
    findWaitpoint: async ({ where }: { where: Record<string, string> }) => {
      waitpointHolder.replicaCalls.push({ where });
      return matchesWaitpoint(where);
    },
    findWaitpointOnPrimary: async ({ where }: { where: Record<string, string> }) => {
      waitpointHolder.primaryCalls.push({ where });
      return matchesWaitpoint(where);
    },
  },
}));

vi.mock("~/db.server", () => ({
  $replica: {
    project: {
      findUnique: async () => ({ id: auth.projectId }),
    },
  },
}));

vi.mock("~/models/runtimeEnvironment.server", () => ({
  findEnvironmentBySlug: async () => ({ id: auth.environmentId }),
}));

vi.mock("~/v3/runEngine.server", () => ({
  engine: {
    completeWaitpoint: async (args: Record<string, unknown>) => {
      engineHolder.calls.push(args);
      return { id: args.id };
    },
  },
}));

vi.mock("~/services/session.server", () => ({
  requireUserId: async () => auth.userId,
}));

vi.mock("~/env.server", () => ({
  env: { TASK_PAYLOAD_MAXIMUM_SIZE: 3_000_000 },
}));

vi.mock("~/services/logger.server", () => ({
  logger: { error: () => {}, info: () => {}, debug: () => {}, warn: () => {} },
}));

vi.mock("~/models/message.server", () => ({
  redirectWithErrorMessage: (redirect: string, _request: Request, message: string) =>
    new Response(null, {
      status: 302,
      headers: { location: redirect, "x-outcome": "error", "x-message": message },
    }),
  redirectWithSuccessMessage: (redirect: string, _request: Request, message: string) =>
    new Response(null, {
      status: 302,
      headers: { location: redirect, "x-outcome": "success", "x-message": message },
    }),
}));

vi.mock("~/runEngine/concerns/waitpointCompletionPacket.server", () => ({
  processWaitpointCompletionPacket: async () => ({ data: undefined, dataType: "application/json" }),
}));

import { WaitpointId } from "@trigger.dev/core/v3/isomorphic";
import { action } from "~/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.waitpoints.$waitpointFriendlyId.complete/route";

function completeRequest(type: "DATETIME" | "MANUAL", isTimeout = false) {
  const body = new URLSearchParams({
    type,
    successRedirect: "/success",
    failureRedirect: "/failure",
  });
  if (type === "MANUAL") body.set("payload", "{}");
  if (isTimeout) body.set("isTimeout", "1");

  return new Request("http://localhost/complete", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
}

async function complete(friendlyId: string, type: "DATETIME" | "MANUAL", isTimeout = false) {
  return (await action({
    request: completeRequest(type, isTimeout),
    params: {
      organizationSlug: "org-slug",
      projectParam: "project-slug",
      envParam: "dev",
      waitpointFriendlyId: friendlyId,
    },
    context: {} as never,
  })) as Response;
}

beforeEach(() => {
  waitpointHolder.waitpoint = undefined;
  waitpointHolder.replicaCalls = [];
  waitpointHolder.primaryCalls = [];
  engineHolder.calls = [];
});

describe("dashboard waitpoint completion authorization", () => {
  it.each([
    { type: "DATETIME" as const, isTimeout: false },
    { type: "MANUAL" as const, isTimeout: true },
  ])(
    "rejects $type completion for another development environment",
    async ({ type, isTimeout }) => {
      const { id, friendlyId } = WaitpointId.generate();
      waitpointHolder.waitpoint = {
        id,
        projectId: auth.projectId,
        environmentId: "env_victim",
      };

      const response = await complete(friendlyId, type, isTimeout);

      expect(response.headers.get("x-outcome")).toBe("error");
      expect(response.headers.get("x-message")).toBe("No waitpoint found");
      expect(engineHolder.calls).toHaveLength(0);
      expect(waitpointHolder.replicaCalls[0]?.where).toEqual({
        id,
        projectId: auth.projectId,
        environmentId: auth.environmentId,
      });
      expect(waitpointHolder.primaryCalls[0]?.where).toEqual({
        id,
        projectId: auth.projectId,
        environmentId: auth.environmentId,
      });
    }
  );

  it.each([
    { type: "DATETIME" as const, isTimeout: false, message: "Waitpoint skipped" },
    { type: "MANUAL" as const, isTimeout: true, message: "Waitpoint timed out" },
  ])(
    "allows $type completion in the authorized environment",
    async ({ type, isTimeout, message }) => {
      const { id, friendlyId } = WaitpointId.generate();
      waitpointHolder.waitpoint = {
        id,
        projectId: auth.projectId,
        environmentId: auth.environmentId,
      };

      const response = await complete(friendlyId, type, isTimeout);

      expect(response.headers.get("x-outcome")).toBe("success");
      expect(response.headers.get("x-message")).toBe(message);
      expect(engineHolder.calls).toHaveLength(1);
      expect(engineHolder.calls[0]?.id).toBe(id);
      expect(waitpointHolder.primaryCalls).toHaveLength(0);
    }
  );
});
