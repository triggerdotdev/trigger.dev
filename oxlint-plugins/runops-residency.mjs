/**
 * oxlint plugin: trigger-runops — fast in-editor fences for the run-ops DB split.
 * Name-based ports of two detectors from the authoritative type-aware guard
 * (apps/webapp/scripts/runOpsLegacyGuard.ts, run as `--check` in CI). Scoped to
 * apps/webapp/app via .oxlintrc.json overrides, matching the guard's scope.
 */

// The 16 run-graph delegates (camelCased run-ops models). Authoritative source is
// internal-packages/run-ops-database/prisma/schema.prisma, which the tsx guard
// parses; kept as a literal here so a missing schema can never disable linting.
const RUN_GRAPH_DELEGATES = new Set([
  "taskRun",
  "taskRunExecutionSnapshot",
  "taskRunCheckpoint",
  "waitpoint",
  "taskRunWaitpoint",
  "waitpointRunConnection",
  "completedWaitpoint",
  "waitpointTag",
  "taskRunTag",
  "taskRunDependency",
  "taskRunAttempt",
  "batchTaskRun",
  "batchTaskRunItem",
  "batchTaskRunError",
  "checkpoint",
  "checkpointRestoreEvent",
]);

// Global control-plane client exports (from ~/db.server).
const CONTROL_PLANE_GLOBALS = new Set(["prisma", "$replica"]);

// Read-through config slots that MUST carry a run-ops client. Kept in sync with
// RUN_OPS_READTHROUGH_SLOTS in scripts/runOpsLegacyGuard.ts. `controlPlaneReplica`
// is intentionally absent — it is meant to be control-plane.
const RUN_OPS_READTHROUGH_SLOTS = new Set([
  "newClient",
  "newReplica",
  "runOpsNew",
  "legacyReplica",
  "runOpsLegacyReplica",
]);
const CONTROL_PLANE_CLIENT_IDENTIFIERS = new Set(["$replica", "prisma"]);
const CONTROL_PLANE_THIS_FIELDS = new Set(["_replica", "_prisma"]);

// Parentheses are not nodes in oxlint's ESTree, so only type-only wrappers unwrap.
function unwrap(node) {
  let current = node;
  while (
    current &&
    (current.type === "TSAsExpression" ||
      current.type === "TSSatisfiesExpression" ||
      current.type === "TSNonNullExpression")
  ) {
    current = current.expression;
  }
  return current;
}

function valueIsControlPlaneClient(node) {
  const expr = unwrap(node);
  if (!expr) return false;
  if (expr.type === "Identifier") return CONTROL_PLANE_CLIENT_IDENTIFIERS.has(expr.name);
  if (
    expr.type === "MemberExpression" &&
    !expr.computed &&
    expr.object.type === "ThisExpression" &&
    expr.property.type === "Identifier"
  ) {
    return CONTROL_PLANE_THIS_FIELDS.has(expr.property.name);
  }
  return false;
}

function propertyKeyName(property) {
  const key = property.key;
  if (!key) return undefined;
  if (key.type === "Identifier" && !property.computed) return key.name;
  if (key.type === "Literal" && typeof key.value === "string") return key.value;
  return undefined;
}

/** @type {import("eslint").Rule.RuleModule} */
const noControlPlaneRunGraphAccess = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow reaching a run-graph table through the global control-plane Prisma client; route through the RunStore.",
    },
    messages: {
      leak: 'Run-graph table "{{delegate}}" is reached through the control-plane client "{{client}}". Once run-ops is a separate database this reads/writes the wrong DB — route through the RunStore instead.',
    },
    schema: [],
  },
  create(context) {
    return {
      MemberExpression(node) {
        if (node.computed || node.property.type !== "Identifier") return;
        if (!RUN_GRAPH_DELEGATES.has(node.property.name)) return;
        if (node.object.type !== "Identifier" || !CONTROL_PLANE_GLOBALS.has(node.object.name)) {
          return;
        }
        context.report({
          node,
          messageId: "leak",
          data: { delegate: node.property.name, client: node.object.name },
        });
      },
    };
  },
};

/** @type {import("eslint").Rule.RuleModule} */
const noControlPlaneInRunOpsSlot = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow assigning a control-plane Prisma client into a run-ops read-through config slot (routes run-ops reads at the wrong database).",
    },
    messages: {
      misroute:
        'Run-ops read-through slot "{{slot}}" is assigned the control-plane client "{{client}}". This routes run-ops reads at the control-plane database. Assign the run-ops client instead.',
    },
    schema: [],
  },
  create(context) {
    return {
      Property(node) {
        const slot = propertyKeyName(node);
        if (!slot || !RUN_OPS_READTHROUGH_SLOTS.has(slot)) return;
        if (node.shorthand) return; // `{ legacyReplica }` binds a same-named local, not a cp export.
        if (!valueIsControlPlaneClient(node.value)) return;
        const client =
          node.value.type === "Identifier"
            ? node.value.name
            : context.sourceCode.getText(unwrap(node.value));
        context.report({ node: node.value, messageId: "misroute", data: { slot, client } });
      },
    };
  },
};

/** @type {import("eslint").ESLint.Plugin} */
const plugin = {
  // Distinct namespace: oxlint keys plugins by meta.name, so this cannot reuse
  // "trigger" without clobbering no-thrown-unawaited-redirect.
  meta: { name: "trigger-runops" },
  rules: {
    "no-control-plane-run-graph-access": noControlPlaneRunGraphAccess,
    "no-control-plane-in-runops-slot": noControlPlaneInRunOpsSlot,
  },
};

export default plugin;
