import { z } from "zod";
import { ResultAsync, okAsync, errAsync } from "neverthrow";
import { logger } from "~/services/logger.server";
import type { VercelApiError } from "./vercelIntegration.server";

// ---------------------------------------------------------------------------
// Recovery utilities for Vercel SDK validation errors
// ---------------------------------------------------------------------------
//
// The Vercel SDK (Speakeasy-generated) validates API responses with strict Zod
// schemas. When the API returns valid data but a field doesn't match the SDK's
// type (e.g., `deletedAt: null` vs `number`), a `ResponseValidationError` is
// thrown — even though the response contains all the data we need.
//
// Error hierarchy:
//   VercelError.body         → raw HTTP body text (HTTP errors — never recover)
//   ResponseValidationError.rawValue → parsed JSON that failed validation
//   SDKValidationError.rawValue      → same pattern, different base class
//
// Recovery: gate on validation error type → extract rawValue → validate → return.
// ---------------------------------------------------------------------------

/**
 * Only attempt recovery for SDK validation errors — not HTTP errors (401/403).
 *
 * ResponseValidationError and SDKValidationError both carry `rawValue` with the
 * parsed JSON that failed schema validation. VercelError (HTTP errors) carries
 * `body` instead — we must NOT recover from those since the response is an error
 * payload, not the data we asked for.
 */
function isValidationError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if (!(error instanceof Error)) return false;

  return (
    error.constructor.name === "ResponseValidationError" ||
    error.constructor.name === "SDKValidationError" ||
    "rawValue" in error
  );
}

function extractRawValue(error: unknown): unknown | undefined {
  if (!error || typeof error !== "object") return undefined;
  if ("rawValue" in error) {
    return (error as { rawValue: unknown }).rawValue;
  }
  return undefined;
}

/**
 * Attempt to recover usable data from a Vercel SDK error.
 *
 * Returns the validated data on success, or `undefined` if recovery fails.
 */
export function recoverFromVercelSdkError<T>(
  error: unknown,
  schema: z.ZodType<any>,
  options?: { context?: string }
): T | undefined {
  if (!isValidationError(error)) return undefined;

  const raw = extractRawValue(error);
  if (raw === undefined) return undefined;

  const result = schema.safeParse(raw);
  if (!result.success) return undefined;

  logger.warn("Recovered data from Vercel SDK validation error", {
    context: options?.context,
    errorMessage: error instanceof Error ? error.message : String(error),
    errorType: error?.constructor?.name,
  });

  return result.data;
}

/**
 * Wrap a Vercel SDK promise with automatic recovery on validation errors.
 *
 * On success: returns the SDK result as-is.
 * On error: attempts recovery via rawValue + schema validation (validation errors only).
 */
export function callVercelWithRecovery<T>(
  sdkCall: Promise<T>,
  schema: z.ZodType<any>,
  options?: { context?: string }
): ResultAsync<T, unknown> {
  return ResultAsync.fromPromise(sdkCall, (error) => error).orElse((error) => {
    const recovered = recoverFromVercelSdkError<T>(error, schema, options);
    if (recovered !== undefined) {
      return okAsync(recovered);
    }
    return errAsync(error);
  });
}

/**
 * Drop-in replacement for `wrapVercelCall` with SDK error recovery.
 *
 * Wraps a Vercel SDK promise in ResultAsync with structured error logging,
 * attempting to recover from validation errors before treating as failure.
 */
export function wrapVercelCallWithRecovery<T>(
  promise: Promise<T>,
  schema: z.ZodType<any>,
  message: string,
  context: Record<string, unknown>,
  toError: (error: unknown) => VercelApiError
): ResultAsync<T, VercelApiError> {
  return callVercelWithRecovery(promise, schema, { context: message }).mapErr((error) => {
    const apiError = toError(error);
    logger.error(message, { ...context, error, authInvalid: apiError.authInvalid });
    return apiError;
  });
}

// ---------------------------------------------------------------------------
// Minimal Zod schemas — validate only the fields we actually use.
// All use .passthrough() to preserve extra fields from the API response.
// ---------------------------------------------------------------------------

export const VercelSchemas = {
  getTeam: z.object({ slug: z.string() }).passthrough(),

  getAuthUser: z
    .object({ user: z.object({ username: z.string() }).passthrough() })
    .passthrough(),

  getCustomEnvironments: z
    .object({
      environments: z
        .array(
          z
            .object({
              id: z.string(),
              slug: z.string(),
              description: z.string().optional(),
              branchMatcher: z.unknown().optional(),
            })
            .passthrough()
        )
        .optional(),
    })
    .passthrough(),

  filterProjectEnvs: z
    .union([
      z
        .object({
          envs: z.array(z.record(z.unknown())),
          pagination: z.unknown().optional(),
        })
        .passthrough(),
      z.array(z.record(z.unknown())),
    ])
    .transform((val) => (Array.isArray(val) ? { envs: val } : val)),

  getProjectEnv: z.object({ key: z.string(), value: z.string().optional() }).passthrough(),

  getProjects: z.union([
    z.array(z.object({ id: z.string(), name: z.string() }).passthrough()),
    z
      .object({
        projects: z.array(
          z.object({ id: z.string(), name: z.string() }).passthrough()
        ),
        pagination: z.unknown().optional(),
      })
      .passthrough(),
  ]),

  listSharedEnvVariable: z
    .object({
      data: z
        .array(
          z
            .object({
              id: z.string().optional(),
              key: z.string().optional(),
              type: z.string().optional(),
              target: z.unknown().optional(),
              value: z.string().optional(),
            })
            .passthrough()
        )
        .optional(),
    })
    .passthrough(),

  getSharedEnvVar: z.object({ value: z.string().optional() }).passthrough(),

  updateProject: z
    .object({ id: z.string(), name: z.string(), autoAssignCustomDomains: z.boolean().optional() })
    .passthrough(),
} as const;
