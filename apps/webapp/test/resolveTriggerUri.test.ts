import { formatTriggerUri } from "@internal/dashboard-agent-contracts";
import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { describe, expect, it, vi } from "vitest";
import { resolveTriggerUri, type TriggerUriScope } from "~/services/resolveTriggerUri.server";
import { seedAgentWorld, type AgentWorld } from "./helpers/dashboardAgentWorld";
const db = vi.hoisted(() => ({ client: null as unknown as PrismaClient }));

vi.mock("~/db.server", () => ({
  get prisma() {
    return db.client;
  },
  get $replica() {
    return db.client;
  },
}));

import { resolveTriggerUrisInOrganization } from "~/services/resolveTriggerUriInOrganization.server";
import {
  v3DeploymentVersionPath,
  v3ErrorPath,
  v3QueuesPath,
  v3RunPath,
  v3RunSpanPath,
} from "~/utils/pathBuilder";

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

describe("resolveTriggerUri: source URIs", () => {
  const sha = "a".repeat(40);
  const sourceUri = (path: string, line?: number) =>
    formatTriggerUri({
      kind: "source",
      ...uriScope,
      sha,
      path,
      ...(line === undefined ? {} : { line }),
    });
  const withRepo = (repository: TriggerUriScope["repository"]): TriggerUriScope => ({
    ...scope,
    repository,
  });

  it("opens the GitHub blob at the pinned commit, with the line", () => {
    expect(
      resolveTriggerUri(
        withRepo({ fullName: "acme/orders" }),
        sourceUri("src/tasks/send-order-receipt.ts", 42)
      )
    ).toEqual({
      label: "src/tasks/send-order-receipt.ts:42",
      url: `https://github.com/acme/orders/blob/${sha}/src/tasks/send-order-receipt.ts#L42`,
      external: true,
    });
  });

  it("omits the line fragment when there is no line, and encodes each path segment", () => {
    expect(
      resolveTriggerUri(withRepo({ fullName: "acme/orders" }), sourceUri("src/some dir/a file.ts"))
        ?.url
    ).toBe(`https://github.com/acme/orders/blob/${sha}/src/some%20dir/a%20file.ts`);
  });

  it("accepts a deployment's git remote however it was written", () => {
    const expected = `https://github.com/acme/orders/blob/${sha}/src/a.ts`;
    for (const remoteUrl of [
      "https://github.com/acme/orders.git",
      "git@github.com:acme/orders.git",
      "ssh://git@github.com/acme/orders",
      "https://x-access-token:secret@github.com/acme/orders.git",
    ]) {
      expect(resolveTriggerUri(withRepo({ remoteUrl }), sourceUri("src/a.ts"))?.url).toBe(expected);
    }
  });

  it("returns null rather than guessing when there's no repository to open", () => {
    expect(resolveTriggerUri(scope, sourceUri("src/a.ts"))).toBeNull();
    expect(resolveTriggerUri(withRepo(null), sourceUri("src/a.ts"))).toBeNull();
    expect(resolveTriggerUri(withRepo({ fullName: "" }), sourceUri("src/a.ts"))).toBeNull();
    expect(
      resolveTriggerUri(
        withRepo({ remoteUrl: "https://gitlab.com/acme/orders" }),
        sourceUri("src/a.ts")
      )
    ).toBeNull();
    expect(
      resolveTriggerUri(withRepo({ remoteUrl: "https://github.com/acme" }), sourceUri("src/a.ts"))
    ).toBeNull();
    expect(
      resolveTriggerUri(withRepo({ fullName: "acme/orders/extra" }), sourceUri("src/a.ts"))
    ).toBeNull();
  });

  it("still refuses a source URI from another project or environment", () => {
    expect(
      resolveTriggerUri(
        withRepo({ fullName: "acme/orders" }),
        formatTriggerUri({
          kind: "source",
          projectRef: "proj_somethingelse",
          environmentId: scope.id,
          sha,
          path: "src/a.ts",
        })
      )
    ).toBeNull();
  });
});

// Live Postgres, no mocks beyond `db.server` (pointed at the container's client): the
// organization scope, membership join and dev-environment ownership rules are real.
describe("resolveTriggerUrisInOrganization", () => {
  vi.setConfig({ testTimeout: 60_000 });

  const runUri = (project: { externalRef: string }, environment: { id: string }) =>
    formatTriggerUri({
      kind: "run",
      projectRef: project.externalRef,
      environmentId: environment.id,
      runId: "run_abc123",
    });

  /** A fresh world per case: each container test gets its own cloned database. */
  function worldTest(name: string, fn: (world: AgentWorld) => Promise<void>) {
    postgresTest(name, async ({ prisma }) => {
      db.client = prisma;
      await fn(await seedAgentWorld(prisma));
    });
  }

  worldTest("resolves another project in the same organization", async (world) => {
    const uri = runUri(world.p2, world.p2Prod);
    const resolved = await resolveTriggerUrisInOrganization(world.actor, [uri]);

    expect(resolved.get(uri)).toEqual({
      label: "run_abc123",
      url: v3RunPath(world.orgA, world.p2, world.p2Prod, { friendlyId: "run_abc123" }),
    });
  });

  worldTest("resolves the actor's own development environment", async (world) => {
    const uri = runUri(world.p1, world.p1Dev);
    const resolved = await resolveTriggerUrisInOrganization(world.actor, [uri]);

    expect(resolved.get(uri)?.url).toBe(
      v3RunPath(world.orgA, world.p1, world.p1Dev, { friendlyId: "run_abc123" })
    );
  });

  // Each of these is its own gate: another member's private dev environment, a soft-deleted
  // project, a non-member, an archived environment, a soft-deleted organization, the
  // organization boundary, and a URI whose two halves name different projects.
  const refused: Array<
    [
      string,
      (world: AgentWorld) => { actor: { userId: string; organizationId: string }; uri: string },
    ]
  > = [
    [
      "another member's development environment",
      (w) => ({ actor: w.actor, uri: runUri(w.p2, w.p2Dev) }),
    ],
    [
      "a deleted project",
      (w) => ({ actor: w.actor, uri: runUri(w.deletedProject, w.deletedProd) }),
    ],
    [
      "a user who is not a member of the organization",
      (w) => ({ actor: w.stranger, uri: runUri(w.p2, w.p2Prod) }),
    ],
    ["an archived environment", (w) => ({ actor: w.actor, uri: runUri(w.p2, w.p2Archived) })],
    ["a deleted organization", (w) => ({ actor: w.deletedOrgActor, uri: runUri(w.p4, w.p4Prod) })],
    ["another organization's project", (w) => ({ actor: w.actor, uri: runUri(w.p3, w.p3Prod) })],
    [
      "a URI whose project and environment disagree",
      (w) => ({ actor: w.actor, uri: runUri(w.p1, w.p2Prod) }),
    ],
  ];

  for (const [what, pick] of refused) {
    worldTest(`refuses ${what}`, async (world) => {
      const { actor, uri } = pick(world);
      const resolved = await resolveTriggerUrisInOrganization(actor, [uri]);

      expect(resolved.get(uri)).toBeNull();
    });
  }

  worldTest("returns an entry per URI, malformed ones included", async (world) => {
    const good = runUri(world.p2, world.p2Prod);
    const resolved = await resolveTriggerUrisInOrganization(world.actor, [good, "not-a-uri", ""]);

    expect(resolved.get(good)).not.toBeNull();
    expect(resolved.get("not-a-uri")).toBeNull();
    expect(resolved.get("")).toBeNull();
  });
});
