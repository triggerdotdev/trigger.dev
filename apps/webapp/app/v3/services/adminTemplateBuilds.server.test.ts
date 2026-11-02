import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { postgresTest } from "@internal/testcontainers";
import { CURRENT_DEPLOYMENT_LABEL } from "@trigger.dev/core/v3/isomorphic";
import { describe, expect, it, vi } from "vitest";
import {
  adminTemplateBuilds,
  TemplateBuildsBodySchema,
  templateBuildStream,
} from "./adminTemplateBuilds.server";
import { selectTemplateBuildDeployments } from "./templateBuildSelection.server";
import { TemplatePrebuildService } from "./templatePrebuild.server";

vi.setConfig({ testTimeout: 60_000 });

const TEMPLATE_KEY = "0123456789abcdef".repeat(4);
const PINNED = `registry.example.com/proj_abc:1.prod@sha256:${"a".repeat(64)}`;

type EnvType = "PRODUCTION" | "STAGING" | "PREVIEW" | "DEVELOPMENT";

async function createOrg(prisma: any) {
  const slug = randomUUID();
  return prisma.organization.create({ data: { title: "Org", slug } });
}

async function createProject(prisma: any, organizationId: string) {
  const ref = `proj_${randomUUID()}`;
  return prisma.project.create({
    data: { name: ref, slug: ref, externalRef: ref, organizationId },
  });
}

async function createEnvironment(
  prisma: any,
  project: { id: string; organizationId: string },
  type: EnvType,
  options: { archived?: boolean } = {}
) {
  const id = randomUUID();
  return prisma.runtimeEnvironment.create({
    data: {
      slug: `${type.toLowerCase()}-${id}`,
      type,
      apiKey: id,
      pkApiKey: id,
      shortcode: id,
      projectId: project.id,
      organizationId: project.organizationId,
      archivedAt: options.archived ? new Date() : undefined,
    },
  });
}

let createdAtSeconds = 0;

async function createDeployment(
  prisma: any,
  environment: { id: string; projectId: string },
  options: {
    status?: "DEPLOYED" | "FAILED";
    current?: boolean;
    imageReference?: string | null;
    templateKey?: string;
  } = {}
) {
  const id = randomUUID();
  const deployment = await prisma.workerDeployment.create({
    data: {
      friendlyId: `deployment_${id}`,
      shortCode: id.slice(0, 8),
      contentHash: id,
      version: id,
      projectId: environment.projectId,
      environmentId: environment.id,
      status: options.status ?? "DEPLOYED",
      imageReference: options.imageReference === undefined ? PINNED : options.imageReference,
      templateKey: options.templateKey,
      // Strictly increasing, so "newest" is well defined within a test.
      createdAt: new Date(Date.UTC(2026, 0, 1) + ++createdAtSeconds * 1000),
    },
  });
  if (options.current) {
    await prisma.workerDeploymentPromotion.upsert({
      where: {
        environmentId_label: { environmentId: environment.id, label: CURRENT_DEPLOYMENT_LABEL },
      },
      create: {
        deploymentId: deployment.id,
        environmentId: environment.id,
        label: CURRENT_DEPLOYMENT_LABEL,
      },
      update: { deploymentId: deployment.id },
    });
  }
  return deployment;
}

/** An org with one project carrying each environment type, each with a current deployment. */
async function seedOrg(prisma: any) {
  const org = await createOrg(prisma);
  const project = await createProject(prisma, org.id);
  const envs = {
    prod: await createEnvironment(prisma, project, "PRODUCTION"),
    staging: await createEnvironment(prisma, project, "STAGING"),
    preview: await createEnvironment(prisma, project, "PREVIEW"),
    dev: await createEnvironment(prisma, project, "DEVELOPMENT"),
  };
  const current = {
    prod: await createDeployment(prisma, envs.prod, { current: true }),
    staging: await createDeployment(prisma, envs.staging, { current: true }),
    preview: await createDeployment(prisma, envs.preview, { current: true }),
    dev: await createDeployment(prisma, envs.dev, { current: true }),
  };
  return { org, project, envs, current };
}

async function builder() {
  let calls = 0;
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      calls++;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ template_id: TEMPLATE_KEY }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    calls: () => calls,
    close: () => {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function service(prisma: any, url: string) {
  return new TemplatePrebuildService(prisma, {
    url,
    timeoutMs: 5_000,
    presets: ["small-1x"],
    shadowRolloutPct: 0,
    mixedRuntimeWorkerGroups: [],
  });
}

function ids(selection: Awaited<ReturnType<typeof selectTemplateBuildDeployments>>) {
  if (!selection.ok) throw new Error(selection.error);
  return selection.deployments;
}

describe("selectTemplateBuildDeployments", () => {
  postgresTest("picks each non-dev environment's current deployment", async ({ prisma }) => {
    const { org, current, envs } = await seedOrg(prisma);
    // An older deployment and an archived environment are not picked.
    await createDeployment(prisma, envs.prod);
    const archived = await createEnvironment(
      prisma,
      { id: envs.prod.projectId, organizationId: org.id },
      "PRODUCTION",
      { archived: true }
    );
    await createDeployment(prisma, archived, { current: true });

    const byId = ids(await selectTemplateBuildDeployments(prisma, { organizationId: org.id }));
    const bySlug = ids(
      await selectTemplateBuildDeployments(prisma, { organizationSlug: org.slug })
    );

    expect(byId).toEqual([
      { deploymentId: current.prod.id, current: true },
      { deploymentId: current.staging.id, current: true },
      { deploymentId: current.preview.id, current: true },
    ]);
    expect(bySlug).toEqual(byId);
  });

  postgresTest("narrows to the given environment types", async ({ prisma }) => {
    const { org, current } = await seedOrg(prisma);

    const selected = ids(
      await selectTemplateBuildDeployments(prisma, {
        organizationId: org.id,
        environmentTypes: ["DEVELOPMENT", "STAGING"],
      })
    );

    expect(selected.map((d) => d.deploymentId).sort()).toEqual(
      [current.staging.id, current.dev.id].sort()
    );
  });

  postgresTest("narrows to one project by id or ref", async ({ prisma }) => {
    const { org, project, current } = await seedOrg(prisma);
    const other = await createProject(prisma, org.id);
    const otherProd = await createEnvironment(prisma, other, "PRODUCTION");
    const otherCurrent = await createDeployment(prisma, otherProd, { current: true });

    const all = ids(await selectTemplateBuildDeployments(prisma, { organizationId: org.id }));
    const byRef = ids(
      await selectTemplateBuildDeployments(prisma, {
        organizationId: org.id,
        projectRef: other.externalRef,
        environmentTypes: ["PRODUCTION"],
      })
    );
    const byId = ids(
      await selectTemplateBuildDeployments(prisma, {
        organizationId: org.id,
        projectId: project.id,
        environmentTypes: ["PRODUCTION"],
      })
    );

    expect(all).toHaveLength(4);
    expect(byRef).toEqual([{ deploymentId: otherCurrent.id, current: true }]);
    expect(byId).toEqual([{ deploymentId: current.prod.id, current: true }]);
  });

  postgresTest(
    "adds the newest other deployed deployments with includeRecent",
    async ({ prisma }) => {
      const { org, envs } = await seedOrg(prisma);
      const oldest = await createDeployment(prisma, envs.prod);
      const older = await createDeployment(prisma, envs.prod);
      await createDeployment(prisma, envs.prod, { status: "FAILED" });
      const current = await createDeployment(prisma, envs.prod, { current: true });
      // A deployment newer than the current one (a rollback) still counts as recent.
      const newer = await createDeployment(prisma, envs.prod);

      const two = ids(
        await selectTemplateBuildDeployments(prisma, {
          organizationId: org.id,
          environmentTypes: ["PRODUCTION"],
          includeRecent: 2,
        })
      );
      const all = ids(
        await selectTemplateBuildDeployments(prisma, {
          organizationId: org.id,
          environmentTypes: ["PRODUCTION"],
          includeRecent: 10,
        })
      );

      expect(two).toEqual([
        { deploymentId: current.id, current: true },
        { deploymentId: newer.id, current: false },
        { deploymentId: older.id, current: false },
      ]);
      // The seeded first deployment was replaced as current, so it is a rollback target too.
      expect(all.map((d) => d.deploymentId)).toContain(oldest.id);
      expect(all.filter((d) => d.current)).toEqual([{ deploymentId: current.id, current: true }]);
      expect(all).toHaveLength(5);
    }
  );

  postgresTest("reports an unknown organization or project", async ({ prisma }) => {
    const { org } = await seedOrg(prisma);
    const otherOrg = await createOrg(prisma);
    const foreign = await createProject(prisma, otherOrg.id);

    expect(await selectTemplateBuildDeployments(prisma, { organizationId: "org_missing" })).toEqual(
      { ok: false, error: "organization_not_found" }
    );
    expect(
      await selectTemplateBuildDeployments(prisma, {
        organizationId: org.id,
        projectRef: foreign.externalRef,
      })
    ).toEqual({ ok: false, error: "project_not_found" });
  });
});

describe("TemplateBuildsBodySchema", () => {
  it("defaults wait to true and force to false", () => {
    expect(TemplateBuildsBodySchema.parse({ deploymentIds: ["abc"] })).toEqual({
      deploymentIds: ["abc"],
      force: false,
      wait: true,
    });
  });

  it.each([
    ["neither ids nor an organization", {}],
    ["both ids and an organization", { deploymentIds: ["abc"], organizationId: "org" }],
    ["both organization fields", { organizationId: "org", organizationSlug: "slug" }],
    ["both project fields", { organizationId: "org", projectId: "p", projectRef: "proj_x" }],
    ["selector fields with ids", { deploymentIds: ["abc"], environmentTypes: ["PRODUCTION"] }],
    ["an unknown field", { organizationId: "org", environmentType: "PRODUCTION" }],
    ["an unknown environment type", { organizationId: "org", environmentTypes: ["PROD"] }],
  ])("rejects %s", (_name, body) => {
    expect(TemplateBuildsBodySchema.safeParse(body).success).toBe(false);
  });
});

describe("adminTemplateBuilds", () => {
  postgresTest("returns JSON results without wait", async ({ prisma }) => {
    const server = await builder();
    try {
      const { org, project, current, envs } = await seedOrg(prisma);
      const recent = await createDeployment(prisma, envs.prod);
      await prisma.workerDeployment.update({
        where: { id: current.staging.id },
        data: { templateKey: "b".repeat(64) },
      });
      await prisma.workerDeployment.update({
        where: { id: current.preview.id },
        data: { imageReference: "registry.example.com/proj_abc:1.prev" },
      });

      const response = await adminTemplateBuilds(
        TemplateBuildsBodySchema.parse({ organizationId: org.id, includeRecent: 1, wait: false }),
        { prisma, service: service(prisma, server.url) }
      );

      expect(response.headers.get("Content-Type")).toContain("application/json");
      const { results } = await response.json();
      const common = { projectRef: project.externalRef };
      expect(results).toEqual([
        {
          deploymentId: current.prod.id,
          friendlyId: current.prod.friendlyId,
          shortCode: current.prod.shortCode,
          environmentType: "PRODUCTION",
          ...common,
          current: true,
          outcome: "built",
          templateKey: TEMPLATE_KEY,
        },
        {
          deploymentId: recent.id,
          friendlyId: recent.friendlyId,
          shortCode: recent.shortCode,
          environmentType: "PRODUCTION",
          ...common,
          current: false,
          outcome: "built",
          templateKey: TEMPLATE_KEY,
        },
        {
          deploymentId: current.staging.id,
          friendlyId: current.staging.friendlyId,
          shortCode: current.staging.shortCode,
          environmentType: "STAGING",
          ...common,
          current: true,
          outcome: "skipped",
          reason: "has_key",
          templateKey: "b".repeat(64),
        },
        {
          deploymentId: current.preview.id,
          friendlyId: current.preview.friendlyId,
          shortCode: current.preview.shortCode,
          environmentType: "PREVIEW",
          ...common,
          current: true,
          outcome: "skipped",
          reason: "no_pinned_image",
        },
      ]);
      expect(server.calls()).toBe(2);
    } finally {
      await server.close();
    }
  });

  postgresTest(
    "streams each result and then all of them with wait, by deployment id",
    async ({ prisma }) => {
      const server = await builder();
      try {
        const { current } = await seedOrg(prisma);

        const response = await adminTemplateBuilds(
          TemplateBuildsBodySchema.parse({
            deploymentIds: [current.prod.shortCode, current.staging.friendlyId],
          }),
          { prisma, service: service(prisma, server.url), waitTimeoutMs: 5_000 }
        );

        expect(response.headers.get("Content-Type")).toBe("application/x-ndjson");
        const lines = (await response.text())
          .split("\n")
          .filter((line) => line.trim() !== "")
          .map((line) => JSON.parse(line));
        expect(lines).toHaveLength(3);
        const final = lines[2].results;
        expect(final.map((r: any) => [r.deploymentId, r.outcome, r.templateKey])).toEqual([
          [current.prod.shortCode, "built", TEMPLATE_KEY],
          [current.staging.friendlyId, "built", TEMPLATE_KEY],
        ]);
        // No `current` flag without a selector, as before.
        expect(final[0]).not.toHaveProperty("current");
        expect(lines.slice(0, 2).map((l) => l.result)).toEqual(expect.arrayContaining(final));
      } finally {
        await server.close();
      }
    }
  );

  postgresTest("answers 404 for an unknown organization", async ({ prisma }) => {
    const response = await adminTemplateBuilds(
      TemplateBuildsBodySchema.parse({ organizationSlug: "missing" }),
      { prisma, service: service(prisma, "http://127.0.0.1:1") }
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "organization_not_found" });
  });
});

describe("templateBuildStream", () => {
  it("sends blank heartbeat lines while the builds run", async () => {
    let finish: (value: number[]) => void = () => {};
    const response = templateBuildStream<number>(
      () => new Promise<number[]>((resolve) => (finish = resolve)),
      10
    );
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();

    const { value } = await reader.read();
    expect(decoder.decode(value)).toBe("\n");

    finish([1]);
    let rest = "";
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      rest += decoder.decode(chunk.value);
    }
    expect(rest.trim()).toBe(JSON.stringify({ results: [1] }));
  });

  it("ends with an error line when the run throws", async () => {
    const response = templateBuildStream<number>(async () => {
      throw new Error("db down");
    });

    expect((await response.text()).trim()).toBe(JSON.stringify({ error: "Internal server error" }));
  });
});
