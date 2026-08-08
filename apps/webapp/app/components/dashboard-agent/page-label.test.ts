import { describe, expect, it } from "vitest";
import { agentPageLabel, pageLabelFromPath } from "./page-label";

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
