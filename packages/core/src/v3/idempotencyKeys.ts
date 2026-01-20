import { apiClientManager } from "./apiClientManager-api.js";
import { idempotencyKeyCatalog } from "./idempotency-key-catalog-api.js";
import type {
  IdempotencyKeyOptions,
  IdempotencyKeyScope,
} from "./idempotency-key-catalog/catalog.js";
import { taskContext } from "./task-context-api.js";
import { IdempotencyKey } from "./types/idempotencyKeys.js";
import { digestSHA256 } from "./utils/crypto.js";
import type { ZodFetchOptions } from "./apiClient/core.js";

// Re-export types from catalog for backwards compatibility
export type { IdempotencyKeyScope, IdempotencyKeyOptions } from "./idempotency-key-catalog/catalog.js";

/**
 * Extracts the user-provided key and scope from an idempotency key created with `idempotencyKeys.create()`.
 *
 * @param idempotencyKey The idempotency key to extract options from
 * @returns The original key and scope, or undefined if the key doesn't have attached options
 *
 * @example
 * ```typescript
 * const key = await idempotencyKeys.create("my-key", { scope: "global" });
 * const options = getIdempotencyKeyOptions(key);
 * // options = { key: "my-key", scope: "global" }
 * ```
 */
export function getIdempotencyKeyOptions(
  idempotencyKey: IdempotencyKey | string
): IdempotencyKeyOptions | undefined {
  // Look up options from the catalog using the hash string
  if (typeof idempotencyKey === "string") {
    return idempotencyKeyCatalog.getKeyOptions(idempotencyKey);
  }
  return undefined;
}

export function isIdempotencyKey(
  value: string | string[] | IdempotencyKey
): value is IdempotencyKey {
  // Cannot check the brand at runtime because it doesn't exist (it's a TypeScript-only construct)
  // Check for primitive strings only (we no longer use String objects)
  if (typeof value === "string") {
    return value.length === 64;
  }
  return false;
}

export function flattenIdempotencyKey(
  idempotencyKey?:
    | IdempotencyKey
    | string
    | string[]
    | (undefined | IdempotencyKey | string | string[])[]
): IdempotencyKey | string | string[] | undefined {
  if (!idempotencyKey) {
    return;
  }

  if (Array.isArray(idempotencyKey)) {
    //if any items are undefined, then return undefined for the entire key
    if (idempotencyKey.some((i) => i === undefined)) {
      return;
    }

    return idempotencyKey.flatMap((key) => {
      const k = flattenIdempotencyKey(key);
      if (!k) return [];
      return [k];
    }) as string[];
  }

  return idempotencyKey;
}

export async function makeIdempotencyKey(
  idempotencyKey?: IdempotencyKey | string | string[]
): Promise<IdempotencyKey | undefined> {
  if (!idempotencyKey) {
    return;
  }

  if (isIdempotencyKey(idempotencyKey)) {
    return idempotencyKey;
  }

  return await createIdempotencyKey(idempotencyKey, {
    scope: "run",
  });
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
 * @returns {Promise<IdempotencyKey>} The idempotency key as a branded string.
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
): Promise<IdempotencyKey> {
  const scope = options?.scope ?? "run";
  const keyArray = Array.isArray(key) ? key : [key];
  const userKey = keyArray.join("-");

  const idempotencyKey = await generateIdempotencyKey(keyArray.concat(injectScope(scope)));

  // Register the original key and scope in the catalog for later extraction
  idempotencyKeyCatalog.registerKeyOptions(idempotencyKey, { key: userKey, scope });

  // Return primitive string cast as IdempotencyKey
  return idempotencyKey as IdempotencyKey;
}

function injectScope(scope: IdempotencyKeyScope): string[] {
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

export type ResetIdempotencyKeyOptions = {
  scope?: IdempotencyKeyScope;
  /** Required if scope is "run" or "attempt" to reconstruct the hash */
  parentRunId?: string;
  /** Required if scope is "attempt" to reconstruct the hash */
  attemptNumber?: number;
};

/**
 * Resets an idempotency key, effectively deleting it from the associated task.
 *
 * @param taskIdentifier The task identifier (e.g., "my-task")
 * @param idempotencyKey The idempotency key to reset. Can be:
 *   - An `IdempotencyKey` created with `idempotencyKeys.create()` (options are extracted automatically)
 *   - A string or string array (requires `options.scope` and potentially `options.parentRunId`)
 * @param options Options for reconstructing the hash if needed
 * @param requestOptions Optional fetch options
 *
 * @example
 * ```typescript
 * // Using a key created with idempotencyKeys.create() - options are extracted automatically
 * const key = await idempotencyKeys.create("my-key", { scope: "global" });
 * await idempotencyKeys.reset("my-task", key);
 *
 * // Using a raw string with global scope
 * await idempotencyKeys.reset("my-task", "my-key", { scope: "global" });
 *
 * // Using a raw string with run scope (requires parentRunId)
 * await idempotencyKeys.reset("my-task", "my-key", {
 *   scope: "run",
 *   parentRunId: "run_abc123"
 * });
 * ```
 */
export async function resetIdempotencyKey(
  taskIdentifier: string,
  idempotencyKey: IdempotencyKey | string | string[],
  options?: ResetIdempotencyKeyOptions,
  requestOptions?: ZodFetchOptions
): Promise<{ id: string }> {
  const client = apiClientManager.clientOrThrow();

  // If the key is already a 64-char hash, use it directly
  if (typeof idempotencyKey === "string" && idempotencyKey.length === 64) {
    return client.resetIdempotencyKey(taskIdentifier, idempotencyKey, requestOptions);
  }

  // Try to extract options from an IdempotencyKey created with idempotencyKeys.create()
  const attachedOptions =
    typeof idempotencyKey === "string"
      ? getIdempotencyKeyOptions(idempotencyKey)
      : undefined;

  const scope = attachedOptions?.scope ?? options?.scope ?? "run";
  const keyArray = Array.isArray(idempotencyKey)
    ? idempotencyKey
    : [attachedOptions?.key ?? String(idempotencyKey)];

  // Build scope suffix based on scope type
  let scopeSuffix: string[] = [];
  switch (scope) {
    case "run": {
      const parentRunId = options?.parentRunId ?? taskContext?.ctx?.run.id;
      if (!parentRunId) {
        throw new Error(
          "resetIdempotencyKey: parentRunId is required for 'run' scope when called outside a task context"
        );
      }
      scopeSuffix = [parentRunId];
      break;
    }
    case "attempt": {
      const parentRunId = options?.parentRunId ?? taskContext?.ctx?.run.id;
      const attemptNumber = options?.attemptNumber ?? taskContext?.ctx?.attempt.number;
      if (!parentRunId || attemptNumber === undefined) {
        throw new Error(
          "resetIdempotencyKey: parentRunId and attemptNumber are required for 'attempt' scope when called outside a task context"
        );
      }
      scopeSuffix = [parentRunId, attemptNumber.toString()];
      break;
    }
  }

  // Generate the hash using the same algorithm as createIdempotencyKey
  const hash = await generateIdempotencyKey(keyArray.concat(scopeSuffix));

  return client.resetIdempotencyKey(taskIdentifier, hash, requestOptions);
}
