import { env } from "~/env.server";
import { parseComputeBackingMap } from "~/runEngine/concerns/computeMigration.server";

/** Parsed once: region -> compute-backing worker queue. Operator env, rarely changes. */
export const computeBackingMap = parseComputeBackingMap(env.COMPUTE_BACKING_MAP);
