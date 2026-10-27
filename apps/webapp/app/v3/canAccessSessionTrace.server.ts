import type { PrismaClientOrTransaction } from "@trigger.dev/database";
import { FEATURE_FLAG } from "~/v3/featureFlags";
import { makeFlag } from "~/v3/featureFlags.server";

// Managed cloud only for now: self-hosted instances never get it, even with the flag set.
export async function canAccessSessionTrace(options: {
  isManagedCloud: boolean;
  isAdmin: boolean;
  orgFeatureFlags: unknown;
  db?: PrismaClientOrTransaction;
}): Promise<boolean> {
  if (!options.isManagedCloud) return false;
  if (options.isAdmin) return true;

  return makeFlag(options.db)({
    key: FEATURE_FLAG.sessionTraceEnabled,
    defaultValue: false,
    overrides: (options.orgFeatureFlags as Record<string, unknown> | null) ?? {},
  });
}
