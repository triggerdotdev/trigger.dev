import { describe, expect } from "vitest";
import { postgresTest } from "@internal/testcontainers";
import { createWaitpointStoreEnabledResolver } from "~/v3/utils/waitpointStoreEnabled.server";

describe("waitpoint rollout", () => {
  postgresTest(
    "waitpoint enrollment uses ordinary org flags, global fallback, and immediate rollback",
    async ({ prisma }) => {
      const org = await prisma.organization.create({
        data: { title: "Waitpoints", slug: "waitpoints" },
      });
      let global: { waitpointStoreEnabled?: boolean } | undefined;
      const enabled = createWaitpointStoreEnabledResolver(() => global, prisma);
      expect(await enabled(org.id)).toBe(false);
      await prisma.organization.update({
        where: { id: org.id },
        data: { featureFlags: { waitpointStoreEnabled: true } },
      });
      expect(await enabled(org.id)).toBe(true);
      global = { waitpointStoreEnabled: false };
      expect(await enabled(org.id)).toBe(true);
      await prisma.organization.update({
        where: { id: org.id },
        data: { featureFlags: { waitpointStoreEnabled: false } },
      });
      global = { waitpointStoreEnabled: true };
      expect(await enabled(org.id)).toBe(false);
      expect(await enabled(org.id, {})).toBe(true);
      expect(await enabled(org.id, { waitpointStoreEnabled: false })).toBe(false);
      global = { waitpointStoreEnabled: false };
      expect(await enabled(org.id)).toBe(false);
      expect(await prisma.featureFlag.count()).toBe(0);
    }
  );
});
