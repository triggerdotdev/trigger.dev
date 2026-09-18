import { Pool } from "pg";
import { postgresTest } from "@internal/testcontainers";
import { describe, expect, vi } from "vitest";
import { TriggerDeployNowService } from "./triggerDeployNow.server";

const deploymentTest = postgresTest.extend<{ lockPool: Pool }>({
  lockPool: async ({ postgresContainer }, runTest) => {
    const pool = new Pool({ connectionString: postgresContainer.getConnectionUri(), max: 3 });
    try {
      await runTest(pool);
    } finally {
      await pool.end();
    }
  },
});

async function seedEnvironment(prisma: any) {
  // Minimal graph: organization → project → runtimeEnvironment (PRODUCTION).
  const org = await prisma.organization.create({
    data: { title: "Org", slug: `org-${Date.now()}` },
  });
  const project = await prisma.project.create({
    data: {
      name: "P",
      slug: `p-${Date.now()}`,
      externalRef: `proj_${Date.now()}`,
      organizationId: org.id,
      version: "V3",
    },
  });
  const env = await prisma.runtimeEnvironment.create({
    data: {
      slug: "prod",
      type: "PRODUCTION",
      apiKey: `tr_prod_${Date.now()}`,
      pkApiKey: `pk_prod_${Date.now()}`,
      shortcode: `sc_${Date.now()}`,
      organizationId: org.id,
      projectId: project.id,
    },
  });
  return { org, project, env };
}

describe("TriggerDeployNowService", () => {
  deploymentTest("triggers when no deployment is in flight", async ({ prisma, lockPool }) => {
    const { project, env } = await seedEnvironment(prisma);
    const triggerFn = vi.fn(async () => ({ ok: true as const }));
    const service = new TriggerDeployNowService(triggerFn, prisma, lockPool);

    const result = await service.call({
      projectId: project.id,
      environmentId: env.id,
      environmentType: "PRODUCTION",
      branch: "main",
    });

    expect(result).toEqual({ ok: true });
    expect(triggerFn).toHaveBeenCalledWith(project.id, { environment: "prod", branch: "main" });
  });

  deploymentTest(
    "returns alreadyInFlight when a non-terminal deployment exists",
    async ({ prisma, lockPool }) => {
      const { project, env } = await seedEnvironment(prisma);
      await prisma.workerDeployment.create({
        data: {
          friendlyId: `deploy_${Date.now()}`,
          contentHash: "abc",
          shortCode: `d${Date.now()}`,
          version: "20240101.1",
          status: "BUILDING",
          environmentId: env.id,
          projectId: project.id,
        },
      });
      const triggerFn = vi.fn(async () => ({ ok: true as const }));
      const service = new TriggerDeployNowService(triggerFn, prisma, lockPool);

      const result = await service.call({
        projectId: project.id,
        environmentId: env.id,
        environmentType: "PRODUCTION",
        branch: "main",
      });

      expect(result).toEqual({ ok: false, reason: "alreadyInFlight" });
      expect(triggerFn).not.toHaveBeenCalled();
    }
  );

  deploymentTest(
    "still triggers when the only deployment is terminal-failed",
    async ({ prisma, lockPool }) => {
      const { project, env } = await seedEnvironment(prisma);
      await prisma.workerDeployment.create({
        data: {
          friendlyId: `deploy_${Date.now()}`,
          contentHash: "abc",
          shortCode: `d${Date.now()}`,
          version: "20240101.1",
          status: "FAILED",
          environmentId: env.id,
          projectId: project.id,
        },
      });
      const triggerFn = vi.fn(async () => ({ ok: true as const }));
      const service = new TriggerDeployNowService(triggerFn, prisma, lockPool);

      const result = await service.call({
        projectId: project.id,
        environmentId: env.id,
        environmentType: "PRODUCTION",
        branch: "main",
      });

      expect(result).toEqual({ ok: true });
      expect(triggerFn).toHaveBeenCalledOnce();
    }
  );

  deploymentTest("rejects a development environment", async ({ prisma, lockPool }) => {
    const { project, env } = await seedEnvironment(prisma);
    const triggerFn = vi.fn(async () => ({ ok: true as const }));
    const service = new TriggerDeployNowService(triggerFn, prisma, lockPool);

    const result = await service.call({
      projectId: project.id,
      environmentId: env.id,
      environmentType: "DEVELOPMENT",
      branch: "main",
    });

    expect(result).toEqual({ ok: false, reason: "unsupportedEnvironment" });
    expect(triggerFn).not.toHaveBeenCalled();
  });
});

deploymentTest(
  "serializes concurrent manual requests until the deployment is persisted",
  async ({ prisma, lockPool }) => {
    const { project, env } = await seedEnvironment(prisma);
    const opts = {
      projectId: project.id,
      environmentId: env.id,
      environmentType: "PRODUCTION" as const,
      branch: "main",
    };
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let calls = 0;
    const trigger = async () => {
      calls++;
      if (calls > 1) return { ok: true as const };
      entered();
      await blocked;
      await prisma.workerDeployment.create({
        data: {
          friendlyId: `concurrent_${env.id}`,
          shortCode: `concurrent_${env.id}`,
          contentHash: "test",
          version: "20260917.1",
          status: "PENDING",
          environmentId: env.id,
          projectId: project.id,
        },
      });
      return { ok: true as const };
    };
    const first = new TriggerDeployNowService(trigger, prisma, lockPool).call(opts);
    try {
      await started;
      const second = await new TriggerDeployNowService(trigger, prisma, lockPool).call(opts);
      expect(second).toEqual({ ok: false, reason: "alreadyInFlight" });
      expect(calls).toBe(1);
    } finally {
      release();
      await first;
    }
    expect(await first).toEqual({ ok: true });
    expect(await new TriggerDeployNowService(trigger, prisma, lockPool).call(opts)).toEqual({
      ok: false,
      reason: "alreadyInFlight",
    });
    expect(await prisma.workerDeployment.count({ where: { environmentId: env.id } })).toBe(1);
    expect(calls).toBe(1);
  }
);

deploymentTest(
  "releases the manual lock after a rejected platform request",
  async ({ prisma, lockPool }) => {
    const { project, env } = await seedEnvironment(prisma);
    const opts = {
      projectId: project.id,
      environmentId: env.id,
      environmentType: "PRODUCTION" as const,
      branch: "main",
    };
    let calls = 0;
    const service = new TriggerDeployNowService(
      async () => ({ ok: ++calls > 1 }),
      prisma,
      lockPool
    );
    expect(await service.call(opts)).toEqual({ ok: false, reason: "error" });
    expect(await service.call(opts)).toEqual({ ok: true });
    expect(calls).toBe(2);
  }
);

deploymentTest(
  "isolates environments and releases the manual lock after an exception",
  async ({ prisma, lockPool }) => {
    const { project, env } = await seedEnvironment(prisma);
    const other = await seedEnvironment(prisma);
    const opts = {
      projectId: project.id,
      environmentId: env.id,
      environmentType: "PRODUCTION" as const,
      branch: "main",
    };
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const first = new TriggerDeployNowService(
      async () => {
        entered();
        await blocked;
        throw new Error("platform failed");
      },
      prisma,
      lockPool
    ).call(opts);
    const failure = expect(first).resolves.toEqual({ ok: false, reason: "error" });
    try {
      await started;
      expect(
        await new TriggerDeployNowService(async () => ({ ok: true }), prisma, lockPool).call({
          ...opts,
          projectId: other.project.id,
          environmentId: other.env.id,
        })
      ).toEqual({ ok: true });
    } finally {
      release();
      await failure;
    }
    expect(
      await new TriggerDeployNowService(async () => ({ ok: true }), prisma, lockPool).call(opts)
    ).toEqual({ ok: true });
  }
);

deploymentTest(
  "bounds pool saturation and drains connections on shutdown",
  async ({ prisma, postgresContainer }) => {
    const { project, env } = await seedEnvironment(prisma);
    const pool = new Pool({
      connectionString: postgresContainer.getConnectionUri(),
      max: 1,
      connectionTimeoutMillis: 50,
    });
    let calls = 0;
    const service = new TriggerDeployNowService(
      async () => {
        calls++;
        return { ok: true };
      },
      prisma,
      pool
    );
    const opts = {
      projectId: project.id,
      environmentId: env.id,
      environmentType: "PRODUCTION" as const,
      branch: "main",
    };
    const held = await pool.connect();
    try {
      expect(await service.call(opts)).toEqual({ ok: false, reason: "error" });
      expect(calls).toBe(0);
    } finally {
      held.release();
    }
    try {
      expect(await service.call(opts)).toEqual({ ok: true });
      expect(calls).toBe(1);
    } finally {
      await pool.end();
    }
    expect(pool.totalCount).toBe(0);
  }
);
