import { expect, it, vi } from "vitest";

/**
 * Self-hosted runs the RBAC fallback, where a PAT gets a blanket ability. A delegated token must
 * not: the env JWT it exchanges for carries scopes with no role context, so the actor's own
 * ability is the only ceiling left. Were the fallback permissive here, the agent's read-only cap
 * would buy a write JWT.
 */

vi.mock("~/db.server", () => ({ prisma: {}, $replica: {} }));

import plugin, { signUserActorToken } from "@trigger.dev/rbac";
import type { PrismaClient } from "@trigger.dev/database";
import { clampUserActorScopes } from "~/services/userActorEnvironment.server";

const SECRET = "test-secret-for-delegated-scope-ceiling";
const AGENT_CAP = ["read:apiKeys", "read:runs", "read:deployments"];

function fallbackController() {
  return plugin.create({ primary: {} as PrismaClient, replica: {} as PrismaClient }, {
    forceFallback: true,
    userActorSecret: SECRET,
  } as any);
}

async function abilityFor(cap?: string[]) {
  const token = await signUserActorToken(SECRET, {
    userId: "usr_1",
    client: "dashboard-agent",
    environmentId: "env_1",
    ...(cap ? { cap } : {}),
  });
  const result = await fallbackController().authenticateUserActor(
    new Request("https://api.trigger.dev/api/v1/test", {
      headers: { Authorization: `Bearer ${token}` },
    }),
    {}
  );

  if (!result.ok) throw new Error("the fallback rejected the token");
  return { ability: result.ability, claims: { userId: "usr_1", client: "dashboard-agent", cap } };
}

it("refuses a write scope the agent's cap doesn't carry", async () => {
  const { ability, claims } = await abilityFor(AGENT_CAP);

  const clamped = clampUserActorScopes(["write:runs"], claims, ability);

  expect(clamped.scopes).toEqual([]);
  expect(clamped.deniedScopes).toContain("write:runs");
});

it("still hands over the reads the cap does carry", async () => {
  const { ability, claims } = await abilityFor(AGENT_CAP);

  const clamped = clampUserActorScopes(["read:runs"], claims, ability);

  expect(clamped.scopes).toEqual(["read:runs"]);
});

it("refuses a write the cap forbids even when the user's role allows it", async () => {
  // The cloud path builds the ability from the user's role, not from the token's cap —
  // so the role alone would hand a read-only agent token a write JWT.
  const { claims } = await abilityFor(AGENT_CAP);
  const roleAllowsEverything = { can: () => true, canSuper: () => false } as never;

  const clamped = clampUserActorScopes(["write:runs"], claims, roleAllowsEverything);

  expect(clamped.scopes).toEqual([]);
  expect(clamped.deniedScopes).toContain("write:runs");
});

it("keeps a capless delegated token read-only", async () => {
  const { ability, claims } = await abilityFor();

  expect(clampUserActorScopes(["write:runs"], claims, ability).scopes).toEqual([]);
  expect(clampUserActorScopes(undefined, claims, ability).scopes).toEqual(["read:all"]);
});
