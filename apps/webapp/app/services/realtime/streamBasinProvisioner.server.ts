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
 *  - **Per-org-basin mode**:
 *    `REALTIME_STREAMS_PER_ORG_BASINS_ENABLED=true`. Each org gets a
 *    dedicated basin with its own retention. The basin is the unit of
 *    cost attribution (S2 exposes per-basin metrics) and isolation
 *    (access tokens scope to one basin).
 *
 * This module is purely retention-string-driven: callers pass a
 * duration like `"30d"` and the provisioner does the S2 round-trip.
 * It has no concept of plans / tiers / billing — operators that want
 * per-tier retention live one layer up (see
 * `streamBasinRetentionByPlan.server.ts`).
 *
 * Provisioning is one-shot per org: at creation time (or via the
 * backfill worker job for existing orgs) we create the basin and stamp
 * `Organization.streamBasinName`. New `TaskRun` / `Session` rows then
 * piggyback on the existing org read in `triggerTask` / session-create
 * paths and copy the value through. Reads use a precedence chain
 * (`run.streamBasinName ?? session.streamBasinName ?? globalBasin`).
 *
 * Plan / retention changes update retention in-place via
 * `reconfigureBasin`. We do not move data across basins.
 */
import type { PrismaClientOrTransaction } from "~/db.server";
import { prisma } from "~/db.server";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";

export function isPerOrgBasinsEnabled(): boolean {
  return env.REALTIME_STREAMS_PER_ORG_BASINS_ENABLED === "true";
}

/**
 * Default retention for new orgs and any caller that doesn't specify
 * a value. Configurable via `REALTIME_STREAMS_BASIN_DEFAULT_RETENTION`.
 */
export function defaultRetention(): string {
  return env.REALTIME_STREAMS_BASIN_DEFAULT_RETENTION;
}

/**
 * Build the basin name for an org. Format: `{prefix}-{env}-org-{slug}`.
 * The org slug is already lowercase-and-hyphenated by
 * `createOrganization`, so it satisfies S2 basin-name rules without
 * further normalization. We truncate defensively to keep total length
 * under 63 chars (a common bucket convention; verify against S2 docs
 * before raising).
 *
 * Throws if `REALTIME_STREAMS_BASIN_NAME_PREFIX` +
 * `REALTIME_STREAMS_BASIN_NAME_ENV` are configured so long that no
 * room remains for the slug — without this guard, `slice(0, 0)` would
 * return an empty string and every org would share the same name,
 * silently colliding via S2's 409-on-create.
 */
export function basinNameForOrg(org: { slug: string }): string {
  const prefix = env.REALTIME_STREAMS_BASIN_NAME_PREFIX;
  const envName = env.REALTIME_STREAMS_BASIN_NAME_ENV;
  const head = `${prefix}-${envName}-org-`;
  const budget = 63 - head.length;
  if (budget <= 0) {
    throw new Error(
      `[streamBasinProvisioner] REALTIME_STREAMS_BASIN_NAME_PREFIX + REALTIME_STREAMS_BASIN_NAME_ENV too long: head="${head}" leaves no room for the org slug (budget=${budget}). Shorten the prefix or env-name values.`
    );
  }
  const slug = org.slug.slice(0, budget);
  return `${head}${slug}`;
}

type ProvisionInput = {
  id: string;
  slug: string;
  /// Duration string passed straight to S2. Defaults to
  /// `defaultRetention()` when omitted. Caller decides; the provisioner
  /// has no opinion about what retention is appropriate.
  retention?: string;
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
 *  - S2 unreachable / 5xx / timeout: throws. Callers in the org-create
 *    path swallow + leave the column null so the backfill worker can
 *    retry, so signup never fails on a transient S2 outage.
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
  const retention = org.retention ?? defaultRetention();

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
 * Update retention in-place. Idempotent. No-op when the org has no
 * provisioned basin.
 */
export async function reconfigureBasinForOrg(
  orgId: string,
  retention: string
): Promise<void> {
  if (!isPerOrgBasinsEnabled()) return;

  const accessToken = env.REALTIME_STREAMS_S2_ACCESS_TOKEN;
  if (!accessToken) return;

  const org = await prisma.organization.findFirst({
    where: { id: orgId },
    select: { id: true, streamBasinName: true },
  });
  if (!org?.streamBasinName) return;

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
    // 10s upper bound so the synchronous org-create call site can't
    // hang signup forever if S2 is slow / unreachable. Soft-fail at the
    // caller swallows the resulting `TimeoutError`; the backfill worker
    // retries the unprovisioned org later.
    signal: AbortSignal.timeout(10_000),
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
    // Same 10s ceiling as create. The reconfigure path runs from the
    // worker, so a timeout here just fails the job and lets redis-worker
    // retry naturally.
    signal: AbortSignal.timeout(10_000),
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
