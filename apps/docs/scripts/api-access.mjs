#!/usr/bin/env node
// The access each API reference operation needs, read from the webapp route that serves it, and
// written into the OpenAPI specs as `x-trigger-access` (`action:resource`, e.g. `read:runs`).
//
//   node scripts/api-access.mjs          rewrite the specs' x-trigger-access from the routes
//   lib/api-access-spec.test.ts          fails when a spec and its routes disagree
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { contentDirOf } from "../lib/content-files.ts";

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const routesDir = path.resolve(app, "../webapp/app/routes");
export const specFiles = ["v3-openapi.yaml", "openapi.yml"].map((f) =>
  path.join(contentDirOf(app), f)
);

// Operations the route reader can't settle on its own, with the reason. Keep this short.
const OVERRIDES = {
  // No authentication: a static list.
  "GET /api/v1/timezones": null,
  // Authenticated by the hash in its URL, not by an API key.
  "POST /api/v1/waitpoints/tokens/{waitpointId}/callback/{callbackHash}": null,
  // The v2 events endpoint; the webapp doesn't serve it.
  "POST /api/v1/events": null,
  // Authorized per item as a task trigger (utils/batchItemAuthorization.ts).
  "POST /api/v3/batches/{batchId}/items": "trigger:tasks",
};

const METHODS = ["get", "post", "put", "patch", "delete"];

/** The Remix route file serving an OpenAPI path, e.g. /api/v1/runs/{runId} -> api.v1.runs.$runParam.ts */
function routeFileFor(apiPath, files = readdirSync(routesDir)) {
  const segments = apiPath.split("/").filter(Boolean);
  const pattern = new RegExp(
    "^" +
      segments
        .map((s) => (s.startsWith("{") ? "\\$[A-Za-z]+" : s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
        .join("\\.") +
      "(?:\\._index)?(?:\\.tsx?|/route\\.tsx?)$"
  );
  const candidates = files.flatMap((f) =>
    f.includes(".") ? [f] : readdirSync(path.join(routesDir, f)).map((c) => `${f}/${c}`)
  );
  return candidates.find((f) => pattern.test(f)) ?? null;
}

/** Every `action`/`resource type` pair the route checks, in source order. */
function accessPairs(source) {
  const pairs = [];
  const patterns = [
    // createLoaderApiRoute / createActionApiRoute: authorization: { action, resource }
    /authorization:\s*\{[\s\S]*?action:\s*"(\w+)"[\s\S]*?type:\s*"(\w+)"/g,
    // authenticateApiKeyWithScope(request, { action, resource: { type } })
    /authenticateApiKeyWithScope\(\s*\w+,\s*\{\s*action:\s*"(\w+)",\s*resource:\s*\{\s*type:\s*"(\w+)"/g,
    // authenticateEnvVarApiRequest(request, "read")
    /authenticateEnvVarApiRequest\(\s*\w+,\s*"(\w+)"\s*\)()/g,
  ];
  for (const re of patterns) {
    for (const m of source.matchAll(re)) {
      pairs.push({ index: m.index, scope: `${m[1]}:${m[2] || "envvars"}` });
    }
  }
  return pairs.sort((a, b) => a.index - b.index).map((p) => p.scope);
}

/** The access an operation needs according to its route, or undefined when it can't be read. */
export function routeAccess(method, apiPath) {
  const key = `${method.toUpperCase()} ${apiPath}`;
  if (key in OVERRIDES) return OVERRIDES[key];
  const file = routeFileFor(apiPath);
  if (!file) return undefined;
  const pairs = [...new Set(accessPairs(readFileSync(path.join(routesDir, file), "utf8")))];
  if (pairs.length === 0) return undefined;
  if (pairs.length === 1) return pairs[0];
  // A loader (GET) and an action in one file: GET reads, the others write.
  const reads = pairs.filter((p) => p.startsWith("read:"));
  const writes = pairs.filter((p) => !p.startsWith("read:"));
  const pick = method.toLowerCase() === "get" ? reads : writes;
  return pick.length === 1 ? pick[0] : undefined;
}

/** Every operation in a spec with the x-trigger-access it declares, by line. */
export function specOperations(text) {
  const ops = [];
  let current;
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    const p = line.match(/^ {2}"?(\/[^":]+)"?:\s*$/);
    if (p) current = p[1];
    const m = line.match(/^ {4}(get|post|put|patch|delete):\s*$/);
    if (m && current && METHODS.includes(m[1])) {
      const next = lines[i + 1]?.match(/^ {6}x-trigger-access:\s*(\S+)\s*$/);
      ops.push({ method: m[1], path: current, line: i, declared: next ? next[1] : undefined });
    }
  });
  return ops;
}

function rewrite(file) {
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");
  const unresolved = [];
  for (const op of specOperations(text).reverse()) {
    const access = routeAccess(op.method, op.path);
    if (access === undefined) unresolved.push(`${op.method.toUpperCase()} ${op.path}`);
    if (op.declared !== undefined) lines.splice(op.line + 1, 1);
    if (access) lines.splice(op.line + 1, 0, `      x-trigger-access: ${access}`);
  }
  writeFileSync(file, lines.join("\n"));
  return unresolved;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let missing = 0;
  for (const file of specFiles) {
    const unresolved = rewrite(file);
    missing += unresolved.length;
    for (const op of unresolved) console.error(`unresolved: ${path.basename(file)} ${op}`);
  }
  process.exit(missing ? 1 : 0);
}
