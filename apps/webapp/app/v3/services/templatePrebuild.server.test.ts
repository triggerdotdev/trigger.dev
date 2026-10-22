import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { postgresTest } from "@internal/testcontainers";
import { describe, expect, it, vi } from "vitest";
import { $transaction } from "~/db.server";
import { FEATURE_FLAG } from "~/v3/featureFlags";
import {
  pinnedImageReference,
  type TemplateBuilderConfig,
  TemplatePrebuildService,
  templateCreateRequest,
  validTemplateKey,
} from "./templatePrebuild.server";

vi.setConfig({ testTimeout: 60_000 });

const DIGEST = `sha256:${"a".repeat(64)}`;
const TEMPLATE_KEY = "0123456789abcdef".repeat(4);
const IMAGE = "registry.example.com/proj_abc:20260101.1.prod";

type Handler = (req: IncomingMessage, body: string, res: ServerResponse) => void;

/** A local stand-in for the template builder that records what it is sent. */
async function builder(handler: Handler) {
  const requests: { auth?: string; body: string }[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      requests.push({ auth: req.headers.authorization, body });
      handler(req, body, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function reply(status: number, body: unknown): Handler {
  return (_req, _body, res) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
}

function config(overrides: Partial<TemplateBuilderConfig> = {}): TemplateBuilderConfig {
  return {
    url: "http://127.0.0.1:1",
    token: "builder-token",
    timeoutMs: 5_000,
    presets: ["small-1x"],
    shadowRolloutPct: 0,
    ...overrides,
  };
}

async function createProject(
  prisma: any,
  options: { workloadType?: "CONTAINER" | "MICROVM"; orgFlags?: Record<string, unknown> } = {}
) {
  const slug = randomUUID();
  const org = await prisma.organization.create({
    data: { title: "Org", slug, featureFlags: options.orgFlags },
  });
  const group = options.workloadType
    ? await prisma.workerInstanceGroup.create({
        data: {
          name: `group-${slug}`,
          masterQueue: `queue-${slug}`,
          type: "MANAGED",
          workloadType: options.workloadType,
          token: { create: { tokenHash: `tok-${slug}` } },
        },
      })
    : undefined;
  return prisma.project.create({
    data: {
      name: `proj-${slug}`,
      slug: `proj-${slug}`,
      externalRef: `proj-${slug}`,
      organizationId: org.id,
      defaultWorkerGroupId: group?.id,
    },
  });
}

async function createDeployment(
  prisma: any,
  project: { id: string; organizationId: string },
  options: {
    status?: "DEPLOYING" | "DEPLOYED";
    imageReference?: string;
    templateKey?: string;
    deployedAt?: Date;
  } = {}
) {
  const id = randomUUID();
  const environment = await prisma.runtimeEnvironment.create({
    data: {
      slug: "prod",
      type: "PRODUCTION",
      apiKey: id,
      pkApiKey: id,
      shortcode: id,
      projectId: project.id,
      organizationId: project.organizationId,
    },
  });
  return prisma.workerDeployment.create({
    data: {
      friendlyId: `deployment_${id}`,
      shortCode: id,
      contentHash: id,
      version: id,
      projectId: project.id,
      environmentId: environment.id,
      status: options.status ?? "DEPLOYING",
      imageReference: options.imageReference ?? IMAGE,
      templateKey: options.templateKey,
      deployedAt: options.deployedAt,
    },
  });
}

async function storedTemplateKey(prisma: any, deploymentId: string) {
  const row = await prisma.workerDeployment.findFirst({
    where: { id: deploymentId },
    select: { templateKey: true },
  });
  return row?.templateKey;
}

describe("pinnedImageReference", () => {
  it("appends a valid digest", () => {
    expect(pinnedImageReference(IMAGE, DIGEST)).toBe(`${IMAGE}@${DIGEST}`);
  });

  it("keeps a reference already pinned by digest", () => {
    expect(pinnedImageReference(`${IMAGE}@${DIGEST}`, undefined)).toBe(`${IMAGE}@${DIGEST}`);
  });

  it("returns undefined without a valid digest", () => {
    expect(pinnedImageReference(IMAGE, undefined)).toBeUndefined();
    expect(pinnedImageReference(IMAGE, "sha256:nothex")).toBeUndefined();
  });
});

describe("templateCreateRequest", () => {
  it("keeps the digest, sets no_snap and maps presets to cpus and memory_mb", () => {
    expect(
      templateCreateRequest(`${IMAGE}@${DIGEST}`, ["small-1x", "medium-1x"], "deployment_abc")
    ).toEqual({
      image: `${IMAGE}@${DIGEST}`,
      machine_configs: [
        { cpus: 0.5, memory_mb: 512 },
        { cpus: 1, memory_mb: 2048 },
      ],
      no_snap: true,
      deployment_id: "deployment_abc",
    });
  });

  it("sends each distinct shape once", () => {
    expect(
      templateCreateRequest(IMAGE, ["small-1x", "small-1x"], "deployment_abc").machine_configs
    ).toEqual([{ cpus: 0.5, memory_mb: 512 }]);
  });
});

describe("validTemplateKey", () => {
  it("accepts 64 lowercase hex characters", () => {
    expect(validTemplateKey(TEMPLATE_KEY)).toBe(TEMPLATE_KEY);
  });

  it("rejects anything else", () => {
    expect(validTemplateKey(undefined)).toBeUndefined();
    expect(validTemplateKey(TEMPLATE_KEY.toUpperCase())).toBeUndefined();
    expect(validTemplateKey(`sha256:${TEMPLATE_KEY}`)).toBeUndefined();
    expect(validTemplateKey(TEMPLATE_KEY.slice(1))).toBeUndefined();
    expect(validTemplateKey(42)).toBeUndefined();
  });
});

describe("resolveMode", () => {
  postgresTest("skips when no builder URL is set", async ({ prisma }) => {
    const project = await createProject(prisma, { workloadType: "MICROVM" });
    const service = new TemplatePrebuildService(prisma, config({ url: undefined }));
    expect(await service.resolveMode(project.id)).toEqual({ mode: "skip", reason: "no-builder" });
  });

  postgresTest("skips a missing project", async ({ prisma }) => {
    const service = new TemplatePrebuildService(prisma, config());
    expect(await service.resolveMode("missing")).toEqual({ mode: "skip", reason: "no-project" });
  });

  postgresTest("shadows a microVM project by default", async ({ prisma }) => {
    const project = await createProject(prisma, { workloadType: "MICROVM" });
    const service = new TemplatePrebuildService(prisma, config());
    expect(await service.resolveMode(project.id)).toEqual({
      mode: "shadow",
      reason: "microvm-native",
    });
  });

  postgresTest("waits when the org flag is on", async ({ prisma }) => {
    const project = await createProject(prisma, {
      workloadType: "MICROVM",
      orgFlags: { [FEATURE_FLAG.computeTemplatePrebuildWait]: true },
    });
    const service = new TemplatePrebuildService(prisma, config());
    expect(await service.resolveMode(project.id)).toEqual({
      mode: "wait",
      reason: "microvm-native",
    });
  });

  postgresTest("shadows an org with compute access", async ({ prisma }) => {
    const project = await createProject(prisma, {
      workloadType: "CONTAINER",
      orgFlags: { [FEATURE_FLAG.hasComputeAccess]: true },
    });
    const service = new TemplatePrebuildService(prisma, config());
    expect(await service.resolveMode(project.id)).toEqual({
      mode: "shadow",
      reason: "compute-access",
    });
  });

  postgresTest("follows the shadow rollout percentage", async ({ prisma }) => {
    const project = await createProject(prisma, { workloadType: "CONTAINER" });
    expect(await new TemplatePrebuildService(prisma, config()).resolveMode(project.id)).toEqual({
      mode: "skip",
      reason: "none",
    });
    expect(
      await new TemplatePrebuildService(prisma, config({ shadowRolloutPct: 100 })).resolveMode(
        project.id
      )
    ).toEqual({ mode: "shadow", reason: "rollout" });
  });

  postgresTest("shadows a rollout-sampled project even with wait on", async ({ prisma }) => {
    const project = await createProject(prisma, {
      workloadType: "CONTAINER",
      orgFlags: { [FEATURE_FLAG.computeTemplatePrebuildWait]: true },
    });
    expect(
      await new TemplatePrebuildService(prisma, config({ shadowRolloutPct: 100 })).resolveMode(
        project.id
      )
    ).toEqual({ mode: "shadow", reason: "rollout" });
  });
});

describe("prebuild", () => {
  // Tests that do not check the template key point at a deployment that does not exist.
  const deployment = {
    deploymentId: "missing",
    deploymentFriendlyId: "deployment_abc",
    imageReference: IMAGE,
  };

  postgresTest("sends the pinned image with the bearer token", async ({ prisma }) => {
    const server = await builder(
      reply(201, { template_id: "a".repeat(64), template_source: "built" })
    );
    try {
      const project = await createProject(prisma, {
        workloadType: "MICROVM",
        orgFlags: { [FEATURE_FLAG.computeTemplatePrebuildWait]: true },
      });
      const service = new TemplatePrebuildService(prisma, config({ url: server.url }));
      const result = await service.prebuild({
        ...deployment,
        projectId: project.id,
        imageDigest: DIGEST,
      });

      expect(result).toEqual({ mode: "wait", reason: "microvm-native", outcome: "built" });
      expect(server.requests).toHaveLength(1);
      expect(server.requests[0].auth).toBe("Bearer builder-token");
      expect(JSON.parse(server.requests[0].body)).toEqual({
        image: `${IMAGE}@${DIGEST}`,
        machine_configs: [{ cpus: 0.5, memory_mb: 512 }],
        no_snap: true,
        deployment_id: "deployment_abc",
      });
    } finally {
      await server.close();
    }
  });

  postgresTest("skips the call when the image has no digest", async ({ prisma }) => {
    const server = await builder(reply(201, {}));
    try {
      const project = await createProject(prisma, { workloadType: "MICROVM" });
      const service = new TemplatePrebuildService(prisma, config({ url: server.url }));
      const result = await service.prebuild({
        ...deployment,
        projectId: project.id,
        imageDigest: undefined,
      });
      expect(result.mode).toBe("skip");
      expect(server.requests).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  postgresTest("does not await the builder in shadow mode", async ({ prisma }) => {
    // Never answers, so prebuild can only return if it does not wait.
    const server = await builder(() => {});
    try {
      const project = await createProject(prisma, { workloadType: "MICROVM" });
      const service = new TemplatePrebuildService(
        prisma,
        config({ url: server.url, timeoutMs: 30_000 })
      );
      const result = await service.prebuild({
        ...deployment,
        projectId: project.id,
        imageDigest: DIGEST,
      });
      expect(result).toEqual({ mode: "shadow", reason: "microvm-native" });
      await vi.waitFor(() => expect(server.requests).toHaveLength(1));
    } finally {
      await server.close();
    }
  });

  postgresTest("carries on after a timeout in wait mode", async ({ prisma }) => {
    const server = await builder(() => {});
    try {
      const project = await createProject(prisma, {
        workloadType: "MICROVM",
        orgFlags: { [FEATURE_FLAG.computeTemplatePrebuildWait]: true },
      });
      const service = new TemplatePrebuildService(
        prisma,
        config({ url: server.url, timeoutMs: 200 })
      );
      const result = await service.prebuild({
        ...deployment,
        projectId: project.id,
        imageDigest: DIGEST,
      });
      expect(result.outcome).toBe("timeout");
    } finally {
      await server.close();
    }
  });

  postgresTest("tells the CLI it is building in wait mode", async ({ prisma }) => {
    const server = await builder(reply(500, { error: "pull failed" }));
    try {
      const project = await createProject(prisma, {
        workloadType: "MICROVM",
        orgFlags: { [FEATURE_FLAG.computeTemplatePrebuildWait]: true },
      });
      const written: string[] = [];
      const writer = new WritableStream<string>({
        write(chunk) {
          written.push(chunk);
        },
      }).getWriter();
      const service = new TemplatePrebuildService(prisma, config({ url: server.url }));
      await service.prebuild({
        ...deployment,
        projectId: project.id,
        imageDigest: DIGEST,
        writer,
      });
      expect(written.join("")).toContain("Building compute template...");
    } finally {
      await server.close();
    }
  });

  postgresTest("does not wait on a CLI that stops reading logs", async ({ prisma }) => {
    const server = await builder(reply(201, { template_source: "built" }));
    try {
      const project = await createProject(prisma, {
        workloadType: "MICROVM",
        orgFlags: { [FEATURE_FLAG.computeTemplatePrebuildWait]: true },
      });
      // A sink that never accepts a chunk, so each write stays pending.
      const writer = new WritableStream<string>({
        write: () => new Promise<void>(() => {}),
      }).getWriter();
      const service = new TemplatePrebuildService(prisma, config({ url: server.url }));
      const result = await service.prebuild({
        ...deployment,
        projectId: project.id,
        imageDigest: DIGEST,
        writer,
      });
      expect(result.outcome).toBe("built");
    } finally {
      await server.close();
    }
  });

  postgresTest("carries on after a builder error in wait mode", async ({ prisma }) => {
    const server = await builder(reply(500, { error: "pull failed" }));
    try {
      const project = await createProject(prisma, {
        workloadType: "MICROVM",
        orgFlags: { [FEATURE_FLAG.computeTemplatePrebuildWait]: true },
      });
      const service = new TemplatePrebuildService(prisma, config({ url: server.url }));
      const result = await service.prebuild({
        ...deployment,
        projectId: project.id,
        imageDigest: DIGEST,
      });
      expect(result.outcome).toBe("failed");
    } finally {
      await server.close();
    }
  });

  postgresTest("carries on when the builder is unreachable", async ({ prisma }) => {
    const server = await builder(() => {});
    const url = server.url;
    await server.close();

    const project = await createProject(prisma, {
      workloadType: "MICROVM",
      orgFlags: { [FEATURE_FLAG.computeTemplatePrebuildWait]: true },
    });
    const service = new TemplatePrebuildService(prisma, config({ url }));
    const result = await service.prebuild({
      ...deployment,
      projectId: project.id,
      imageDigest: DIGEST,
    });
    expect(result.outcome).toBe("failed");
  });

  postgresTest("reports a template the mirror already had", async ({ prisma }) => {
    const server = await builder(
      reply(201, { template_id: "a".repeat(64), template_source: "mirror" })
    );
    try {
      const project = await createProject(prisma, {
        workloadType: "MICROVM",
        orgFlags: { [FEATURE_FLAG.computeTemplatePrebuildWait]: true },
      });
      const service = new TemplatePrebuildService(prisma, config({ url: server.url }));
      const result = await service.prebuild({
        ...deployment,
        projectId: project.id,
        imageDigest: DIGEST,
      });
      expect(result.outcome).toBe("already_there");
    } finally {
      await server.close();
    }
  });

  postgresTest("stores the template key before returning in wait mode", async ({ prisma }) => {
    const server = await builder(
      reply(201, { template_id: TEMPLATE_KEY, template_source: "built" })
    );
    try {
      const project = await createProject(prisma, {
        workloadType: "MICROVM",
        orgFlags: { [FEATURE_FLAG.computeTemplatePrebuildWait]: true },
      });
      const row = await createDeployment(prisma, project);
      const service = new TemplatePrebuildService(prisma, config({ url: server.url }));
      const result = await service.prebuild({
        projectId: project.id,
        deploymentId: row.id,
        deploymentFriendlyId: row.friendlyId,
        imageReference: IMAGE,
        imageDigest: DIGEST,
      });
      expect(result.outcome).toBe("built");
      expect(JSON.parse(server.requests[0].body).deployment_id).toBe(row.friendlyId);
      expect(await storedTemplateKey(prisma, row.id)).toBe(TEMPLATE_KEY);
    } finally {
      await server.close();
    }
  });

  postgresTest(
    "stores the template key when the background call completes in shadow mode",
    async ({ prisma }) => {
      let answer: (() => void) | undefined;
      const server = await builder((_req, _body, res) => {
        answer = () => reply(201, { template_id: TEMPLATE_KEY })(_req, _body, res);
      });
      try {
        const project = await createProject(prisma, { workloadType: "MICROVM" });
        // Finalisation has already moved on by the time the builder answers.
        const row = await createDeployment(prisma, project, {
          status: "DEPLOYED",
          imageReference: `${IMAGE}@${DIGEST}`,
        });
        const service = new TemplatePrebuildService(
          prisma,
          config({ url: server.url, timeoutMs: 30_000 })
        );
        const result = await service.prebuild({
          projectId: project.id,
          deploymentId: row.id,
          deploymentFriendlyId: row.friendlyId,
          imageReference: IMAGE,
          imageDigest: DIGEST,
        });
        expect(result.mode).toBe("shadow");
        await vi.waitFor(() => expect(answer).toBeDefined());
        expect(await storedTemplateKey(prisma, row.id)).toBeNull();

        answer!();
        await vi.waitFor(async () =>
          expect(await storedTemplateKey(prisma, row.id)).toBe(TEMPLATE_KEY)
        );
      } finally {
        await server.close();
      }
    }
  );

  postgresTest(
    "does not store the key on a deployment finalised with another image",
    async ({ prisma }) => {
      const server = await builder(reply(201, { template_id: TEMPLATE_KEY }));
      try {
        const project = await createProject(prisma, { workloadType: "MICROVM" });
        const row = await createDeployment(prisma, project, {
          status: "DEPLOYED",
          imageReference: `${IMAGE}@sha256:${"b".repeat(64)}`,
        });
        const service = new TemplatePrebuildService(prisma, config({ url: server.url }));
        await service.build(`${IMAGE}@${DIGEST}`, "shadow", {
          id: row.id,
          friendlyId: row.friendlyId,
        });
        expect(await storedTemplateKey(prisma, row.id)).toBeNull();
      } finally {
        await server.close();
      }
    }
  );

  postgresTest("does not hold wait mode past the timeout on a slow write", async ({ prisma }) => {
    const server = await builder(reply(201, { template_id: TEMPLATE_KEY }));
    let release: (() => void) | undefined;
    let lock: Promise<unknown> | undefined;
    try {
      const project = await createProject(prisma, {
        workloadType: "MICROVM",
        orgFlags: { [FEATURE_FLAG.computeTemplatePrebuildWait]: true },
      });
      const row = await createDeployment(prisma, project);

      // Hold the row lock so the template key update blocks.
      let locked: () => void;
      const isLocked = new Promise<void>((resolve) => (locked = resolve));
      lock = $transaction(
        prisma,
        "holdTemplatePrebuildLock",
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM "WorkerDeployment" WHERE id = ${row.id} FOR UPDATE`;
          locked();
          await new Promise<void>((resolve) => (release = resolve));
        },
        { timeout: 30_000 }
      );
      await isLocked;

      const service = new TemplatePrebuildService(
        prisma,
        config({ url: server.url, timeoutMs: 1_000 })
      );
      const startedAt = Date.now();
      const result = await service.prebuild({
        projectId: project.id,
        deploymentId: row.id,
        deploymentFriendlyId: row.friendlyId,
        imageReference: IMAGE,
        imageDigest: DIGEST,
      });
      expect(result.outcome).toBe("built");
      expect(Date.now() - startedAt).toBeLessThan(5_000);

      release!();
      await lock;
      await vi.waitFor(async () =>
        expect(await storedTemplateKey(prisma, row.id)).toBe(TEMPLATE_KEY)
      );
    } finally {
      release?.();
      await lock?.catch(() => {});
      await server.close();
    }
  });

  for (const [name, body] of [
    ["an invalid", { template_id: TEMPLATE_KEY.toUpperCase() }],
    ["a missing", { template_source: "built" }],
  ] as const) {
    postgresTest(`stores nothing for ${name} template id`, async ({ prisma }) => {
      const server = await builder(reply(201, body));
      try {
        const project = await createProject(prisma, {
          workloadType: "MICROVM",
          orgFlags: { [FEATURE_FLAG.computeTemplatePrebuildWait]: true },
        });
        const fresh = await createDeployment(prisma, project);
        const existing = await createDeployment(prisma, project, { templateKey: TEMPLATE_KEY });
        const service = new TemplatePrebuildService(prisma, config({ url: server.url }));
        for (const row of [fresh, existing]) {
          const result = await service.prebuild({
            projectId: project.id,
            deploymentId: row.id,
            deploymentFriendlyId: row.friendlyId,
            imageReference: IMAGE,
            imageDigest: DIGEST,
          });
          expect(result.outcome).toBe("built");
        }
        expect(await storedTemplateKey(prisma, fresh.id)).toBeNull();
        expect(await storedTemplateKey(prisma, existing.id)).toBe(TEMPLATE_KEY);
      } finally {
        await server.close();
      }
    });
  }

  postgresTest("leaves the template key unset after a builder failure", async ({ prisma }) => {
    const server = await builder(reply(500, { template_id: TEMPLATE_KEY, error: "pull failed" }));
    try {
      const project = await createProject(prisma, {
        workloadType: "MICROVM",
        orgFlags: { [FEATURE_FLAG.computeTemplatePrebuildWait]: true },
      });
      const row = await createDeployment(prisma, project);
      const service = new TemplatePrebuildService(prisma, config({ url: server.url }));
      const result = await service.prebuild({
        projectId: project.id,
        deploymentId: row.id,
        deploymentFriendlyId: row.friendlyId,
        imageReference: IMAGE,
        imageDigest: DIGEST,
      });
      expect(result.outcome).toBe("failed");
      expect(await storedTemplateKey(prisma, row.id)).toBeNull();
    } finally {
      await server.close();
    }
  });

  it("never rejects, even when mode resolution throws", async () => {
    const broken = {
      project: {
        findFirst: () => Promise.reject(new Error("database down")),
      },
    } as any;
    const service = new TemplatePrebuildService(broken, config());
    await expect(
      service.prebuild({ ...deployment, projectId: "proj", imageDigest: DIGEST })
    ).resolves.toEqual({ mode: "skip" });
  });
});

describe("requestBuilds", () => {
  const PINNED = `${IMAGE}@${DIGEST}`;

  postgresTest(
    "builds deployments by id or friendly id and reports each outcome",
    async ({ prisma }) => {
      const server = await builder(reply(200, { template_id: TEMPLATE_KEY }));
      try {
        const project = await createProject(prisma);
        const byId = await createDeployment(prisma, project, {
          status: "DEPLOYED",
          imageReference: PINNED,
        });
        const old = await createDeployment(prisma, project, {
          status: "DEPLOYED",
          imageReference: PINNED,
          deployedAt: new Date("2025-01-01T00:00:00Z"),
        });
        const keyed = await createDeployment(prisma, project, {
          status: "DEPLOYED",
          imageReference: PINNED,
          templateKey: "b".repeat(64),
        });
        const unpinned = await createDeployment(prisma, project, { status: "DEPLOYED" });
        const service = new TemplatePrebuildService(prisma, config({ url: server.url }));

        const results = await service.requestBuilds({
          deploymentIds: [byId.id, old.friendlyId, keyed.id, unpinned.id, "deployment_missing"],
        });

        expect(results).toEqual([
          { deploymentId: byId.id, friendlyId: byId.friendlyId, outcome: "built" },
          { deploymentId: old.friendlyId, friendlyId: old.friendlyId, outcome: "built" },
          {
            deploymentId: keyed.id,
            friendlyId: keyed.friendlyId,
            outcome: "skipped",
            reason: "has_key",
          },
          {
            deploymentId: unpinned.id,
            friendlyId: unpinned.friendlyId,
            outcome: "skipped",
            reason: "no_pinned_image",
          },
          { deploymentId: "deployment_missing", outcome: "not_found" },
        ]);
        expect(server.requests).toHaveLength(2);
        expect(JSON.parse(server.requests[0].body).image).toBe(PINNED);
        expect(await storedTemplateKey(prisma, byId.id)).toBe(TEMPLATE_KEY);
        expect(await storedTemplateKey(prisma, old.id)).toBe(TEMPLATE_KEY);
        expect(await storedTemplateKey(prisma, keyed.id)).toBe("b".repeat(64));
      } finally {
        await server.close();
      }
    }
  );

  postgresTest("force rebuilds a deployment that has a key", async ({ prisma }) => {
    const server = await builder(reply(200, { template_id: TEMPLATE_KEY }));
    try {
      const project = await createProject(prisma);
      const keyed = await createDeployment(prisma, project, {
        status: "DEPLOYED",
        imageReference: PINNED,
        templateKey: "b".repeat(64),
      });
      const service = new TemplatePrebuildService(prisma, config({ url: server.url }));

      const [result] = await service.requestBuilds({ deploymentIds: [keyed.id], force: true });

      expect(result).toMatchObject({ outcome: "built" });
      expect(await storedTemplateKey(prisma, keyed.id)).toBe(TEMPLATE_KEY);
    } finally {
      await server.close();
    }
  });

  postgresTest("reports a 429 from the builder as rate_limited", async ({ prisma }) => {
    const server = await builder(reply(429, { error: "slow down" }));
    try {
      const project = await createProject(prisma);
      const row = await createDeployment(prisma, project, {
        status: "DEPLOYED",
        imageReference: PINNED,
      });
      const service = new TemplatePrebuildService(prisma, config({ url: server.url }));

      const [result] = await service.requestBuilds({ deploymentIds: [row.id] });

      expect(result).toMatchObject({ outcome: "rate_limited" });
      expect(await storedTemplateKey(prisma, row.id)).toBeNull();
    } finally {
      await server.close();
    }
  });

  postgresTest("skips every deployment when no builder is configured", async ({ prisma }) => {
    const project = await createProject(prisma);
    const row = await createDeployment(prisma, project, {
      status: "DEPLOYED",
      imageReference: PINNED,
    });
    const service = new TemplatePrebuildService(prisma, config({ url: undefined }));

    await expect(service.requestBuilds({ deploymentIds: [row.id] })).resolves.toEqual([
      {
        deploymentId: row.id,
        friendlyId: row.friendlyId,
        outcome: "skipped",
        reason: "no_builder",
      },
    ]);
  });
});
