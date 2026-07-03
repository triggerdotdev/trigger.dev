// Real heterogeneous legacy + new Postgres proof for the public waitpoint retrieve read.
// The DB is never mocked: reads hit the two real containers. Only pure boundaries
// (splitEnabled, isPastRetention) and recording client wrappers are
// injected. heteroPostgresTest runs the legacy and new databases on different major versions.
import {
  heteroPostgresTest,
  heteroRunOpsPostgresTest,
  postgresTest,
} from "@internal/testcontainers";
import type { RunOpsPrismaClient } from "@internal/run-ops-database";
import type { PrismaClient, WaitpointType } from "@trigger.dev/database";
import { generateKsuidId } from "@trigger.dev/core/v3/isomorphic";
import { describe, expect, vi } from "vitest";
import type { PrismaReplicaClient } from "~/db.server";
import { ApiWaitpointPresenter } from "~/presenters/v3/ApiWaitpointPresenter.server";

vi.setConfig({ testTimeout: 60_000 });

// 25-char cuid body (length-disjoint from the 27-char KSUID) → LEGACY residency.
function generateLegacyCuid() {
  const suffix = Array.from(
    { length: 24 },
    () => "0123456789abcdefghijklmnopqrstuvwxyz"[Math.floor(Math.random() * 36)]
  ).join("");
  return `c${suffix}`;
}

// A read client whose waitpoint.findFirst is recorded; throws if used after being marked
// forbidden, so we can prove a store was NEVER read.
function recording(client: PrismaClient | RunOpsPrismaClient, opts: { forbidden?: boolean } = {}) {
  const calls: unknown[] = [];
  const waitpoint = {
    findFirst: (args: unknown) => {
      calls.push(args);
      if (opts.forbidden) {
        throw new Error("this store must never be read");
      }
      return (client as unknown as PrismaReplicaClient).waitpoint.findFirst(args as never);
    },
  };
  return { handle: { ...client, waitpoint } as unknown as PrismaReplicaClient, calls };
}

async function seedOrgProjectEnv(prisma: PrismaClient, suffix: string) {
  const organization = await prisma.organization.create({
    data: { title: `test-${suffix}`, slug: `test-${suffix}` },
  });
  const project = await prisma.project.create({
    data: {
      name: `test-${suffix}`,
      slug: `test-${suffix}`,
      organizationId: organization.id,
      externalRef: `test-${suffix}`,
    },
  });
  const environment = await prisma.runtimeEnvironment.create({
    data: {
      slug: `test-${suffix}`,
      type: "PRODUCTION",
      projectId: project.id,
      organizationId: organization.id,
      apiKey: `apikey-${suffix}`,
      pkApiKey: `pk-${suffix}`,
      shortcode: `test-${suffix}`,
    },
  });
  return { organization, project, environment };
}

async function seedWaitpoint(
  prisma: PrismaClient,
  id: string,
  env: { id: string; projectId: string },
  overrides: Partial<{
    status: "PENDING" | "COMPLETED";
    type: WaitpointType;
    output: string;
    outputType: string;
    outputIsError: boolean;
    completedAt: Date;
    completedAfter: Date;
    tags: string[];
  }> = {}
) {
  return prisma.waitpoint.create({
    data: {
      id,
      friendlyId: `waitpoint_${id}`,
      type: overrides.type ?? "MANUAL",
      status: overrides.status ?? "COMPLETED",
      idempotencyKey: `idem-${id}`,
      userProvidedIdempotencyKey: false,
      output: overrides.output ?? JSON.stringify({ hello: "world" }),
      outputType: overrides.outputType ?? "application/json",
      outputIsError: overrides.outputIsError ?? false,
      completedAt: overrides.completedAt ?? new Date(),
      completedAfter: overrides.completedAfter,
      tags: overrides.tags ?? ["a", "b"],
      projectId: env.projectId,
      environmentId: env.id,
    },
  });
}

const environmentArg = (env: { id: string; projectId: string }) => ({
  id: env.id,
  type: "PRODUCTION" as const,
  project: { id: env.projectId, engine: "V2" as const },
  apiKey: "tr_test_apikey",
});

describe("ApiWaitpointPresenter read-through (heterogeneous legacy + new Postgres)", () => {
  heteroPostgresTest(
    "resolves on run-ops NEW (ksuid), legacy replica never touched",
    async ({ prisma17, prisma14 }) => {
      const id = generateKsuidId();
      expect(id.length).toBe(27);

      const { project, environment } = await seedOrgProjectEnv(prisma17, "new");
      const seeded = await seedWaitpoint(
        prisma17,
        id,
        { id: environment.id, projectId: project.id },
        { tags: ["x", "y", "z"], output: JSON.stringify({ n: 42 }) }
      );

      const newClient = recording(prisma17);
      const legacy = recording(prisma14, { forbidden: true });

      const presenter = new ApiWaitpointPresenter(undefined, undefined, {
        splitEnabled: true,
        newClient: newClient.handle,
        legacyReplica: legacy.handle,
      });

      const result = await presenter.call(environmentArg(environment), id);

      expect(result.id).toBe(seeded.friendlyId);
      expect(result.tags).toEqual(["x", "y", "z"]);
      expect(result.output).toBe(JSON.stringify({ n: 42 }));
      expect(result.type).toBe("MANUAL");
      // ksuid → NEW: new store served the read, legacy never touched (fast-path).
      expect(newClient.calls.length).toBe(1);
      expect(legacy.calls.length).toBe(0);
    }
  );

  heteroPostgresTest(
    "resolves off the LEGACY replica (cuid), never a legacy primary",
    async ({ prisma17, prisma14 }) => {
      const id = generateLegacyCuid();
      expect(id.length).toBe(25);

      const { project, environment } = await seedOrgProjectEnv(prisma14, "legacy");
      const seeded = await seedWaitpoint(prisma14, id, {
        id: environment.id,
        projectId: project.id,
      });

      const newClient = recording(prisma17);
      // The deps expose only legacyReplica — there is NO legacy-primary handle at all.
      const legacy = recording(prisma14);

      const presenter = new ApiWaitpointPresenter(undefined, undefined, {
        splitEnabled: true,
        newClient: newClient.handle,
        legacyReplica: legacy.handle,
      });

      const result = await presenter.call(environmentArg(environment), id);

      expect(result.id).toBe(seeded.friendlyId);
      expect(result.tags).toEqual(["a", "b"]);
      // NEW probed first (miss) → resolved off the LEGACY REPLICA handle.
      expect(newClient.calls.length).toBe(1);
      expect(legacy.calls.length).toBe(1);
    }
  );

  heteroPostgresTest(
    "not-found maps to the existing ServiceValidationError surface",
    async ({ prisma17, prisma14 }) => {
      const id = generateLegacyCuid();
      const { environment } = await seedOrgProjectEnv(prisma14, "nf");

      const presenter = new ApiWaitpointPresenter(undefined, undefined, {
        splitEnabled: true,
        newClient: recording(prisma17).handle,
        legacyReplica: recording(prisma14).handle,
      });

      await expect(presenter.call(environmentArg(environment), id)).rejects.toThrow(
        "Waitpoint not found"
      );
    }
  );

  heteroPostgresTest(
    "past-retention maps to the same not-found surface",
    async ({ prisma17, prisma14 }) => {
      const id = generateLegacyCuid();
      const { environment } = await seedOrgProjectEnv(prisma14, "pr");

      const presenter = new ApiWaitpointPresenter(undefined, undefined, {
        splitEnabled: true,
        newClient: recording(prisma17).handle,
        legacyReplica: recording(prisma14).handle,
        isPastRetention: () => true,
      });

      await expect(presenter.call(environmentArg(environment), id)).rejects.toThrow(
        "Waitpoint not found"
      );
    }
  );

  heteroPostgresTest(
    "cross-seam — new-resident served from NEW (legacy untouched); in-retention served from legacy",
    async ({ prisma17, prisma14 }) => {
      // New-resident waitpoint: lives on NEW, the new probe hits, legacy must never be touched.
      const newId = generateKsuidId();
      const newEnv = await seedOrgProjectEnv(prisma17, "x2new");
      await seedWaitpoint(prisma17, newId, {
        id: newEnv.environment.id,
        projectId: newEnv.project.id,
      });
      const newLegacy = recording(prisma14, { forbidden: true });
      const migratedPresenter = new ApiWaitpointPresenter(undefined, undefined, {
        splitEnabled: true,
        newClient: recording(prisma17).handle,
        legacyReplica: newLegacy.handle,
      });
      const migratedResult = await migratedPresenter.call(
        environmentArg(newEnv.environment),
        newId
      );
      expect(migratedResult.id).toBe(`waitpoint_${newId}`);
      expect(newLegacy.calls.length).toBe(0);

      // In-retention waitpoint: lives on the legacy replica, served from it.
      const oldId = generateLegacyCuid();
      const oldEnv = await seedOrgProjectEnv(prisma14, "x2old");
      await seedWaitpoint(prisma14, oldId, {
        id: oldEnv.environment.id,
        projectId: oldEnv.project.id,
      });
      const retentionPresenter = new ApiWaitpointPresenter(undefined, undefined, {
        splitEnabled: true,
        newClient: recording(prisma17).handle,
        legacyReplica: recording(prisma14).handle,
      });
      const retentionResult = await retentionPresenter.call(
        environmentArg(oldEnv.environment),
        oldId
      );
      expect(retentionResult.id).toBe(`waitpoint_${oldId}`);
    }
  );
});

// Regression: the split-mode NEW client is the REAL scalar-only run-ops client (prisma17). A cuid
// classifies LEGACY, so readThroughRun probes NEW first — a relation in hydrate() (connectedRuns)
// throws PrismaClientValidationError there (the 500) before the legacy fallback runs.
describe("ApiWaitpointPresenter read-through (dedicated scalar-only run-ops NEW client)", () => {
  heteroRunOpsPostgresTest(
    "cuid token: hydrate() select is valid against the scalar-only run-ops client, resolves via legacy",
    async ({ prisma17, prisma14 }) => {
      const id = generateLegacyCuid();
      expect(id.length).toBe(25);

      const { project, environment } = await seedOrgProjectEnv(prisma14, "scalar-legacy");
      const seeded = await seedWaitpoint(
        prisma14,
        id,
        { id: environment.id, projectId: project.id },
        { tags: ["p", "q"], output: JSON.stringify({ ok: true }) }
      );

      const newClient = recording(prisma17);
      const legacy = recording(prisma14);

      const presenter = new ApiWaitpointPresenter(undefined, undefined, {
        splitEnabled: true,
        newClient: newClient.handle,
        legacyReplica: legacy.handle,
      });

      // Must NOT throw PrismaClientValidationError; resolves the token off the legacy side.
      const result = await presenter.call(environmentArg(environment), id);

      expect(result.id).toBe(seeded.friendlyId);
      expect(result.tags).toEqual(["p", "q"]);
      expect(result.output).toBe(JSON.stringify({ ok: true }));
      expect(newClient.calls.length).toBe(1);
      expect(legacy.calls.length).toBe(1);
    }
  );
});

describe("ApiWaitpointPresenter passthrough (single-DB)", () => {
  postgresTest(
    "no read-through deps → one plain replica read; legacy never touched",
    async ({ prisma }) => {
      const id = generateKsuidId();
      const { project, environment } = await seedOrgProjectEnv(prisma, "pt");
      const seeded = await seedWaitpoint(
        prisma,
        id,
        { id: environment.id, projectId: project.id },
        { tags: ["one"], output: JSON.stringify({ ok: true }) }
      );

      const single = recording(prisma);
      const legacy = recording(prisma, { forbidden: true });

      // No splitEnabled → passthrough. newClient defaults to the single recording handle so we
      // can assert exactly one read against it; legacy must never fire.
      const presenter = new ApiWaitpointPresenter(undefined, undefined, {
        newClient: single.handle,
        legacyReplica: legacy.handle,
      });

      const result = await presenter.call(environmentArg(environment), id);

      expect(result.id).toBe(seeded.friendlyId);
      expect(result.tags).toEqual(["one"]);
      expect(result.output).toBe(JSON.stringify({ ok: true }));
      // Passthrough: exactly one read on the single client; legacy untouched.
      expect(single.calls.length).toBe(1);
      expect(legacy.calls.length).toBe(0);
    }
  );
});
