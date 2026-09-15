import type { FilterAst, FilterOp, FilterScalar, FilterValue } from "@trigger.dev/core/v3";
import type { FilterContext, FilterMatch } from "./types.js";

// Evaluate a compiled filter against a delivery. Pure + deterministic (retry-safe). On no-match,
// `reason` names the representative failing clause + the actual value, for WebhookDelivery.filterReason.

export function evaluateFilter(ast: FilterAst, ctx: FilterContext): FilterMatch {
  return evalNode(ast, ctx);
}

function evalNode(node: FilterAst, ctx: FilterContext): FilterMatch {
  if (node.kind === "and") {
    for (const clause of node.clauses) {
      const r = evalNode(clause, ctx);
      if (!r.match) return r;
    }
    return { match: true };
  }
  if (node.kind === "or") {
    let firstReason: string | undefined;
    for (const clause of node.clauses) {
      const r = evalNode(clause, ctx);
      if (r.match) return { match: true };
      firstReason ??= r.reason;
    }
    return { match: false, reason: firstReason ?? "no condition matched" };
  }
  if (node.kind === "quantifier") {
    const arr = resolvePath(node.path, ctx);
    const sub = node.clause;
    const label = `${sub.path} ${OP_LABEL[sub.op]} ${JSON.stringify(sub.value)}`;
    if (!Array.isArray(arr)) {
      return { match: false, reason: `${node.path} is not an array` };
    }
    const test = (el: unknown) => applyOp(sub.op, resolveRelative(el, sub.path), sub.value);
    const ok = node.mode === "any" ? arr.some(test) : arr.every(test);
    return ok
      ? { match: true }
      : {
          match: false,
          reason:
            node.mode === "any"
              ? `no element of ${node.path} satisfies ${label}`
              : `not every element of ${node.path} satisfies ${label}`,
        };
  }
  const actual = resolvePath(node.path, ctx);
  if (node.valueRef !== undefined) {
    const rhs = resolvePath(node.valueRef, ctx);
    return applyOpRef(node.op, actual, rhs)
      ? { match: true }
      : {
          match: false,
          reason: `${node.path} is ${JSON.stringify(actual)}, expected ${OP_LABEL[node.op]} ${
            node.valueRef
          } (${JSON.stringify(rhs)})`,
        };
  }
  return applyOp(node.op, actual, node.value as FilterValue)
    ? { match: true }
    : { match: false, reason: describe(node.path, node.op, actual, node.value as FilterValue) };
}

// Field-to-field comparison (both operands resolved from the event). Equality is strict on the
// resolved values; ordering coerces to number. Non-comparison ops are rejected by the parser/types.
function applyOpRef(op: FilterOp, a: unknown, b: unknown): boolean {
  switch (op) {
    case "eq":
      return a === b;
    case "neq":
      return a !== b;
    case "gt":
      return numCompare(a, b, (x, y) => x > y);
    case "lt":
      return numCompare(a, b, (x, y) => x < y);
    case "gte":
      return numCompare(a, b, (x, y) => x >= y);
    case "lte":
      return numCompare(a, b, (x, y) => x <= y);
    default:
      return false;
  }
}

function resolvePath(path: string, ctx: FilterContext): unknown {
  const segs = path.split(".");
  const [ns, ...rest] = segs;
  if (ns === "header") return lookupHeaderCI(ctx.headers, rest.join("."));
  let cur: unknown = ns === "event" ? ctx.event : ns === "webhook" ? ctx.webhook : undefined;
  for (const seg of rest) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

// Resolve a bare (element-relative) dotted path against an object, used for quantifier sub-clauses.
function resolveRelative(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const seg of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

function lookupHeaderCI(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return headers[key];
  }
  return undefined;
}

function applyOp(op: FilterOp, actual: unknown, value: FilterValue): boolean {
  const missing = actual === undefined;
  switch (op) {
    case "eq":
      return looseEq(actual, value as FilterScalar);
    case "neq":
      return !looseEq(actual, value as FilterScalar);
    case "gt":
      return numCompare(actual, value, (a, b) => a > b);
    case "lt":
      return numCompare(actual, value, (a, b) => a < b);
    case "gte":
      return numCompare(actual, value, (a, b) => a >= b);
    case "lte":
      return numCompare(actual, value, (a, b) => a <= b);
    case "in":
      return Array.isArray(value) && value.some((v) => looseEq(actual, v));
    case "nin":
      return !(Array.isArray(value) && value.some((v) => looseEq(actual, v)));
    case "startsWith":
      return !missing && typeof value === "string" && String(actual).startsWith(value);
    case "endsWith":
      return !missing && typeof value === "string" && String(actual).endsWith(value);
    case "contains":
      return !missing && typeof value === "string" && String(actual).includes(value);
  }
}

// Literal-type-driven comparison, to tame JSON's loose typing. A missing field equals only `null`.
function looseEq(actual: unknown, lit: FilterScalar): boolean {
  if (lit === null) return actual === null || actual === undefined;
  if (actual === undefined) return false;
  if (typeof lit === "string") return String(actual) === lit;
  if (typeof lit === "number") {
    const n = typeof actual === "number" ? actual : Number(actual);
    return !Number.isNaN(n) && n === lit;
  }
  return actual === lit; // boolean
}

function coerceNum(x: unknown): number {
  return typeof x === "number" ? x : typeof x === "string" ? Number(x) : NaN;
}

function numCompare(
  actual: unknown,
  value: unknown,
  cmp: (a: number, b: number) => boolean
): boolean {
  const a = coerceNum(actual);
  const b = coerceNum(value);
  return !Number.isNaN(a) && !Number.isNaN(b) && cmp(a, b);
}

const OP_LABEL: Record<FilterOp, string> = {
  eq: "==",
  neq: "!=",
  gt: ">",
  lt: "<",
  gte: ">=",
  lte: "<=",
  in: "in",
  nin: "not in",
  startsWith: "startsWith",
  endsWith: "endsWith",
  contains: "contains",
};

function describe(path: string, op: FilterOp, actual: unknown, value: FilterValue): string {
  return `${path} is ${JSON.stringify(actual)}, expected ${OP_LABEL[op]} ${JSON.stringify(value)}`;
}
