import { apiClientManager } from "./apiClientManager-api.js";
import { taskContext } from "./task-context-api.js";
import {
  IdempotencyKey,
  IdempotencyKeyInfo,
  IdempotencyKeyScope,
  isIdempotencyKeyInfo,
  createIdempotencyKeyInfo,
} from "./types/idempotencyKeys.js";
import { digestSHA256 } from "./utils/crypto.js";
import type { ZodFetchOptions } from "./apiClient/core.js";

export { isIdempotencyKeyInfo } from "./types/idempotencyKeys.js";
export type { IdempotencyKeyInfo, IdempotencyKeyScope } from "./types/idempotencyKeys.js";

export function isIdempotencyKey(
  value: string | string[] | IdempotencyKey
): value is IdempotencyKey {
  // Cannot check the brand at runtime because it doesn't exist (it's a TypeScript-only construct)
  return typeof value === "string" && value.length === 64;
}

export function flattenIdempotencyKey(
  idempotencyKey?:
    | IdempotencyKey
    | IdempotencyKeyInfo
    | string
    | string[]
    | (undefined | IdempotencyKey | IdempotencyKeyInfo | string | string[])[]
): IdempotencyKey | IdempotencyKeyInfo | string | string[] | undefined {
  if (!idempotencyKey) {
    return;
  }

  // If it's an IdempotencyKeyInfo, return it as-is (don't flatten)
  if (isIdempotencyKeyInfo(idempotencyKey)) {
    return idempotencyKey;
  }

  if (Array.isArray(idempotencyKey)) {
    //if any items are undefined, then return undefined for the entire key
    if (idempotencyKey.some((i) => i === undefined)) {
      return;
    }

    return idempotencyKey.flatMap((key) => {
      const k = flattenIdempotencyKey(key);
      if (!k) return [];
      // If the flattened result is an IdempotencyKeyInfo, extract the userKey for array flattening
      if (isIdempotencyKeyInfo(k)) {
        return Array.isArray(k.userKey) ? k.userKey : [k.userKey];
      }
      return [k];
    }) as string[];
  }

  return idempotencyKey;
}

export type MakeIdempotencyKeyResult = {
  /** The hashed idempotency key */
  hash: IdempotencyKey;
  /** The user-provided key value (arrays joined with `-`), undefined if pre-hashed */
  userValue: string | undefined;
  /** The scope used, undefined if pre-hashed */
  scope: IdempotencyKeyScope | undefined;
};

export async function makeIdempotencyKey(
  idempotencyKey?: IdempotencyKey | IdempotencyKeyInfo | string | string[]
): Promise<IdempotencyKey | undefined> {
  if (!idempotencyKey) {
    return;
  }

  // If it's an IdempotencyKeyInfo object, extract the hash
  if (isIdempotencyKeyInfo(idempotencyKey)) {
    return idempotencyKey.hash;
  }

  if (isIdempotencyKey(idempotencyKey)) {
    return idempotencyKey;
  }

  const result = await createIdempotencyKey(idempotencyKey, {
    scope: "run",
  });

  return result.hash;
}

/**
 * Creates an idempotency key and returns both the hash and user-provided info.
 * This is useful for storing/displaying the original key alongside the hash.
 */
export async function makeIdempotencyKeyWithUserInfo(
  idempotencyKey?: IdempotencyKey | IdempotencyKeyInfo | string | string[]
): Promise<MakeIdempotencyKeyResult | undefined> {
  if (!idempotencyKey) {
    return;
  }

  // If it's an IdempotencyKeyInfo object (from idempotencyKeys.create()), extract all info
  if (isIdempotencyKeyInfo(idempotencyKey)) {
    // Serialize the user value (join arrays with `-`)
    const userValue = Array.isArray(idempotencyKey.userKey)
      ? idempotencyKey.userKey.join("-")
      : idempotencyKey.userKey;

    return {
      hash: idempotencyKey.hash,
      userValue,
      scope: idempotencyKey.scope,
    };
  }

  // If it's already a hash (64-char string), we don't have the original value
  if (isIdempotencyKey(idempotencyKey)) {
    return {
      hash: idempotencyKey,
      userValue: undefined,
      scope: undefined,
    };
  }

  // Create the hash with "run" scope (default for makeIdempotencyKey)
  const keyInfo = await createIdempotencyKey(idempotencyKey, { scope: "run" });

  // Serialize the user value (join arrays with `-`)
  const userValue = Array.isArray(idempotencyKey) ? idempotencyKey.join("-") : idempotencyKey;

  return {
    hash: keyInfo.hash,
    userValue,
    scope: keyInfo.scope,
  };
}

/**
 * Creates a deterministic idempotency key based on the provided key material.
 *
 * If running inside a task, the task run ID is automatically included in the key material, giving you a unique key per task run.
 * This ensures that a given child task is only triggered once per task run, even if the parent task is retried.
 *
 * @param {string | string[]} key The key material to create the idempotency key from.
 * @param {object} [options] Additional options.
 * @param {"run" | "attempt" | "global"} [options.scope="run"] The scope of the idempotency key.
 *
 * @returns {Promise<IdempotencyKeyInfo>} An object containing the hash, original key, and scope.
 *
 * @example
 *
 * ```typescript
 * import { idempotencyKeys, task } from "@trigger.dev/sdk/v3";
 *
 * export const myTask = task({
 *  id: "my-task",
 *  run: async (payload: any) => {
 *   const idempotencyKey = await idempotencyKeys.create("my-task-key");
 *
 *   // Use the idempotency key when triggering child tasks
 *   await childTask.triggerAndWait(payload, { idempotencyKey });
 *  }
 * });
 * ```
 *
 * You can also use the `scope` parameter to create a key that is unique per task run, task run attempts (retries of the same run), or globally:
 *
 * ```typescript
 *  await idempotencyKeys.create("my-task-key", { scope: "attempt" }); // Creates a key that is unique per task run attempt
 *  await idempotencyKeys.create("my-task-key", { scope: "global" }); // Skips including the task run ID
 * ```
 */
export async function createIdempotencyKey(
  key: string | string[],
  options?: { scope?: IdempotencyKeyScope }
): Promise<IdempotencyKeyInfo> {
  const scope: IdempotencyKeyScope = options?.scope ?? "run";
  const hash = await generateIdempotencyKey(
    [...(Array.isArray(key) ? key : [key])].concat(injectScope(scope))
  );

  return createIdempotencyKeyInfo(hash as IdempotencyKey, key, scope);
}

function injectScope(scope: "run" | "attempt" | "global"): string[] {
  switch (scope) {
    case "run": {
      if (taskContext?.ctx) {
        return [taskContext.ctx.run.id];
      }
      break;
    }
    case "attempt": {
      if (taskContext?.ctx) {
        return [taskContext.ctx.run.id, taskContext.ctx.attempt.number.toString()];
      }
      break;
    }
  }

  return [];
}

async function generateIdempotencyKey(keyMaterial: string[]) {
  return await digestSHA256(keyMaterial.join("-"));
}

type AttemptKeyMaterial = {
  run: {
    id: string;
  };
  attempt: {
    number: number;
  };
};

/** Creates a unique key for each attempt. */
export function attemptKey(ctx: AttemptKeyMaterial): string {
  return `${ctx.run.id}-${ctx.attempt.number}`;
}

/** Resets an idempotency key, effectively deleting it from the associated task.*/
export async function resetIdempotencyKey(
  taskIdentifier: string,
  idempotencyKey: string,
  requestOptions?: ZodFetchOptions
): Promise<{ id: string }> {
  const client = apiClientManager.clientOrThrow();

  return client.resetIdempotencyKey(taskIdentifier, idempotencyKey, requestOptions);
}
