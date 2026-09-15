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

type PathValue<T, P extends string> = P extends `${infer H}.${infer R}`
  ? H extends keyof T
    ? PathValue<NonNullable<T[H]>, R>
    : Invalid
  : P extends keyof T
    ? NonNullable<T[P]>
    : Invalid;

type ResolveFilterPath<TEvent, P extends string> = P extends `event.${infer R}`
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

type CheckValue<F, Lit extends string, P extends string> = [FilterLiteralType<Lit>] extends [
  Invalid,
]
  ? FilterError<`cannot parse value: ${Lit}`>
  : [FilterLiteralType<Lit>] extends [F]
    ? true
    : FilterError<`value ${Lit} is not valid for ${P}`>;
type CheckNum<F, Lit extends string, P extends string> = [F] extends [number]
  ? Lit extends `${number}`
    ? true
    : FilterError<`${P} needs a number`>
  : FilterError<`${P} is not numeric`>;
type CheckStr<F, Lit extends string, P extends string> = [F] extends [string]
  ? Lit extends `'${string}'`
    ? true
    : FilterError<`${P} op needs a string literal`>
  : FilterError<`${P} is not a string`>;
// `in`/`not in` lists are validated unspaced (`['a','b']`), since the type tokenizer is space-only;
// the runtime tokenizer also accepts spaced lists.
type CheckInItems<
  F,
  Items extends string,
  P extends string,
> = Items extends `${infer Head},${infer Tail}`
  ? CheckValue<F, Head, P> extends true
    ? CheckInItems<F, Tail, P>
    : CheckValue<F, Head, P>
  : CheckValue<F, Items, P>;
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
type ElementOf<T> = T extends readonly (infer E)[] ? E : never;
type CheckQuantifier<
  TEvent,
  ArrP extends string,
  SubP extends string,
  Op extends string,
  Lit extends string,
> =
  ResolveFilterPath<TEvent, ArrP> extends infer Arr
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

type Tokenize<S extends string, Acc extends string[] = []> = S extends `${infer H} ${infer R}`
  ? Tokenize<R, [...Acc, H]>
  : [...Acc, S];

type Scan<
  TEvent,
  Tk extends string[],
  Depth extends 1[],
  Expect extends "operand" | "operator",
> = Expect extends "operand"
  ? Tk extends ["(", ...infer Rest extends string[]]
    ? Scan<TEvent, Rest, [1, ...Depth], "operand">
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
        ? CheckQuantifier<TEvent, ArrP, SubP, SubOp, SubLit> extends infer R
          ? R extends true
            ? Scan<TEvent, Rest, Depth, "operator">
            : R
          : never
        : Tk extends [
              infer P extends string,
              "not",
              "in",
              infer Lit extends string,
              ...infer Rest extends string[],
            ]
          ? ResolveFilterPath<TEvent, P> extends infer F
            ? [F] extends [Invalid]
              ? FilterError<`unknown field: ${P}`>
              : CheckIn<F, Lit, P> extends infer R
                ? R extends true
                  ? Scan<TEvent, Rest, Depth, "operator">
                  : R
                : never
            : never
          : Tk extends [
                infer P extends string,
                infer Op extends string,
                infer Lit extends string,
                ...infer Rest extends string[],
              ]
            ? LeafCheck<TEvent, P, Op, Lit> extends infer R
              ? R extends true
                ? Scan<TEvent, Rest, Depth, "operator">
                : R
              : never
            : FilterError<`incomplete clause`>
  : Tk extends []
    ? Depth extends []
      ? true
      : FilterError<`unbalanced parens (missing ")")`>
    : Tk extends ["&&" | "||", ...infer Rest extends string[]]
      ? Scan<TEvent, Rest, Depth, "operand">
      : Tk extends [")", ...infer Rest extends string[]]
        ? Depth extends [1, ...infer D extends 1[]]
          ? Scan<TEvent, Rest, D, "operator">
          : FilterError<`unmatched ")"`>
        : FilterError<`expected && or ||, got "${Tk[0] & string}"`>;

type ScanFilter<TEvent, S extends string> = Scan<TEvent, Tokenize<S>, [], "operand">;

// Valid -> S; invalid -> a branded FilterError literal. Use with `const S` in conditional-param
// position so the error surfaces inline: `filter?: ValidateWebhookFilter<TEvent, S>`.
export type ValidateWebhookFilter<TEvent, S extends string> =
  ScanFilter<TEvent, S> extends true ? S : ScanFilter<TEvent, S>;
