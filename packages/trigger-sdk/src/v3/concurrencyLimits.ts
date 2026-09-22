import type {
  ApiPromise,
  ApiRequestOptions,
  ConcurrencyLimitItem,
  ListConcurrencyLimitOptions,
  OffsetLimitPagePromise,
  OverrideConcurrencyLimitRequestBody,
} from "@trigger.dev/core/v3";
import {
  accessoryAttributes,
  apiClientManager,
  flattenAttributes,
  mergeRequestOptions,
} from "@trigger.dev/core/v3";
import { tracer } from "./tracer.js";

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
 * Retrieves a concurrency limit by name.
 *
 * @example
 *
 * ```ts
 * const limit = await concurrencyLimits.retrieve("openai");
 * console.log(limit.running, limit.queued, limit.total.current);
 * ```
 * @param name - The limit's name, as declared with `concurrencyLimit()`
 * @returns The concurrency limit
 */
export function retrieve(
  name: string,
  requestOptions?: ApiRequestOptions
): ApiPromise<ConcurrencyLimitItem> {
  const apiClient = apiClientManager.clientOrThrow();

  const $requestOptions = mergeRequestOptions(
    {
      tracer,
      name: "concurrencyLimits.retrieve()",
      icon: "queue",
      attributes: {
        ...flattenAttributes({ name }),
        ...accessoryAttributes({
          items: [{ text: name, variant: "normal" }],
          style: "codepath",
        }),
      },
    },
    requestOptions
  );

  return apiClient.retrieveConcurrencyLimit(name, $requestOptions);
}

/**
 * Overrides a concurrency limit's bounds. Only the given fields change; the
 * declared values are kept as the base and restored by `reset`. To stop runs
 * holding a limit, prefer `pause` (it keeps the configured bounds); overriding
 * `total` to `0` also blocks every run holding the limit.
 *
 * @example
 *
 * ```ts
 * await concurrencyLimits.override("openai", { total: 50 });
 * ```
 * @param name - The limit's name
 * @param override - The bounds to change (`perKey` and/or `total`)
 * @returns The updated concurrency limit
 */
export function override(
  name: string,
  override: OverrideConcurrencyLimitRequestBody,
  requestOptions?: ApiRequestOptions
): ApiPromise<ConcurrencyLimitItem> {
  const apiClient = apiClientManager.clientOrThrow();

  const $requestOptions = mergeRequestOptions(
    {
      tracer,
      name: "concurrencyLimits.override()",
      icon: "queue",
      attributes: {
        ...flattenAttributes({ name, override }),
        ...accessoryAttributes({
          items: [{ text: name, variant: "normal" }],
          style: "codepath",
        }),
      },
    },
    requestOptions
  );

  return apiClient.overrideConcurrencyLimit(name, override, $requestOptions);
}

/**
 * Resets a concurrency limit back to its declared values, clearing any override.
 *
 * @param name - The limit's name
 * @returns The updated concurrency limit
 */
export function reset(
  name: string,
  requestOptions?: ApiRequestOptions
): ApiPromise<ConcurrencyLimitItem> {
  const apiClient = apiClientManager.clientOrThrow();

  const $requestOptions = mergeRequestOptions(
    {
      tracer,
      name: "concurrencyLimits.reset()",
      icon: "queue",
      attributes: {
        ...flattenAttributes({ name }),
        ...accessoryAttributes({
          items: [{ text: name, variant: "normal" }],
          style: "codepath",
        }),
      },
    },
    requestOptions
  );

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
      attributes: {
        ...flattenAttributes({ name }),
        ...accessoryAttributes({
          items: [{ text: name, variant: "normal" }],
          style: "codepath",
        }),
      },
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
      attributes: {
        ...flattenAttributes({ name }),
        ...accessoryAttributes({
          items: [{ text: name, variant: "normal" }],
          style: "codepath",
        }),
      },
    },
    requestOptions
  );

  return apiClient.pauseConcurrencyLimit(name, "resume", $requestOptions);
}
