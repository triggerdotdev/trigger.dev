import { taskContext } from "@trigger.dev/core/v3";

export const idempotencyKeys = {
  create: createIdempotencyKey,
};

declare const __brand: unique symbol;
type Brand<B> = { [__brand]: B };
type Branded<T, B> = T & Brand<B>;

export type IdempotencyKey = Branded<string, "IdempotencyKey">;

export function isIdempotencyKey(value: string | IdempotencyKey): value is IdempotencyKey {
  // Cannot check the brand at runtime because it doesn't exist (it's a TypeScript-only construct)
  return typeof value === "string" && value.length === 64;
}

/**
 * Creates a deterministic idempotency key based on the provided key material.
 *
 * If running inside a task, the task run ID is automatically included in the key material, giving you a unique key per task run.
 * This ensures that a given child task is only triggered once per task run, even if the parent task is retried.
 *
 * @param {string | string[]} key The key material to create the idempotency key from.
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
 */
async function createIdempotencyKey(key: string | string[]): Promise<IdempotencyKey> {
  const idempotencyKey = await generateIdempotencyKey(
    [...(Array.isArray(key) ? key : [key])].concat(taskContext?.ctx ? [taskContext.ctx.run.id] : [])
  );

  return idempotencyKey as IdempotencyKey;
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
