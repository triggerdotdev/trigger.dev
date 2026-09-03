import { describe, expect, it } from "vitest";
import { Prisma } from "../generated/prisma";
import {
  isInfrastructureError,
  isRetryableInfrastructureError,
  looksLikeConnectivityError,
} from "./infraError";

const known = (code: string, message = "") =>
  new Prisma.PrismaClientKnownRequestError(message, { code, clientVersion: "6.14.0" });

describe("isInfrastructureError", () => {
  it("treats connection-level Prisma codes as infrastructure errors", () => {
    for (const code of ["P1001", "P1002", "P1008", "P1017"]) {
      expect(isInfrastructureError(known(code, "boom"))).toBe(true);
    }
  });

  it("does not treat query/validation errors as infrastructure errors", () => {
    expect(isInfrastructureError(known("P2025", "record not found"))).toBe(false);
    expect(isInfrastructureError(known("P2002", "unique constraint"))).toBe(false);
  });

  it("treats P2010 as infrastructure only when the message looks like connectivity loss", () => {
    expect(isInfrastructureError(known("P2010", "Connection terminated unexpectedly"))).toBe(true);
    expect(isInfrastructureError(known("P2010", "syntax error at or near"))).toBe(false);
  });

  it("treats init / panic / unknown request errors as infrastructure errors", () => {
    expect(
      isInfrastructureError(new Prisma.PrismaClientInitializationError("no db", "6.14.0"))
    ).toBe(true);
  });

  it("recognises raw connectivity errno / messages", () => {
    expect(isInfrastructureError({ code: "ECONNRESET" })).toBe(true);
    expect(isInfrastructureError(new Error("server has closed the connection"))).toBe(true);
    expect(isInfrastructureError(new Error("column does not exist"))).toBe(false);
  });
});

describe("looksLikeConnectivityError", () => {
  it("matches known errno codes and message fragments", () => {
    expect(looksLikeConnectivityError({ code: "EHOSTUNREACH" })).toBe(true);
    expect(looksLikeConnectivityError(new Error("Can't reach database server"))).toBe(true);
    expect(looksLikeConnectivityError(new Error("relation does not exist"))).toBe(false);
  });
});

describe("isRetryableInfrastructureError", () => {
  it("retries connection-level codes and connectivity errnos/messages", () => {
    for (const code of ["P1001", "P1002", "P1008", "P1017"]) {
      expect(isRetryableInfrastructureError(known(code, "boom"))).toBe(true);
    }
    expect(isRetryableInfrastructureError({ code: "ECONNRESET" })).toBe(true);
    expect(isRetryableInfrastructureError(new Error("server has closed the connection"))).toBe(
      true
    );
  });

  it("does not retry query/validation errors", () => {
    expect(isRetryableInfrastructureError(known("P2025", "record not found"))).toBe(false);
    expect(isRetryableInfrastructureError(new Error("column does not exist"))).toBe(false);
  });

  it("retries an init error only with a connectivity signal (not a permanent one)", () => {
    expect(
      isRetryableInfrastructureError(
        new Prisma.PrismaClientInitializationError("Can't reach database server", "6.14.0", "P1001")
      )
    ).toBe(true);
    expect(
      isRetryableInfrastructureError(
        new Prisma.PrismaClientInitializationError(
          "Authentication failed against database server",
          "6.14.0",
          "P1000"
        )
      )
    ).toBe(false);
  });

  it("never retries a Rust-engine panic", () => {
    expect(
      isRetryableInfrastructureError(new Prisma.PrismaClientRustPanicError("panic", "6.14.0"))
    ).toBe(false);
  });

  it("never retries a panic from the run-ops runtime, even with a connectivity-ish message", () => {
    // The run-ops client is a separately generated Prisma runtime, so its panic is not the
    // control-plane class. Recognised by name so it can never fall through to the message check.
    const foreignPanic = {
      name: "PrismaClientRustPanicError",
      message: "connection terminated: RUST PANIC in query engine",
    };
    expect(isRetryableInfrastructureError(foreignPanic)).toBe(false);
  });

  it("retries a run-ops-runtime known-request error by name + code, not instanceof", () => {
    const foreignKnown = { name: "PrismaClientKnownRequestError", code: "P1017", message: "" };
    expect(isRetryableInfrastructureError(foreignKnown)).toBe(true);
  });

  it("never retries pool exhaustion (P2024), even though its message looks like connectivity", () => {
    const poolMsg = "Timed out fetching a new connection from the connection pool";
    expect(isRetryableInfrastructureError(known("P2024", poolMsg))).toBe(false);
    expect(isRetryableInfrastructureError(new Error(poolMsg))).toBe(false);
    // The broad classifier still flags it (used for logging, not retry).
    expect(isInfrastructureError(new Error(poolMsg))).toBe(true);
  });

  it("retries the pg driver adapter's mid-statement connection-loss error", () => {
    // The adapter surfaces a killed-mid-statement connection as this unknown-request error; without
    // matching it, a blip during an in-flight statement is never retried.
    expect(
      isRetryableInfrastructureError(
        new Prisma.PrismaClientUnknownRequestError(
          "Client has encountered a connection error and is not queryable",
          { clientVersion: "6.14.0" }
        )
      )
    ).toBe(true);
  });

  it("retries the raw admin-shutdown 'terminating connection' error (pg 57P01)", () => {
    // The other shape a mid-statement backend kill produces on the adapter: the raw PostgreSQL
    // 57P01 fatal surfaced as an unknown-request error. Both shapes must be retryable.
    expect(
      isRetryableInfrastructureError(
        new Prisma.PrismaClientUnknownRequestError(
          "terminating connection due to administrator command",
          { clientVersion: "6.14.0" }
        )
      )
    ).toBe(true);
  });

  it("retries an unknown-request error only with a connectivity signal", () => {
    expect(
      isRetryableInfrastructureError(
        new Prisma.PrismaClientUnknownRequestError("connection terminated unexpectedly", {
          clientVersion: "6.14.0",
        })
      )
    ).toBe(true);
    expect(
      isRetryableInfrastructureError(
        new Prisma.PrismaClientUnknownRequestError("unexpected engine failure", {
          clientVersion: "6.14.0",
        })
      )
    ).toBe(false);
  });
});
