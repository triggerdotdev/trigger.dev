/**
 * oxlint plugin: trigger-prisma — flags `in:` / `notIn:` list filters.
 *
 * Prisma expands a list filter into one bind parameter per element, so every distinct list
 * length is a separate prepared statement. Where the list length tracks data volume (batch
 * size, run-graph fan-out, a prior query's id set) a single call site can mint hundreds of
 * statements, and the pooler's prepared-statement cache evicts entries that were being
 * reused to make room for ones that never will be.
 *
 * The fix is per call site: bound the list, chunk it to a fixed size, or rewrite to
 * `= ANY($1)` so arity stops changing the SQL. This rule enumerates the sites that need
 * that treatment and stops new ones appearing.
 *
 * Deliberately scoped to filter position. A key named `in` inside `data`, `create`,
 * `update`, `set` or a JSON `equals` value is user data, not a predicate, and must never be
 * touched — rewriting those corrupts what gets stored or compared.
 */

/** Subtrees that hold predicates. Descend into these. */
const FILTER_ROOTS = new Set(["where", "having", "cursor"]);

/**
 * Keys whose values are stored or compared verbatim. Never descend into these, even inside
 * a `where`: a JSON column's `equals` value is data, not a predicate.
 */
const VALUE_POSITION = new Set([
  "data",
  "create",
  "update",
  "set",
  "equals",
  "connect",
  "connectOrCreate",
  "select",
  "include",
  "_count",
]);

/**
 * Only `in` and `notIn` expand to one bind parameter per element. The scalar-list filters
 * `hasSome` and `hasEvery` compile to `&& $1` and `@> $1`, passing the whole array as a single
 * parameter, so their arity never reaches the statement text and bounding them would add
 * elements for no benefit.
 */
const LIST_FILTERS = new Set(["in", "notIn"]);

/**
 * Helpers whose first argument IS a where clause, so the filter arrives as a bare object
 * with no `where:` key for the main rule to key off. Repo-specific by design, in the same
 * spirit as the delegate list in runops-residency.mjs: an explicit list cannot silently
 * stop matching the way a heuristic can.
 */
const FILTER_ARG_HELPERS = new Set(["targetFindManyArgs"]);

/** Fallback for helpers that follow the naming convention but are not listed above. */
const FILTER_ARG_HELPER_PATTERN =
  /(?:FindMany|FindFirst|FindUnique|Count|DeleteMany|UpdateMany)Args$/;

function isFilterArgHelper(callee) {
  const name =
    callee.type === "Identifier"
      ? callee.name
      : callee.type === "MemberExpression" &&
          !callee.computed &&
          callee.property.type === "Identifier"
        ? callee.property.name
        : undefined;
  if (!name) return false;
  return FILTER_ARG_HELPERS.has(name) || FILTER_ARG_HELPER_PATTERN.test(name);
}

/** The sanctioned bounding helper from `@trigger.dev/database`. */
const BOUNDING_HELPER = "boundedIn";

/**
 * A list filter is acceptable when its arity cannot vary at runtime: an inline array
 * literal (fixed in the source) or a `boundedIn()` call (padded to a power of two).
 * Type-only wrappers are unwrapped so `boundedIn(ids) as string[]` still counts.
 *
 * An array literal counts only when nothing spreads into it. `[...new Set(ids)]` is an
 * ArrayExpression whose length is decided at runtime, which is precisely the case the
 * helper exists for.
 */
function isBounded(node) {
  let current = node;
  while (
    current &&
    (current.type === "TSAsExpression" ||
      current.type === "TSSatisfiesExpression" ||
      current.type === "TSNonNullExpression")
  ) {
    current = current.expression;
  }
  if (!current) return false;

  if (current.type === "ArrayExpression") {
    return current.elements.every((element) => !element || element.type !== "SpreadElement");
  }

  if (current.type === "CallExpression") {
    const callee = current.callee;
    if (callee.type === "Identifier") return callee.name === BOUNDING_HELPER;
    if (callee.type === "MemberExpression" && !callee.computed) {
      return callee.property.type === "Identifier" && callee.property.name === BOUNDING_HELPER;
    }
  }

  return false;
}

function propertyKeyName(node) {
  if (!node || node.type !== "Property") return undefined;
  const key = node.key;
  if (!node.computed && key.type === "Identifier") return key.name;
  if (key.type === "Literal" && typeof key.value === "string") return key.value;
  return undefined;
}

/**
 * Reports every `in` / `notIn` reachable from a filter root without passing through a
 * value-position key. Depth-bounded so a pathological args object cannot stall the linter.
 *
 * Filters are routinely assembled conditionally, so the walk follows the shapes that carry
 * them: `cond ? { … } : {}`, `cond && { … }`, and `...(cond ? { … } : {})`. Stopping at a
 * plain ObjectExpression would leave those permanently invisible to the rule.
 *
 * It also follows call arguments, so a filter fragment built by a helper and spread into
 * `where` is still inspected, and it descends through properties whose key it cannot read
 * statically. A computed key inside a filter subtree is a column name, so the value below
 * it is still predicate territory; skipping it would hide the whole branch.
 */
function reportListFilters(node, context, depth, messageId = "listFilter", extra = {}) {
  if (!node || typeof node !== "object" || depth > 12) return;

  const descend = (child) => reportListFilters(child, context, depth + 1, messageId, extra);

  switch (node.type) {
    case "TSAsExpression":
    case "TSSatisfiesExpression":
    case "TSNonNullExpression":
      return descend(node.expression);
    case "ConditionalExpression":
      descend(node.consequent);
      return descend(node.alternate);
    case "LogicalExpression":
      descend(node.left);
      return descend(node.right);
    case "ArrayExpression":
      for (const element of node.elements) descend(element);
      return;
    case "SpreadElement":
      return descend(node.argument);
    case "CallExpression":
      for (const argument of node.arguments) descend(argument);
      return;
    default:
      break;
  }

  if (node.type !== "ObjectExpression") return;

  for (const property of node.properties) {
    if (property.type === "SpreadElement") {
      descend(property.argument);
      continue;
    }
    if (property.type !== "Property") continue;

    const name = propertyKeyName(property);

    if (!name) {
      descend(property.value);
      continue;
    }

    if (VALUE_POSITION.has(name)) continue;

    if (LIST_FILTERS.has(name)) {
      if (!isBounded(property.value)) {
        context.report({
          node: property,
          messageId,
          data: { filter: name, ...extra },
        });
      }
      continue;
    }

    reportListFilters(property.value, context, depth + 1, messageId, extra);
  }
}

/** @type {import("eslint").Rule.RuleModule} */
const noUnboundedListFilter = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow `in` / `notIn` list filters, whose arity changes the generated SQL and churns the prepared-statement cache.",
    },
    messages: {
      listFilter:
        "Prisma `{{filter}}:` filter. Its length becomes the bind-parameter count, so each distinct length is a separate prepared statement. Bound or chunk the list, or rewrite to `= ANY($1)`. If the length is genuinely fixed and small, disable this line with a reason.",
    },
    schema: [],
  },
  create(context) {
    return {
      Property(node) {
        const name = propertyKeyName(node);
        if (!name || !FILTER_ROOTS.has(name)) return;
        reportListFilters(node.value, context, 0);
      },
    };
  },
};

/** @type {import("eslint").Rule.RuleModule} */
const noUnboundedListFilterInArgsHelper = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow `in` / `notIn` in a bare filter object passed to a where-building helper, which the where-keyed rule cannot see.",
    },
    messages: {
      listFilter:
        "Prisma `{{filter}}:` filter passed to `{{helper}}()` as a bare where clause. Its length becomes the bind-parameter count, so each distinct length is a separate prepared statement. Bound or chunk the list, or rewrite to `= ANY($1)`.",
    },
    schema: [],
  },
  create(context) {
    return {
      CallExpression(node) {
        if (!isFilterArgHelper(node.callee)) return;
        const first = node.arguments[0];
        if (!first || first.type !== "ObjectExpression") return;

        const helper =
          node.callee.type === "Identifier" ? node.callee.name : node.callee.property.name;

        reportListFilters(first, context, 0, "listFilter", { helper });
      },
    };
  },
};

/** @type {import("eslint").ESLint.Plugin} */
const plugin = {
  meta: { name: "trigger-prisma" },
  rules: {
    "no-unbounded-list-filter": noUnboundedListFilter,
    "no-unbounded-list-filter-in-args-helper": noUnboundedListFilterInArgsHelper,
  },
};

export default plugin;
