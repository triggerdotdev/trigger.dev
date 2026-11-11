import { generateInternalId } from "@trigger.dev/core/v3/isomorphic";
import { type Prisma, PrismaClient } from "@trigger.dev/database";
import { setTimeout } from "node:timers/promises";
import { expect } from "vitest";
import type { RunEngineOptions } from "../../types.js";

// A PrismaClient whose Organization queries are counted from its query events. Prisma emits them in
// execution order, so once a marker query's event arrives every earlier query has been counted.
export function organizationQueryCounter(uri: string) {
  const client = new PrismaClient({
    datasources: { db: { url: uri } },
    log: [{ emit: "event", level: "query" }],
  });
  let organizationQueries = 0;
  const markers = new Set<string>();
  client.$on("query", (event: Prisma.QueryEvent) => {
    if (event.query.includes('"Organization"')) organizationQueries++;
    for (const marker of markers) if (event.query.includes(marker)) markers.delete(marker);
  });
  async function settle() {
    const marker = `lookup_marker_${generateInternalId()}`;
    markers.add(marker);
    await client.$queryRawUnsafe(`SELECT 1 AS "${marker}"`);
    for (let i = 0; i < 500 && markers.has(marker); i++) await setTimeout(10);
    expect(markers.has(marker)).toBe(false);
  }
  return {
    client,
    async measure<T>(fn: () => Promise<T>): Promise<{ result: T; lookups: number }> {
      await settle();
      const before = organizationQueries;
      const result = await fn();
      await settle();
      return { result, lookups: organizationQueries - before };
    },
  };
}

// An org-scoped flag resolver with the deployed cost: one Organization read per evaluation, unless the
// caller passes the org's flags. Only an org override of `true` enables; there is no global default.
export function organizationFlagResolver(
  client: PrismaClient
): NonNullable<RunEngineOptions["waitpointStoreEnabled"]> {
  return async (organizationId, organizationFlags) => {
    const flags =
      organizationFlags !== undefined
        ? organizationFlags
        : (
            await client.organization.findFirst({
              where: { id: organizationId },
              select: { featureFlags: true },
            })
          )?.featureFlags;
    return (
      typeof flags === "object" &&
      flags !== null &&
      "waitpointStoreEnabled" in flags &&
      flags.waitpointStoreEnabled === true
    );
  };
}
