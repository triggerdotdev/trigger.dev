import {
  hasPinnedExecutionPolicy,
  resolvePolicyScopes,
  RunExecutionPolicy,
  type RunExecutionPolicy as Policy,
} from "@trigger.dev/core/v3";
import { z } from "zod/v4";
import type { EnvironmentVariable } from "~/v3/environmentVariables/repository";

const PinnedPolicy = z.object({
  executionPolicy: RunExecutionPolicy.optional(),
  sessionId: z.string().optional(),
});

export type PinnedRunPolicy = { policy: Policy; sessionId?: string };

/**
 * The policy pinned on a run at trigger time, or undefined for a standard run. A run marked as a
 * sandbox with an unreadable policy throws, so it can never start with standard access.
 */
export function pinnedRunPolicy(annotations: unknown): PinnedRunPolicy | undefined {
  if (!hasPinnedExecutionPolicy(annotations)) return undefined;
  const parsed = PinnedPolicy.parse(annotations);
  if (!parsed.executionPolicy) throw new Error("Sandbox run has no execution policy");
  return { policy: parsed.executionPolicy, sessionId: parsed.sessionId };
}

export function runTokenScopes(
  pinned: PinnedRunPolicy | undefined,
  runFriendlyId: string
): string[] | undefined {
  return pinned
    ? resolvePolicyScopes(pinned.policy.scopes, {
        runId: runFriendlyId,
        sessionId: pinned.sessionId,
      })
    : undefined;
}

export function withoutRootKey(
  pinned: PinnedRunPolicy | undefined,
  variables: EnvironmentVariable[]
): EnvironmentVariable[] {
  return pinned && !pinned.policy.rootKey
    ? variables.filter((variable) => variable.key !== "TRIGGER_SECRET_KEY")
    : variables;
}
