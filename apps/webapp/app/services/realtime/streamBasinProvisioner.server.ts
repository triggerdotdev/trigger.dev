/**
 * Per-org S2 basin provisioning. Gated by
 * `REALTIME_STREAMS_PER_ORG_BASINS_ENABLED`: when off, all orgs share
 * `REALTIME_STREAMS_S2_BASIN` and this module no-ops.
 *
 * Pure retention-string in / S2-call out. No plan or billing
 * vocabulary — that lives in `streamBasinRetentionByPlan.server.ts`.
 */
import type { PrismaClientOrTransaction } from "~/db.server";
import { prisma } from "~/db.server";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import { parseDuration } from "./duration.server";

export function isPerOrgBasinsEnabled(): boolean {
  return env.REALTIME_STREAMS_PER_ORG_BASINS_ENABLED === "true";
}

export function defaultRetention(): string {
  return env.REALTIME_STREAMS_BASIN_DEFAULT_RETENTION;
}

// Org id is a cuid — fixed-length and stable, so the basin name is
// collision-free without truncation. Slugs are user-editable and would
// drift.
export function basinNameForOrg(org: { id: string }): string {
  const prefix = env.REALTIME_STREAMS_BASIN_NAME_PREFIX;
  const envName = env.REALTIME_STREAMS_BASIN_NAME_ENV;
  return `${prefix}-${envName}-org-${org.id}`;
}

type ProvisionInput = {
  id: string;
  retention?: string;
  streamBasinName: string | null | undefined;
};

type ProvisionResult =
  | { kind: "skipped"; reason: "feature-disabled" | "already-provisioned"; basin: string | null }
  | { kind: "provisioned"; basin: string; retention: string };

// Idempotent. Treats S2 409 as success (race with another caller, or
// previous run that crashed after S2 ack but before the column write).
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

export async function reconfigureBasinForOrg(
  orgId: string,
  retention: string
): Promise<void> {
  if (!isPerOrgBasinsEnabled()) return;

  const accessToken = env.REALTIME_STREAMS_S2_ACCESS_TOKEN;
  if (!accessToken) {
    throw new Error(
      "REALTIME_STREAMS_S2_ACCESS_TOKEN must be set when REALTIME_STREAMS_PER_ORG_BASINS_ENABLED=true"
    );
  }

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

// S2 REST: POST /v1/basins to create, PATCH /v1/basins/{name} to
// reconfigure. Wire shape takes integer seconds; we accept human strings
// like "7d" / "1y" as env-var ergonomics and parse them here.

type CreateBasinOptions = {
  accessToken: string;
  retentionPolicy: string;
  storageClass: "express" | "standard";
  deleteOnEmptyMinAge: string;
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
        retention_policy: { age: parseDuration(opts.retentionPolicy) },
        delete_on_empty: { min_age_secs: parseDuration(opts.deleteOnEmptyMinAge) },
      },
    },
  };

  const res = await fetch(url, {
    signal: AbortSignal.timeout(10_000),
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  // 409 = basin already exists; treat as success (idempotent).
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
      retention_policy: { age: parseDuration(opts.retentionPolicy) },
    },
  };

  const res = await fetch(url, {
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

