import { describe, expect, it } from "vitest";
import type { AgentPage } from "./page-context-types";
import {
  agentPageEntityId,
  agentPageLabel,
  entityIdFromPath,
  pageLabelFromPath,
} from "./page-label";

const envRoot = "/orgs/acme-1234/projects/hello-world-ab12/env/dev";

describe("pageLabelFromPath", () => {
  it("labels the env root as Overview", () => {
    expect(pageLabelFromPath(envRoot)).toBe("Overview");
    expect(pageLabelFromPath(`${envRoot}/`)).toBe("Overview");
  });

  it("labels known env sections", () => {
    expect(pageLabelFromPath(`${envRoot}/runs`)).toBe("Runs");
    expect(pageLabelFromPath(`${envRoot}/queues`)).toBe("Queues");
    expect(pageLabelFromPath(`${envRoot}/deployments`)).toBe("Deployments");
    expect(pageLabelFromPath(`${envRoot}/environment-variables`)).toBe("Environment variables");
    expect(pageLabelFromPath(`${envRoot}/apikeys`)).toBe("API keys");
  });

  it("labels a detail path by its section", () => {
    expect(pageLabelFromPath(`${envRoot}/runs/run_abc123`)).toBe("Runs");
    expect(pageLabelFromPath(`${envRoot}/errors/deadbeef`)).toBe("Errors");
  });

  it("prettifies unknown sections instead of showing a raw slug", () => {
    expect(pageLabelFromPath(`${envRoot}/some-new-thing`)).toBe("Some new thing");
  });

  it("reads the section past a preview branch named like a path marker", () => {
    const branchRoot = "/orgs/acme-1234/projects/hello-world-ab12/env";

    expect(pageLabelFromPath(`${branchRoot}/env/runs`)).toBe("Runs");
    expect(pageLabelFromPath(`${branchRoot}/env/runs/run_abc123`)).toBe("Runs");
    expect(pageLabelFromPath(`${branchRoot}/env/environment-variables`)).toBe(
      "Environment variables"
    );
    expect(pageLabelFromPath(`${branchRoot}/env`)).toBe("Overview");
    expect(pageLabelFromPath(`${branchRoot}/projects/queues`)).toBe("Queues");
  });

  it("falls back to the last segment outside an env path", () => {
    expect(pageLabelFromPath("/orgs/acme-1234/settings/members")).toBe("Members");
    expect(pageLabelFromPath("/account/security")).toBe("Security");
  });

  it("never returns an empty label", () => {
    expect(pageLabelFromPath("/")).toBe("Dashboard");
    expect(pageLabelFromPath("")).toBe("Dashboard");
  });
});

describe("agentPageLabel", () => {
  it("prefers the structured page kind", () => {
    expect(agentPageLabel({ page: { kind: "runs" }, signals: [] }, `${envRoot}/anything`)).toBe(
      "Runs"
    );
    expect(
      agentPageLabel(
        { page: { kind: "run", runId: "run_abc", status: "FAILED", taskId: "t" }, signals: [] },
        `${envRoot}/runs/run_abc`
      )
    ).toBe("Run detail");
    expect(agentPageLabel({ page: { kind: "queue", name: "default" }, signals: [] }, envRoot)).toBe(
      "Queue detail"
    );
    expect(
      agentPageLabel({ page: { kind: "deployment", version: "20240101.1" }, signals: [] }, envRoot)
    ).toBe("Deployment detail");
    expect(
      agentPageLabel({ page: { kind: "error", fingerprint: "abc" }, signals: [] }, envRoot)
    ).toBe("Error detail");
  });

  it("falls back to the path an unclassified page carries", () => {
    expect(
      agentPageLabel({ page: { kind: "other", path: `${envRoot}/queues` }, signals: [] }, "/")
    ).toBe("Queues");
  });

  it("falls back to the location with no page context at all", () => {
    expect(agentPageLabel(undefined, `${envRoot}/schedules`)).toBe("Schedules");
  });
});

describe("agentPageEntityId", () => {
  const at = (page: AgentPage) => agentPageEntityId({ page, signals: [] }, envRoot);

  it("names the entity a detail page is about", () => {
    expect(at({ kind: "run", runId: "run_abc123", status: "COMPLETED", taskId: "my-task" })).toBe(
      "run_abc123"
    );
    expect(at({ kind: "error", fingerprint: "deadbeef" })).toBe("deadbeef");
    expect(at({ kind: "queue", name: "default" })).toBe("default");
    expect(at({ kind: "deployment", version: "20240101.1" })).toBe("20240101.1");
    expect(at({ kind: "task", taskId: "my-task" })).toBe("my-task");
    expect(at({ kind: "schedule", scheduleId: "sched_1", taskId: "my-task" })).toBe("sched_1");
    expect(at({ kind: "batch", batchId: "batch_9" })).toBe("batch_9");
  });

  it("names it on the kinds that double as a list, only once one is selected", () => {
    expect(at({ kind: "waitpoints" })).toBeUndefined();
    expect(at({ kind: "waitpoints", tokenId: "waitpoint_1" })).toBe("waitpoint_1");
    expect(at({ kind: "bulkactions" })).toBeUndefined();
    expect(at({ kind: "bulkactions", bulkActionId: "bulk_1" })).toBe("bulk_1");
    expect(at({ kind: "sessions", sessionId: "sess_1" })).toBe("sess_1");
    expect(at({ kind: "prompts", slug: "summarize" })).toBe("summarize");
  });

  it("has nothing to name on a list or overview page", () => {
    expect(at({ kind: "runs" })).toBeUndefined();
    expect(at({ kind: "queues" })).toBeUndefined();
    expect(at({ kind: "deployments" })).toBeUndefined();
    expect(at({ kind: "tasks" })).toBeUndefined();
    expect(at({ kind: "settings" })).toBeUndefined();
  });

  it("prefers the page's own subject over an id it merely mentions", () => {
    // The run, not its task; the list, not the failure it points at.
    expect(at({ kind: "run", runId: "run_abc123", status: "FAILED", taskId: "my-task" })).toBe(
      "run_abc123"
    );
    expect(at({ kind: "batches", latestFailedBatchId: "batch_9" })).toBeUndefined();
  });

  it("falls back to the path for an unclassified page", () => {
    expect(
      agentPageEntityId({ page: { kind: "other", path: "" }, signals: [] }, `${envRoot}/runs/run_x`)
    ).toBe("run_x");
    expect(
      agentPageEntityId(
        { page: { kind: "other", path: `${envRoot}/queues/default` }, signals: [] },
        "/"
      )
    ).toBe("default");
  });

  it("falls back to the path with no page context at all", () => {
    expect(agentPageEntityId(undefined, `${envRoot}/deployments/20240101.1`)).toBe("20240101.1");
    expect(agentPageEntityId(undefined, `${envRoot}/runs`)).toBeUndefined();
  });
});

describe("entityIdFromPath", () => {
  it("reads the segment after the section", () => {
    expect(entityIdFromPath(`${envRoot}/runs/run_abc123`)).toBe("run_abc123");
    expect(entityIdFromPath(`${envRoot}/runs/run_abc123/spans/span_1`)).toBe("run_abc123");
  });

  it("reads past a preview branch named like a path marker", () => {
    const branchRoot = "/orgs/acme-1234/projects/hello-world-ab12/env";
    expect(entityIdFromPath(`${branchRoot}/env/runs/run_abc123`)).toBe("run_abc123");
    expect(entityIdFromPath(`${branchRoot}/env/runs`)).toBeUndefined();
  });

  it("has nothing to read on a list, the env root, or a path outside an environment", () => {
    expect(entityIdFromPath(`${envRoot}/runs`)).toBeUndefined();
    expect(entityIdFromPath(envRoot)).toBeUndefined();
    expect(entityIdFromPath(`${envRoot}/`)).toBeUndefined();
    expect(entityIdFromPath("/orgs/acme-1234/settings/members")).toBeUndefined();
    expect(entityIdFromPath("/account/security")).toBeUndefined();
    expect(entityIdFromPath("/")).toBeUndefined();
  });
});
