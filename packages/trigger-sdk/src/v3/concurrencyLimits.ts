import type {
  ApiPromise,
  ApiRequestOptions,
  ConcurrencyLimitItem,
  ConcurrencyLimitKeyItem,
  ListConcurrencyLimitOptions,
  OffsetLimitPagePromise,
  OverrideConcurrencyLimitBoundsBody,
  OverrideConcurrencyLimitKeyBody,
  OverrideConcurrencyLimitRequestBody,
} from "@trigger.dev/core/v3";
import {
  accessoryAttributes,
  apiClientManager,
  flattenAttributes,
  mergeRequestOptions,
} from "@trigger.dev/core/v3";
import { tracer } from "./tracer.js";

/** Options that address one concurrencyKey of a limit. */
export type ConcurrencyLimitKeyOptions = {
  /** The concurrencyKey whose view, or whose override, the call is about. */
  concurrencyKey: string;
};

/**
 * `retrieve` and `reset` take an optional key-options object before the request
 * options. The two are told apart by the `concurrencyKey` property, so existing
 * callers that pass request options in the second position keep working.
 */
function splitKeyOptions<T extends object>(
  first: T | ApiRequestOptions | undefined,
  second: ApiRequestOptions | undefined
): { keyOptions: T | undefined; requestOptions: ApiRequestOptions | undefined } {
  if (first && typeof first === "object" && "concurrencyKey" in first) {
    return { keyOptions: first as T, requestOptions: second };
  }
  return { keyOptions: undefined, requestOptions: first as ApiRequestOptions | undefined };
}

function limitAttributes(name: string, extra: Record<string, unknown> = {}) {
  return {
    ...flattenAttributes({ name, ...extra }),
    ...accessoryAttributes({
      items: [{ text: name, variant: "normal" }],
      style: "codepath",
    }),
  };
}

/**
 * Lists the environment's named concurrency limits (anonymous inline limits appear
 * under their derived `task/<taskId>` names).
 *
 * @param options - The list options
 * @param options.page - The page number
 * @param options.perPage - The number of limits per page
 * @returns The list of concurrency limits
 */
export function list(
  options?: ListConcurrencyLimitOptions,
  requestOptions?: ApiRequestOptions
): OffsetLimitPagePromise<typeof ConcurrencyLimitItem> {
  const apiClient = apiClientManager.clientOrThrow();

  const $requestOptions = mergeRequestOptions(
    {
      tracer,
      name: "concurrencyLimits.list()",
      icon: "queue",
    },
    requestOptions
  );

  return apiClient.listConcurrencyLimits(options, $requestOptions);
}

/**
 * Retrieves a concurrency limit by name, or, with `{ concurrencyKey }`, the limit's
 * view for one key: its per-key bound (including any override and when it expires)
 * and the runs executing for that key.
 *
 * @example
 *
 * ```ts
 * const limit = await concurrencyLimits.retrieve("openai");
 * console.log(limit.running, limit.queued, limit.total.current);
 *
 * const session = await concurrencyLimits.retrieve("subagents", { concurrencyKey: sessionId });
 * console.log(session.perKey.override, session.perKey.expiresAt);
 * ```
 * @param name - The limit's name, as declared with `concurrencyLimit()`
 * @returns The concurrency limit, or its view for the given key
 */
export function retrieve(
  name: string,
  options: ConcurrencyLimitKeyOptions,
  requestOptions?: ApiRequestOptions
): ApiPromise<ConcurrencyLimitKeyItem>;
export function retrieve(
  name: string,
  requestOptions?: ApiRequestOptions
): ApiPromise<ConcurrencyLimitItem>;
export function retrieve(
  name: string,
  optionsOrRequestOptions?: ConcurrencyLimitKeyOptions | ApiRequestOptions,
  maybeRequestOptions?: ApiRequestOptions
): ApiPromise<ConcurrencyLimitItem> | ApiPromise<ConcurrencyLimitKeyItem> {
  const apiClient = apiClientManager.clientOrThrow();
  const { keyOptions, requestOptions } = splitKeyOptions<ConcurrencyLimitKeyOptions>(
    optionsOrRequestOptions,
    maybeRequestOptions
  );

  const $requestOptions = mergeRequestOptions(
    {
      tracer,
      name: "concurrencyLimits.retrieve()",
      icon: "queue",
      attributes: limitAttributes(
        name,
        keyOptions ? { concurrencyKey: keyOptions.concurrencyKey } : {}
      ),
    },
    requestOptions
  );

  if (keyOptions) {
    return apiClient.retrieveConcurrencyLimitKey(name, keyOptions.concurrencyKey, $requestOptions);
  }

  return apiClient.retrieveConcurrencyLimit(name, $requestOptions);
}

/**
 * Overrides a concurrency limit's bounds. Only the given fields change; the
 * declared values are kept as the base and restored by `reset`. To stop runs
 * holding a limit, prefer `pause` (it keeps the configured bounds); overriding
 * `total` to `0` also blocks every run holding the limit.
 *
 * With `concurrencyKey`, the override is a temporary per-key cap for that one key:
 * it replaces the limit's `perKey` for the key, applies to every task holding the
 * limit, and expires after `ttl` (default 7 days, at most 30 days). The limit itself
 * is untouched, and other keys keep the declared `perKey`.
 *
 * @example
 *
 * ```ts
 * await concurrencyLimits.override("openai", { total: 50 });
 *
 * // this session may run 3 sub-agents at once, for the next 7 days
 * await concurrencyLimits.override("subagents", { concurrencyKey: sessionId, perKey: 3 });
 * ```
 * @param name - The limit's name
 * @param override - The bounds to change (`perKey` and/or `total`), or `concurrencyKey` with the key's `perKey` cap (and optional `ttl`)
 * @returns The updated concurrency limit, or the key's view when `concurrencyKey` was given
 */
export function override(
  name: string,
  override: OverrideConcurrencyLimitKeyBody,
  requestOptions?: ApiRequestOptions
): ApiPromise<ConcurrencyLimitKeyItem>;
export function override(
  name: string,
  override: OverrideConcurrencyLimitBoundsBody,
  requestOptions?: ApiRequestOptions
): ApiPromise<ConcurrencyLimitItem>;
export function override(
  name: string,
  override: OverrideConcurrencyLimitRequestBody,
  requestOptions?: ApiRequestOptions
): ApiPromise<ConcurrencyLimitItem | ConcurrencyLimitKeyItem>;
export function override(
  name: string,
  override: OverrideConcurrencyLimitRequestBody,
  requestOptions?: ApiRequestOptions
): ApiPromise<ConcurrencyLimitItem> | ApiPromise<ConcurrencyLimitKeyItem> {
  const apiClient = apiClientManager.clientOrThrow();

  const $requestOptions = mergeRequestOptions(
    {
      tracer,
      name: "concurrencyLimits.override()",
      icon: "queue",
      attributes: limitAttributes(name, { override }),
    },
    requestOptions
  );

  if (override.concurrencyKey !== undefined) {
    return apiClient.overrideConcurrencyLimitKey(name, override, $requestOptions);
  }

  return apiClient.overrideConcurrencyLimit(name, override, $requestOptions);
}

/**
 * Resets a concurrency limit back to its declared values, clearing any override.
 * With `{ concurrencyKey }`, clears that key's override instead and leaves the
 * limit itself alone.
 *
 * @example
 *
 * ```ts
 * await concurrencyLimits.reset("openai");
 * await concurrencyLimits.reset("subagents", { concurrencyKey: sessionId });
 * ```
 * @param name - The limit's name
 * @returns The updated concurrency limit, or the key's view when `concurrencyKey` was given
 */
export function reset(
  name: string,
  options: ConcurrencyLimitKeyOptions,
  requestOptions?: ApiRequestOptions
): ApiPromise<ConcurrencyLimitKeyItem>;
export function reset(
  name: string,
  requestOptions?: ApiRequestOptions
): ApiPromise<ConcurrencyLimitItem>;
export function reset(
  name: string,
  optionsOrRequestOptions?: ConcurrencyLimitKeyOptions | ApiRequestOptions,
  maybeRequestOptions?: ApiRequestOptions
): ApiPromise<ConcurrencyLimitItem> | ApiPromise<ConcurrencyLimitKeyItem> {
  const apiClient = apiClientManager.clientOrThrow();
  const { keyOptions, requestOptions } = splitKeyOptions<ConcurrencyLimitKeyOptions>(
    optionsOrRequestOptions,
    maybeRequestOptions
  );

  const $requestOptions = mergeRequestOptions(
    {
      tracer,
      name: "concurrencyLimits.reset()",
      icon: "queue",
      attributes: limitAttributes(
        name,
        keyOptions ? { concurrencyKey: keyOptions.concurrencyKey } : {}
      ),
    },
    requestOptions
  );

  if (keyOptions) {
    return apiClient.resetConcurrencyLimitKey(
      name,
      { concurrencyKey: keyOptions.concurrencyKey },
      $requestOptions
    );
  }

  return apiClient.resetConcurrencyLimit(name, $requestOptions);
}

/**
 * Pauses a concurrency limit. Nothing holding the limit is admitted until it is
 * resumed; runs already executing continue. The configured bounds are kept.
 *
 * @example
 *
 * ```ts
 * await concurrencyLimits.pause("openai");
 * ```
 * @param name - The limit's name
 * @returns The updated concurrency limit
 */
export function pause(
  name: string,
  requestOptions?: ApiRequestOptions
): ApiPromise<ConcurrencyLimitItem> {
  const apiClient = apiClientManager.clientOrThrow();

  const $requestOptions = mergeRequestOptions(
    {
      tracer,
      name: "concurrencyLimits.pause()",
      icon: "queue",
      attributes: limitAttributes(name),
    },
    requestOptions
  );

  return apiClient.pauseConcurrencyLimit(name, "pause", $requestOptions);
}

/**
 * Resumes a paused concurrency limit, so runs holding it can be admitted again
 * under its configured bounds.
 *
 * @example
 *
 * ```ts
 * await concurrencyLimits.resume("openai");
 * ```
 * @param name - The limit's name
 * @returns The updated concurrency limit
 */
export function resume(
  name: string,
  requestOptions?: ApiRequestOptions
): ApiPromise<ConcurrencyLimitItem> {
  const apiClient = apiClientManager.clientOrThrow();

  const $requestOptions = mergeRequestOptions(
    {
      tracer,
      name: "concurrencyLimits.resume()",
      icon: "queue",
      attributes: limitAttributes(name),
    },
    requestOptions
  );

  return apiClient.pauseConcurrencyLimit(name, "resume", $requestOptions);
}
