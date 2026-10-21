// Type machinery for `chat.event(...)` — the descriptor an agent claims via `chat.agent({ events })`.
// Type-only. The `key` is a validated string of {event.x}/{webhook.x}/{header.x} placeholders.
import type { WebhookEndpointContext } from "./webhooks.js";

export type WebhookKeyScalar = string | number | boolean | bigint;

// Endpoint metadata resolvable at ingest without parsing the body. externalRef/tenantId are the ""
// sentinel on declared (P1) webhooks; per-tenant with P2 endpoints.
export interface WebhookKeyMeta {
  externalRef: string; // the "webhook external id" (endpointExternalRef); the multi-tenant scope
  tenantId: string;
  id: string;
  source: string;
  deliveryId: string;
}

// A miss must be a real brand, not `never` (`never extends WebhookKeyScalar` is `true`, so bad paths
// would pass).
declare const invalidBrand: unique symbol;
type Invalid = { readonly [invalidBrand]: true };

type PathValue<T, P extends string> = P extends `${infer Head}.${infer Rest}`
  ? Head extends keyof T
    ? PathValue<NonNullable<T[Head]>, Rest>
    : Invalid
  : P extends keyof T
    ? NonNullable<T[P]>
    : Invalid;

export type WebhookKeyError<M extends string> = `✖ ${M}`;

type TrimSpace<S extends string> = S extends ` ${infer R}`
  ? TrimSpace<R>
  : S extends `${infer L} `
    ? TrimSpace<L>
    : S;

// A placeholder may list first-non-empty fallbacks: `{a || b}`. Validate each side as a path.
type CheckKeyPath<TEvent, Path extends string> = Path extends `${infer L}||${infer R}`
  ? CheckKeyPathSingle<TEvent, TrimSpace<L>> extends true
    ? CheckKeyPath<TEvent, TrimSpace<R>>
    : CheckKeyPathSingle<TEvent, TrimSpace<L>>
  : CheckKeyPathSingle<TEvent, TrimSpace<Path>>;

type CheckKeyTemplate<
  TEvent,
  S extends string,
> = S extends `${infer _Pre}{${infer Path}}${infer Rest}`
  ? CheckKeyPath<TEvent, Path> extends true
    ? CheckKeyTemplate<TEvent, Rest>
    : CheckKeyPath<TEvent, Path>
  : true;

// The parameter type IS the validation result: S when valid, else the branded error (which localizes
// the message to `key`). No union, no `S & ...` intersection — both broke inference/errors before.
// Paired with a `const S extends string` fn generic that captures the literal from the argument.
export type ValidatedWebhookKey<TEvent, S extends string> =
  CheckKeyTemplate<TEvent, S> extends true ? S : CheckKeyTemplate<TEvent, S>;

// An event path in a key or a waiter's match. It passes through open records (an index signature or
// an unknown event), since provider payloads are often only partly typed: only a missing field on a
// closed object, or a known non-scalar, is refused.
type MatchNext<X> = unknown extends X ? unknown : NonNullable<X>;

type MatchPathValue<T, P extends string> = unknown extends T
  ? unknown
  : P extends `${infer Head}.${infer Rest}`
    ? Head extends keyof T
      ? MatchPathValue<MatchNext<T[Head]>, Rest>
      : string extends keyof T
        ? unknown
        : Invalid
    : P extends keyof T
      ? MatchNext<T[P]>
      : string extends keyof T
        ? unknown
        : Invalid;

type CheckEventPath<TEvent, Path extends string> = Path extends
  | ""
  | `.${string}`
  | `${string}.`
  | `${string}..${string}`
  ? WebhookKeyError<`empty path segment: ${Path}`>
  : MatchPathValue<TEvent, Path> extends Invalid
    ? WebhookKeyError<`unknown event path: ${Path}`>
    : unknown extends MatchPathValue<TEvent, Path>
      ? true
      : MatchPathValue<TEvent, Path> extends WebhookKeyScalar
        ? true
        : WebhookKeyError<`non-scalar event path: ${Path}`>;

type CheckMetaPath<Path extends string> = Path extends `header.${infer Name}`
  ? Name extends ""
    ? WebhookKeyError<`empty header name`>
    : true
  : Path extends `webhook.${infer Rest}`
    ? PathValue<WebhookKeyMeta, Rest> extends WebhookKeyScalar
      ? true
      : WebhookKeyError<`unknown or non-scalar webhook meta path: ${Rest}`>
    : false;

// Key placeholders and match paths name their namespace like a filter path: event.*, header.* or
// webhook.*.
type CheckNamespacedPath<
  TEvent,
  Path extends string,
  What extends string,
> = Path extends `event.${infer Rest}`
  ? CheckEventPath<TEvent, Rest>
  : CheckMetaPath<Path> extends false
    ? WebhookKeyError<`${What} paths start with event., header. or webhook.: ${Path}`>
    : CheckMetaPath<Path>;

type CheckMatchPath<TEvent, Path extends string> = CheckNamespacedPath<TEvent, Path, "match">;
type CheckKeyPathSingle<TEvent, Path extends string> = CheckNamespacedPath<TEvent, Path, "key">;

/**
 * A webhook waiter's `match`: each key a path (`event.*` reads the event, `header.*` a header and
 * `webhook.*` the endpoint), each value the scalar it must equal. A bad path turns that key's value
 * type into an error naming it.
 */
export type ValidatedWebhookMatch<TEvent, M> = {
  [K in keyof M]: K extends string
    ? CheckMatchPath<TEvent, K> extends true
      ? M[K]
      : CheckMatchPath<TEvent, K>
    : never;
};

declare const dEvt: unique symbol;

export interface ChatEvent<TType extends string, TEvent> {
  id: string;
  type: TType; // the action.type discriminant; defaults to `id` when omitted at authoring
  key: string; // compiled canonical template
  /** The endpoint this event subscribes to (`webhooks.endpoint.define` id). */
  endpointId: string;
  source: string; // the endpoint source's provider tag
  // Optional server-side gate (same DSL as webhook()); a non-matching delivery is recorded FILTERED
  // and never routed to the session.
  filter?: string;
  readonly [dEvt]?: TEvent;
}

export type AnyChatEvent = ChatEvent<string, any>;

// The fixed envelope a delivery becomes, projected from a descriptor; drives chat.agent.onAction.
export type ChatEventAction<W> =
  W extends ChatEvent<infer TType, infer TEvent>
    ? {
        type: TType;
        event: TEvent;
        source: string;
        headers: Record<string, string>;
        /** The delivery's id (`whd_...`), as in the dashboard and the deliveries API. A replay gets a new one. */
        deliveryId: string;
        /**
         * The provider's id for the delivery (e.g. Stripe's `evt_...`), the same across replays.
         * Absent on an action delivered by an older server.
         */
        externalDeliveryId?: string;
        /** The endpoint the delivery arrived on. */
        endpoint?: WebhookEndpointContext;
      }
    : never;

// Distributive union over an agent's `events` tuple (closed `type` discriminant, `event` narrows).
export type ChatEventActions<TW extends readonly AnyChatEvent[]> = ChatEventAction<TW[number]>;
