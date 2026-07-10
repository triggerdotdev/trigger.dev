/**
 * oxlint custom rule: no-thrown-unawaited-redirect
 *
 * Catches `throw someRedirectHelper(...)` where the helper is an *async* function
 * that returns a Promise<Response> (e.g. `redirectWithErrorMessage`). Throwing the
 * un-awaited call throws a *pending Promise* instead of a Response, so Remix renders
 * the route's error boundary instead of performing the redirect.
 *
 * Correct forms are:
 *   - `throw await redirectWithErrorMessage(...)`
 *   - `return redirectWithErrorMessage(...)`
 *
 * Note: the plain synchronous `redirect(...)` from `remix-typedjson` returns a
 * `Response` directly, so `throw redirect(...)` is the intended Remix control-flow
 * pattern and is intentionally NOT flagged.
 */

// Async redirect helpers that return a Promise. Extend this list as new async
// redirect helpers are added.
const ASYNC_REDIRECT_HELPERS = new Set([
  "redirectWithSuccessMessage",
  "redirectWithErrorMessage",
  "redirectBackWithErrorMessage",
  "redirectBackWithSuccessMessage",
  "redirectWithImpersonation",
]);

const FUNCTION_TYPES = new Set([
  "ArrowFunctionExpression",
  "FunctionDeclaration",
  "FunctionExpression",
]);

function isInsideAsyncFunction(node, sourceCode) {
  const ancestors = sourceCode.getAncestors(node);

  for (let index = ancestors.length - 1; index >= 0; index--) {
    const ancestor = ancestors[index];

    if (FUNCTION_TYPES.has(ancestor.type)) {
      return ancestor.async;
    }
  }

  return false;
}

/** @type {import("eslint").Rule.RuleModule} */
const noThrownUnawaitedRedirect = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow throwing an un-awaited async redirect helper (throws a pending Promise instead of a Response).",
    },
    fixable: "code",
    messages: {
      unawaited:
        'Throwing an un-awaited "{{name}}()" throws a pending Promise (Remix renders the error boundary instead of redirecting). Use "throw await {{name}}()" or "return {{name}}()".',
    },
    schema: [],
  },
  create(context) {
    return {
      ThrowStatement(node) {
        const argument = node.argument;

        // Already awaited (`throw await helper()`) -> fine.
        if (!argument || argument.type === "AwaitExpression") {
          return;
        }

        // Only care about direct calls: `throw helper(...)`.
        if (argument.type !== "CallExpression") {
          return;
        }

        const callee = argument.callee;
        if (callee.type !== "Identifier" || !ASYNC_REDIRECT_HELPERS.has(callee.name)) {
          return;
        }

        const canAutofix = isInsideAsyncFunction(node, context.sourceCode);

        context.report({
          node: argument,
          messageId: "unawaited",
          data: { name: callee.name },
          fix: canAutofix ? (fixer) => fixer.insertTextBefore(argument, "await ") : undefined,
        });
      },
    };
  },
};

/** @type {import("eslint").ESLint.Plugin} */
const plugin = {
  meta: {
    name: "trigger",
  },
  rules: {
    "no-thrown-unawaited-redirect": noThrownUnawaitedRedirect,
  },
};

export default plugin;
