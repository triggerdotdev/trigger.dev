// The current version read is on every page that shows a version (runs list, span inspector, task
// and agent pages, Versions): it reads the promotion and the deployment, and nothing else.

import { describe, expect, it, vi } from "vitest";

// Every call here passes its own client; the module-level ones are never used.
vi.mock("~/db.server", () => ({ prisma: {}, $replica: {} }));
import {
  findCurrentDeployment,
  findCurrentDeploymentVersion,
} from "~/v3/models/workerDeployment.server";

function recordingClient(deployment: Record<string, unknown>) {
  const calls: unknown[] = [];
  const client = {
    workerDeploymentPromotion: {
      findFirst: async (args: unknown) => {
        calls.push(args);
        return { deployment };
      },
    },
  };
  return { calls, client: client as never };
}

describe("findCurrentDeploymentVersion", () => {
  // Catches: the version read loading the worker too (a third query on every page that shows the
  // current version, for every project).
  it("selects the deployment's version only, not its worker", async () => {
    const { calls, client } = recordingClient({ version: "20261124.1" });

    await expect(findCurrentDeploymentVersion("env_1", client)).resolves.toBe("20261124.1");

    expect(calls).toEqual([
      {
        where: { environmentId: "env_1", label: "current" },
        select: { deployment: { select: { version: true } } },
      },
    ]);
  });

  it("is undefined when nothing is promoted", async () => {
    const client = { workerDeploymentPromotion: { findFirst: async () => null } };
    await expect(findCurrentDeploymentVersion("env_1", client as never)).resolves.toBeUndefined();
  });
});

describe("findCurrentDeployment", () => {
  // Catches: the whole worker loaded for a read that needs its id only.
  it("loads the version, worker id and creation time, not the worker", async () => {
    const createdAt = new Date("2026-11-24T00:00:00Z");
    const { calls, client } = recordingClient({
      version: "20261124.1",
      workerId: "worker_1",
      createdAt,
    });

    await expect(findCurrentDeployment("env_1", client)).resolves.toEqual({
      version: "20261124.1",
      workerId: "worker_1",
      createdAt,
    });
    expect(calls).toEqual([
      {
        where: { environmentId: "env_1", label: "current" },
        select: { deployment: { select: { version: true, workerId: true, createdAt: true } } },
      },
    ]);
  });
});
