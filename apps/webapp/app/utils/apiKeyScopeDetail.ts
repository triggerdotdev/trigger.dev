import type { ApiKeyPreset } from "~/services/apiKeyPresetValidation.server";

export type CapId =
  | "tasks"
  | "runs"
  | "batches"
  | "queues"
  | "sessions"
  | "tags"
  | "errors"
  | "webhooks"
  | "waitpoints"
  | "deployments"
  | "branches"
  | "envvars";

/**
 * Capability rows shown in the scope pane, in a fixed order so two presets read
 * as a diff of the same list rather than a reshuffled one.
 */
export const SCOPE_CAPABILITIES: [CapId, string][] = [
  ["tasks", "Tasks"],
  ["runs", "Runs"],
  ["batches", "Batches"],
  ["queues", "Queues"],
  ["sessions", "Sessions (all tasks)"],
  ["tags", "Tagged runs"],
  ["errors", "Errors"],
  ["webhooks", "Webhooks"],
  ["waitpoints", "Waitpoints"],
  ["deployments", "Deployments"],
  ["branches", "Preview branches"],
  ["envvars", "Environment variables"],
];

/** The second entry retains the plugin-provided raw scope strings. */
type PresetCapability = [level: number, rawScopes: string[]];

export type PresetScopeDetail = {
  /** A single `admin` scope grants everything, so every row reads "Full access". */
  admin?: boolean;
  /** Task-scopable presets expand task scopes into the selected task identifiers. */
  scopable?: boolean;
  /** Shown in the task-access panel for presets that aren't task-scopable. */
  taskLabel?: string;
  caps: Partial<Record<CapId, PresetCapability>>;
};

const SCOPE_CAPABILITY_BY_SCOPE: Record<string, [CapId, number]> = {
  "trigger:tasks": ["tasks", 3],
  "batchTrigger:tasks": ["batches", 3],
  "batchTrigger:batch": ["batches", 3],
  "read:tasks": ["tasks", 1],
  "write:tasks": ["tasks", 2],
  "read:runs": ["runs", 1],
  "write:runs": ["runs", 2],
  "read:batch": ["batches", 1],
  "write:batch": ["batches", 2],
  "read:queues": ["queues", 1],
  "write:queues": ["queues", 2],
  "read:sessions": ["sessions", 1],
  "write:sessions": ["sessions", 2],
  "read:tags": ["tags", 1],
  "read:errors": ["errors", 1],
  "write:errors": ["errors", 2],
  "read:webhooks": ["webhooks", 1],
  "write:webhooks": ["webhooks", 2],
  "read:waitpoints": ["waitpoints", 1],
  "write:waitpoints": ["waitpoints", 2],
  "read:deployments": ["deployments", 1],
  "write:deployments": ["deployments", 2],
  "write:branches": ["branches", 3],
  "read:envvars": ["envvars", 1],
  "write:envvars": ["envvars", 2],
};

export function scopeDetailForPreset(preset?: ApiKeyPreset): PresetScopeDetail | undefined {
  const scopes = preset?.scopes;
  if (!scopes) return;
  if (scopes.includes("admin")) {
    return { admin: true, taskLabel: "All tasks", caps: {} };
  }

  const caps: PresetScopeDetail["caps"] = {};
  for (const scope of scopes) {
    const [action, resource] = scope.split(":");
    const capability = SCOPE_CAPABILITY_BY_SCOPE[`${action}:${resource}`];
    if (!capability) continue;

    const [key, level] = capability;
    const current = caps[key];
    caps[key] = [Math.max(current?.[0] ?? 0, level), [...(current?.[1] ?? []), scope]];
  }

  return {
    scopable: preset.usesTaskSelection,
    taskLabel: scopes.some((scope) => scope.split(":")[1] === "tasks") ? "All tasks" : "No tasks",
    caps,
  };
}
