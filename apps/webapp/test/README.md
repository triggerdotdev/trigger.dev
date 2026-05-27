# Webapp tests

Three suites live in this directory.

## Unit tests — `*.test.ts`

Run with `pnpm test` from `apps/webapp`. Default vitest pickup. No
container setup. Run on every PR via `unit-tests-webapp.yml`.

## Smoke e2e — `*.e2e.test.ts`

End-to-end auth baseline that proves the route auth plumbing is wired up.
Each file spins up its own webapp + Postgres + Redis container in
`beforeAll` (~30s startup). Vitest config: `vitest.e2e.config.ts`. Run on
every PR via `e2e-webapp.yml`.

```bash
cd apps/webapp
pnpm exec vitest --config vitest.e2e.config.ts
```

## Comprehensive auth e2e — `*.e2e.full.test.ts`

The full RBAC auth matrix — every route family with explicit pass/fail
scenarios. See TRI-8731 for the parent ticket and TRI-8732 onwards for
each family's coverage spec.

**Architecture**: one container reused across the whole suite via
`vitest.e2e.full.config.ts`'s `globalSetup`. Test files share the server
through `getTestServer()` from `helpers/sharedTestServer.ts`. Each test
seeds its own resources so order doesn't matter.

**Layout**:

| File | Top-level describe | Family subtasks |
|---|---|---|
| `auth-api.e2e.full.test.ts` | `API` | TRI-8733 trigger, TRI-8734 run resource, TRI-8735 run mutations, TRI-8736 run lists, TRI-8737 batches, TRI-8738 prompts, TRI-8739 deployments + query, TRI-8740 waitpoints + input streams, TRI-8741 PAT |
| `auth-dashboard.e2e.full.test.ts` | `Dashboard` | TRI-8742 admin pages |
| `auth-cross-cutting.e2e.full.test.ts` | `Cross-cutting` | TRI-8743 deleted projects / revoked keys / expired JWTs / env mismatch / force-fallback toggle |

**Adding a new family**: pick the relevant file, add a nested `describe`
block. Inside, seed your own fixtures via the helpers and hit the shared
server.

```ts
describe("Trigger task", () => {
  const server = getTestServer();

  it("missing Authorization → 401", async () => {
    const res = await server.webapp.fetch("/api/v1/tasks/x/trigger", { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
  });
});
```

**CI**: `e2e-webapp-auth-full.yml`. Triggers on `workflow_dispatch`,
nightly schedule, and PRs touching auth-relevant paths (route builders,
rbac.server.ts, apiAuth.server.ts, apiroutes, the suite itself).

**Run locally**:

```bash
cd apps/webapp
pnpm exec vitest --config vitest.e2e.full.config.ts
```
