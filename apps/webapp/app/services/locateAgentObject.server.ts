/**
 * Org-wide lookup for the Dashboard Agent: given a run or error id the agent could not find in
 * the current project/environment, name every scope inside the token's organization where it
 * exists. The organization is a hard boundary — an object in another org reads as not found, so
 * the endpoint never confirms its existence.
 */

import { boundedIn, type RuntimeEnvironmentType } from "@trigger.dev/database";
import { ErrorId } from "@trigger.dev/core/v3/isomorphic";
import { $replica } from "~/db.server";
import { dashboardAgentEnvironmentAddress } from "~/services/dashboardAgentEnvironmentAddress.server";
import { clickhouseFactory } from "~/services/clickhouse/clickhouseFactoryInstance.server";
import { runStore } from "~/v3/runStore.server";

type LocatedScope = {
  projectRef: string;
  projectName: string;
  environmentName: string;
  environmentType: RuntimeEnvironmentType;
  branchName?: string;
  /** Whether the caller may act in this scope. An inaccessible scope is still reported. */
  targetable: boolean;
};

export type LocateResult =
  | { found: true; scopes: LocatedScope[]; checked: "organization" }
  | { found: false; checked: "organization" };

const NOT_FOUND: LocateResult = { found: false, checked: "organization" };

export type LocateTarget = {
  kind: "run" | "error";
  id: string;
  organizationId: string;
  userId: string;
};

export async function isOrganizationMember(
  organizationId: string,
  userId: string
): Promise<boolean> {
  const organization = await $replica.organization.findFirst({
    where: { id: organizationId, deletedAt: null, members: { some: { userId } } },
    select: { id: true },
  });

  return !!organization;
}

export async function locateAgentObject(target: LocateTarget): Promise<LocateResult> {
  const environmentIds =
    target.kind === "run"
      ? await runEnvironmentIds(target.id)
      : await errorEnvironmentIds(target.id, target.organizationId);

  const scopes = await scopesForEnvironments(environmentIds, target.organizationId, target.userId);

  return scopes.length > 0 ? { found: true, scopes, checked: "organization" } : NOT_FOUND;
}

/** A run friendlyId is globally unique, so this is one lookup; the org filter comes later. */
async function runEnvironmentIds(friendlyId: string): Promise<string[]> {
  const run = await runStore.findRun({ friendlyId }, { select: { runtimeEnvironmentId: true } });

  return run ? [run.runtimeEnvironmentId] : [];
}

/** A fingerprint is legitimately present in many environments, so every one of them answers. */
async function errorEnvironmentIds(errorId: string, organizationId: string): Promise<string[]> {
  let fingerprint: string;
  try {
    fingerprint = ErrorId.toId(errorId);
  } catch {
    return [];
  }

  const clickhouse = await clickhouseFactory.getClickhouseForOrganization(organizationId, "logs");
  const [queryError, rows] = await clickhouse.errors.getScopes({
    organizationId,
    errorFingerprint: fingerprint,
  });

  if (queryError) {
    throw queryError;
  }

  return (rows ?? []).map((row) => row.environment_id);
}

async function scopesForEnvironments(
  environmentIds: string[],
  organizationId: string,
  userId: string
): Promise<LocatedScope[]> {
  if (environmentIds.length === 0) {
    return [];
  }

  const environments = await $replica.runtimeEnvironment.findMany({
    where: {
      id: { in: boundedIn(environmentIds) },
      organizationId,
      project: { deletedAt: null },
    },
    select: {
      slug: true,
      type: true,
      branchName: true,
      archivedAt: true,
      orgMember: { select: { userId: true } },
      project: { select: { externalRef: true, name: true } },
    },
  });

  return environments.map((environment) => ({
    projectRef: environment.project.externalRef,
    projectName: environment.project.name,
    // Name the API routes address, not the dashboard slug: a branch child's slug is compound.
    environmentName:
      dashboardAgentEnvironmentAddress(environment).environmentName ?? environment.slug,
    environmentType: environment.type,
    ...(environment.branchName ? { branchName: environment.branchName } : {}),
    // dev is per-user and an archived env is frozen; both exist, so both are still reported.
    targetable:
      !environment.archivedAt &&
      (environment.type !== "DEVELOPMENT" || environment.orgMember?.userId === userId),
  }));
}
