import { createHash } from "node:crypto";
import type { AuditLogEnvironmentType, AuditLogTarget } from "@trigger.dev/plugins";
import { getHttpContext, type RequestAuditIdentity } from "~/services/httpAsyncStorage.server";
import { logger } from "~/services/logger.server";
import { singleton } from "~/utils/singleton";
import { auditLogs } from "./auditLogs.server";

// Env var reads are audited. The API routes are also how the CLI reads, and `trigger dev` reads on
// every rebuild, so API reads are rolled up before they reach `auditLogs.record()`. Dashboard page
// loads and build server reads are each recorded.
//
// In the rollup, the first read of a key is recorded at once, with its full request context.
// Repeats of the same read, by the same caller, credential, IP and user agent, are not recorded
// until the key has been idle for `idleMs` or open for `maxAgeMs`. Nothing is held back to be
// recorded later, so there is nothing to lose on shutdown.
//
// The rollup is per process. A caller whose reads land on several webapp instances gets up to one
// event per instance per window. Never record values: only ids, key names and environment slugs.

const READ_ROLLUP_IDLE_MS = 30 * 60 * 1000;
const READ_ROLLUP_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const READ_ROLLUP_MAX_KEYS = 20_000;

export type EnvironmentVariableReadInput = {
  action: "envvar.listed" | "envvar.read";
  organizationId: string;
  projectId: string;
  environmentId: string;
  environmentType: AuditLogEnvironmentType;
  /** `environment` for a listing, `environment_variable` (id, key name) for one key. */
  target: AuditLogTarget;
};

export type ReadRollup = {
  /** True when the read should be recorded: the first for its key in the current window. */
  shouldRecord(key: string): boolean;
  readonly size: number;
};

export function createReadRollup({
  idleMs = READ_ROLLUP_IDLE_MS,
  maxAgeMs = READ_ROLLUP_MAX_AGE_MS,
  maxKeys = READ_ROLLUP_MAX_KEYS,
  now = () => Date.now(),
}: { idleMs?: number; maxAgeMs?: number; maxKeys?: number; now?: () => number } = {}): ReadRollup {
  // Insertion order is last-read order: a hit is moved to the end, so the first key is the least
  // recently read one.
  const open = new Map<string, { openedAt: number; lastReadAt: number }>();

  const isExpired = (entry: { openedAt: number; lastReadAt: number }, at: number) =>
    at - entry.lastReadAt >= idleMs || at - entry.openedAt >= maxAgeMs;

  function makeRoom(at: number) {
    for (const [key, entry] of open) {
      if (isExpired(entry, at)) open.delete(key);
    }
    // Evicting can only cause an extra event later, never hide a first read.
    while (open.size >= maxKeys) {
      const oldest = open.keys().next().value;
      if (oldest === undefined) break;
      open.delete(oldest);
    }
  }

  return {
    shouldRecord(key) {
      const at = now();
      const entry = open.get(key);
      if (entry && !isExpired(entry, at)) {
        open.delete(key);
        open.set(key, { openedAt: entry.openedAt, lastReadAt: at });
        return false;
      }

      open.delete(key);
      if (open.size >= maxKeys) makeRoom(at);
      open.set(key, { openedAt: at, lastReadAt: at });
      return true;
    },
    get size() {
      return open.size;
    },
  };
}

/** One rollup per process, shared by every read call site. */
function processReadRollup(): ReadRollup {
  return singleton("auditEnvVarReadRollup", () => createReadRollup());
}

/** Who read, with what and from where, as the request's auth functions noted it. */
function rollupKey(
  input: EnvironmentVariableReadInput,
  identity: RequestAuditIdentity | undefined
) {
  const parts = [
    input.organizationId,
    input.projectId,
    input.environmentId,
    input.action,
    input.target.type,
    input.target.id,
    identity?.actor?.type,
    identity?.actor?.id,
    identity?.credential?.kind,
    identity?.credential?.id,
    identity?.credential?.last4,
    identity?.onBehalfOf?.userId,
    identity?.source,
    identity?.origin?.deploymentId,
    identity?.endpoint?.ip,
    identity?.endpoint?.userAgent,
  ];
  return createHash("sha256").update(JSON.stringify(parts)).digest("base64");
}

/**
 * Records a read of env var values: a dashboard page load or a build server request. Call after the
 * values have been read, when the response will carry them. Never throws and never blocks the
 * request.
 */
export function recordEnvironmentVariableRead(input: EnvironmentVariableReadInput): void {
  recordRead(input, () => true);
}

/**
 * Records an API read of env var values, rolled up: the CLI reads through the same routes, on every
 * rebuild. Call after the values have been read, when the response will carry them. Never throws
 * and never blocks the request.
 */
export function recordRolledUpEnvironmentVariableRead(
  input: EnvironmentVariableReadInput,
  rollup: ReadRollup = processReadRollup()
): void {
  recordRead(input, () => rollup.shouldRecord(rollupKey(input, getHttpContext()?.auditIdentity)));
}

function recordRead(input: EnvironmentVariableReadInput, shouldRecord: () => boolean): void {
  try {
    if (!auditLogs.isRecordingEnabled()) return;
    if (!shouldRecord()) return;

    auditLogs.record({
      category: "envvars",
      action: input.action,
      organizationId: input.organizationId,
      projectId: input.projectId,
      environmentId: input.environmentId,
      environmentType: input.environmentType,
      target: input.target,
    });
  } catch (error) {
    // Auditing must never fail a read.
    logger.error("Audit logs: failed to record env var read", {
      action: input.action,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** The environment a listing read, as an audit target. */
export function environmentReadTarget(environment: {
  id: string;
  slug: string;
  branchName?: string | null;
}): AuditLogTarget {
  return {
    type: "environment",
    id: environment.id,
    name: environment.branchName ?? environment.slug,
  };
}

/** One variable a read returned, as an audit target: its id and key name, never its value. */
export function environmentVariableReadTarget(variable: {
  id: string;
  key: string;
}): AuditLogTarget {
  return { type: "environment_variable", id: variable.id, name: variable.key };
}

/**
 * Says the request was made for a deployment: a build fetching its build env vars. The actor stays
 * whoever the credential says it is, since any holder of the environment's key can call the route.
 * Does nothing outside an authenticated request.
 */
export function noteDeploymentOrigin(origin: { deploymentId: string }): void {
  try {
    const identity = getHttpContext()?.auditIdentity;
    if (!identity) return;
    identity.origin = { deploymentId: origin.deploymentId };
  } catch {
    // Auditing must never fail the request.
  }
}

/**
 * The dashboard list sends values to the browser on load, so a load is a listing: one event per
 * environment whose values the page sent. Environments whose values were masked aren't recorded.
 */
export function recordDashboardEnvironmentVariablesListed({
  organizationId,
  projectId,
  environments,
  readEnvironmentIds,
}: {
  organizationId: string;
  projectId: string;
  environments: Array<{
    id: string;
    slug: string;
    type: AuditLogEnvironmentType;
    branchName: string | null;
  }>;
  readEnvironmentIds: string[];
}): void {
  try {
    const read = new Set(readEnvironmentIds);
    for (const environment of environments) {
      if (!read.has(environment.id)) continue;
      recordEnvironmentVariableRead({
        action: "envvar.listed",
        organizationId,
        projectId,
        environmentId: environment.id,
        environmentType: environment.type,
        target: environmentReadTarget(environment),
      });
    }
  } catch (error) {
    logger.error("Audit logs: failed to record env var listing", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** The dashboard key panel sends one key's value in each environment: one read per environment. */
export function recordDashboardEnvironmentVariableKeyRead({
  organizationId,
  projectId,
  variables,
}: {
  organizationId: string;
  projectId: string;
  variables: Array<{
    id: string;
    key: string;
    environment: { id: string; type: AuditLogEnvironmentType };
  }>;
}): void {
  try {
    for (const variable of variables) {
      recordEnvironmentVariableRead({
        action: "envvar.read",
        organizationId,
        projectId,
        environmentId: variable.environment.id,
        environmentType: variable.environment.type,
        target: environmentVariableReadTarget(variable),
      });
    }
  } catch (error) {
    logger.error("Audit logs: failed to record env var read", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
