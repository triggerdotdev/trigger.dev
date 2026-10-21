import { SpanStatusCode } from "@opentelemetry/api";
import {
  accessoryAttributes,
  ApiError,
  apiClientManager,
  makeIdempotencyKey,
  mergeRequestOptions,
  runtime,
  SemanticInternalAttributes,
  taskContext,
  WaitpointTimeoutError,
  WebhookEndpointNotFoundError,
  WebhookFilterError,
  WebhookWaiterCancelledError,
  WebhookWaiterLimitError,
  type AnyWebhookEndpoint,
  type ApiRequestOptions,
  type IdempotencyKey,
  type InferWebhookEndpointEvent,
  type NarrowWebhookEvent,
  type ValidatedWebhookMatch,
  type ValidateWebhookFilter,
  type WaitpointTokenTypedResult,
  type WebhookWaiterLimitReason,
  type WebhookWaiterOutput,
} from "@trigger.dev/core/v3";
import { conditionallyImportAndParsePacket } from "@trigger.dev/core/v3/utils/ioSerialization";
import { tracer } from "./tracer.js";

declare const waiterEvent: unique symbol;

/** A registered webhook waiter. Pass it (or its id) to `webhooks.waiter.wait` or `.cancel`. */
export type WebhookWaiter<TEvent = unknown> = {
  /** The waiter id, which is also its waitpoint id (`waitpoint_...`). */
  id: string;
  /**
   * For a waiter created without `match`: the URL to hand the provider as its per-request callback.
   * A delivery to it resumes only this waiter.
   */
  url?: string;
  expiresAt: Date;
  /** True when an earlier create with the same idempotency key already made this waiter. */
  isCached: boolean;
  /** phantom, type-level only; never present at runtime */
  readonly [waiterEvent]?: TEvent;
};

export type CreateWebhookWaiterOptions<TMatch, TFilter extends string> = {
  /**
   * Paths to the values a delivery must have: `event.*` reads the event, `header.*` a header and
   * `webhook.*` the endpoint, the same namespaces as a filter. At most 5 paths. Omit it for a
   * URL-matched waiter.
   */
  match?: TMatch;
  /** A filter the event must also pass, checked after `match`. */
  filter?: TFilter;
  /** How long to wait: a duration like `"1h"` or a date. Default 24 hours, at most 90 days. */
  timeout?: string | Date;
  /** Up to 10 tags, shown on the waiter's waitpoint. */
  tags?: string | string[];
  /**
   * Returns the original waiter for a repeated key, possibly already completed. Inside a task a
   * string key is scoped to the run, like `trigger()`'s, so a retried attempt gets the waiter (and
   * the event) from the attempt before it; use `idempotencyKeys.create(key, { scope })` for another
   * scope. Without a key every call makes a new waiter, which only matches deliveries after it.
   */
  idempotencyKey?: IdempotencyKey | string | string[];
  /** How long the idempotency key lasts, e.g. `"1h"`. */
  idempotencyKeyTTL?: string;
};

/**
 * Register a waiter on an endpoint: the next matching delivery that arrives after this call resumes
 * whoever waits on it. Create it before doing whatever makes the provider send the webhook, and match
 * on values you control (like your own order id in the event's metadata). Works inside a run and from
 * your backend.
 *
 * @example
 * ```ts
 * const waiter = await webhooks.waiter.create(payments, {
 *   match: { "event.data.object.metadata.orderId": order.id, "event.type": "payment_intent.succeeded" },
 *   timeout: "1h",
 * });
 * await stripe.paymentIntents.create({ amount: 4200, currency: "usd", metadata: { orderId: order.id } });
 * const { event } = await webhooks.waiter.wait(waiter).unwrap();
 * ```
 */
export async function createWebhookWaiter<
  TEndpoint extends AnyWebhookEndpoint,
  const TMatch extends Record<string, string | number | boolean> = Record<
    string,
    string | number | boolean
  >,
  const TFilter extends string = string,
>(
  endpoint: TEndpoint,
  options: CreateWebhookWaiterOptions<
    ValidatedWebhookMatch<InferWebhookEndpointEvent<TEndpoint>, TMatch>,
    ValidateWebhookFilter<InferWebhookEndpointEvent<TEndpoint>, TFilter>
  > = {},
  requestOptions?: ApiRequestOptions
): Promise<WebhookWaiter<NarrowWebhookEvent<InferWebhookEndpointEvent<TEndpoint>, TFilter>>> {
  const apiClient = apiClientManager.clientOrThrow();
  const idempotencyKey =
    (await makeIdempotencyKey(options.idempotencyKey)) ?? globalThis.crypto.randomUUID();
  const timeout = options.timeout instanceof Date ? options.timeout.toISOString() : options.timeout;

  try {
    const result = await apiClient.createWebhookWaiter(
      endpoint.id,
      {
        ...(options.match ? { match: options.match } : {}),
        ...(options.filter ? { filter: options.filter } : {}),
        ...(timeout ? { timeout } : {}),
        ...(options.tags ? { tags: options.tags } : {}),
        idempotencyKey,
        ...(options.idempotencyKeyTTL ? { idempotencyKeyTTL: options.idempotencyKeyTTL } : {}),
      },
      mergeRequestOptions(
        {
          tracer,
          name: "webhooks.waiter.create()",
          icon: "wait",
          attributes: {
            endpoint: endpoint.id,
            ...(options.match ? { match: Object.keys(options.match).join(", ") } : {}),
          },
          onResponseBody: (body, span) => span.setAttribute("id", body.id),
        },
        requestOptions
      )
    );
    return result as WebhookWaiter<
      NarrowWebhookEvent<InferWebhookEndpointEvent<TEndpoint>, TFilter>
    >;
  } catch (error) {
    throw toWebhookWaiterError(error);
  }
}

function toWebhookWaiterError(error: unknown): unknown {
  if (!(error instanceof ApiError)) return error;
  const body = error.body as { error?: string; reason?: WebhookWaiterLimitReason } | undefined;
  const message = typeof body?.error === "string" ? body.error : error.message;
  switch (error.code) {
    case "webhook_waiter_limit":
      return new WebhookWaiterLimitError(body?.reason ?? "endpoint_limit", message);
    case "webhook_endpoint_not_found":
      return new WebhookEndpointNotFoundError(message);
    case "webhook_filter_invalid":
      return new WebhookFilterError(message);
    default:
      return error;
  }
}

/** A waiter's result. `.unwrap()` returns the output or throws its typed error. */
export class WebhookWaiterPromise<TEvent> extends Promise<
  WaitpointTokenTypedResult<WebhookWaiterOutput<TEvent>>
> {
  unwrap(): Promise<WebhookWaiterOutput<TEvent>> {
    return this.then((result) => {
      if (result.ok) return result.output;
      throw result.error;
    });
  }
}

type WaiterRef<TEvent> = WebhookWaiter<TEvent> | string;

function waiterIdOf(waiter: WaiterRef<unknown>): string {
  return typeof waiter === "string" ? waiter : waiter.id;
}

/**
 * Suspend the current run until the waiter matches a delivery, times out or is cancelled. Only inside
 * `task.run()`. The result's error is a `WaitpointTimeoutError` or a `WebhookWaiterCancelledError`.
 */
export function waitForWebhookWaiter<TEvent = unknown>(
  waiter: WaiterRef<TEvent>
): WebhookWaiterPromise<TEvent> {
  return new WebhookWaiterPromise<TEvent>(async (resolve, reject) => {
    try {
      const ctx = taskContext.ctx;
      if (!ctx) {
        throw new Error("webhooks.waiter.wait can only be used from inside a task.run()");
      }

      const apiClient = apiClientManager.clientOrThrow();
      const waiterId = waiterIdOf(waiter);

      const result = await tracer.startActiveSpan(
        "webhooks.waiter.wait()",
        async (span) => {
          const response = await apiClient.waitForWaitpointToken({
            runFriendlyId: ctx.run.id,
            waitpointFriendlyId: waiterId,
          });
          if (!response.success) {
            throw new Error(`Failed to wait for webhook waiter ${waiterId}`);
          }

          const completion = await runtime.waitUntil(waiterId);
          const data = completion.output
            ? await conditionallyImportAndParsePacket(
                { data: completion.output, dataType: completion.outputType ?? "application/json" },
                apiClient
              )
            : undefined;

          if (completion.ok) {
            return { ok: true, output: data } as WaitpointTokenTypedResult<
              WebhookWaiterOutput<TEvent>
            >;
          }

          const failure = data as { name?: string; message?: string } | undefined;
          const error =
            failure?.name === "WebhookWaiterCancelledError"
              ? new WebhookWaiterCancelledError(failure.message)
              : new WaitpointTimeoutError(failure?.message ?? "The webhook waiter timed out");
          span.recordException(error);
          span.setStatus({ code: SpanStatusCode.ERROR });
          return { ok: false, error } as WaitpointTokenTypedResult<WebhookWaiterOutput<TEvent>>;
        },
        {
          attributes: {
            [SemanticInternalAttributes.STYLE_ICON]: "wait",
            [SemanticInternalAttributes.ENTITY_TYPE]: "waitpoint",
            [SemanticInternalAttributes.ENTITY_ID]: waiterId,
            id: waiterId,
            ...accessoryAttributes({
              items: [{ text: waiterId, variant: "normal" }],
              style: "codepath",
            }),
          },
        }
      );

      resolve(result);
    } catch (error) {
      reject(error);
    }
  });
}

export type CancelWebhookWaiterResult =
  | { cancelled: true }
  | { cancelled: false; reason: "too_late"; deliveryId: string };

/**
 * Cancel a waiter: frees its slot and fails its wait with `WebhookWaiterCancelledError`. If a delivery
 * already claimed it, this is too late and the waiting run resumes with that delivery.
 */
export async function cancelWebhookWaiter(
  waiter: WaiterRef<unknown>,
  requestOptions?: ApiRequestOptions
): Promise<CancelWebhookWaiterResult> {
  const apiClient = apiClientManager.clientOrThrow();
  const waiterId = waiterIdOf(waiter);
  const result = await apiClient.cancelWebhookWaiter(
    waiterId,
    mergeRequestOptions(
      {
        tracer,
        name: "webhooks.waiter.cancel()",
        icon: "wait",
        attributes: { id: waiterId },
      },
      requestOptions
    )
  );
  return result.cancelled
    ? { cancelled: true }
    : { cancelled: false, reason: "too_late", deliveryId: result.deliveryId ?? "" };
}
