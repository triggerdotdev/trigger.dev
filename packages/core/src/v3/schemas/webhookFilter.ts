import { z } from "zod/v4";

// Webhook delivery filter: server-side predicate gating routing. LEAF module (imports only `z`).

// ── Runtime AST (stored on WebhookEndpoint.filterAst; produced by the engine parser) ──

export const FilterOp = z.enum([
  "eq",
  "neq",
  "gt",
  "lt",
  "gte",
  "lte",
  "in",
  "nin",
  "startsWith",
  "endsWith",
  "contains",
]);
export type FilterOp = z.infer<typeof FilterOp>;

export const FilterScalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export type FilterScalar = z.infer<typeof FilterScalar>;

export const FilterValue = z.union([FilterScalar, z.array(FilterScalar)]);
export type FilterValue = z.infer<typeof FilterValue>;

export type FilterAst =
  | { kind: "and"; clauses: FilterAst[] }
  | { kind: "or"; clauses: FilterAst[] }
  // Exactly one of `value` (literal RHS) / `valueRef` (field-to-field: another path on the same event).
  | { kind: "clause"; path: string; op: FilterOp; value?: FilterValue; valueRef?: string }
  // `path any|all (subClause)`: the array at `path`, with `clause.path` resolved against each element.
  | {
      kind: "quantifier";
      mode: "any" | "all";
      path: string;
      clause: { path: string; op: FilterOp; value: FilterValue };
    };

// Bump when the AST shape changes; a stored AST with a different version is re-parsed from `filter`.
export const FILTER_AST_VERSION = 1;

export const FilterAst: z.ZodType<FilterAst> = z.lazy(() =>
  z.union([
    z.object({ kind: z.literal("and"), clauses: z.array(FilterAst) }),
    z.object({ kind: z.literal("or"), clauses: z.array(FilterAst) }),
    z.object({
      kind: z.literal("clause"),
      path: z.string(),
      op: FilterOp,
      value: FilterValue.optional(),
      valueRef: z.string().optional(),
    }),
    z.object({
      kind: z.literal("quantifier"),
      mode: z.enum(["any", "all"]),
      path: z.string(),
      clause: z.object({ path: z.string(), op: FilterOp, value: FilterValue }),
    }),
  ])
);

// The endpoint-level metadata the `webhook.*` namespace resolves against (mirrors WebhookEndpoint).
export type WebhookFilterMeta = {
  externalRef: string;
  tenantId: string;
  id: string;
  source: string;
  deliveryId: string;
};

// ── Compile-time validator (type-only; the SDK `webhook({ filter })` generic uses it) ──
// Tail-recursive scanner so TS's tail-recursion elimination applies (ceiling ~200+ clauses, not ~12).

type FilterError<M extends string> = `✖ ${M}`;
type Invalid = { readonly "~webhookFilterInvalid": true };

// Unknown payloads (including open provider records) cannot supply field-type checks.
// Keep parsing the filter, but only reject paths/operators where the event type is concrete.
type IsValidFilterPath<P extends string> = P extends
  | ""
  | `.${string}`
  | `${string}.`
  | `${string}..${string}`
  ? false
  : true;

type KnownValue<T> = unknown extends T ? unknown : NonNullable<T>;
/** Resolves per union member, so a path only some members have still resolves. */
type MemberPathValue<T, P extends string> = unknown extends T
  ? unknown
  : NonNullable<T> extends infer M
    ? M extends unknown
      ? P extends `${infer H}.${infer R}`
        ? H extends keyof M
          ? MemberPathValue<M[H], R>
          : Invalid
        : P extends keyof M
          ? KnownValue<M[P]>
          : Invalid
      : never
    : never;
type PathValue<T, P extends string> =
  IsValidFilterPath<P> extends false
    ? Invalid
    : [Exclude<MemberPathValue<T, P>, Invalid>] extends [never]
      ? Invalid
      : Exclude<MemberPathValue<T, P>, Invalid>;

type ResolveFilterPath<TEvent, P extends string> =
  IsValidFilterPath<P> extends false
    ? Invalid
    : P extends `event.${infer R}`
      ? PathValue<TEvent, R>
      : P extends `header.${string}`
        ? string
        : P extends `webhook.${infer R}`
          ? PathValue<WebhookFilterMeta, R>
          : Invalid;

type FilterLiteralType<Lit extends string> = Lit extends `'${infer S}'`
  ? S
  : Lit extends `${infer N extends number}`
    ? N
    : Lit extends "true"
      ? true
      : Lit extends "false"
        ? false
        : Lit extends "null"
          ? null
          : Invalid;

/** `null` is valid on every field: the server matches it against a missing field as well as a null one. */
type CheckValue<F, Lit extends string, P extends string> = Lit extends "null"
  ? true
  : [FilterLiteralType<Lit>] extends [Invalid]
    ? FilterError<`cannot parse value: ${Lit}`>
    : [FilterLiteralType<Lit>] extends [F]
      ? true
      : FilterError<`value ${Lit} is not valid for ${P}`>;
type CheckNum<F, Lit extends string, P extends string> = [
  Extract<unknown extends F ? number : F, number>,
] extends [never]
  ? FilterError<`${P} is not numeric`>
  : Lit extends `${number}`
    ? true
    : FilterError<`${P} needs a number`>;
type CheckStr<F, Lit extends string, P extends string> = [
  Extract<unknown extends F ? string : F, string>,
] extends [never]
  ? FilterError<`${P} is not a string`>
  : Lit extends `'${string}'`
    ? true
    : FilterError<`${P} op needs a string literal`>;
type TrimItem<S extends string> = S extends ` ${infer R}`
  ? TrimItem<R>
  : S extends `${infer L} `
    ? TrimItem<L>
    : S;
type CheckInItems<
  F,
  Items extends string,
  P extends string,
> = Items extends `${infer Head},${infer Tail}`
  ? CheckValue<F, TrimItem<Head>, P> extends true
    ? CheckInItems<F, Tail, P>
    : CheckValue<F, TrimItem<Head>, P>
  : CheckValue<F, TrimItem<Items>, P>;
type CheckIn<F, Lit extends string, P extends string> = Lit extends `[${infer Items}]`
  ? CheckInItems<F, Items, P>
  : FilterError<`${P} "in" expects a [list]`>;
type CheckOp<F, Op extends string, Lit extends string, P extends string> = Op extends "==" | "!="
  ? CheckValue<F, Lit, P>
  : Op extends ">" | "<" | ">=" | "<="
    ? CheckNum<F, Lit, P>
    : Op extends "startsWith" | "endsWith" | "contains"
      ? CheckStr<F, Lit, P>
      : Op extends "in"
        ? CheckIn<F, Lit, P>
        : FilterError<`unknown operator: ${Op}`>;
// An unquoted, namespace-prefixed operand is a field reference (field-to-field), not a literal.
type IsFilterPath<S extends string> = S extends
  | `event.${string}`
  | `header.${string}`
  | `webhook.${string}`
  ? true
  : false;

// Field-to-field: only equality/ordering, and the two field types must be comparable.
type CheckFieldToField<
  TEvent,
  F,
  Op extends string,
  Rhs extends string,
  P extends string,
> = Op extends "==" | "!=" | ">" | "<" | ">=" | "<="
  ? ResolveFilterPath<TEvent, Rhs> extends infer RF
    ? [RF] extends [Invalid]
      ? FilterError<`unknown field: ${Rhs}`>
      : [RF] extends [F]
        ? true
        : [F] extends [RF]
          ? true
          : FilterError<`${P} and ${Rhs} are not comparable`>
    : never
  : FilterError<`operator "${Op}" does not support a field reference`>;

type LeafCheck<TEvent, P extends string, Op extends string, Lit extends string> =
  ResolveFilterPath<TEvent, P> extends infer F
    ? [F] extends [Invalid]
      ? FilterError<`unknown field: ${P}`>
      : IsFilterPath<Lit> extends true
        ? CheckFieldToField<TEvent, F, Op, Lit, P>
        : CheckOp<F, Op, Lit, P>
    : never;

// Quantifier: `arrPath any|all ( subPath op lit )` — the sub-clause resolves against the array element.
type ElementOf<T> = unknown extends T ? unknown : T extends readonly (infer E)[] ? E : never;
/** The array a quantifier reads: a field, or the event itself (`event any (...)`) when the body is an array. */
type ResolveQuantifierArray<TEvent, ArrP extends string> = ArrP extends "event"
  ? TEvent
  : ResolveFilterPath<TEvent, ArrP>;
type CheckQuantifier<
  TEvent,
  ArrP extends string,
  SubP extends string,
  Op extends string,
  Lit extends string,
> =
  ResolveQuantifierArray<TEvent, ArrP> extends infer Arr
    ? [Arr] extends [Invalid]
      ? FilterError<`unknown field: ${ArrP}`>
      : [ElementOf<Arr>] extends [never]
        ? FilterError<`${ArrP} is not an array`>
        : PathValue<ElementOf<Arr>, SubP> extends infer SF
          ? [SF] extends [Invalid]
            ? FilterError<`unknown field: ${SubP} (in ${ArrP})`>
            : CheckOp<SF, Op, Lit, SubP>
          : never
    : never;

type OddQuotes<S extends string, Odd extends boolean = false> = S extends `${string}'${infer R}`
  ? OddQuotes<R, Odd extends true ? false : true>
  : Odd;
type Unclosed<S extends string> =
  OddQuotes<S> extends true
    ? true
    : S extends `${string}[${infer After}`
      ? After extends `${string}]${string}`
        ? false
        : true
      : false;

/** Splits on spaces, keeping a quoted string or a `[list]` that contains spaces as one token. */
type SplitOnSpaces<S extends string, Acc extends string[] = []> = S extends `${infer H} ${infer R}`
  ? Unclosed<H> extends true
    ? TokenizeJoin<R, H, Acc>
    : SplitOnSpaces<R, [...Acc, H]>
  : [...Acc, S];
type TokenizeJoin<
  S extends string,
  Cur extends string,
  Acc extends string[],
> = S extends `${infer H} ${infer R}`
  ? Unclosed<`${Cur} ${H}`> extends true
    ? TokenizeJoin<R, `${Cur} ${H}`, Acc>
    : SplitOnSpaces<R, [...Acc, `${Cur} ${H}`]>
  : [...Acc, `${Cur} ${S}`];

type SplitClose<S extends string, Post extends string[] = []> = S extends `${infer L})`
  ? SplitClose<L, [")", ...Post]>
  : S extends ""
    ? Post
    : [S, ...Post];
type SplitOpen<S extends string, Pre extends string[] = []> = S extends `(${infer R}`
  ? SplitOpen<R, [...Pre, "("]>
  : [...Pre, ...SplitClose<S>];
type SplitParens<Tk extends string[], Acc extends string[] = []> = Tk extends [
  infer H extends string,
  ...infer R extends string[],
]
  ? SplitParens<R, [...Acc, ...(H extends `'${string}'` ? [H] : SplitOpen<H>)]>
  : Acc;
type Tokenize<S extends string> = SplitParens<SplitOnSpaces<S>>;

type InItemTypes<Items extends string, Acc = never> = Items extends `${infer Head},${infer Tail}`
  ? InItemTypes<Tail, Acc | FilterLiteralType<TrimItem<Head>>>
  : Acc | FilterLiteralType<TrimItem<Items>>;
type LooseEqKind<V> = V extends string ? string : V extends number ? number : unknown;
/**
 * Drops a member only when its field can never equal `V` under the server's coercing `==`: the field
 * is missing, or holds only values of `V`'s own primitive kind that differ from it.
 */
type NarrowTo<T, P extends string, V> = V extends unknown
  ? T extends unknown
    ? Exclude<MemberPathValue<T, P>, Invalid> extends infer F
      ? [V] extends [F]
        ? T
        : [F] extends [LooseEqKind<V>]
          ? never
          : T
      : never
    : never
  : never;
/**
 * The server's `==` also matches a null field for `null`, `'null'` and `0`, so those never narrow,
 * nor does a number literal TypeScript can't type exactly (`0.0`, `-0`), which reads as `number`.
 */
type NarrowEq<T, P extends string, V> = unknown extends T
  ? T
  : number extends V
    ? T
    : [Extract<V, null | "null" | 0>] extends [never]
      ? NarrowTo<T, P, V>
      : T;
type NarrowLeaf<
  T,
  P extends string,
  Op extends string,
  Lit extends string,
> = P extends `event.${infer R}`
  ? Op extends "=="
    ? IsFilterPath<Lit> extends true
      ? T
      : NarrowEq<T, R, FilterLiteralType<Lit>>
    : Op extends "in"
      ? Lit extends `[${infer Items}]`
        ? NarrowEq<T, R, InItemTypes<Items>>
        : T
      : T
  : T;

type Frame = [unknown, unknown];

/**
 * `Cur` is the event the current `&&` chain has narrowed to. Each paren group (and the whole filter)
 * is a frame of [the type the group started from, the union of its finished `||` branches]. A valid
 * filter scans to `[narrowed event]`, an invalid one to its error.
 */

type Scan<
  Cur,
  Tk extends string[],
  Frames extends Frame[],
  Expect extends "operand" | "operator",
> = Expect extends "operand"
  ? Tk extends ["(", ...infer Rest extends string[]]
    ? Scan<Cur, Rest, [[Cur, never], ...Frames], "operand">
    : Tk extends [")" | "&&" | "||", ...string[]]
      ? FilterError<`unexpected "${Tk[0] & string}"`>
      : Tk extends [
            infer ArrP extends string,
            "any" | "all",
            "(",
            infer SubP extends string,
            infer SubOp extends string,
            infer SubLit extends string,
            ")",
            ...infer Rest extends string[],
          ]
        ? CheckQuantifier<Cur, ArrP, SubP, SubOp, SubLit> extends infer R
          ? R extends true
            ? Scan<Cur, Rest, Frames, "operator">
            : R
          : never
        : Tk extends [
              infer P extends string,
              "not",
              "in",
              infer Lit extends string,
              ...infer Rest extends string[],
            ]
          ? ResolveFilterPath<Cur, P> extends infer F
            ? [F] extends [Invalid]
              ? FilterError<`unknown field: ${P}`>
              : CheckIn<F, Lit, P> extends infer R
                ? R extends true
                  ? Scan<Cur, Rest, Frames, "operator">
                  : R
                : never
            : never
          : Tk extends [
                infer P extends string,
                infer Op extends string,
                infer Lit extends string,
                ...infer Rest extends string[],
              ]
            ? LeafCheck<Cur, P, Op, Lit> extends infer R
              ? R extends true
                ? Scan<NarrowLeaf<Cur, P, Op, Lit>, Rest, Frames, "operator">
                : R
              : never
            : FilterError<`incomplete clause`>
  : Tk extends []
    ? Frames extends [[unknown, infer Done]]
      ? [Done | Cur]
      : FilterError<`unbalanced parens (missing ")")`>
    : Tk extends ["&&", ...infer Rest extends string[]]
      ? Scan<Cur, Rest, Frames, "operand">
      : Tk extends ["||", ...infer Rest extends string[]]
        ? Frames extends [[infer Base, infer Done], ...infer Outer extends Frame[]]
          ? Scan<Base, Rest, [[Base, Done | Cur], ...Outer], "operand">
          : never
        : Tk extends [")", ...infer Rest extends string[]]
          ? Frames extends [
              [unknown, infer Done],
              infer Next extends Frame,
              ...infer Outer extends Frame[],
            ]
            ? Scan<Done | Cur, Rest, [Next, ...Outer], "operator">
            : FilterError<`unmatched ")"`>
          : FilterError<`expected && or ||, got "${Tk[0] & string}"`>;

type ScanFilter<TEvent, S extends string> = Scan<TEvent, Tokenize<S>, [[TEvent, never]], "operand">;

// Valid -> S; invalid -> a branded FilterError literal. Use with `const S` in conditional-param
// position so the error surfaces inline: `filter?: ValidateWebhookFilter<TEvent, S>`.
export type ValidateWebhookFilter<TEvent, S extends string> = string extends S
  ? S
  : ScanFilter<TEvent, S> extends [unknown]
    ? S
    : ScanFilter<TEvent, S>;

/**
 * The event a handler sees once the filter `S` has passed: the members of a union event that the
 * filter's `event.<path> == <literal>` (or `in [...]`) clauses select, or `TEvent` when the filter
 * doesn't narrow it (or isn't a literal).
 */
export type NarrowWebhookEvent<TEvent, S extends string> = string extends S
  ? TEvent
  : ScanFilter<TEvent, S> extends [infer Narrowed]
    ? Narrowed
    : TEvent;
