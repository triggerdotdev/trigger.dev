import { describe, expect, it } from "vitest";
import { Prisma } from "@trigger.dev/database";
import { DefaultQueueManager } from "../app/runEngine/concerns/queues.server.js";
import { ServiceValidationError } from "../app/v3/services/common.server.js";

// Minimal non-DEVELOPMENT environment so getWorkerQueue resolves a worker group
// (DEVELOPMENT short-circuits before touching the DB).
function productionEnv() {
  return { type: "PRODUCTION", projectId: "proj_test", id: "env_test" } as any;
}

describe("DefaultQueueManager.getWorkerQueue — writer DB error handling", () => {
  it("rethrows a Prisma connectivity error unchanged instead of wrapping it in a client-facing ServiceValidationError", async () => {
    // The exact production failure: getDefaultWorkerGroupForProject's writer
    // `project.findFirst` throws P1001 when the DB is unreachable. The raw
    // message carries the DB hostname and must NOT become a 422 with that text.
    const prisma = {
      project: {
        findFirst: async () => {
          throw new Prisma.PrismaClientKnownRequestError(
            "Invalid `prisma.project.findFirst()` invocation: Can't reach database server at host:5432",
            { code: "P1001", clientVersion: "6.14.0" }
          );
        },
      },
    } as any;

    const queueManager = new DefaultQueueManager(prisma, {} as any);

    const result = await queueManager.getWorkerQueue(productionEnv()).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error })
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      expect(result.error).not.toBeInstanceOf(ServiceValidationError);
    }
  });

  it("still wraps a genuine domain failure (project not found) as a ServiceValidationError", async () => {
    const prisma = {
      project: { findFirst: async () => null },
    } as any;

    const queueManager = new DefaultQueueManager(prisma, {} as any);

    await expect(queueManager.getWorkerQueue(productionEnv())).rejects.toBeInstanceOf(
      ServiceValidationError
    );
  });
});
