import { formatTriggerUri } from "@internal/dashboard-agent-contracts";
import { describe, expect, it } from "vitest";
import { resolveTriggerUri, type TriggerUriScope } from "~/services/resolveTriggerUri.server";
import {
  v3DeploymentVersionPath,
  v3ErrorPath,
  v3QueuesPath,
  v3RunPath,
  v3RunSpanPath,
} from "~/utils/pathBuilder";

// The scope a URI is read against — the same shape an AuthenticatedEnvironment has.
const scope: TriggerUriScope = {
  id: "env_1234",
  slug: "prod",
  project: { slug: "my-project-abcd", externalRef: "proj_abcdefghijklmnop" },
  organization: { slug: "my-org-1234" },
};

const org = scope.organization;
const project = scope.project;
const env = { slug: scope.slug };

const uriScope = { projectRef: project.externalRef, environmentId: scope.id };

describe("resolveTriggerUri", () => {
  it("resolves a run", () => {
    const uri = formatTriggerUri({ kind: "run", ...uriScope, runId: "run_abc123" });
    expect(resolveTriggerUri(scope, uri)).toEqual({
      label: "run_abc123",
      url: v3RunPath(org, project, env, { friendlyId: "run_abc123" }),
    });
  });

  it("resolves a span to its run page with the span selected", () => {
    const uri = formatTriggerUri({
      kind: "span",
      ...uriScope,
      runId: "run_abc123",
      spanId: "span_xyz",
    });
    const resolved = resolveTriggerUri(scope, uri);
    expect(resolved).toEqual({
      label: "run_abc123 (span_xyz)",
      url: v3RunSpanPath(org, project, env, { friendlyId: "run_abc123" }, { spanId: "span_xyz" }),
    });
    expect(resolved!.url).toContain("span=span_xyz");
  });

  it("resolves an error group by fingerprint", () => {
    const uri = formatTriggerUri({ kind: "error", ...uriScope, fingerprint: "error_5a1c73" });
    expect(resolveTriggerUri(scope, uri)).toEqual({
      label: "error_5a1c73",
      url: v3ErrorPath(org, project, env, { fingerprint: "error_5a1c73" }),
    });
  });

  it("resolves a queue to the queues list filtered to its name", () => {
    // A URI carries the rename-stable queue NAME; the detail route is keyed by
    // friendlyId, so the filtered list is the target that needs no lookup.
    const uri = formatTriggerUri({ kind: "queue", ...uriScope, name: "task/send email" });
    expect(resolveTriggerUri(scope, uri)).toEqual({
      label: "task/send email",
      url: `${v3QueuesPath(org, project, env)}?query=task%2Fsend%20email`,
    });
  });

  it("resolves a deployment by version", () => {
    const uri = formatTriggerUri({ kind: "deployment", ...uriScope, version: "20260726.4" });
    expect(resolveTriggerUri(scope, uri)).toEqual({
      label: "20260726.4",
      url: v3DeploymentVersionPath(org, project, env, "20260726.4"),
    });
  });

  it("returns null for kinds with no dashboard page yet", () => {
    expect(
      resolveTriggerUri(scope, formatTriggerUri({ kind: "report", ...uriScope, key: "health" }))
    ).toBeNull();
    expect(
      resolveTriggerUri(
        scope,
        formatTriggerUri({ kind: "source", ...uriScope, sha: "abc123", path: "src/a.ts", line: 4 })
      )
    ).toBeNull();
    expect(
      resolveTriggerUri(
        scope,
        formatTriggerUri({ kind: "investigation", ...uriScope, investigationId: "inv_1" })
      )
    ).toBeNull();
  });

  it("percent-decodes a segment before putting it in a path", () => {
    const uri = formatTriggerUri({ kind: "deployment", ...uriScope, version: "2026.1+beta" });
    expect(uri).toContain("2026.1%2Bbeta");
    expect(resolveTriggerUri(scope, uri)!.label).toBe("2026.1+beta");
  });

  it("refuses a URI from another project or environment", () => {
    const otherProject = formatTriggerUri({
      kind: "run",
      projectRef: "proj_somethingelse",
      environmentId: scope.id,
      runId: "run_abc123",
    });
    const otherEnvironment = formatTriggerUri({
      kind: "run",
      projectRef: project.externalRef,
      environmentId: "env_other",
      runId: "run_abc123",
    });
    expect(resolveTriggerUri(scope, otherProject)).toBeNull();
    expect(resolveTriggerUri(scope, otherEnvironment)).toBeNull();
  });

  it("returns null instead of throwing on anything malformed", () => {
    expect(resolveTriggerUri(scope, "")).toBeNull();
    expect(resolveTriggerUri(scope, "https://cloud.trigger.dev/runs/run_abc")).toBeNull();
    expect(resolveTriggerUri(scope, "trigger://proj_a/env_1234/teapot/x")).toBeNull();
    expect(resolveTriggerUri(scope, "trigger://proj_abcdefghijklmnop/env_1234/run")).toBeNull();
  });
});
