import { describe, expect, it } from "vitest";
import { postgresTest } from "@internal/testcontainers";
import { Prisma, PrismaClient } from "@trigger.dev/database";
import {
  captureInfrastructureErrors,
  clientSafeErrorMessage,
  infraErrorAlreadyLogged,
  logTransactionInfrastructureError,
} from "~/utils/prismaErrors";

vi.setConfig({ testTimeout: 60_000 });

function capturingLogger() {
  const captured: Array<{ message: string; fields?: Record<string, unknown> }> = [];
  return {
    captured,
    error: (message: string, fields?: Record<string, unknown>) => {
      captured.push({ message, fields });
    },
  };
}

describe("captureInfrastructureErrors", () => {
  postgresTest("P2025 (not found) passes through with code intact and unlogged", async ({
    prisma,
  }) => {
    const log = capturingLogger();
    const client = captureInfrastructureErrors(prisma, log);

    const error = await client.secretStore
      .update({ where: { key: "does-not-exist" }, data: { version: "2" } })
      .then(() => undefined)
      .catch((e) => e);

    expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect((error as Prisma.PrismaClientKnownRequestError).code).toBe("P2025");
    expect(log.captured).toHaveLength(0);
  });

  postgresTest("P2002 (unique violation) passes through with code intact and unlogged", async ({
    prisma,
  }) => {
    const log = capturingLogger();
    const client = captureInfrastructureErrors(prisma, log);

    await client.secretStore.create({ data: { key: "dup-key", value: { a: 1 } } });

    const error = await client.secretStore
      .create({ data: { key: "dup-key", value: { a: 2 } } })
      .then(() => undefined)
      .catch((e) => e);

    expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect((error as Prisma.PrismaClientKnownRequestError).code).toBe("P2002");
    expect(log.captured).toHaveLength(0);
  });

  postgresTest("errors raised inside an interactive $transaction keep their code", async ({
    prisma,
  }) => {
    const log = capturingLogger();
    const client = captureInfrastructureErrors(prisma, log);

    // Proves $allOperations fires per-statement inside a transaction — the
    // basis for transaction retry logic (which branches on error.code) staying
    // intact.
    const error = await client
      .$transaction(async (tx) => {
        await tx.secretStore.update({ where: { key: "missing-in-tx" }, data: { version: "2" } });
      })
      .then(() => undefined)
      .catch((e) => e);

    expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect((error as Prisma.PrismaClientKnownRequestError).code).toBe("P2025");
    expect(log.captured).toHaveLength(0);
  });

  postgresTest("raw queries (model undefined) are wrapped without crashing", async ({
    prisma,
  }) => {
    const log = capturingLogger();
    const client = captureInfrastructureErrors(prisma, log);

    const rows = await client.$queryRaw<Array<{ one: number }>>(Prisma.sql`SELECT 1 as one`);
    expect(rows[0].one).toBe(1);

    // A failing raw query (non-infra) must still rethrow rather than throw on
    // the undefined `model`.
    const error = await client
      .$queryRaw(Prisma.sql`SELECT 1 / 0`)
      .then(() => undefined)
      .catch((e) => e);

    expect(error).toBeInstanceOf(Error);
    expect(log.captured).toHaveLength(0);
  });

  postgresTest("a genuine connectivity failure is logged with model/operation/code", async () => {
    const log = capturingLogger();
    // Point at a closed port to provoke a real P1001 / initialization error —
    // no mocking.
    const unreachable = new PrismaClient({
      datasources: {
        db: { url: "postgresql://postgres:postgres@127.0.0.1:1/postgres?connect_timeout=2" },
      },
    });
    const client = captureInfrastructureErrors(unreachable, log);

    try {
      const error = await client.secretStore
        .findFirst({ where: { key: "anything" } })
        .then(() => undefined)
        .catch((e) => e);

      expect(error).toBeInstanceOf(Error);
      expect(log.captured).toHaveLength(1);
      expect(log.captured[0].message).toBe("prisma infrastructure error");
      expect(log.captured[0].fields?.operation).toBe("findFirst");
      expect(log.captured[0].fields?.model).toBe("SecretStore");

      // Dedupe: the extension tagged it, so a $transaction-boundary logger
      // seeing the same error must NOT log it a second time.
      expect(infraErrorAlreadyLogged(error)).toBe(true);
      const boundaryLog = capturingLogger();
      expect(logTransactionInfrastructureError(error, boundaryLog)).toBe(false);
      expect(boundaryLog.captured).toHaveLength(0);
    } finally {
      await unreachable.$disconnect();
    }
  });
});

describe("logTransactionInfrastructureError", () => {
  // Covers the transaction boundary, which $allOperations cannot reach.
  it("logs an uncoded infra error (PrismaClientInitializationError)", () => {
    const log = capturingLogger();
    const error = new Prisma.PrismaClientInitializationError(
      "Can't reach database server",
      "6.14.0",
      "P1001"
    );

    expect(logTransactionInfrastructureError(error, log)).toBe(true);
    expect(log.captured).toHaveLength(1);
    expect(log.captured[0].message).toBe("prisma.$transaction infrastructure error");
    expect(log.captured[0].fields?.name).toBe("PrismaClientInitializationError");
  });

  it("skips a coded infra error (transac's callback already logs those)", () => {
    const log = capturingLogger();
    const error = new Prisma.PrismaClientKnownRequestError("Can't reach database server", {
      code: "P1001",
      clientVersion: "6.14.0",
    });

    expect(logTransactionInfrastructureError(error, log)).toBe(false);
    expect(log.captured).toHaveLength(0);
  });

  it("skips a non-infra coded error (P2002)", () => {
    const log = capturingLogger();
    const error = new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
      code: "P2002",
      clientVersion: "6.14.0",
    });

    expect(logTransactionInfrastructureError(error, log)).toBe(false);
    expect(log.captured).toHaveLength(0);
  });

  it("skips a plain non-Prisma error", () => {
    const log = capturingLogger();

    expect(logTransactionInfrastructureError(new Error("boom"), log)).toBe(false);
    expect(log.captured).toHaveLength(0);
  });
});

describe("clientSafeErrorMessage", () => {
  // Guards the API-route leak: an infra error's message carries the DB hostname.
  it("obfuscates a coded infra error (P1001) message", () => {
    const error = new Prisma.PrismaClientKnownRequestError(
      "Can't reach database server at `db-internal.example.com:5432`",
      { code: "P1001", clientVersion: "6.14.0" }
    );

    expect(clientSafeErrorMessage(error)).toBe("Internal Server Error");
  });

  it("obfuscates an uncoded infra error (PrismaClientInitializationError) message", () => {
    const error = new Prisma.PrismaClientInitializationError(
      "Can't reach database server at `db-internal.example.com:5432`",
      "6.14.0",
      "P1001"
    );

    expect(clientSafeErrorMessage(error)).toBe("Internal Server Error");
  });

  it("leaves non-infra Prisma error (P2002) messages unchanged", () => {
    const error = new Prisma.PrismaClientKnownRequestError("Unique constraint failed on email", {
      code: "P2002",
      clientVersion: "6.14.0",
    });

    expect(clientSafeErrorMessage(error)).toBe("Unique constraint failed on email");
  });

  it("leaves plain domain/validation error messages unchanged", () => {
    expect(clientSafeErrorMessage(new Error("Invalid delay value"))).toBe("Invalid delay value");
  });
});
