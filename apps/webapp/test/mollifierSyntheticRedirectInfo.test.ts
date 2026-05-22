import { describe, expect, vi } from "vitest";
import { redisTest } from "@internal/testcontainers";
import { MollifierBuffer } from "@trigger.dev/redis-worker";

vi.mock("~/db.server", () => ({ prisma: {}, $replica: {} }));

import { findBufferedRunRedirectInfo } from "~/v3/mollifier/syntheticRedirectInfo.server";

const SNAPSHOT = {
  spanId: "span_1",
  environment: {
    slug: "dev",
    project: { slug: "hello-world-bN7m" },
    organization: { slug: "references-6120" },
  },
};

function fakePrisma(member: { id: string } | null) {
  return {
    orgMember: { findFirst: vi.fn(async () => member) },
  } as unknown as Parameters<typeof findBufferedRunRedirectInfo>[1]["prismaClient"];
}

describe("findBufferedRunRedirectInfo (testcontainers)", () => {
  redisTest("returns slugs + spanId for a real buffer entry when user is a member", async ({ redisOptions }) => {
    const buffer = new MollifierBuffer({ redisOptions });
    try {
      await buffer.accept({
        runId: "run_real_1",
        envId: "env_a",
        orgId: "org_1",
        payload: JSON.stringify(SNAPSHOT),
      });
      const info = await findBufferedRunRedirectInfo(
        { runFriendlyId: "run_real_1", userId: "user_1" },
        { getBuffer: () => buffer, prismaClient: fakePrisma({ id: "member_1" }) },
      );
      expect(info).toEqual({
        organizationSlug: "references-6120",
        projectSlug: "hello-world-bN7m",
        environmentSlug: "dev",
        spanId: "span_1",
      });
    } finally {
      await buffer.close();
    }
  });

  redisTest("returns null when no buffer entry exists for the runId", async ({ redisOptions }) => {
    const buffer = new MollifierBuffer({ redisOptions });
    try {
      const info = await findBufferedRunRedirectInfo(
        { runFriendlyId: "run_missing", userId: "user_1" },
        { getBuffer: () => buffer, prismaClient: fakePrisma({ id: "member_1" }) },
      );
      expect(info).toBeNull();
    } finally {
      await buffer.close();
    }
  });

  redisTest("returns null when the user is not an org member (default check enforced)", async ({ redisOptions }) => {
    const buffer = new MollifierBuffer({ redisOptions });
    try {
      await buffer.accept({
        runId: "run_real_2",
        envId: "env_a",
        orgId: "org_1",
        payload: JSON.stringify(SNAPSHOT),
      });
      const info = await findBufferedRunRedirectInfo(
        { runFriendlyId: "run_real_2", userId: "user_other" },
        { getBuffer: () => buffer, prismaClient: fakePrisma(null) },
      );
      expect(info).toBeNull();
    } finally {
      await buffer.close();
    }
  });

  redisTest("skips the org-membership check when skipOrgMembershipCheck is set (admin path)", async ({ redisOptions }) => {
    const buffer = new MollifierBuffer({ redisOptions });
    try {
      await buffer.accept({
        runId: "run_real_3",
        envId: "env_a",
        orgId: "org_1",
        payload: JSON.stringify(SNAPSHOT),
      });
      const findFirst = vi.fn();
      const info = await findBufferedRunRedirectInfo(
        { runFriendlyId: "run_real_3", userId: "user_admin", skipOrgMembershipCheck: true },
        {
          getBuffer: () => buffer,
          prismaClient: { orgMember: { findFirst } } as unknown as Parameters<typeof findBufferedRunRedirectInfo>[1]["prismaClient"],
        },
      );
      expect(info?.organizationSlug).toBe("references-6120");
      expect(findFirst).not.toHaveBeenCalled();
    } finally {
      await buffer.close();
    }
  });

  redisTest("returns null when snapshot is malformed JSON", async ({ redisOptions }) => {
    const buffer = new MollifierBuffer({ redisOptions });
    try {
      await buffer.accept({
        runId: "run_real_4",
        envId: "env_a",
        orgId: "org_1",
        payload: "{not-json",
      });
      const info = await findBufferedRunRedirectInfo(
        { runFriendlyId: "run_real_4", userId: "user_1" },
        { getBuffer: () => buffer, prismaClient: fakePrisma({ id: "member_1" }) },
      );
      expect(info).toBeNull();
    } finally {
      await buffer.close();
    }
  });

  redisTest("returns null when snapshot lacks org/project slugs", async ({ redisOptions }) => {
    const buffer = new MollifierBuffer({ redisOptions });
    try {
      await buffer.accept({
        runId: "run_real_5",
        envId: "env_a",
        orgId: "org_1",
        payload: JSON.stringify({ spanId: "s", environment: { slug: "dev" } }),
      });
      const info = await findBufferedRunRedirectInfo(
        { runFriendlyId: "run_real_5", userId: "user_1" },
        { getBuffer: () => buffer, prismaClient: fakePrisma({ id: "member_1" }) },
      );
      expect(info).toBeNull();
    } finally {
      await buffer.close();
    }
  });

  redisTest("returns info with undefined spanId when snapshot has no spanId", async ({ redisOptions }) => {
    const buffer = new MollifierBuffer({ redisOptions });
    try {
      await buffer.accept({
        runId: "run_real_6",
        envId: "env_a",
        orgId: "org_1",
        payload: JSON.stringify({ environment: SNAPSHOT.environment }),
      });
      const info = await findBufferedRunRedirectInfo(
        { runFriendlyId: "run_real_6", userId: "user_1" },
        { getBuffer: () => buffer, prismaClient: fakePrisma({ id: "member_1" }) },
      );
      expect(info?.spanId).toBeUndefined();
      expect(info?.environmentSlug).toBe("dev");
    } finally {
      await buffer.close();
    }
  });
});
