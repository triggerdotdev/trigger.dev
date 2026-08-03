import type { RbacAbility } from "@trigger.dev/rbac";

export class BatchItemAuthorizationError extends Error {}

export function batchPublicAccessScopes(
  batchId: string,
  ability: RbacAbility,
  browserClient: boolean
): string[] {
  const scopes = [`read:batch:${batchId}`];

  if (browserClient && ability.can("batchTrigger", { type: "tasks" })) {
    scopes.push(`write:batch:${batchId}`);
  }

  return scopes;
}

/**
 * Wraps `authorizeBatchItems` so a credential without a batch-level write grant
 * must present at least one authorized item before the batch is touched at all.
 *
 * A selected-task credential can only be authorized by the items it streams —
 * by design, see the phase-two comment in `api.v3.batches.ts`. So a stream that
 * yields nothing passes zero checks, and because `StreamBatchItemsService` does
 * its batch lookup *before* it ever pulls an item, its "not found" / "not in
 * PENDING (current: …)" / `runCount` responses would leak an arbitrary batch's
 * existence, lifecycle state and progress to any key in the environment. This
 * route bypasses the route builder's `restrictedApiKey && !authorization -> 403`
 * fail-closed, so nothing else stops that probe.
 *
 * Pulling and authorizing the first item up front closes it: no item, no
 * authorization. The auth layer must never grant on no input — the same rule
 * `checkAuth` applies for empty resource arrays in `apiBuilder.server.ts`.
 */
export async function authorizedBatchItemStream(
  items: AsyncIterable<unknown>,
  ability: RbacAbility,
  batchId: string
): Promise<AsyncIterable<unknown>> {
  const authorized = authorizeBatchItems(items, ability, batchId);

  // A batch-level write grant is authorization in its own right, so an empty
  // stream stays legal for credentials that own the batch: root keys (via the
  // permissive ability) and phase one's delegated browser token. Only a
  // restricted credential, which has nothing but its items to go on, is held
  // to the at-least-one-item rule.
  if (ability.can("write", { type: "batch", id: batchId })) {
    return authorized;
  }

  const iterator = authorized[Symbol.asyncIterator]();
  const first = await iterator.next();

  if (first.done) {
    throw new BatchItemAuthorizationError();
  }

  return (async function* () {
    try {
      yield first.value;

      while (true) {
        const next = await iterator.next();
        if (next.done) return;
        yield next.value;
      }
    } finally {
      // Consumers can stop early — p-map abandons the iterator when a mapper
      // rejects. Close the generator we pulled from so it unwinds its own
      // `for await` and releases the request body stream.
      await iterator.return?.();
    }
  })();
}

export async function* authorizeBatchItems(
  items: AsyncIterable<unknown>,
  ability: RbacAbility,
  batchId: string
): AsyncIterable<unknown> {
  const canWriteBatch = ability.can("write", { type: "batch", id: batchId });

  for await (const item of items) {
    const task =
      typeof item === "object" && item !== null && "task" in item && typeof item.task === "string"
        ? item.task
        : undefined;

    if (!canWriteBatch && (!task || !ability.can("batchTrigger", { type: "tasks", id: task }))) {
      throw new BatchItemAuthorizationError();
    }

    yield item;
  }
}
