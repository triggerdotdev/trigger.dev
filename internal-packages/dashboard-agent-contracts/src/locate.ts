/**
 * The result of resolving a run, deployment or error fingerprint to the environment scope(s)
 * it lives in. Shared between the webapp (which produces it) and the dashboard agent (which
 * validates it at the boundary, since the webapp isn't importable there).
 */
import { z } from "zod";

// `.passthrough()`: the server may add fields (e.g. a future canonical name) a caller
// doesn't know yet, and stripping them would silently discard what the route sent.
export const locatedScopeSchema = z
  .object({
    projectRef: z.string(),
    environmentName: z.string(),
    environmentId: z.string(),
    branch: z.string().optional(),
    taskIdentifier: z.string().optional(),
    // `kind: "deployment"` only — what `get_deploy`'s `version` param accepts, so a caller can
    // follow up without a second lookup.
    version: z.string().optional(),
    shortCode: z.string().optional(),
    // `kind: "queue"` only — the queue as `get_queue` addresses it, so a caller can follow
    // up without guessing which kind of queue the name belongs to.
    queueName: z.string().optional(),
    queueType: z.enum(["task", "custom"]).optional(),
  })
  .passthrough();

export type LocatedScope = z.infer<typeof locatedScopeSchema>;

export const locateResultSchema = z.union([
  z
    .object({
      found: z.literal(false),
      // `kind: "error"` only — the warehouse query's cap-detection itself hit its cap (e.g. an
      // overflowing private-environment exclusion list), so a visible location may exist beyond
      // what this lookup could check. Distinguishes "definitely not found" from "couldn't check
      // everything".
      truncated: z.literal(true).optional(),
      // `kind: "error"` only — the warehouse query itself failed (transport, timeout, a bad
      // query). This is not evidence the error doesn't exist: distinguishes "definitely not
      // found" from "couldn't check at all".
      unavailable: z.literal(true).optional(),
    })
    .passthrough(),
  z
    .object({
      found: z.literal(true),
      kind: z.enum(["run", "deployment", "error", "queue"]),
      id: z.string(),
      scopes: z.array(locatedScopeSchema),
      // `kind: "error"` only — the warehouse query hit its cap, so more matching (environment,
      // task) pairs may exist beyond what `scopes` lists.
      truncated: z.boolean().optional(),
    })
    .passthrough(),
]);

export type LocateResult = z.infer<typeof locateResultSchema>;
