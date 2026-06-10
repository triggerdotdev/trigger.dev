import { describe, expect, it } from "vitest";
import { Prisma } from "@trigger.dev/database";
import { isInfrastructureError } from "../app/utils/prismaErrors.js";

describe("isInfrastructureError", () => {
  it("treats a P1001 'can't reach database server' (KnownRequestError) as infrastructure", () => {
    // Prisma 6.x reports P1001 as a PrismaClientKnownRequestError with code P1001 —
    // this is the exact production shape that leaked the RDS hostname to a customer.
    const err = new Prisma.PrismaClientKnownRequestError(
      "Invalid `prisma.project.findFirst()` invocation: Can't reach database server at host:5432",
      { code: "P1001", clientVersion: "6.14.0" }
    );
    expect(isInfrastructureError(err)).toBe(true);
  });

  it("treats a PrismaClientInitializationError as infrastructure", () => {
    const err = new Prisma.PrismaClientInitializationError("init failed", "6.14.0");
    expect(isInfrastructureError(err)).toBe(true);
  });

  it("does NOT treat a query/validation error (P2002 unique constraint) as infrastructure", () => {
    const err = new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
      code: "P2002",
      clientVersion: "6.14.0",
    });
    expect(isInfrastructureError(err)).toBe(false);
  });

  it("does NOT treat a plain domain Error as infrastructure", () => {
    expect(isInfrastructureError(new Error("Project not found."))).toBe(false);
  });
});
