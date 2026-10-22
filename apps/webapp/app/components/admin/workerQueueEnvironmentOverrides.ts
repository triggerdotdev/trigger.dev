import {
  WORKER_QUEUE_OVERRIDE_ENVIRONMENT_TYPES,
  type WorkerQueueEnvironmentOverride,
} from "~/v3/featureFlags";

export type WorkerQueueEnvironmentOverrides = Record<string, WorkerQueueEnvironmentOverride>;

export type OverrideEnvironment = {
  id: string;
  type: string;
  branchName: string | null;
  projectName: string;
};

const ENVIRONMENT_TYPE_LABELS: Record<string, string> = {
  PRODUCTION: "Production",
  STAGING: "Staging",
  PREVIEW: "Preview",
};

export function overrideScopeLabel(
  scope: string,
  environments: readonly OverrideEnvironment[]
): string {
  const typeLabel = ENVIRONMENT_TYPE_LABELS[scope];
  if (typeLabel) {
    return `All ${typeLabel.toLowerCase()}`;
  }

  const environment = environments.find((environment) => environment.id === scope);
  if (!environment) {
    return `Unknown environment (${scope})`;
  }

  const name = ENVIRONMENT_TYPE_LABELS[environment.type] ?? environment.type;
  return environment.branchName
    ? `${environment.projectName} / ${name} (${environment.branchName})`
    : `${environment.projectName} / ${name}`;
}

export function orderedOverrideScopes(
  overrides: WorkerQueueEnvironmentOverrides,
  environments: readonly OverrideEnvironment[]
): string[] {
  const known = [
    ...WORKER_QUEUE_OVERRIDE_ENVIRONMENT_TYPES,
    ...environments.map((environment) => environment.id),
  ];
  const scopes = Object.keys(overrides);
  return [
    ...known.filter((scope) => scopes.includes(scope)),
    ...scopes.filter((scope) => !known.includes(scope)).sort(),
  ];
}

export function availableOverrideScopes(
  overrides: WorkerQueueEnvironmentOverrides,
  environments: readonly OverrideEnvironment[]
): string[] {
  return [
    ...WORKER_QUEUE_OVERRIDE_ENVIRONMENT_TYPES,
    ...environments.map((environment) => environment.id),
  ].filter((scope) => !(scope in overrides));
}

export function setOverrideField<K extends keyof WorkerQueueEnvironmentOverride>(
  overrides: WorkerQueueEnvironmentOverrides,
  scope: string,
  field: K,
  value: WorkerQueueEnvironmentOverride[K] | undefined
): WorkerQueueEnvironmentOverrides {
  const entry = { ...overrides[scope] };
  if (value === undefined) {
    delete entry[field];
  } else {
    entry[field] = value;
  }
  return { ...overrides, [scope]: entry };
}

export function removeOverride(
  overrides: WorkerQueueEnvironmentOverrides,
  scope: string
): WorkerQueueEnvironmentOverrides | undefined {
  const next = { ...overrides };
  delete next[scope];
  return Object.keys(next).length === 0 ? undefined : next;
}

export function incompleteOverrideScopes(overrides: WorkerQueueEnvironmentOverrides): string[] {
  return Object.entries(overrides)
    .filter(([, entry]) => entry.compat === undefined && entry.channel === undefined)
    .map(([scope]) => scope);
}
