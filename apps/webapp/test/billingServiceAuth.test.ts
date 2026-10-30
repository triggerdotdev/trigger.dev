import { beforeEach, describe, expect, vi } from "vitest";

const SECRET = "billing-service-secret-0123456789abcdef";

const db = vi.hoisted(() => ({ client: null as any }));
const env = vi.hoisted(() => ({
  SESSION_SECRET: "test-session-secret-for-billing-service-auth",
  ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
  BILLING_SERVICE_SECRET: undefined as string | undefined,
}));

vi.mock("~/db.server", () => ({
  get prisma() {
    return db.client;
  },
  get $replica() {
    return db.client;
  },
}));
vi.mock("~/env.server", () => ({ env }));
vi.mock("~/services/logger.server", () => ({
  logger: { debug: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
vi.mock("~/services/rbac.server", () => ({
  rbac: { isUsingPlugin: async () => false, setTokenRole: async () => ({ ok: true }) },
}));

import { postgresTest } from "@internal/testcontainers";
import { requireBillingServiceOrAdminApiRequest } from "~/services/billingServiceAuth.server";
import {
  createPersonalAccessToken,
  requireAdminApiRequest,
} from "~/services/personalAccessToken.server";

vi.setConfig({ testTimeout: 60_000 });

let userCounter = 0;

async function patFor(prisma: any, admin: boolean) {
  userCounter += 1;
  const user = await prisma.user.create({
    data: {
      email: `billing-service-auth-${userCounter}-${Date.now()}@example.com`,
      authenticationMethod: "MAGIC_LINK",
      admin,
    },
  });
  const pat = await createPersonalAccessToken({ name: "test", userId: user.id });
  return (pat as { token: string }).token;
}

function bearer(token: string) {
  return new Request("http://localhost/admin/api/v1/orgs/org_1/runs/enable", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
}

async function statusOf(guard: Promise<unknown>) {
  try {
    await guard;
    return 200;
  } catch (error) {
    if (error instanceof Response) return error.status;
    throw error;
  }
}

describe("billing service admin API auth", () => {
  beforeEach(() => {
    env.BILLING_SERVICE_SECRET = SECRET;
  });

  /** Catches: billing's calls failing once the secret is configured. */
  postgresTest("billing routes accept the billing service secret", async ({ prisma }) => {
    db.client = prisma;
    expect(await statusOf(requireBillingServiceOrAdminApiRequest(bearer(SECRET)))).toBe(200);
  });

  /** Catches: admins losing access to the billing routes, or the fallback accepting any user's PAT. */
  postgresTest("billing routes still take admin PATs and refuse others", async ({ prisma }) => {
    db.client = prisma;
    const adminPat = await patFor(prisma, true);
    const userPat = await patFor(prisma, false);

    expect(await statusOf(requireBillingServiceOrAdminApiRequest(bearer(adminPat)))).toBe(200);
    expect(await statusOf(requireBillingServiceOrAdminApiRequest(bearer(userPat)))).toBe(403);
  });

  /** Catches: a near-match of the secret being accepted. */
  postgresTest("billing routes refuse a wrong secret", async ({ prisma }) => {
    db.client = prisma;
    expect(await statusOf(requireBillingServiceOrAdminApiRequest(bearer(`${SECRET}x`)))).toBe(401);
  });

  /** Catches: installs without billing accepting a bearer value because no secret is configured. */
  postgresTest("the secret does nothing when it isn't configured", async ({ prisma }) => {
    db.client = prisma;
    env.BILLING_SERVICE_SECRET = undefined;
    expect(await statusOf(requireBillingServiceOrAdminApiRequest(bearer(SECRET)))).toBe(401);
  });

  /** Catches: the billing secret working as an admin credential on the other admin routes. */
  postgresTest("other admin routes refuse the secret", async ({ prisma }) => {
    db.client = prisma;
    expect(await statusOf(requireAdminApiRequest(bearer(SECRET)))).toBe(401);
  });
});
