import { apiClientManager, type CreatedSessionResponseBody } from "@trigger.dev/core/v3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { chat } from "./ai.js";
import {
  __setSessionOpenImplForTests,
  __setSessionStartImplForTests,
  SessionHandle,
  sessions,
} from "./sessions.js";

const ENV_KEYS = [
  "TRIGGER_EXTERNAL_DEPLOYMENT_ID",
  "TRIGGER_AUTOMATIC_SKEW_VERSION_PROTECTION",
  "VERCEL_GIT_COMMIT_SHA",
  "GITHUB_SHA",
] as const;

let capturedPin: string | undefined;

function installStartFixture() {
  __setSessionStartImplForTests(async (body): Promise<CreatedSessionResponseBody> => {
    capturedPin = body.triggerConfig.externalDeploymentId;
    return {
      id: "session_fixture",
      externalId: body.externalId ?? null,
      type: body.type,
      taskIdentifier: body.taskIdentifier,
      triggerConfig: body.triggerConfig,
      currentRunId: "run_fixture",
      tags: body.triggerConfig.tags ?? [],
      metadata: body.metadata ?? null,
      closedAt: null,
      closedReason: null,
      expiresAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      runId: "run_fixture",
      publicAccessToken: "tr_pat_fixture",
      isCached: false,
    };
  });
  __setSessionOpenImplForTests(() => new SessionHandle("session_fixture"));
}

function setGlobalConfig(externalDeploymentId?: string) {
  apiClientManager.setGlobalAPIClientConfiguration({
    baseURL: "https://example.invalid",
    accessToken: "tr_test_secret",
    ...(externalDeploymentId ? { externalDeploymentId } : {}),
  });
}

async function startRaw(triggerConfig: Parameters<typeof sessions.start>[0]["triggerConfig"]) {
  await sessions.start({
    type: "chat.agent",
    externalId: "chat-1",
    taskIdentifier: "fake-chat",
    triggerConfig,
  });
  return capturedPin;
}

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  setGlobalConfig();
  installStartFixture();
});

afterEach(() => {
  __setSessionStartImplForTests(undefined);
  __setSessionOpenImplForTests(undefined);
  capturedPin = undefined;
  for (const key of ENV_KEYS) delete process.env[key];
});

describe("sessions.start — external deployment id discovery", () => {
  it("sends nothing when there is nothing to discover", async () => {
    expect(await startRaw({ basePayload: {} })).toBeUndefined();
  });

  it("discovers TRIGGER_EXTERNAL_DEPLOYMENT_ID", async () => {
    process.env.TRIGGER_EXTERNAL_DEPLOYMENT_ID = "from-env";

    expect(await startRaw({ basePayload: {} })).toBe("from-env");
  });

  it("prefers an explicit id over the environment", async () => {
    process.env.TRIGGER_EXTERNAL_DEPLOYMENT_ID = "from-env";

    expect(await startRaw({ basePayload: {}, externalDeploymentId: "explicit" })).toBe("explicit");
  });

  it("prefers the client config over the environment", async () => {
    process.env.TRIGGER_EXTERNAL_DEPLOYMENT_ID = "from-env";
    setGlobalConfig("from-client-config");

    expect(await startRaw({ basePayload: {} })).toBe("from-client-config");
  });

  it("ignores platform commit vars unless automatic protection is on", async () => {
    process.env.VERCEL_GIT_COMMIT_SHA = "commit-sha";

    expect(await startRaw({ basePayload: {} })).toBeUndefined();
  });

  it("discovers the platform commit var when automatic protection is on", async () => {
    process.env.TRIGGER_AUTOMATIC_SKEW_VERSION_PROTECTION = "1";
    process.env.VERCEL_GIT_COMMIT_SHA = "commit-sha";

    expect(await startRaw({ basePayload: {} })).toBe("commit-sha");
  });

  it("treats null as an opt-out, outranking every source", async () => {
    process.env.TRIGGER_EXTERNAL_DEPLOYMENT_ID = "from-env";
    process.env.TRIGGER_AUTOMATIC_SKEW_VERSION_PROTECTION = "1";
    process.env.VERCEL_GIT_COMMIT_SHA = "commit-sha";
    setGlobalConfig("from-client-config");

    expect(await startRaw({ basePayload: {}, externalDeploymentId: null })).toBeUndefined();
  });

  it("normalizes a whitespace-only id to absent", async () => {
    expect(await startRaw({ basePayload: {}, externalDeploymentId: "   " })).toBeUndefined();
  });

  it("skips an over-long id rather than sending it", async () => {
    expect(
      await startRaw({ basePayload: {}, externalDeploymentId: "a".repeat(129) })
    ).toBeUndefined();
  });
});

describe("chat.createStartSessionAction — external deployment id", () => {
  it("discovers from the environment", async () => {
    process.env.TRIGGER_EXTERNAL_DEPLOYMENT_ID = "from-env";
    const start = chat.createStartSessionAction("fake-chat");

    await start({ chatId: "chat-1" });

    expect(capturedPin).toBe("from-env");
  });

  it("prefers the per-call id over the action default", async () => {
    const start = chat.createStartSessionAction("fake-chat", {
      triggerConfig: { externalDeploymentId: "action-default" },
    });

    await start({ chatId: "chat-1", triggerConfig: { externalDeploymentId: "per-call" } });

    expect(capturedPin).toBe("per-call");
  });

  it("prefers the action default over the environment", async () => {
    process.env.TRIGGER_EXTERNAL_DEPLOYMENT_ID = "from-env";
    const start = chat.createStartSessionAction("fake-chat", {
      triggerConfig: { externalDeploymentId: "action-default" },
    });

    await start({ chatId: "chat-1" });

    expect(capturedPin).toBe("action-default");
  });

  it("honours a per-call null opt-out over a pinning action default", async () => {
    const start = chat.createStartSessionAction("fake-chat", {
      triggerConfig: { externalDeploymentId: "action-default" },
    });

    await start({ chatId: "chat-1", triggerConfig: { externalDeploymentId: null } });

    expect(capturedPin).toBeUndefined();
  });

  it("still resolves inside an apiClient-scoped action", async () => {
    // `apiClient` re-enters via `runWithConfig`, which inherits context — so env discovery
    // must survive the scope rather than being suppressed like it is for `new TriggerClient`.
    process.env.TRIGGER_EXTERNAL_DEPLOYMENT_ID = "from-env";
    const start = chat.createStartSessionAction("fake-chat", {
      apiClient: { baseURL: "https://scoped.invalid", accessToken: "tr_scoped_secret" },
    });

    await start({ chatId: "chat-1" });

    expect(capturedPin).toBe("from-env");
  });

  it("carries an id set on the scoped apiClient config", async () => {
    const start = chat.createStartSessionAction("fake-chat", {
      apiClient: {
        baseURL: "https://scoped.invalid",
        accessToken: "tr_scoped_secret",
        externalDeploymentId: "from-scoped-config",
      },
    });

    await start({ chatId: "chat-1" });

    expect(capturedPin).toBe("from-scoped-config");
  });
});
