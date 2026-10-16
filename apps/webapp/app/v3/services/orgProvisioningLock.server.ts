import { randomUUID } from "node:crypto";
import { tryCatch } from "@trigger.dev/core/v3";
import type { RedisClient } from "~/redis.server";

const RELEASE_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`;

export class OrgProvisioningBusyError extends Error {
  constructor(key: string) {
    super(`Org provisioning job ${key} is already running`);
    this.name = "OrgProvisioningBusyError";
  }
}

// A busy lock throws `OrgProvisioningBusyError`, and the worker retries after the holder.
export function createOrgProvisioningLock(redis: Pick<RedisClient, "set" | "eval">, ttlMs: number) {
  return async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const lockKey = `org-provisioning:lock:${key}`;
    const token = randomUUID();

    const acquired = await redis.set(lockKey, token, "PX", ttlMs, "NX");
    if (acquired !== "OK") throw new OrgProvisioningBusyError(key);

    const [error, result] = await tryCatch(fn());
    await redis.eval(RELEASE_SCRIPT, 1, lockKey, token);
    if (error) throw error;
    return result;
  };
}
