import { describe, expect, it } from "vitest";
import { Prisma } from "@trigger.dev/database";
import { LockAcquisitionTimeoutError } from "@internal/run-engine";
import { continueRunErrorResponse } from "./continueRunErrors.server";

function prismaError(code: string) {
  return new Prisma.PrismaClientKnownRequestError(`prisma error ${code}`, {
    code,
    clientVersion: "test",
  });
}

async function respond(error: unknown, retryableErrors: boolean) {
  const response = continueRunErrorResponse(error, { retryableErrors });
  return response ? { status: response.status, body: await response.json() } : undefined;
}

const lockTimeout = new LockAcquisitionTimeoutError(["run_1"], 15_000, 10);
const unreachable = prismaError("P1001");
const mismatch = new Error("Snapshot ID doesn't match the latest snapshot in continueRunExecution");

const temporary = { status: 503, body: { error: "Temporarily unable to continue run execution" } };

describe("continueRunErrorResponse", () => {
  describe("with temporary-error retries on", () => {
    it.each(["P2024", "P2028", "P2034"])("returns 503 for %s", async (code) => {
      expect(await respond(prismaError(code), true)).toEqual(temporary);
    });

    it("returns 503 for an infrastructure error, with no database details", async () => {
      expect(await respond(unreachable, true)).toEqual(temporary);
    });

    it("returns 409 when the run lock is busy", async () => {
      expect(await respond(lockTimeout, true)).toEqual({
        status: 409,
        body: { error: "Run is busy, try again" },
      });
    });

    it("returns 422 with the error message for anything else", async () => {
      expect(await respond(mismatch, true)).toEqual({
        status: 422,
        body: { error: mismatch.message },
      });
      expect(await respond(prismaError("P2002"), true)).toEqual({
        status: 422,
        body: { error: "prisma error P2002" },
      });
    });

    it("returns 422 with a generic message for something that isn't an Error", async () => {
      expect(await respond("not an error", true)).toEqual({
        status: 422,
        body: { error: "Failed to continue run execution" },
      });
    });
  });

  describe("with temporary-error retries off", () => {
    it("lets an infrastructure error reach the generic 500 handler, as today", async () => {
      expect(await respond(unreachable, false)).toBeUndefined();
    });

    it("returns 422 for everything else, as today", async () => {
      expect(await respond(prismaError("P2028"), false)).toEqual({
        status: 422,
        body: { error: "prisma error P2028" },
      });
      expect(await respond(lockTimeout, false)).toMatchObject({ status: 422 });
      expect(await respond(mismatch, false)).toEqual({
        status: 422,
        body: { error: mismatch.message },
      });
    });
  });
});
