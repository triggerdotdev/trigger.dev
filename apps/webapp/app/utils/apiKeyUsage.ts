import {
  type ApiKeyCapability,
  type ApiKeyCapabilityCatalogue,
  type ApiKeyCapabilityMap,
  type ApiKeyCapabilityUsage,
  type ApiKeyNarrowBlocker,
  apiKeyCapabilitiesEqual,
  NO_ACCESS_LEVEL_ID,
} from "@trigger.dev/plugins";

export const API_KEY_USAGE_WINDOW_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

export type ApiKeyUsageView = {
  trackedSince: Date;
  windowDays: number;
  capabilities: Record<string, ApiKeyCapabilityUsage>;
  narrowTo: ApiKeyCapabilityMap | null;
  narrowBlocker?: ApiKeyNarrowBlocker;
};

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function daysAgo(value: Date | string, now: number): number {
  return Math.max(0, Math.floor((now - toDate(value).getTime()) / DAY_MS));
}

function when(value: Date | string, now: number): string {
  const days = daysAgo(value, now);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

function trackingStartDate(value: Date | string): string {
  return toDate(value).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function inWindow(value: Date | string | null, view: ApiKeyUsageView, now: number): boolean {
  return value !== null && daysAgo(value, now) < view.windowDays;
}

function levelLabelOf(capability: ApiKeyCapability, levelId: string | null | undefined): string {
  return capability.levels.find((level) => level.id === levelId)?.label ?? "None";
}

export type CapabilityUsageLine = { label: string; lastUsedAt: Date | null };

export function capabilityUsageLine(
  capability: ApiKeyCapability,
  grantedLevelId: string | undefined,
  view: ApiKeyUsageView
): CapabilityUsageLine {
  const usage = view.capabilities[capability.id];
  const lastUsedAt = usage?.lastUsedAt ? toDate(usage.lastUsedAt) : null;
  if (
    !lastUsedAt ||
    !grantedLevelId ||
    !usage?.usedLevelId ||
    usage.usedLevelId === grantedLevelId
  ) {
    return { label: "Last used", lastUsedAt };
  }
  return { label: `${levelLabelOf(capability, usage.usedLevelId)} last used`, lastUsedAt };
}

export function lossNote(
  capability: ApiKeyCapability,
  toLevelId: string,
  view: ApiKeyUsageView,
  now: number
): string {
  const usage = view.capabilities[capability.id];
  if (usage?.usedLevelId && usage.lastUsedAt && inWindow(usage.lastUsedAt, view, now)) {
    const kept = capability.levels.find((level) => level.id === toLevelId)?.scopes ?? [];
    const used = capability.levels.find((level) => level.id === usage.usedLevelId)?.scopes ?? [];
    return used.every((scope) => kept.includes(scope))
      ? "still covers what it used"
      : `${levelLabelOf(capability, usage.usedLevelId)} used ${when(usage.lastUsedAt, now)}`;
  }
  if (usage?.lastUsedAt) return `last used ${when(usage.lastUsedAt, now)}`;
  return `never used since tracking started ${trackingStartDate(view.trackedSince)}`;
}

export type NarrowToUsage =
  | { ok: true; capabilities: ApiKeyCapabilityMap }
  | { ok: false; reason: string };

export function narrowToUsage(params: {
  view: ApiKeyUsageView;
  catalogue: ApiKeyCapabilityCatalogue;
  capabilities: ApiKeyCapabilityMap | undefined;
  fullAccess: boolean;
}): NarrowToUsage {
  const { view, catalogue, capabilities, fullAccess } = params;
  if (!catalogue.available) {
    return { ok: false, reason: "Narrowing makes a restricted key, which needs the Pro plan." };
  }
  const blocker = view.narrowBlocker;
  if (blocker?.kind === "tooLittleHistory") {
    return { ok: false, reason: `Narrowing needs ${blocker.minimumDays} days of usage.` };
  }
  if (blocker?.kind === "usedUnrestrictedRoutes") {
    return {
      ok: false,
      reason: `It called endpoints only full-access keys can use in the last ${view.windowDays} days, so a narrower key would break.`,
    };
  }
  if (blocker?.kind === "usedOutsideCatalogue") {
    return {
      ok: false,
      reason: `It used access the grid doesn't cover: ${blocker.scopes.join(", ")}.`,
    };
  }
  if (!view.narrowTo) return { ok: false, reason: "Usage isn't available for this key." };
  if (Object.keys(view.narrowTo).length === 0) {
    return { ok: false, reason: `It hasn't been used in the last ${view.windowDays} days.` };
  }
  if (!fullAccess && apiKeyCapabilitiesEqual(view.narrowTo, capabilities ?? {})) {
    return { ok: false, reason: `It used all of its access in the last ${view.windowDays} days.` };
  }
  return { ok: true, capabilities: view.narrowTo };
}

export function fullAccessCapabilities(catalogue: ApiKeyCapabilityCatalogue): ApiKeyCapabilityMap {
  return Object.fromEntries(
    catalogue.capabilities.flatMap((capability) => {
      const top = capability.levels[capability.levels.length - 1];
      return top && top.id !== NO_ACCESS_LEVEL_ID ? [[capability.id, top.id]] : [];
    })
  );
}
