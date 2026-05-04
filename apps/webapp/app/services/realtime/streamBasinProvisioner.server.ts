/**
 * Per-org S2 basin provisioning.
 *
 * The webapp runs in two modes for realtime stream storage:
 *
 *  - **Single-basin mode** (OSS / s2-lite installs):
 *    `REALTIME_STREAMS_PER_ORG_BASINS_ENABLED=false`. All orgs share the
 *    basin in `REALTIME_STREAMS_S2_BASIN`. `Organization.streamBasinName`
 *    stays null forever; reads / writes resolve to the global basin.
 *
 *  - **Per-org-basin mode** (cloud):
 *    `REALTIME_STREAMS_PER_ORG_BASINS_ENABLED=true`. Each org gets a
 *    dedicated basin with retention tied to its billing plan. The
 *    basin is the unit of cost attribution (S2 exposes per-basin
 *    metrics) and isolation (access tokens scope to one basin).
 *
 * Provisioning is one-shot per org: at creation time (or a one-off
 * backfill for existing orgs) we create the basin and stamp
 * `Organization.streamBasinName`. New `TaskRun` / `Session` rows then
 * piggyback on the existing org read in `triggerTask` / session-create
 * paths and copy the value through. Reads use a precedence chain
 * (`run.streamBasinName ?? session.streamBasinName ?? globalBasin`).
 *
 * Plan changes update retention in-place via `reconfigureBasin`. We do
 * not move data across basins.
 */
import type { PrismaClientOrTransaction } from "~/db.server";
import { prisma } from "~/db.server";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";

/**
 * Plan-tier shorthand for retention mapping. Callers translate the
 * org's billing plan (via `getCurrentPlan`) into one of these and pass
 * it to the provisioner. New orgs (no plan yet) and unbilled orgs
 * default to `free` so we don't accidentally grant a year of retention
 * to a freeloader.
 */
export type StreamBasinTier = "free" | "hobby" | "pro";

export function retentionFor(tier: StreamBasinTier): string {
  switch (tier) {
    case "pro":
      return env.REALTIME_STREAMS_BASIN_RETENTION_PRO;
    case "hobby":
      return env.REALTIME_STREAMS_BASIN_RETENTION_HOBBY;
    case "free":
    default:
      return env.REALTIME_STREAMS_BASIN_RETENTION_FREE;
  }
}

/**
 * Permissive plan-name → tier mapping. Billing returns various strings
 * over time (`free_connected`, `hobby`, `team_pro`, `enterprise`, etc.)
 * — be forgiving but predictable.
 */
export function planTierFor(planType: string | null | undefined): StreamBasinTier {
  if (!planType) return "free";
  const normalized = planType.toLowerCase();
  if (normalized.includes("pro") || normalized.includes("team") || normalized.includes("enterprise")) {
    return "pro";
  }
  if (normalized.includes("hobby") || normalized.includes("starter")) {
    return "hobby";
  }
  return "free";
}

export function isPerOrgBasinsEnabled(): boolean {
  return env.REALTIME_STREAMS_PER_ORG_BASINS_ENABLED === "true";
}

/**
 * Build the basin name for an org. Format: `{prefix}-{env}-org-{slug}`
 * (e.g. `triggerdotdev-prod-org-acme-corp`). The org slug is already
 * lowercase-and-hyphenated by `createOrganization`, so it satisfies S2
 * basin-name rules without further normalization. We truncate
 * defensively to keep total length under 63 chars (a common bucket
 * convention; verify against S2 docs before raising).
 */
export function basinNameForOrg(org: { slug: string }): string {
  const prefix = env.REALTIME_STREAMS_BASIN_NAME_PREFIX;
  const envName = env.REALTIME_STREAMS_BASIN_NAME_ENV;
  const head = `${prefix}-${envName}-org-`;
  const budget = 63 - head.length;
  const slug = org.slug.slice(0, budget);
  return `${head}${slug}`;
}

type ProvisionInput = {
  id: string;
  slug: string;
  /// Caller decides the tier. Org-create path passes `"free"` for new
  /// orgs; the backfill worker resolves the tier via `getCurrentPlan`
  /// before calling. Defaults to `"free"` if omitted.
  tier?: StreamBasinTier;
  streamBasinName: string | null | undefined;
};

type ProvisionResult =
  | { kind: "skipped"; reason: "feature-disabled" | "already-provisioned"; basin: string | null }
  | { kind: "provisioned"; basin: string; retention: string };

/**
 * Idempotent: if the org already has `streamBasinName`, returns the
 * existing value without contacting S2. Otherwise creates the basin
 * (S2 returns 409 on race with another caller — we treat that as
 * success) and writes the column.
 *
 * Failure modes:
 *  - S2 unreachable / 5xx: throws. Callers in the org-create path
 *    should swallow + enqueue a retry job so signup never fails on a
 *    transient S2 outage. The backfill worker retries naturally.
 *  - Auth misconfig (no token): throws. Should never happen in
 *    per-org-basins mode but worth surfacing loudly.
 */
export async function provisionBasinForOrg(
  org: ProvisionInput,
  prismaClient: PrismaClientOrTransaction = prisma
): Promise<ProvisionResult> {
  if (!isPerOrgBasinsEnabled()) {
    return { kind: "skipped", reason: "feature-disabled", basin: null };
  }

  if (org.streamBasinName) {
    return { kind: "skipped", reason: "already-provisioned", basin: org.streamBasinName };
  }

  const accessToken = env.REALTIME_STREAMS_S2_ACCESS_TOKEN;
  if (!accessToken) {
    throw new Error(
      "REALTIME_STREAMS_S2_ACCESS_TOKEN must be set when REALTIME_STREAMS_PER_ORG_BASINS_ENABLED=true"
    );
  }

  const basin = basinNameForOrg(org);
  const retention = retentionFor(org.tier ?? "free");

  await s2CreateBasin(basin, {
    accessToken,
    retentionPolicy: retention,
    storageClass: env.REALTIME_STREAMS_BASIN_STORAGE_CLASS,
    deleteOnEmptyMinAge: env.REALTIME_STREAMS_BASIN_DELETE_ON_EMPTY_MIN_AGE,
  });

  await prismaClient.organization.update({
    where: { id: org.id },
    data: { streamBasinName: basin },
  });

  logger.info("[streamBasinProvisioner] provisioned basin for org", {
    orgId: org.id,
    basin,
    retention,
  });

  return { kind: "provisioned", basin, retention };
}

/**
 * Update retention after a plan change. Idempotent. No-op when the
 * org has no provisioned basin. Caller resolves the tier and passes
 * it in — keeps the provisioner ignorant of billing.
 */
export async function reconfigureBasinForOrg(
  orgId: string,
  tier: StreamBasinTier
): Promise<void> {
  if (!isPerOrgBasinsEnabled()) return;

  const accessToken = env.REALTIME_STREAMS_S2_ACCESS_TOKEN;
  if (!accessToken) return;

  const org = await prisma.organization.findFirst({
    where: { id: orgId },
    select: { id: true, streamBasinName: true },
  });
  if (!org?.streamBasinName) return;

  const retention = retentionFor(tier);
  await s2ReconfigureBasin(org.streamBasinName, { accessToken, retentionPolicy: retention });

  logger.info("[streamBasinProvisioner] reconfigured basin retention", {
    orgId,
    basin: org.streamBasinName,
    retention,
  });
}

// ---------- S2 REST ----------
//
// Account-level API: `POST /v1/basins` to create, `PATCH /v1/basins/{name}`
// to reconfigure. The wire shape uses integer seconds for durations
// (`retention_policy.age`, `delete_on_empty.min_age_secs`) — the human
// strings (`7d`, `30d`, `1y`) are env-var ergonomics that we parse on
// the way out.

type CreateBasinOptions = {
  accessToken: string;
  retentionPolicy: string; // e.g. "7d", "30d", "365d"
  storageClass: "express" | "standard";
  deleteOnEmptyMinAge: string; // e.g. "1h"
};

async function s2CreateBasin(name: string, opts: CreateBasinOptions): Promise<void> {
  const url = `https://aws.s2.dev/v1/basins`;
  const body = {
    basin: name,
    config: {
      create_stream_on_append: true,
      create_stream_on_read: true,
      default_stream_config: {
        storage_class: opts.storageClass,
        retention_policy: { age: durationToSeconds(opts.retentionPolicy) },
        delete_on_empty: { min_age_secs: durationToSeconds(opts.deleteOnEmptyMinAge) },
      },
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  // 200/201 = created. 409 = basin already exists (race with another
  // caller, or a previous run that crashed after S2 ack but before our
  // column write committed) — treat as success.
  if (res.ok || res.status === 409) return;

  const text = await res.text().catch(() => "");
  throw new Error(`S2 createBasin failed: ${res.status} ${res.statusText} ${text}`);
}

type ReconfigureBasinOptions = {
  accessToken: string;
  retentionPolicy: string;
};

async function s2ReconfigureBasin(name: string, opts: ReconfigureBasinOptions): Promise<void> {
  const url = `https://aws.s2.dev/v1/basins/${encodeURIComponent(name)}`;
  const body = {
    default_stream_config: {
      retention_policy: { age: durationToSeconds(opts.retentionPolicy) },
    },
  };

  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${opts.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (res.ok) return;

  const text = await res.text().catch(() => "");
  throw new Error(`S2 reconfigureBasin failed: ${res.status} ${res.statusText} ${text}`);
}

/**
 * Parse a short duration string (e.g. `7d`, `30d`, `365d`, `1h`, `90m`,
 * `45s`, `2w`) into seconds. Tolerant of `7days` and `1week` forms too.
 * Throws on garbage so a misconfigured env var fails loudly at first use.
 */
function durationToSeconds(input: string): number {
  const trimmed = input.trim().toLowerCase();
  const match = trimmed.match(/^(\d+)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hour|hours?|d|day|days?|w|week|weeks?|y|year|years?)$/);
  if (!match) {
    throw new Error(`Invalid duration string: ${input}`);
  }
  const value = parseInt(match[1]!, 10);
  const unit = match[2]!;
  const multiplier =
    /^s/.test(unit) ? 1
    : /^m(?:in|ins|inute|inutes)?$/.test(unit) ? 60
    : /^h/.test(unit) ? 3600
    : /^d/.test(unit) ? 86400
    : /^w/.test(unit) ? 604800
    : /^y/.test(unit) ? 31_536_000
    : NaN;
  if (!Number.isFinite(multiplier)) {
    throw new Error(`Invalid duration unit: ${unit}`);
  }
  return value * multiplier;
}
