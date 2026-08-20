// Type machinery for `chat.event(...)` — the descriptor an agent claims via `chat.agent({ events })`.
// Type-only. The `key` is a validated string of {body.x}/{webhook.x}/{header.x} placeholders.
import type {
  WebhookSecretProvisioning,
  WebhookVerifierArtifact,
} from "../schemas/webhookConfig.js";

export type WebhookKeyScalar = string | number | boolean | bigint;

// Endpoint metadata resolvable at ingest without parsing the body. externalRef/tenantId are the ""
// sentinel on declared (P1) webhooks; per-tenant with P2 endpoints.
export interface WebhookKeyMeta {
  externalRef: string; // the "webhook external id" (endpointExternalRef); the multi-tenant scope
  tenantId: string;
  id: string; // handlerWebhookId
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

// Validate one {…} placeholder by namespace: webhook.→WebhookKeyMeta, header.→any non-empty name,
// body./bare→event. `true` when a scalar path, else a branded error naming it.
type CheckKeyPathSingle<TEvent, Path extends string> = Path extends `webhook.${infer Rest}`
  ? PathValue<WebhookKeyMeta, Rest> extends WebhookKeyScalar
    ? true
    : WebhookKeyError<`unknown or non-scalar webhook meta path: ${Rest}`>
  : Path extends `header.${infer Name}`
    ? Name extends ""
      ? WebhookKeyError<`empty header name`>
      : true
    : Path extends `body.${infer Rest}`
      ? PathValue<TEvent, Rest> extends WebhookKeyScalar
        ? true
        : WebhookKeyError<`unknown or non-scalar event path: ${Rest}`>
      : PathValue<TEvent, Path> extends WebhookKeyScalar
        ? true
        : WebhookKeyError<`unknown or non-scalar event path: ${Path}`>;

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

declare const dEvt: unique symbol;

export interface ChatEvent<TType extends string, TEvent> {
  id: string;
  type: TType; // the action.type discriminant; defaults to `id` when omitted at authoring
  key: string; // compiled canonical template
  source: string; // provider tag
  // Registration data carried from the source so the claiming agent can create the endpoint.
  verifierArtifact: WebhookVerifierArtifact;
  secretProvisioning?: WebhookSecretProvisioning;
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
        deliveryId: string;
      }
    : never;

// Distributive union over an agent's `events` tuple (closed `type` discriminant, `event` narrows).
export type ChatEventActions<TW extends readonly AnyChatEvent[]> = ChatEventAction<TW[number]>;
