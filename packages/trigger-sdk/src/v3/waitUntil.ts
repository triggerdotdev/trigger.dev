import { waitUntil as core_waitUntil } from "@trigger.dev/core/v3";

/**
 * waitUntil extends the lifetime of a task run until the provided promise settles.
 * You can use this function to ensure that a task run does not complete until the promise resolves or rejects.
 *
 * Useful if you need to make sure something happens but you wait to continue doing other work in the task run.
 *
 * @param promise - The promise to wait for.
 */
export function waitUntil(promise: Promise<any>) {
  return core_waitUntil.register({ promise, requiresResolving: () => true });
}
