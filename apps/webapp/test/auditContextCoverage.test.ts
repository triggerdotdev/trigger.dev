import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parseAst, transformWithEsbuild } from "vite";
import { describe, expect, it } from "vitest";

const appDir = path.join(__dirname, "../app");
const routesDir = path.join(appDir, "routes");

/**
 * Routes that read or change environment variables, credentials or members. Their audit events
 * need to know who made the request, so each must authenticate through a function that fills the
 * request audit context.
 */
const AUDITED_ROUTE_PATTERNS: RegExp[] = [
  // Environment variables, including the dashboard pages.
  /envvars/,
  /environment-variables/,
  /build-env-vars/,
  // Credentials: API keys, public tokens, personal access tokens.
  /apikeys/,
  /api-key/,
  /\bjwt\b/,
  /public-tokens/,
  /user-actor-token/,
  /authorization-code/,
  /^account\.tokens/,
  /^api\.v1\.token\.ts$/,
  // Members and invites.
  /members/,
  /invite/,
  /\bteam\b/,
];

const API_BUILDER = "services/routeBuilders/apiBuilder.server.ts";
const SESSION = "services/session.server.ts";
const AUTH_TELEMETRY = "services/authTelemetry.server.ts";
const API_AUTH = "services/apiAuth.server.ts";
const ENV_VAR_ACCESS = "services/environmentVariableApiAccess.server.ts";

/**
 * Auth functions that fill the request audit context, and what each module calls to do it. The
 * second test checks every chain ends in a `note…Authentication` call, so a refactor that drops one
 * fails here too. Paths are relative to `app/`.
 */
const CONTEXT_ENTRY_POINTS: Record<string, { module: string; calls: string[] }> = {
  createLoaderApiRoute: { module: API_BUILDER, calls: ["authenticateRequestForApiBuilder"] },
  createActionApiRoute: { module: API_BUILDER, calls: ["authenticateRequestForApiBuilder"] },
  createMultiMethodApiRoute: { module: API_BUILDER, calls: ["authenticateRequestForApiBuilder"] },
  authenticateRequestForApiBuilder: {
    module: API_BUILDER,
    calls: ["authenticateBearerWithTelemetry"],
  },
  createLoaderPATApiRoute: {
    module: API_BUILDER,
    calls: ["notePersonalAccessTokenAuthentication"],
  },
  createActionPATApiRoute: {
    module: API_BUILDER,
    calls: ["notePersonalAccessTokenAuthentication"],
  },
  dashboardLoader: {
    module: "services/routeBuilders/dashboardBuilder.ts",
    calls: ["authenticateAndAuthorize"],
  },
  dashboardAction: {
    module: "services/routeBuilders/dashboardBuilder.ts",
    calls: ["authenticateAndAuthorize"],
  },
  authenticateAndAuthorize: {
    module: "services/routeBuilders/dashboardBuilder.server.ts",
    calls: ["getUserId"],
  },
  getUserId: { module: SESSION, calls: ["sessionUserId"] },
  sessionUserId: { module: SESSION, calls: ["noteSessionAuthentication"] },
  getUser: { module: SESSION, calls: ["getUserId"] },
  requireUserId: { module: SESSION, calls: ["getUserId"] },
  requireUser: { module: SESSION, calls: ["getUser"] },
  authenticateBearerWithTelemetry: { module: AUTH_TELEMETRY, calls: ["noteBearerAuthentication"] },
  authenticateAuthorizeBearerWithTelemetry: {
    module: AUTH_TELEMETRY,
    calls: ["authenticateBearerWithTelemetry"],
  },
  authenticateApiKeyWithScope: {
    module: API_AUTH,
    calls: ["authenticateAuthorizeBearerWithTelemetry"],
  },
  authenticateApiKeyRequest: { module: API_AUTH, calls: ["authenticateBearerWithTelemetry"] },
  authenticateApiRequest: { module: API_AUTH, calls: ["observeLegacyApiKeyAuthentication"] },
  authenticateApiRequestWithFailure: {
    module: API_AUTH,
    calls: ["observeLegacyApiKeyAuthentication"],
  },
  observeLegacyApiKeyAuthentication: {
    module: API_AUTH,
    calls: ["noteLegacyApiKeyAuthentication"],
  },
  authenticateRequest: {
    module: API_AUTH,
    calls: [
      "notePersonalAccessTokenAuthentication",
      "noteOrganizationAccessTokenAuthentication",
      "observeLegacyApiKeyAuthentication",
    ],
  },
  authenticateRequestWithScopedApiKey: {
    module: API_AUTH,
    calls: ["authenticateRequest", "authenticateApiKeyWithScope"],
  },
  authenticateEnvVarApiRequest: {
    module: ENV_VAR_ACCESS,
    calls: ["authenticateEnvironmentScopedApiRequest"],
  },
  authenticateEnvironmentScopedApiRequest: {
    module: ENV_VAR_ACCESS,
    calls: ["authenticateRequestWithScopedApiKey"],
  },
  authenticateEnvironmentBootstrapRequest: {
    module: ENV_VAR_ACCESS,
    calls: ["authenticateRequest", "authenticateApiKeyRequest"],
  },
  authenticateUatOrApiRequest: {
    module: "services/uatRoutePreamble.server.ts",
    calls: ["notePersonalAccessTokenAuthentication", "authenticateRequest"],
  },
  handlePublicTokenRequest: {
    module: "services/publicTokens.server.ts",
    calls: ["authenticateBearerWithTelemetry"],
  },
};

/** Auth functions that authenticate a caller without filling the audit context. */
const AUTH_WITHOUT_CONTEXT = [
  "authenticateApiRequestWithPersonalAccessToken",
  "authenticateApiRequestWithOrganizationAccessToken",
  "authenticatePersonalAccessToken",
  "authenticateApiKey",
  "authenticateAuthorizationHeader",
  "requireAdminApiRequest",
  "authenticateAdminRequest",
  "rbac.authenticatePat",
  "rbac.authenticateUserActor",
];

/** In scope by name, but no caller to attribute. */
const NO_CALLER: Record<string, string> = {
  "api.v1.token.ts": "Unauthenticated: the CLI polls it to collect a token made in the dashboard.",
  "api.v1.authorization-code.ts": "Unauthenticated: the CLI asks for a code to start logging in.",
  "orgs.$organizationSlug.team.ts": "Redirect only.",
};

/**
 * Routes that don't fill the context yet. Each needs its auth function to note the caller before
 * its events can be attributed. Remove an entry once it does: the test fails on stale entries.
 */
const KNOWN_GAPS: Record<string, string> = {
  "admin.api.v1.revoked-api-keys.$revokedApiKeyId.ts":
    "Admin API: requireAdminApiRequest authenticates a staff PAT without noting it.",
  "api.v1.auth.user-actor-token.ts": "Calls rbac.authenticatePat directly.",
};

const EXPORT = /^export\s+(?:async\s+function|function|const)\s+(loader|action)\b/gm;

/** Whether `source` names `name`, called or passed as a default dependency. */
function references(source: string, name: string): boolean {
  return new RegExp(`(?<![\\w.])${name}\\b`).test(source);
}

function calls(source: string, name: string): boolean {
  const escaped = name.replace(/[.$]/g, "\\$&");
  return new RegExp(`(?<![\\w.])${escaped}(?:<[^>()]*>)?\\(`).test(source);
}

/**
 * The source of the function or const named `name`, parameters included (auth functions are
 * sometimes passed as default parameters), or null when `source` doesn't define it. Types are
 * stripped first, so only a function's implementation counts, not its overloads.
 */
async function definitionOf(source: string, name: string): Promise<string | null> {
  const { code } = await transformWithEsbuild(source, "module.ts");
  let definition: string | null = null;
  const visit = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const { type, id, init, start, end } = node as Record<string, any>;
    if (type === "FunctionDeclaration" && id?.name === name) {
      definition = code.slice(start, end);
    } else if (type === "VariableDeclarator" && id?.name === name && init) {
      definition = code.slice(init.start, init.end);
    }
    for (const child of Object.values(node)) visit(child);
  };
  visit(parseAst(code));
  return definition;
}

/** Route name → loader/action source, for route files and folder routes. */
function auditedRoutes(): Map<string, string> {
  const routes = new Map<string, string>();
  for (const name of readdirSync(routesDir)) {
    if (!AUDITED_ROUTE_PATTERNS.some((pattern) => pattern.test(name))) continue;

    const fullPath = path.join(routesDir, name);
    const file = statSync(fullPath).isDirectory()
      ? ["route.tsx", "route.ts"].map((entry) => path.join(fullPath, entry)).find(existsSync)
      : /\.tsx?$/.test(name)
        ? fullPath
        : undefined;
    if (!file) continue;

    const source = readFileSync(file, "utf8");
    if (source.match(EXPORT)) routes.set(name, source);
  }
  return routes;
}

describe("request audit context coverage", () => {
  /**
   * Catches: a new or edited env var, credential or member route that authenticates in a way the
   * audit context never sees, so its events would have no actor or credential.
   */
  it("authenticates every env var, credential and member route through a context-filling auth function", () => {
    const routes = auditedRoutes();
    const uncovered: Record<string, string> = {};

    for (const [name, source] of routes) {
      if (NO_CALLER[name]) continue;

      const entryPoints = Object.keys(CONTEXT_ENTRY_POINTS).filter((entry) => calls(source, entry));
      const bypasses = AUTH_WITHOUT_CONTEXT.filter((entry) => calls(source, entry));

      if (entryPoints.length === 0) {
        uncovered[name] = "no context-filling auth function";
      } else if (bypasses.length > 0) {
        uncovered[name] = `also authenticates with ${bypasses.join(", ")}`;
      }
    }

    expect(Object.keys(uncovered).sort()).toEqual(Object.keys(KNOWN_GAPS).sort());
    // The dashboard env var pages are in scope, not just the API.
    expect(
      routes.has(
        "_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.environment-variables"
      )
    ).toBe(true);
    for (const name of Object.keys(NO_CALLER)) {
      expect(routes.has(name), `${name} is no longer an in-scope route`).toBe(true);
    }
  });

  /** Catches: an auth function that stops noting the caller, which would hide every route above. */
  it("ends every context-filling auth function in a note…Authentication call", async () => {
    const broken: string[] = [];

    for (const [entry, { module, calls: callees }] of Object.entries(CONTEXT_ENTRY_POINTS)) {
      const definition = await definitionOf(readFileSync(path.join(appDir, module), "utf8"), entry);
      if (!definition) {
        broken.push(`${entry}: not defined in ${module}`);
        continue;
      }
      for (const callee of callees) {
        const isNote = /^note\w+Authentication$/.test(callee);
        // Auth functions are sometimes passed as default dependencies rather than called directly.
        const found = isNote ? calls(definition, callee) : references(definition, callee);
        if (!found) broken.push(`${entry}: ${entry} doesn't call ${callee}`);
        if (!isNote && !(callee in CONTEXT_ENTRY_POINTS)) {
          broken.push(`${entry}: ${callee} is not a known context step`);
        }
      }
    }

    expect(broken).toEqual([]);
  });

  /**
   * Catches: the check above reading the whole module, so one function's call hides another
   * function losing its own.
   */
  it("checks each auth function's own definition, not the rest of its module", async () => {
    const source = `
      export function createLoaderPATApiRoute() { notePersonalAccessTokenAuthentication(request, result); }
      export const createActionPATApiRoute = () => { authenticateApiRequestWithPersonalAccessToken(request); };
      export function authenticateApiKeyWithScope(request, authorizeBearer = authenticateAuthorizeBearerWithTelemetry) {}
    `;

    expect(calls(source, "notePersonalAccessTokenAuthentication")).toBe(true);
    expect(
      calls(
        (await definitionOf(source, "createLoaderPATApiRoute"))!,
        "notePersonalAccessTokenAuthentication"
      )
    ).toBe(true);
    expect(
      calls(
        (await definitionOf(source, "createActionPATApiRoute"))!,
        "notePersonalAccessTokenAuthentication"
      )
    ).toBe(false);
    expect(
      references(
        (await definitionOf(source, "authenticateApiKeyWithScope"))!,
        "authenticateAuthorizeBearerWithTelemetry"
      )
    ).toBe(true);
    expect(await definitionOf(source, "authenticateRequest")).toBeNull();
  });
});
