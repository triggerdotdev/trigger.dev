import { z } from "zod";
import { logger } from "~/services/logger.server";

// An environment's skew protection thresholds as stored, and their strict read. The writes live in
// skewProtectionThreshold.server.ts, the signal in skewProtectionThresholdSignal.server.ts, and
// the lenient read that appends use in sessionVersionFloor.server.ts.

/** Who set the skew protection threshold. `migrated` is the staff-set floor it replaced. */
export const SkewProtectionThresholdSetBy = z.object({
  type: z.enum(["user", "api", "migrated"]),
  id: z.string().optional(),
  /** The user's display name or name; null when they have neither (never their email). */
  name: z.string().nullable().optional(),
});
export type SkewProtectionThresholdSetBy = z.infer<typeof SkewProtectionThresholdSetBy>;

export const SkewProtectionThreshold = z.object({
  version: z.string().min(1),
  setAt: z.string(),
  setBy: SkewProtectionThresholdSetBy.optional(),
});
export type SkewProtectionThreshold = z.infer<typeof SkewProtectionThreshold>;

/** An environment's thresholds as stored. Task ids are data, hence the Map. */
export type SkewProtectionThresholds = {
  environment: SkewProtectionThreshold | undefined;
  tasks: Map<string, SkewProtectionThreshold>;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The strict read of `RuntimeEnvironment.skewProtectionThresholds`, for writes and the dashboard.
 * Each threshold is read on its own: one that is set but doesn't match the schema reads as not
 * set, with a warning that names the environment (and the task), and the others still read.
 * Appends don't come through here: `sessionVersionFloorFor` reads leniently.
 */
export function readSkewProtectionThresholds(
  value: unknown,
  environmentId: string
): SkewProtectionThresholds {
  const thresholds: SkewProtectionThresholds = { environment: undefined, tasks: new Map() };
  if (value == null) return thresholds;

  const warn = (task: string | undefined, issues: string[]) =>
    logger.warn(
      "A skew protection threshold doesn't match the schema and reads as not set here. Set or clear it to rewrite it",
      { environmentId, task, issues }
    );
  const read = (raw: unknown, task: string | undefined) => {
    const parsed = SkewProtectionThreshold.safeParse(raw);
    if (parsed.success) return parsed.data;
    warn(
      task,
      parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    );
    return undefined;
  };

  if (!isPlainObject(value)) {
    warn(undefined, ["expected an object"]);
    return thresholds;
  }
  if (value.environment != null) thresholds.environment = read(value.environment, undefined);
  if (isPlainObject(value.tasks)) {
    // Own keys only, kept in a Map: a task can be named `__proto__` or `constructor`.
    for (const [task, raw] of Object.entries(value.tasks)) {
      const threshold = read(raw, task);
      if (threshold) thresholds.tasks.set(task, threshold);
    }
  }
  return thresholds;
}
