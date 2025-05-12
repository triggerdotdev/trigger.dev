import { taskContext } from "./task-context-api.js";
import { IdempotencyKey } from "./types/idempotencyKeys.js";

export function isIdempotencyKey(
  value: string | string[] | IdempotencyKey
): value is IdempotencyKey {
  // Cannot check the brand at runtime because it doesn't exist (it's a TypeScript-only construct)
  return typeof value === "string" && value.length === 64;
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

  return await createIdempotencyKey(idempotencyKey, { scope: "global" });
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
  options?: { scope?: "run" | "attempt" | "global" }
): Promise<IdempotencyKey> {
  const idempotencyKey = await generateIdempotencyKey(
    [...(Array.isArray(key) ? key : [key])].concat(injectScope(options?.scope ?? "run"))
  );

  return idempotencyKey as IdempotencyKey;
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
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(keyMaterial.join("-"))
  );

  // Return a hex string, using cross-runtime compatible methods
  return Array.from(new Uint8Array(hash))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
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
