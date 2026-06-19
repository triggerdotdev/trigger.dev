import { tool, type ToolSet } from "ai";
import { z } from "zod";

/**
 * Read-only tools for the dashboard agent. The agent is firewalled from the
 * main database, so every tool reaches the user's data the sanctioned way: the
 * public Trigger.dev API, authenticated as the user with the short-lived
 * delegated token the `in` proxy injects into the turn's metadata.
 *
 * - User-level reads (projects, environments) use the delegated token directly.
 * - Environment-scoped reads (runs, tasks) first exchange the token for an env
 *   JWT for the current project + environment, then call the API with that.
 *
 * Tools return `{ error }` on failure rather than throwing, so the model can
 * recover and explain instead of the turn dying.
 */

// The per-turn context the `in` proxy injects server-side. All optional: on a
// turn that didn't carry a token (e.g. an older session) we expose no tools.
export type DashboardAgentToolContext = {
  userActorToken?: string;
  apiOrigin?: string;
  projectRef?: string;
  // Canonical API env name (dev/staging/prod/preview), resolved by the proxy.
  environmentName?: string;
};

type FetchResult = { ok: true; data: unknown } | { ok: false; status: number };

async function apiGet(origin: string, path: string, token: string): Promise<FetchResult> {
  const res = await fetch(`${origin}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!res.ok) return { ok: false, status: res.status };
  return { ok: true, data: await res.json() };
}

// Swap the delegated token for an env JWT scoped to the current project + env.
// The exchange ceilings these scopes to the token's read-only cap, so the JWT
// can never widen the grant. Returns null when there's no current env or the
// exchange is denied.
async function exchangeEnvJwt(
  origin: string,
  userActorToken: string,
  projectRef: string,
  environmentName: string
): Promise<string | null> {
  const res = await fetch(`${origin}/api/v1/projects/${projectRef}/${environmentName}/jwt`, {
    method: "POST",
    headers: { Authorization: `Bearer ${userActorToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ claims: { scopes: ["read:runs", "read:deployments"] } }),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { token?: string };
  return data.token ?? null;
}

function curateProjects(data: unknown) {
  const projects = Array.isArray(data) ? data : [];
  return {
    projects: projects.map((p: any) => ({
      ref: p.externalRef,
      name: p.name,
      slug: p.slug,
      organization: p.organization?.title,
    })),
  };
}

function curateEnvironments(data: unknown) {
  const envs = Array.isArray(data) ? data : [];
  return {
    environments: envs.map((e: any) => ({
      slug: e.slug,
      type: e.type,
      paused: e.paused,
      branchName: e.branchName ?? undefined,
    })),
  };
}

function curateRun(run: any) {
  return {
    id: run.id,
    status: run.status,
    taskIdentifier: run.taskIdentifier,
    version: run.version,
    isQueued: run.isQueued,
    isExecuting: run.isExecuting,
    isCompleted: run.isCompleted,
    isFailed: run.isFailed,
    isCancelled: run.isCancelled,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    durationMs: run.durationMs,
    costInCents: run.costInCents,
    attemptCount: run.attemptCount,
    tags: run.tags,
    error: run.error ? { name: run.error.name, message: run.error.message } : undefined,
  };
}

function curateTasks(data: unknown) {
  const tasks = (data as any)?.worker?.tasks ?? [];
  return {
    tasks: (Array.isArray(tasks) ? tasks : []).map((t: any) => ({
      slug: t.slug,
      filePath: t.filePath,
      triggerSource: t.triggerSource,
    })),
  };
}

const NO_AUTH = { error: "No delegated access is available for this turn." } as const;

// Always returns the same four tools so the declared tool set stays stable
// across turns (the SDK replays it over prior history). When a turn carried no
// delegated token, each tool reports that rather than silently disappearing.
export function buildDashboardAgentTools(ctx: DashboardAgentToolContext): ToolSet {
  const { userActorToken, apiOrigin, projectRef, environmentName } = ctx;
  const origin = apiOrigin ? apiOrigin.replace(/\/$/, "") : "";
  const hasAuth = Boolean(userActorToken && origin);

  // Exchange lazily and once per turn — turns that never touch an env tool
  // never pay for the exchange.
  let envJwtPromise: Promise<string | null> | undefined;
  function getEnvJwt(): Promise<string | null> {
    if (!hasAuth || !projectRef || !environmentName) return Promise.resolve(null);
    envJwtPromise ??= exchangeEnvJwt(origin, userActorToken!, projectRef, environmentName);
    return envJwtPromise;
  }

  return {
    list_projects: tool({
      description:
        "List the Trigger.dev projects the user can access, with each project's ref, name, slug, and organization.",
      inputSchema: z.object({}),
      execute: async () => {
        if (!hasAuth) return NO_AUTH;
        const result = await apiGet(origin, "/api/v1/projects", userActorToken!);
        if (!result.ok) return { error: `Couldn't list projects (status ${result.status}).` };
        return curateProjects(result.data);
      },
    }),

    list_environments: tool({
      description:
        "List the environments (dev, staging, production, preview branches) for a project. Defaults to the current project when projectRef is omitted.",
      inputSchema: z.object({
        projectRef: z
          .string()
          .optional()
          .describe("Project ref like proj_... . Defaults to the current project."),
      }),
      execute: async ({ projectRef: inputRef }) => {
        if (!hasAuth) return NO_AUTH;
        const ref = inputRef ?? projectRef;
        if (!ref) return { error: "No project ref available. Ask the user which project." };
        const result = await apiGet(origin, `/api/v1/projects/${ref}/environments`, userActorToken!);
        if (!result.ok) return { error: `Couldn't list environments (status ${result.status}).` };
        return curateEnvironments(result.data);
      },
    }),

    get_run: tool({
      description:
        "Get the status, timing, cost, and error details for a single run in the current environment, by its run id (run_...).",
      inputSchema: z.object({
        runId: z.string().describe("The run id, e.g. run_abc123."),
      }),
      execute: async ({ runId }) => {
        const envJwt = await getEnvJwt();
        if (!envJwt) return { error: "No current environment is available to read runs from." };
        const result = await apiGet(origin, `/api/v3/runs/${runId}`, envJwt);
        if (!result.ok) return { error: `Couldn't get run ${runId} (status ${result.status}).` };
        return curateRun(result.data);
      },
    }),

    list_tasks: tool({
      description:
        "List the tasks deployed in the current environment's latest deployment, with each task's slug, file path, and trigger source.",
      inputSchema: z.object({}),
      execute: async () => {
        if (!hasAuth) return NO_AUTH;
        if (!projectRef || !environmentName) {
          return { error: "No current environment is available to read tasks from." };
        }
        // The worker-by-tag route is user-level (PAT/UAT), so this uses the
        // delegated token directly — no env-JWT exchange.
        const result = await apiGet(
          origin,
          `/api/v1/projects/${projectRef}/${environmentName}/workers/current`,
          userActorToken!
        );
        if (!result.ok) return { error: `Couldn't list tasks (status ${result.status}).` };
        return curateTasks(result.data);
      },
    }),
  };
}
