import { json, redirect } from "@remix-run/server-runtime";
import { $replica, prisma } from "~/db.server";
import { env } from "~/env.server";
import { v3ProjectAlertsPath } from "~/utils/pathBuilder";
import { FEATURE_FLAG } from "~/v3/featureFlags";
import { makeFlag } from "~/v3/featureFlags.server";
import { computeCanUseAlertsList, isAlertsEnabledEnv } from "./canUseAlertsList";
import { isAlertsConfigured } from "./services/alerts/alertsConfigured.server";

async function isAlertsFlagEnabled(
  orgFeatureFlags: Record<string, unknown> | null | undefined
): Promise<boolean> {
  const flag = makeFlag();
  const flagResult = await flag({
    key: FEATURE_FLAG.alertsEnabled,
    defaultValue: isAlertsEnabledEnv(env.ALERTS_ENABLED),
    overrides: orgFeatureFlags ?? {},
  });
  return Boolean(flagResult);
}

const ORG_FLAG_TTL_MS = 30_000;
const orgFlagCache = new Map<string, { value: boolean; expiresAt: number }>();

export async function isOrganizationAlertsEnabled(organizationId: string): Promise<boolean> {
  const hit = orgFlagCache.get(organizationId);
  if (hit && hit.expiresAt > Date.now()) return hit.value;

  const org = await $replica.organization.findFirst({
    where: { id: organizationId },
    select: { featureFlags: true },
  });
  const value = org
    ? await isAlertsFlagEnabled(org.featureFlags as Record<string, unknown> | null)
    : false;
  if (orgFlagCache.size > 10_000) orgFlagCache.clear();
  orgFlagCache.set(organizationId, { value, expiresAt: Date.now() + ORG_FLAG_TTL_MS });
  return value;
}

export async function canUseAlertsList(options: {
  orgFeatureFlags: Record<string, unknown> | null | undefined;
  user?: { admin: boolean } | null;
  userId?: string;
}): Promise<boolean> {
  const flagResult = await isAlertsFlagEnabled(options.orgFeatureFlags);

  let isAdmin = options.user?.admin ?? false;
  if (!options.user && options.userId) {
    const user = await prisma.user.findFirst({
      where: { id: options.userId },
      select: { admin: true },
    });
    isAdmin = user?.admin ?? false;
  }

  return computeCanUseAlertsList(
    Boolean(flagResult),
    isAdmin,
    isAlertsConfigured({ alertsEnabled: env.ALERTS_ENABLED })
  );
}

type AlertsGateParams = {
  organizationSlug: string;
  projectParam: string;
  envParam: string;
};

export async function canUseAlertsListForSlug(userId: string, organizationSlug: string) {
  const org = await $replica.organization.findFirst({
    where: { slug: organizationSlug, members: { some: { userId } } },
    select: { featureFlags: true },
  });
  if (!org) return false;
  return canUseAlertsList({
    orgFeatureFlags: (org.featureFlags as Record<string, unknown>) ?? {},
    userId,
  });
}

export async function requireAlertsEnabledOrRedirect(userId: string, params: AlertsGateParams) {
  if (!(await canUseAlertsListForSlug(userId, params.organizationSlug))) {
    throw redirect(
      v3ProjectAlertsPath(
        { slug: params.organizationSlug },
        { slug: params.projectParam },
        { slug: params.envParam }
      )
    );
  }
}

export async function requireAlertsEnabledOrForbid(userId: string, organizationSlug: string) {
  if (!(await canUseAlertsListForSlug(userId, organizationSlug))) {
    throw json({ error: "Alerts not enabled" }, { status: 403 });
  }
}
