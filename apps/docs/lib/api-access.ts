// Access is a list of `action:resource` scopes, as API keys carry them and as each API operation
// declares it (`x-trigger-access` in the OpenAPI specs, checked against the webapp routes).

// Same matching rule as scopesCover in apps/webapp/app/services/docsKeys.server.ts.
/** Whether a key's scopes grant every needed scope. `null` scopes: unrestricted (full access). */
export function covers(scopes: string[] | null, needed: string[]): boolean {
  if (!scopes) return true;
  return needed.every((scope) => {
    const [action] = scope.split(":");
    return scopes.includes("admin") || scopes.includes(scope) || scopes.includes(`${action}:all`);
  });
}

const RESOURCES: Record<string, string> = {
  batch: "Batches",
  deployments: "Deployments",
  envvars: "Env vars",
  errors: "Errors",
  query: "Query",
  queues: "Queues",
  runs: "Runs",
  schedules: "Schedules",
  sessions: "Sessions",
  tasks: "Tasks",
  waitpoints: "Waitpoints",
  webhooks: "Webhooks",
};

const ACTIONS: Record<string, string> = {
  read: "read",
  write: "write",
  trigger: "trigger",
  batchTrigger: "batch trigger",
  admin: "admin",
};

/** "Env vars: read" for `read:envvars`. */
export function accessLabel(scope: string): string {
  const [action, resource] = scope.split(":");
  return `${RESOURCES[resource] ?? resource}: ${ACTIONS[action] ?? action}`;
}

// SDK calls in code samples that the default docs key doesn't cover, by namespace.
const SDK_AREAS: Record<string, { resource: string; methods: RegExp }> = {
  envvars: { resource: "envvars", methods: /^(list|retrieve|create|update|upload|del)$/ },
  schedules: {
    resource: "schedules",
    methods: /^(list|retrieve|create|update|del|activate|deactivate)$/,
  },
  deployments: { resource: "deployments", methods: /^(list|retrieve|promote|cancel)$/ },
  query: { resource: "query", methods: /^execute$/ },
};
const READS = /^(list|retrieve|execute)$/;

/** The access a code sample's SDK calls need beyond the default docs key, or null when none. */
export function sampleAccess(code: string): string[] | null {
  const scopes = new Set<string>();
  for (const [, namespace, method] of code.matchAll(/\b(\w+)\.(\w+)\(/g)) {
    const area = SDK_AREAS[namespace];
    if (!area?.methods.test(method)) continue;
    scopes.add(`${READS.test(method) ? "read" : "write"}:${area.resource}`);
  }
  return scopes.size ? [...scopes].sort() : null;
}
