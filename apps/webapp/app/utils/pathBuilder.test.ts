import { describe, expect, test } from "vitest";
import { resolveAlertDraftPrefill } from "~/v3/services/alerts/createAlertFromDraft.server";
import { v3AlertCreatePath } from "./pathBuilder";

const org = { slug: "org" };
const project = { slug: "project" };
const environment = { slug: "dev" };

describe("v3AlertCreatePath", () => {
  test("builds the alerts path with create=1 and no prefill", () => {
    const path = v3AlertCreatePath(org, project, environment);
    const url = new URL(path, "http://test");
    expect(url.pathname).toBe("/orgs/org/projects/project/env/dev/alerts");
    expect(url.searchParams.get("create")).toBe("1");
  });

  test("encodes capability, scope, and scopeValue as query params", () => {
    const path = v3AlertCreatePath(org, project, environment, {
      capability: "queue.depth",
      scope: "queue",
      scopeValue: "my-queue",
    });

    const url = new URL(path, "http://test");
    expect(url.pathname).toBe("/orgs/org/projects/project/env/dev/alerts");
    expect(url.searchParams.get("create")).toBe("1");
    expect(url.searchParams.get("capability")).toBe("queue.depth");
    expect(url.searchParams.get("scope")).toBe("queue");
    expect(url.searchParams.get("scopeValue")).toBe("my-queue");
  });

  test("round-trips through resolveAlertDraftPrefill", () => {
    const path = v3AlertCreatePath(org, project, environment, {
      capability: "runs.failure_rate",
      scope: "task",
      scopeValue: "my-task",
    });

    const url = new URL(path, "http://test");
    const prefill = resolveAlertDraftPrefill({
      capability: url.searchParams.get("capability") ?? undefined,
      scope: (url.searchParams.get("scope") as "task") ?? undefined,
      scopeValue: url.searchParams.get("scopeValue") ?? undefined,
    });

    expect(prefill).toEqual({
      capabilityKey: "runs.failure_rate",
      scope: { type: "task", taskIdentifier: "my-task" },
    });
  });

  test("round-trips a queue scope through resolveAlertDraftPrefill", () => {
    const path = v3AlertCreatePath(org, project, environment, {
      capability: "queue.depth",
      scope: "queue",
      scopeValue: "my-queue",
    });

    const url = new URL(path, "http://test");
    const prefill = resolveAlertDraftPrefill({
      capability: url.searchParams.get("capability") ?? undefined,
      scope: (url.searchParams.get("scope") as "queue") ?? undefined,
      scopeValue: url.searchParams.get("scopeValue") ?? undefined,
    });

    expect(prefill).toEqual({
      capabilityKey: "queue.depth",
      scope: { type: "queue", queue: "my-queue" },
    });
  });
});
