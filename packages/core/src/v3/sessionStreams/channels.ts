export type SessionChannelShape = { in?: unknown; out?: unknown };

/**
 * A typed declaration of a named Session channel. The channel analogue of
 * `Task<TId, TIn, TOut>`: `TName` captures the channel's literal name and
 * `TShape` its per-direction record types. `__shape` is a phantom carrier
 * for `TShape` and is never read at runtime.
 */
export type SessionChannel<
  TName extends string = string,
  TShape extends SessionChannelShape = SessionChannelShape,
> = {
  readonly name: TName;
  readonly __shape?: TShape;
};

export type AnySessionChannel = SessionChannel<string, SessionChannelShape>;

/** Extract a channel's literal name, the analogue of `TaskIdentifier`. */
export type SessionChannelName<C extends AnySessionChannel> =
  C extends SessionChannel<infer N, any> ? N : never;

/** Extract the `.out` record type, the analogue of `TaskOutput`. */
export type SessionChannelOut<C extends AnySessionChannel> =
  C extends SessionChannel<any, infer S> ? (S extends { out: infer O } ? O : unknown) : never;

/** Extract the `.in` record type, the analogue of `TaskPayload`. */
export type SessionChannelIn<C extends AnySessionChannel> =
  C extends SessionChannel<any, infer S> ? (S extends { in: infer I } ? I : unknown) : never;
