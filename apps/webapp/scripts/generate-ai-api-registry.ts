/**
 * Generates the AI assistant's API registry from the Trigger.dev OpenAPI spec
 * (`docs/v3-openapi.yaml`). The registry is the single source of truth the API
 * agent searches over (BM25) and executes against.
 *
 * Run it whenever the OpenAPI spec changes:
 *
 *   pnpm exec tsx apps/webapp/scripts/generate-ai-api-registry.ts
 *
 * This lives in scripts/ (NOT app/trigger/) on purpose: the trigger CLI indexes
 * and imports everything under app/trigger, which would run this at boot. Keep
 * its imports to Node built-ins + `yaml`.
*/
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

// tsx provides __dirname in CJS; fall back to import.meta.url under ESM.
const here =
  typeof __dirname !== "undefined" ? __dirname : dirname(fileURLToPath(import.meta.url));

/** Walk up from `start` until a directory containing `docs/v3-openapi.yaml` is found. */
function findRepoRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 10; i++) {
    if (existsSync(resolve(dir, "docs/v3-openapi.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`Could not locate docs/v3-openapi.yaml walking up from ${start}`);
}

const REPO_ROOT = findRepoRoot(here);
const SPEC_PATH = resolve(REPO_ROOT, "docs/v3-openapi.yaml");
const OUTPUT_PATH = resolve(
  REPO_ROOT,
  "apps/webapp/app/trigger/ai-assistant-tools/api/registry.json"
);

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;

// Operations that change or destroy state. call_api asks the user to confirm
// before executing these. DELETE is always treated as destructive; these are
// the non-DELETE verbs that still mutate.
const DESTRUCTIVE_OPERATION_IDS = new Set([
  "cancel_run_v1",
  "deactivate_schedule_v1",
  "delete_schedule_v1",
  "delete_project_envvar_v1",
  "pause_queue_v1",
  "override_queue_concurrency_v1",
  "reset_queue_concurrency_v1",
  "promote_deployment_v1",
  "replay_run_v1",
]);

type Json = any;

interface FlatParam {
  name: string;
  in: "path" | "query" | "body";
  required: boolean;
  type?: string;
  enum?: string[];
  description?: string;
  /** For body params: the (dereferenced) JSON Schema of the request body. */
  schema?: Json;
}

interface RegistryEntry {
  operationId: string;
  method: string;
  path: string;
  summary: string;
  description?: string;
  tag: string;
  /** "secretKey" | "personalAccessToken" | "public" | "none" */
  auth: string;
  destructive: boolean;
  parameters: FlatParam[];
  requiredParams: string[];
  searchText: string;
}

/** Recursively inline `$ref`s pointing into the spec, guarding against cycles. */
function deref(node: Json, spec: Json, seen: Set<string> = new Set()): Json {
  if (Array.isArray(node)) return node.map((n) => deref(n, spec, seen));
  if (node && typeof node === "object") {
    if (typeof node.$ref === "string") {
      const ref: string = node.$ref;
      if (seen.has(ref)) return {}; // cycle — stop expanding
      const target = resolveRef(ref, spec);
      if (target === undefined) return node;
      return deref(target, spec, new Set([...seen, ref]));
    }
    const out: Json = {};
    for (const [key, value] of Object.entries(node)) {
      out[key] = deref(value, spec, seen);
    }
    return out;
  }
  return node;
}

function resolveRef(ref: string, spec: Json): Json | undefined {
  if (!ref.startsWith("#/")) return undefined;
  return ref
    .slice(2)
    .split("/")
    .reduce<Json>((acc, part) => (acc == null ? acc : acc[part]), spec);
}

function authFromSecurity(security: Json): string {
  if (!Array.isArray(security)) return "secretKey"; // spec default
  if (security.length === 0) return "none";
  const schemes = security.flatMap((entry) => Object.keys(entry ?? {}));
  if (schemes.includes("secretKey")) return "secretKey";
  if (schemes.includes("personalAccessToken")) return "personalAccessToken";
  if (schemes.includes("publicAccessToken")) return "public";
  return schemes[0] ?? "secretKey";
}

function flattenParameters(operation: Json, pathLevelParams: Json[], spec: Json): FlatParam[] {
  const out: FlatParam[] = [];

  const allParams = [...pathLevelParams, ...(operation.parameters ?? [])].map((p) =>
    deref(p, spec)
  );
  for (const param of allParams) {
    if (!param?.name || (param.in !== "path" && param.in !== "query")) continue;
    out.push({
      name: param.name,
      in: param.in,
      required: Boolean(param.required),
      type: param.schema?.type,
      enum: param.schema?.enum,
      description: typeof param.description === "string" ? param.description.trim() : undefined,
    });
  }

  const requestBody = operation.requestBody ? deref(operation.requestBody, spec) : undefined;
  const bodySchema = requestBody?.content?.["application/json"]?.schema;
  if (bodySchema) {
    out.push({
      name: "_body",
      in: "body",
      required: Boolean(requestBody.required),
      description: "JSON request body. Pass its fields directly inside `params`.",
      schema: bodySchema,
    });
  }

  return out;
}

/** Pull leaf field names out of a JSON Schema so they feed the BM25 index. */
function collectFieldNames(schema: Json, acc: string[] = [], depth = 0): string[] {
  if (!schema || typeof schema !== "object" || depth > 4) return acc;
  if (schema.properties && typeof schema.properties === "object") {
    for (const [key, value] of Object.entries(schema.properties)) {
      acc.push(key);
      collectFieldNames(value, acc, depth + 1);
    }
  }
  for (const combinator of ["allOf", "anyOf", "oneOf"] as const) {
    if (Array.isArray(schema[combinator])) {
      for (const sub of schema[combinator]) collectFieldNames(sub, acc, depth + 1);
    }
  }
  if (schema.items) collectFieldNames(schema.items, acc, depth + 1);
  return acc;
}

function buildRegistry(spec: Json): RegistryEntry[] {
  const registry: RegistryEntry[] = [];

  for (const [path, pathItem] of Object.entries<Json>(spec.paths ?? {})) {
    const pathLevelParams: Json[] = Array.isArray(pathItem.parameters)
      ? pathItem.parameters
      : [];

    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (!operation?.operationId) continue;

      const tag = String(operation.tags?.[0] ?? "general").toLowerCase();
      const parameters = flattenParameters(operation, pathLevelParams, spec);
      const requiredParams = parameters.filter((p) => p.required).map((p) => p.name);
      const auth = authFromSecurity(operation.security);
      const destructive =
        method === "delete" || DESTRUCTIVE_OPERATION_IDS.has(operation.operationId);

      const bodyFields = parameters
        .filter((p) => p.in === "body")
        .flatMap((p) => collectFieldNames(p.schema));
      const searchText = [
        operation.operationId,
        operation.summary ?? "",
        operation.description ?? "",
        tag,
        method,
        path,
        parameters.map((p) => p.name).join(" "),
        bodyFields.join(" "),
      ]
        .filter(Boolean)
        .join(" ")
        .replace(/\s+/g, " ")
        .toLowerCase();

      registry.push({
        operationId: operation.operationId,
        method: method.toUpperCase(),
        path,
        summary: String(operation.summary ?? operation.operationId),
        description:
          typeof operation.description === "string" ? operation.description.trim() : undefined,
        tag,
        auth,
        destructive,
        parameters,
        requiredParams,
        searchText,
      });
    }
  }

  registry.sort((a, b) => a.operationId.localeCompare(b.operationId));
  return registry;
}

function main() {
  const spec = parseYaml(readFileSync(SPEC_PATH, "utf8"));
  const registry = buildRegistry(spec);
  writeFileSync(OUTPUT_PATH, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
  console.log(
    `Wrote ${registry.length} operations to ${OUTPUT_PATH} ` +
      `(${registry.filter((r) => r.destructive).length} flagged destructive).`
  );
}

main();
