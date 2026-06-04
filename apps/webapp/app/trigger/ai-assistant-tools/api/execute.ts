/**
 * HTTP execution layer for the API agent. Resolves the user's environment
 * secret key from the database (the task has Prisma access + org/project/env
 * slugs from clientData), builds the request from a registry entry, and
 * executes it against the Trigger.dev REST API.
 */
import { prisma } from "../../db";
import type { ClientData } from "../types";
import { getOperation, type RegistryEntry, type RegistryParam } from "./search";

const RESPONSE_CHAR_LIMIT = 8_000;
const LIST_ITEM_LIMIT = 10;

interface ApiContext {
  apiKey: string;
  /** Project external ref (`proj_...`), auto-filled into `projectRef` path params. */
  projectRef: string;
  /** Environment slug (`dev`/`staging`/`prod`), auto-filled into `env` path params. */
  envSlug: string;
  baseUrl: string;
}

// Resolved env auth is stable for the life of the task; cache by identity key.
const contextCache = new Map<string, ApiContext>();

function baseUrl(): string {
  return (
    process.env.API_ORIGIN ?? process.env.APP_ORIGIN ?? "http://localhost:3030"
  ).replace(/\/$/, "");
}

async function resolveApiContext(clientData: ClientData): Promise<ApiContext> {
  const cacheKey = `${clientData.userId}:${clientData.organizationSlug}:${clientData.projectSlug}:${clientData.environmentSlug}`;
  const cached = contextCache.get(cacheKey);
  if (cached) return cached;

  const environment = await prisma.runtimeEnvironment.findFirst({
    where: {
      slug: clientData.environmentSlug,
      project: {
        slug: clientData.projectSlug,
        organization: { slug: clientData.organizationSlug },
      },
      // Dev environments are per-member; everything else is shared. Mirrors
      // findEnvironmentBySlug so we resolve the caller's own dev key.
      OR: [
        { type: { in: ["PREVIEW", "STAGING", "PRODUCTION"] } },
        { type: "DEVELOPMENT", orgMember: { userId: clientData.userId } },
      ],
    },
    select: {
      apiKey: true,
      project: { select: { externalRef: true } },
    },
  });

  if (!environment) {
    throw new Error(
      `Could not resolve API credentials for ${clientData.projectSlug}/${clientData.environmentSlug}.`
    );
  }

  const context: ApiContext = {
    apiKey: environment.apiKey,
    projectRef: environment.project.externalRef,
    envSlug: clientData.environmentSlug,
    baseUrl: baseUrl(),
  };
  contextCache.set(cacheKey, context);
  return context;
}

export type ApiCallResult =
  | { status: "error"; error: string; details?: unknown; httpStatus?: number }
  | { status: "ok"; httpStatus: number; data: unknown; truncated?: boolean; note?: string };

/** Serialize a query value, expanding objects to OpenAPI deepObject bracket form. */
function appendQueryParam(search: URLSearchParams, key: string, value: unknown): void {
  if (value == null) return;
  if (Array.isArray(value)) {
    search.set(key, value.join(","));
  } else if (typeof value === "object") {
    for (const [subKey, subValue] of Object.entries(value as Record<string, unknown>)) {
      if (subValue == null) continue;
      const serialized = Array.isArray(subValue)
        ? subValue.join(",")
        : typeof subValue === "object"
          ? JSON.stringify(subValue)
          : String(subValue);
      search.set(`${key}[${subKey}]`, serialized);
    }
  } else {
    search.set(key, String(value));
  }
}

function paramByName(operation: RegistryEntry, name: string): RegistryParam | undefined {
  return operation.parameters.find((p) => p.name === name);
}

/** Truncate large list responses to keep the model context small. */
function truncateResponse(data: unknown): { data: unknown; truncated: boolean; note?: string } {
  if (Array.isArray(data) && data.length > LIST_ITEM_LIMIT) {
    return {
      data: data.slice(0, LIST_ITEM_LIMIT),
      truncated: true,
      note: `Showing first ${LIST_ITEM_LIMIT} of ${data.length} items.`,
    };
  }
  if (data && typeof data === "object") {
    const record = data as Record<string, unknown>;
    if (Array.isArray(record.data) && record.data.length > LIST_ITEM_LIMIT) {
      const total = record.data.length;
      return {
        data: { ...record, data: record.data.slice(0, LIST_ITEM_LIMIT) },
        truncated: true,
        note: `Showing first ${LIST_ITEM_LIMIT} of ${total} items. Use pagination to see more.`,
      };
    }
  }
  return { data, truncated: false };
}

export interface ExecuteApiCallOptions {
  operationId: string;
  params: Record<string, unknown>;
  clientData: ClientData;
}

export async function executeApiCall(options: ExecuteApiCallOptions): Promise<ApiCallResult> {
  const { operationId, params, clientData } = options;
  const operation = getOperation(operationId);

  if (!operation) {
    return {
      status: "error",
      error: `Unknown operationId "${operationId}". Use searchApi to find the right one.`,
    };
  }

  if (operation.auth === "personalAccessToken") {
    return {
      status: "error",
      error: `"${operationId}" requires a Personal Access Token, which the assistant doesn't have. Suggest the user run this from the CLI/SDK instead.`,
    };
  }

  // State-changing operations only reach execute() after the user approves the
  // call in the UI — the AI SDK holds the tool until then (see `needsApproval`
  // on the callApi tool). So by the time we're here, execution is authorized.

  let context: ApiContext;
  try {
    context = await resolveApiContext(clientData);
  } catch (error) {
    return { status: "error", error: error instanceof Error ? error.message : String(error) };
  }

  // Validate required params (projectRef/env are auto-filled from context).
  const autoFilled = new Set(["projectRef", "env"]);
  const missing = operation.requiredParams.filter(
    (name) => params[name] === undefined && !autoFilled.has(name) && name !== "_body"
  );
  if (operation.requiredParams.includes("_body") && params._body === undefined) {
    // Body fields may be passed flat; only flag if no body-ish keys exist.
    const knownNonBody = new Set(operation.parameters.filter((p) => p.in !== "body").map((p) => p.name));
    const hasBodyKeys = Object.keys(params).some((k) => !knownNonBody.has(k));
    if (!hasBodyKeys) missing.push("_body (request body fields)");
  }
  if (missing.length > 0) {
    return {
      status: "error",
      error: `Missing required parameter(s): ${missing.join(", ")}. Call getApiDetails("${operationId}") to see the full parameter schema before retrying.`,
      details: { requiredParams: operation.requiredParams },
    };
  }

  // --- Build the request -------------------------------------------------
  let path = operation.path;
  const search = new URLSearchParams();
  const consumed = new Set<string>();

  for (const param of operation.parameters) {
    if (param.in === "path") {
      let value = params[param.name];
      if (value === undefined && param.name === "projectRef") value = context.projectRef;
      if (value === undefined && param.name === "env") value = context.envSlug;
      if (value === undefined) {
        return {
          status: "error",
          error: `Missing path parameter "${param.name}". Call getApiDetails("${operationId}") to see all required parameters.`,
        };
      }
      path = path.replace(`{${param.name}}`, encodeURIComponent(String(value)));
      consumed.add(param.name);
    } else if (param.in === "query") {
      if (params[param.name] !== undefined) {
        appendQueryParam(search, param.name, params[param.name]);
        consumed.add(param.name);
      }
    }
  }

  // Body: explicit `_body`, otherwise collect remaining (unconsumed) keys.
  const bodyParam = paramByName(operation, "_body");
  let body: unknown;
  if (bodyParam) {
    if (params._body !== undefined) {
      body = params._body;
      consumed.add("_body");
    } else {
      const collected: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(params)) {
        if (!consumed.has(key)) collected[key] = value;
      }
      if (Object.keys(collected).length > 0) body = collected;
    }
  }

  const queryString = search.toString();
  const url = `${context.baseUrl}${path}${queryString ? `?${queryString}` : ""}`;
  const hasBody = body !== undefined && operation.method !== "GET";

  let response: Response;
  try {
    response = await fetch(url, {
      method: operation.method,
      headers: {
        Authorization: `Bearer ${context.apiKey}`,
        Accept: "application/json",
        ...(hasBody ? { "Content-Type": "application/json" } : {}),
      },
      body: hasBody ? JSON.stringify(body) : undefined,
    });
  } catch (error) {
    return { status: "error", error: `Request failed: ${error instanceof Error ? error.message : String(error)}` };
  }

  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // non-JSON response; keep raw text
  }

  if (!response.ok) {
    return {
      status: "error",
      error: `API returned ${response.status} ${response.statusText}`,
      httpStatus: response.status,
      details: parsed,
    };
  }

  const { data, truncated, note } = truncateResponse(parsed);
  let serialized = JSON.stringify(data);
  if (serialized.length > RESPONSE_CHAR_LIMIT) {
    serialized = serialized.slice(0, RESPONSE_CHAR_LIMIT);
    return {
      status: "ok",
      httpStatus: response.status,
      data: serialized,
      truncated: true,
      note: "Response was large and has been truncated. Ask for a narrower query if you need specifics.",
    };
  }

  return { status: "ok", httpStatus: response.status, data, truncated, note };
}
