// A TYPE-LEVEL test: it must COMPILE. It proves a RunOpsPrismaClient can back a
// PostgresRunStore that satisfies the RunStore interface, alongside the legacy client.
import { expectTypeOf, it } from "vitest";
import type { PrismaClient } from "@trigger.dev/database";
import type { RunOpsPrismaClient } from "@internal/run-ops-database";
import { PostgresRunStore } from "./PostgresRunStore.js";
import type { RunStore } from "./types.js";

it("both clients can back a RunStore", () => {
  // These are type-only assertions; no runtime DB needed.
  const legacy = null as unknown as PrismaClient;
  const dedicated = null as unknown as RunOpsPrismaClient;
  const a: RunStore = new PostgresRunStore({ prisma: legacy, readOnlyPrisma: legacy });
  const b: RunStore = new PostgresRunStore({ prisma: dedicated, readOnlyPrisma: dedicated });
  expectTypeOf(a).toMatchTypeOf<RunStore>();
  expectTypeOf(b).toMatchTypeOf<RunStore>();
});
