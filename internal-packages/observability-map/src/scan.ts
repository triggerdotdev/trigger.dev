import ts from "@typescript/typescript6";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CatchEvidence, EntryPoint, LogCall } from "./types.js";

/** Thrown by `scanFile` when the source does not parse cleanly. */
export class ParseFailureError extends Error {
  constructor(
    readonly fileName: string,
    readonly diagnostic: string
  ) {
    super(`${fileName}: ${diagnostic}`);
    this.name = "ParseFailureError";
  }
}

type EntryFunction = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction;

function isEntryFunction(node: ts.Node): node is EntryFunction {
  return (
    ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)
  );
}

/** Strip wrappers that do not change which expression is really being referred to. */
function unwrap(expr: ts.Expression): ts.Expression {
  let current = expr;
  for (;;) {
    if (
      ts.isParenthesizedExpression(current) ||
      ts.isAwaitExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isNonNullExpression(current)
    ) {
      current = current.expression;
      continue;
    }
    return current;
  }
}

/**
 * Root callee of a call, unwrapping chains: `createLoaderApiRoute({}).withCors()`
 * resolves to `createLoaderApiRoute`, not `withCors`.
 */
function rootCalleeName(call: ts.CallExpression): string | null {
  let current: ts.Expression = unwrap(call.expression);
  for (;;) {
    if (ts.isIdentifier(current)) return current.text;
    if (
      ts.isCallExpression(current) ||
      ts.isPropertyAccessExpression(current) ||
      ts.isElementAccessExpression(current)
    ) {
      current = unwrap(current.expression);
      continue;
    }
    return null;
  }
}

/**
 * A dotted property path, `authentication.userId`, or null when the chain does not start from a
 * plain identifier. Property accesses only: a call or an index anywhere in the chain gives null.
 */
function propertyPath(expr: ts.Expression): string | null {
  const target = unwrap(expr);
  if (ts.isIdentifier(target)) return target.text;
  if (!ts.isPropertyAccessExpression(target)) return null;
  const base = propertyPath(target.expression);
  return base === null ? null : `${base}.${target.name.text}`;
}

/**
 * Expressions that are the caller's own id, in the spellings the route tree uses. Anchored at both
 * ends: the root is one of the auth bindings a builder hands the handler and the last segment is an
 * identity field, so `user.name` is not a scope and neither is `run.userId`, which is a resource's
 * owner rather than the caller.
 */
const CALLER_ID_PATH =
  /^(authentication|authenticationResult|auth|sessionAuth|user)(\.[A-Za-z0-9_$]+)*\.(userId|id|actor)$/;

/**
 * Property names that mean the value says WHOSE rather than merely carrying the caller's id around.
 * Read off the tree: of the ten names taking a caller-id value, `sub`, `value` and `consumerId` are
 * the three left out.
 */
const CALLER_ID_FIELD =
  /^(id|userId|user|memberId|orgMemberId|createdBy|createdByUserId|environmentId|runtimeEnvironmentId|organizationId|orgId|projectId)$/;

/**
 * Callees handed the caller's id that cannot narrow a read with it: the log line and the response
 * body. A denylist of sinks rather than an allowlist of query callees, which is a measurement and not
 * a preference. See INTERNALS.md, "What auth-scope reads as scoping".
 */
const NON_SCOPING_CALLEE = /(^|\.)console\.[A-Za-z_$][\w$]*$|^(json|typedjson|defer)$/;

/**
 * Whether a callee could plausibly narrow a read with the object it is handed. A callee with no
 * readable name of its own is credited, because refusing it would ACCUSE the route.
 */
function couldScopeAQuery(callee: ts.Expression): boolean {
  const text = calleeText(callee);
  if (text === null) return true;
  return !LOGGER_CALLEE.test(text) && !NON_SCOPING_CALLEE.test(text);
}

/**
 * Whether the object literal holding this property is handed to a call that could scope a query,
 * through any depth of nesting. Arrays count, so `{ OR: [{ userId }] }` still reaches its call.
 *
 * Refuses a filter built and dropped (`dead-caller-scope-object`, `dead-caller-scope-userid`) and
 * one handed to a `NON_SCOPING_CALLEE` (`log-caller-scope-userid`). Does NOT refuse a filter handed
 * to a named call that ignores it: `String({ userId: user.id })` reads as scoping, the same way
 * `try { String(0); }` reads as error handling.
 */
function isHandedToAScopingCall(property: ts.PropertyAssignment): boolean {
  let node: ts.Node = property;
  for (let parent = node.parent; parent; node = parent, parent = node.parent) {
    if (ts.isCallExpression(parent) || ts.isNewExpression(parent)) {
      if (parent.arguments?.some((a) => a === node) !== true) return false;
      return couldScopeAQuery(parent.expression);
    }
    if (
      !ts.isObjectLiteralExpression(parent) &&
      !ts.isPropertyAssignment(parent) &&
      !ts.isArrayLiteralExpression(parent)
    ) {
      return false;
    }
  }
  return false;
}

/**
 * Whether any handler in `fns` assigns the caller's own id to an object-literal property. Three
 * conditions, all load bearing: INTERNALS.md, "What auth-scope reads as scoping".
 *
 * Per export rather than per entry point, which is why it is computed here rather than in the main
 * body walk. Nested functions are walked, since a filter built inside a callback still filters.
 * Same-file helpers are NOT followed, unlike the main walk, so a route computing its filter in a
 * helper is reported as unscoped. Nothing in the tree does.
 */
function scopesByCallerIn(fns: Iterable<EntryFunction>): boolean {
  let found = false;
  const visit = (node: ts.Node) => {
    if (found) return;
    if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      CALLER_ID_FIELD.test(node.name.text)
    ) {
      const path = propertyPath(node.initializer);
      if (path !== null && CALLER_ID_PATH.test(path) && isHandedToAScopingCall(node)) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  for (const fn of fns) {
    if (fn.body) visit(fn.body);
  }
  return found;
}

/** Callee as recorded in `calleeNames`: the identifier, or the property for a member call. */
function calleeName(expr: ts.Expression): string | null {
  const target = unwrap(expr);
  if (ts.isIdentifier(target)) return target.text;
  if (ts.isPropertyAccessExpression(target)) return target.name.text;
  return null;
}

/**
 * The whole callee path of a call, `prisma.organization.findFirst` rather than `findFirst`. Used to
 * match a call against `LOGGER_CALLEE` and `PARSE_CALLEE`. Null when the path runs through something
 * with no name of its own, e.g. `new PromptService().createOverride`, where the caller falls back to
 * the bare name.
 */
function calleeText(expr: ts.Expression): string | null {
  const target = unwrap(expr);
  if (ts.isIdentifier(target)) return target.text;
  if (target.kind === ts.SyntaxKind.ThisKeyword) return "this";
  if (ts.isPropertyAccessExpression(target)) {
    const base = calleeText(target.expression);
    return base === null ? null : `${base}.${target.name.text}`;
  }
  if (ts.isCallExpression(target)) {
    const base = calleeText(target.expression);
    return base === null ? null : `${base}()`;
  }
  return null;
}

/** `logger.error`, `log.info`, `this.logger.debug`. */
const LOGGER_CALLEE = /(^|\.)(logger|log)\.[A-Za-z_$][\w$]*$/;

/** Property names on the first object-literal argument, e.g. `{ environmentId, error }`. */
function objectArgumentFields(call: ts.CallExpression): string[] {
  for (const arg of call.arguments) {
    const target = unwrap(arg);
    if (!ts.isObjectLiteralExpression(target)) continue;
    const fields: string[] = [];
    for (const property of target.properties) {
      const name = propertyName(property);
      if (name) fields.push(name);
    }
    return fields;
  }
  return [];
}

/**
 * Calls that turn input into a value and throw when it is malformed. `parse`/`safeParse` cover
 * `JSON.parse` and the zod schemas. `.json` has to be a member call, because a bare `json(...)` is
 * the remix response helper, which every route calls and which parses nothing.
 */
const PARSE_CALLEE = /(^|\.)(parse|safeParse|parseAsync|safeParseAsync|decode)$|\.json$/;

/**
 * Constructors that parse untrusted input and throw when it is malformed. Deliberately short: any
 * constructor at all excuses a catch guarding ordinary work, which was true of 77 try blocks.
 */
const PARSE_CONSTRUCTORS = new Set(["URL", "URLSearchParams", "RegExp"]);

function isParseCall(node: ts.Node): boolean {
  if (ts.isNewExpression(node)) {
    return ts.isIdentifier(node.expression) && PARSE_CONSTRUCTORS.has(node.expression.text);
  }
  if (!ts.isCallExpression(node)) return false;
  const text = calleeText(node.expression) ?? calleeName(node.expression);
  return text !== null && PARSE_CALLEE.test(text);
}

/**
 * Body reads: what a parse guard waits for before it parses, when the parse is written separately
 * from the read. Only consulted for `awaitsOnlyParse`, never for `guardsParse`, which bounds it: a
 * body read on its own does not make a try block a parse guard.
 */
const BODY_READ_METHODS = new Set(["text", "formData", "arrayBuffer", "blob", "bytes"]);

function isBodyRead(node: ts.Node): boolean {
  if (!ts.isCallExpression(node)) return false;
  const callee = unwrap(node.expression);
  return ts.isPropertyAccessExpression(callee) && BODY_READ_METHODS.has(callee.name.text);
}

/**
 * Syntax that can raise, i.e. anything a try block might do that produces something for a catch
 * clause to catch. A whitelist, so it also misses real raising code; `guardedWork` has both
 * directions of that residual.
 */
function canRaise(node: ts.Node): boolean {
  return (
    ts.isCallExpression(node) ||
    ts.isNewExpression(node) ||
    ts.isTaggedTemplateExpression(node) ||
    ts.isAwaitExpression(node) ||
    ts.isYieldExpression(node) ||
    ts.isPropertyAccessExpression(node) ||
    ts.isElementAccessExpression(node) ||
    ts.isThrowStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isForInStatement(node) ||
    (ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword ||
        node.operatorToken.kind === ts.SyntaxKind.InKeyword))
  );
}

/**
 * What the guarded region does, in the three terms `error-classification` needs. Each term's rule
 * and measurement: INTERNALS.md, "Catch evidence, per clause".
 *
 * Two residuals in opposite directions, both live. `guardCanRaise` refuses `try { 0; }` and nothing
 * cleverer, because `canRaise` accepts any call at all, so `try { String(0); }` reads as
 * classification and takes the tree from 19 to 44: `dead-classifying-try-with-call`, the corpus's
 * expected failure. And `canRaise` misses code that CAN raise, a destructuring declaration and a
 * temporal-dead-zone read among them, which is why `guardMayRaise` exists beside it.
 *
 * Nested function bodies are skipped throughout: a callback written inside the try is not work the
 * try is guarding on this pass through, and a `throw` inside one is not either.
 */
function guardedWork(tryBlock: ts.Block): {
  guardsParse: boolean;
  awaitsOnlyParse: boolean;
  guardCanRaise: boolean;
} {
  let guardsParse = false;
  let awaitsOnlyParse = true;
  let guardCanRaise = false;
  const visit = (node: ts.Node) => {
    if (ts.isFunctionLike(node)) return;
    if (isParseCall(node)) guardsParse = true;
    if (canRaise(node)) guardCanRaise = true;
    if (ts.isAwaitExpression(node)) {
      const awaited = unwrap(node.expression);
      if (!isParseCall(awaited) && !isBodyRead(awaited)) awaitsOnlyParse = false;
    }
    ts.forEachChild(node, visit);
  };
  visit(tryBlock);
  return { guardsParse, awaitsOnlyParse, guardCanRaise };
}

/** Whether some node in the tree rooted at `node` matches `predicate`. */
function someNode(node: ts.Node, predicate: (n: ts.Node) => boolean): boolean {
  if (predicate(node)) return true;
  return ts.forEachChild(node, (child) => someNode(child, predicate)) === true;
}

function containsInstanceOf(node: ts.Node): boolean {
  return someNode(
    node,
    (n) => ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword
  );
}

/**
 * Whether a binding name pattern declares `target`, recursively, including every destructured shape:
 * a shadow check that only recognised `ts.isIdentifier` missed all of them.
 */
function bindingDeclares(name: ts.BindingName, target: string): boolean {
  if (ts.isIdentifier(name)) return name.text === target;
  for (const element of name.elements) {
    if (!ts.isOmittedExpression(element) && bindingDeclares(element.name, target)) return true;
  }
  return false;
}

/** Whether `name` is declared by a var/let/const, function or class statement directly in this
 * statement list. Not recursive: a nested block's own declarations are handled when the walk
 * reaches that block. */
function declaresInScope(statements: readonly ts.Statement[], name: string): boolean {
  for (const statement of statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) return true;
    if (ts.isClassDeclaration(statement) && statement.name?.text === name) return true;
    if (
      ts.isVariableStatement(statement) &&
      statement.declarationList.declarations.some((d) => bindingDeclares(d.name, name))
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Whether `node` contains a genuine read of the given catch binding. Two shapes share the binding's
 * text without reading it, the property side of a member expression and an object literal key, and a
 * name re-declared in a nested scope refers to that declaration instead, so the walk stops at the
 * boundary that re-declares it.
 */
function referencesBinding(node: ts.Node, bindingName: string): boolean {
  if (ts.isIdentifier(node) && node.text === bindingName) {
    const parent = node.parent;
    if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
    if (ts.isPropertyAssignment(parent) && parent.name === node) return false;
    return true;
  }

  if (
    ts.isFunctionLike(node) &&
    node.parameters.some((p) => bindingDeclares(p.name, bindingName))
  ) {
    return false;
  }

  if (ts.isCatchClause(node)) {
    const decl = node.variableDeclaration;
    if (decl && bindingDeclares(decl.name, bindingName)) return false;
  }

  if (ts.isBlock(node) && declaresInScope(node.statements, bindingName)) return false;

  return ts.forEachChild(node, (child) => referencesBinding(child, bindingName)) === true;
}

/** The catch binding's name, or null for a bindingless `catch { ... }` or a destructured one. */
function catchBindingName(clause: ts.CatchClause): string | null {
  const decl = clause.variableDeclaration;
  return decl && ts.isIdentifier(decl.name) ? decl.name.text : null;
}

/** A node's source text with all whitespace removed, for comparing two branch arms. */
function normalizedText(node: ts.Node): string {
  return node.getText().replace(/\s+/g, "");
}

/**
 * Whether a conditional expression tests the error to pick what the clause does, rather than to word
 * what it says. The caller only offers it the whole value of a `return`/`throw`, so
 * `return json({ error: e instanceof Error ? e.message : String(e) })` does not reach here: that is
 * message formatting and every error leaves by the same path.
 *
 * The two arms have to differ, the same requirement `selectsADistinctPath` makes of an `if`, with
 * parentheses and whitespace stripped. `same-arms-ternary` and
 * `wrap-body-in-same-arms-throw-ternary` are the tree-scale versions, the second of which would take
 * every route in the tree to a pass. The residual both branch tests share is on
 * `selectsADistinctPath`.
 */
function selectsAnErrorPath(node: ts.ConditionalExpression, bindingName: string | null): boolean {
  if (bindingName === null) return false;
  if (!containsInstanceOf(node.condition)) return false;
  if (!referencesBinding(node.condition, bindingName)) return false;
  return normalizedText(unwrap(node.whenTrue)) !== normalizedText(unwrap(node.whenFalse));
}

/**
 * Which bare (unlabelled) jumps, at this point in the recursion, leave the statement list the
 * question is being asked about. A bare jump targets the nearest enclosing construct of its kind, so
 * descending past one of those changes the answer for the jumps it captures.
 */
type BareJumps = { break: boolean; continue: boolean };

/** A jump written directly in the list under question always leaves it: whatever it targets
 * encloses the list. */
const ESCAPES: BareJumps = { break: true, continue: true };

/** A `do` body, asked about from the list the `do` sits in. Both jumps reach the statement written
 * after the `do`, so neither leaves that list. */
const IN_DO_BODY: BareJumps = { break: false, continue: false };

/**
 * A statement that leaves the statement list it sits in on every path through itself, so anything
 * after it in the same list never runs. Recognises a nested construct and not only the bare jump
 * forms, which is what stopped a dead `throw error;` counting as a rethrow (`dead-throw-after-*`).
 *
 * A bare `break` or `continue` only counts where it actually leaves the list, which is what `jumps`
 * carries: a `break` in a switch clause targets the switch, a `continue` targets an enclosing loop
 * that the switch cannot be. `break and continue inside the construct they target` holds both
 * halves. A labelled jump always counts, since nothing between the list and the jump can carry the
 * label.
 *
 * A sound under-approximation: everything not listed answers false, including a `do` that never
 * falls through, since separating that from `do { continue; } while (c)` means folding a loop
 * condition. Saying false when the truth is true only leaves a later statement in the list, which
 * withholds evidence rather than inventing it.
 */
function definitelyExits(statement: ts.Statement, jumps: BareJumps = ESCAPES): boolean {
  if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) return true;
  if (ts.isBreakStatement(statement)) return statement.label !== undefined || jumps.break;
  if (ts.isContinueStatement(statement)) return statement.label !== undefined || jumps.continue;
  if (ts.isBlock(statement)) {
    return statement.statements.some((s) => definitelyExits(s, jumps));
  }
  // A `do` body runs before its condition is ever read.
  if (ts.isDoStatement(statement)) return definitelyExits(statement.statement, IN_DO_BODY);
  if (ts.isIfStatement(statement)) {
    // Keyword-exact, the same spelling rule as the walk's `if (true)` entry and for the same
    // reason: this GRANTS a reachability cut and a wrong grant pays.
    // `cuts a dead trailing statement after an if true that exits` is the pin.
    if (unwrap(statement.expression).kind === ts.SyntaxKind.TrueKeyword) {
      return definitelyExits(statement.thenStatement, jumps);
    }
    return (
      statement.elseStatement !== undefined &&
      definitelyExits(statement.thenStatement, jumps) &&
      definitelyExits(statement.elseStatement, jumps)
    );
  }
  if (ts.isTryStatement(statement)) {
    if (statement.finallyBlock && definitelyExits(statement.finallyBlock, jumps)) return true;
    if (!definitelyExits(statement.tryBlock, jumps)) return false;
    return (
      statement.catchClause === undefined || definitelyExits(statement.catchClause.block, jumps)
    );
  }
  if (ts.isSwitchStatement(statement)) {
    const inClause: BareJumps = { break: false, continue: jumps.continue };
    const clauses = statement.caseBlock.clauses;
    const last = clauses[clauses.length - 1];
    if (!clauses.some(ts.isDefaultClause) || last === undefined) return false;
    // An empty clause falls through to the next one, so it does not have to exit itself; the last
    // clause has nothing to fall through to and does.
    return (
      clauses.every(
        (c) => c.statements.length === 0 || c.statements.some((s) => definitelyExits(s, inClause))
      ) && last.statements.some((s) => definitelyExits(s, inClause))
    );
  }
  return false;
}

/** `statements` up to and including the first one that definitely exits. */
function reachableStatements(statements: readonly ts.Statement[]): readonly ts.Statement[] {
  // The arrow matters: `findIndex` passes an index as the second argument, which `definitelyExits`
  // would read as its `jumps` record.
  const index = statements.findIndex((s) => definitelyExits(s));
  return index === -1 ? statements : statements.slice(0, index + 1);
}

/**
 * Whether the tree rooted at `node` contains a `break` or `continue` that would leave it. What the
 * catch walk asks of a finally block before entering the tryBlock beside it, since a finally that
 * completes abruptly cancels the try's completion (`dead-throw-in-cancelled-try`).
 *
 * A containment read and not a liveness one, on purpose: the caller is deciding whether to GRANT
 * credit, so a jump that only may run still refuses
 * (`refuses the tryBlock when the finally only may break`). A `return` is not looked for here
 * because the returns veto already reads it off the whole statement.
 */
function containsEscapingJump(node: ts.Node, jumps: BareJumps = ESCAPES): boolean {
  if (ts.isFunctionLike(node)) return false;
  if (ts.isBreakStatement(node)) return node.label !== undefined || jumps.break;
  if (ts.isContinueStatement(node)) return node.label !== undefined || jumps.continue;
  if (ts.isSwitchStatement(node)) {
    const inClause: BareJumps = { break: false, continue: jumps.continue };
    return node.caseBlock.clauses.some((c) =>
      c.statements.some((s) => containsEscapingJump(s, inClause))
    );
  }
  // Any loop captures both bare jumps, so nothing inside one can leave `node`
  // (`does not refuse a finally whose loop captures its own break`).
  if (ts.isIterationStatement(node, false)) {
    return (
      ts.forEachChild(node, (child) =>
        containsEscapingJump(child, { break: false, continue: false })
      ) === true
    );
  }
  return ts.forEachChild(node, (child) => containsEscapingJump(child, jumps)) === true;
}

/**
 * Literal truthiness of a guard expression: true, false, or null when not decidable from the token
 * alone. An identifier, call, bigint, `&&`, `||` or a template with substitutions is always null, so
 * a live guard can never be read as dead. That is deliberate and it is what leaves
 * `dead-conjunction-instanceof-if` open. Pinned by `still refuses an error test after an always-true
 * spelling that throws`.
 */
function literalTruth(expr: ts.Expression): boolean | null {
  const target = unwrap(expr);
  const literal = literalValue(target);
  if (literal !== undefined) return Boolean(literal);
  if (ts.isPrefixUnaryExpression(target) && target.operator === ts.SyntaxKind.ExclamationToken) {
    const inner = literalTruth(target.operand);
    return inner === null ? null : !inner;
  }
  if (ts.isBinaryExpression(target)) {
    const op = target.operatorToken.kind;
    if (
      op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      op === ts.SyntaxKind.ExclamationEqualsEqualsToken
    ) {
      const left = literalValue(target.left);
      const right = literalValue(target.right);
      if (left === undefined || right === undefined) return null;
      const equal = left === right;
      return op === ts.SyntaxKind.EqualsEqualsEqualsToken ? equal : !equal;
    }
  }
  return null;
}

/** The value of a literal token, or undefined when the expression is not a bare literal. */
function literalValue(expr: ts.Expression): string | number | boolean | null | undefined {
  const target = unwrap(expr);
  if (target.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (target.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (target.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isStringLiteral(target) || ts.isNoSubstitutionTemplateLiteral(target)) return target.text;
  if (ts.isNumericLiteral(target)) return Number(target.text);
  return undefined;
}

/** Whether a try block could throw at all: false only when every statement is an expression
 * statement over a bare literal, the one shape that provably cannot raise. */
function tryBlockMayThrow(block: ts.Block): boolean {
  return !block.statements.every(
    (s) => ts.isExpressionStatement(s) && literalValue(s.expression) !== undefined
  );
}

/**
 * Whether the tree rooted at `root` contains a node `hit` accepts that a provably-untaken branch does
 * not already rule out. Strictly subtractive against a plain containment read, which is what lets its
 * two callers read it for opposite purposes: see INTERNALS.md, "Two folds, pointing opposite ways".
 *
 * The `exited` half is pinned by `dead and deferred code prepended to a deciding catch does not blind
 * it` and the `BRANCH_EXITED` family; the `selectsADistinctPath` half by `an arm whose only exit is
 * dead decides nothing` and `dead-armed-instanceof-if`.
 */
function containsLiveWhere(root: ts.Node, hit: (n: ts.Node) => boolean): boolean {
  const walk = (node: ts.Node): boolean => {
    if (ts.isFunctionLike(node)) return false;
    if (hit(node)) return true;
    if (ts.isIfStatement(node)) {
      const truth = literalTruth(node.expression);
      if (truth === true) return walk(node.thenStatement);
      if (truth === false) {
        return node.elseStatement !== undefined && walk(node.elseStatement);
      }
      return (
        walk(node.thenStatement) || (node.elseStatement !== undefined && walk(node.elseStatement))
      );
    }
    if (ts.isWhileStatement(node)) {
      if (literalTruth(node.expression) === false) return false;
      return walk(node.statement);
    }
    if (ts.isForStatement(node)) {
      if (node.condition !== undefined && literalTruth(node.condition) === false) return false;
      return ts.forEachChild(node, walk) === true;
    }
    if (ts.isForOfStatement(node) || ts.isForInStatement(node)) {
      const iterable = unwrap(node.expression);
      const emptyArray = ts.isArrayLiteralExpression(iterable) && iterable.elements.length === 0;
      const emptyObject =
        ts.isForInStatement(node) &&
        ts.isObjectLiteralExpression(iterable) &&
        iterable.properties.length === 0;
      if (emptyArray || emptyObject) return false;
      return ts.forEachChild(node, walk) === true;
    }
    if (ts.isSwitchStatement(node)) {
      const disc = literalValue(node.expression);
      const clauses = node.caseBlock.clauses;
      const allLiteral =
        disc !== undefined &&
        clauses.every((c) => ts.isDefaultClause(c) || literalValue(c.expression) !== undefined);
      if (!allLiteral) return clauses.some((c) => c.statements.some(walk));
      // Fall-through: from the first matching (or default) clause, every later clause is reachable.
      let matched = clauses.findIndex(
        (c) => !ts.isDefaultClause(c) && literalValue(c.expression) === disc
      );
      if (matched === -1) matched = clauses.findIndex(ts.isDefaultClause);
      if (matched === -1) return false;
      return clauses.slice(matched).some((c) => c.statements.some(walk));
    }
    if (ts.isTryStatement(node)) {
      // A finally that always completes abruptly supersedes the try's and the catch's completion, so
      // only its own statements stay live. Folded only where `definitelyExits` can prove it; a
      // conditional jump keeps the containment answer, which refuses credit rather than inventing
      // it. Without this the `dead-throw-in-cancelled-try` prepend blinded the walk to every real
      // classification below it (`keeps the classification after a finally-break no-op`).
      if (node.finallyBlock !== undefined && definitelyExits(node.finallyBlock)) {
        return walk(node.finallyBlock);
      }
      if (walk(node.tryBlock)) return true;
      if (node.finallyBlock !== undefined && walk(node.finallyBlock)) return true;
      if (node.catchClause !== undefined && tryBlockMayThrow(node.tryBlock)) {
        return walk(node.catchClause.block);
      }
      return false;
    }
    return ts.forEachChild(node, walk) === true;
  };
  return walk(root);
}

function containsLiveExit(node: ts.Node): boolean {
  return containsLiveWhere(node, (n) => ts.isReturnStatement(n) || ts.isThrowStatement(n));
}

function containsLiveReturn(node: ts.Node): boolean {
  return containsLiveWhere(node, ts.isReturnStatement);
}

/**
 * Whether an `if`/`switch` sends at least one arm somewhere the others do not go, by returning or
 * throwing from inside it. `if (e instanceof Error) { }` fails this, since every error still leaves
 * by the same path afterwards (`empty-instanceof-if`). Two textually identical arms do not count,
 * the same comparison `selectsAnErrorPath` makes of a ternary.
 *
 * The exit an arm is credited for has to be a LIVE one, never a plain containment read
 * (`an arm whose only exit is dead decides nothing`, `dead-armed-instanceof-if`).
 *
 * The residual both branch tests share, stated here once for both: two arms that produce the same
 * outcome by different spellings still read as a real decision, e.g.
 * `if (e instanceof Error) { return json(x); } return Response.json(x);`. Telling those apart needs
 * the produced values compared for meaning rather than for text, which is a different kind of
 * analysis from anything else in this file.
 */
function selectsADistinctPath(statement: ts.IfStatement | ts.SwitchStatement): boolean {
  if (ts.isIfStatement(statement)) {
    const otherwise = statement.elseStatement;
    if (otherwise !== undefined) {
      if (normalizedText(statement.thenStatement) === normalizedText(otherwise)) return false;
      return containsLiveExit(statement.thenStatement) || containsLiveExit(otherwise);
    }
    return containsLiveExit(statement.thenStatement);
  }
  // Per clause statement rather than over the whole switch: reading the switch as one node would
  // hand `containsLiveWhere`'s discriminant fold a `switch (1)` it can decide, which is not this
  // predicate's business, since an unreachable CLAUSE is caught by the same fold one level down.
  return statement.caseBlock.clauses.some((clause) => clause.statements.some(containsLiveExit));
}

/**
 * What a catch clause does with the error, beyond the fact that it caught one.
 *
 * Both answers are read off the clause's own guaranteed path: the walk enters a construct exactly
 * where the entered statements are guaranteed to execute whenever the clause body runs, so no credit
 * can ever come from code a semantics-preserving edit could have added dead. Which constructs are
 * entered and which are refused, and the eleven dead spellings this replaced: INTERNALS.md,
 * "The dead-code defence". `dead-*` in the mutation corpus is the tree-scale proof, one entry per
 * shape.
 *
 * The cost is real, in both rules. `catch (e) { if (transient) throw e; return null; }` no longer
 * reads as a rethrow, so it fails rather than sitting out. That is the direction to be wrong in.
 */
function catchClauseEvidence(clause: ts.CatchClause): {
  rethrows: boolean;
  throws: boolean;
  branches: boolean;
} {
  // The state record travels so an if/else arm can be walked against an isolated copy. `returns`
  // stays a single shared flag, because it is a clause-wide veto and never per-arm evidence.
  //
  // `exited` is raised at the END of each statement, after that statement's own branch check: a
  // deciding statement contains an exit by definition, so raising it first makes every such
  // statement refuse itself, measured at 78 routes losing their pass.
  //
  // `vetoReturns` is false only in the arm walks. `returns` is read at the PARENT level over the
  // whole statement, so an arm walk re-reading its own statements adds a false veto for a
  // folded-dead arm (`dead-classifier-one-arm`).
  type ClauseState = {
    rethrows: boolean;
    branches: boolean;
    exited: boolean;
    vetoReturns: boolean;
  };
  let returns = false;
  const state: ClauseState = { rethrows: false, branches: false, exited: false, vetoReturns: true };
  const bindingName = catchBindingName(clause);

  const walk = (statements: readonly ts.Statement[], state: ClauseState) => {
    // A block re-declaring the binding name means an `if` below it references the shadowing
    // declaration, not this clause's error, so the whole list is skipped for branch purposes.
    const shadowed = bindingName !== null && declaresInScope(statements, bindingName);

    for (const statement of reachableStatements(statements)) {
      if (ts.isThrowStatement(statement)) {
        state.rethrows = true;
        // Read the branch check here, before the path is cut. A thrown ternary picks WHICH error
        // leaves, which is a classification, and the shared check below is unreachable from this arm
        // because it always continues first.
        if (
          bindingName !== null &&
          !shadowed &&
          !state.exited &&
          statement.expression !== undefined
        ) {
          const thrown = unwrap(statement.expression);
          if (ts.isConditionalExpression(thrown) && selectsAnErrorPath(thrown, bindingName)) {
            state.branches = true;
          }
        }
        state.exited = true;
        continue;
      }
      if (ts.isBlock(statement)) {
        walk(statement.statements, state);
        if (containsLiveExit(statement)) state.exited = true;
        continue;
      }
      // A `do` body runs before its condition is ever read, so it is on the straight-line path
      // whatever the condition says. The only loop form that is.
      if (ts.isDoStatement(statement)) {
        const body = statement.statement;
        walk(ts.isBlock(body) ? body.statements : [body], state);
        if (containsLiveExit(statement)) state.exited = true;
        continue;
      }
      // The three handlers below share one template: walk the inner list with the SAME shared state,
      // then read `returns` and `exited` off the whole statement and continue. The explicit
      // `containsLiveReturn` read is load-bearing, because the `continue` skips the shared read below
      // and `try { throw e; } finally { return null; }` genuinely swallows (`reads a try whose
      // finally returns as swallowing, not rethrowing`).
      //
      // A catchless `try` is entered only when its finally cannot complete abruptly, since a finally
      // that does cancels the try's completion and the throw never escapes the clause
      // (`reads a throw a finally break discards as no rethrow`, `dead-throw-in-cancelled-try`). The
      // finallyBlock itself is NOT walked, so classification living only there is under-credited. A
      // `try` WITH a catch clause is not entered at all, since a throw in its tryBlock is
      // intercepted by the nested catch, which is judged separately as its own `ep.catches` entry
      // (`does not read the tryBlock of a caught try as this clause's rethrow`).
      if (
        ts.isTryStatement(statement) &&
        statement.catchClause === undefined &&
        (statement.finallyBlock === undefined || !containsEscapingJump(statement.finallyBlock))
      ) {
        walk(statement.tryBlock.statements, state);
        if (state.vetoReturns && containsLiveReturn(statement)) returns = true;
        if (containsLiveExit(statement)) state.exited = true;
        continue;
      }
      // A `switch` whose caseBlock is exactly one DefaultClause: those statements always run, as a
      // bare list. Any other switch shape falls through to the branch gate below, so a real
      // `switch (e.code)` keeps its top-level credit. `reads a clause wrapped in a single-default
      // switch as the bare clause` is the pin.
      if (ts.isSwitchStatement(statement)) {
        const clauses = statement.caseBlock.clauses;
        const only = clauses.length === 1 ? clauses[0] : undefined;
        if (only !== undefined && ts.isDefaultClause(only)) {
          walk(only.statements, state);
          if (state.vetoReturns && containsLiveReturn(statement)) returns = true;
          if (containsLiveExit(statement)) state.exited = true;
          continue;
        }
      }
      // An `if` whose condition is exactly the `true` keyword: the then-arm always runs, the else-arm
      // is NEVER walked (`reads a dead else arm under if true as contributing nothing`).
      // Keyword-exact on purpose, because entry GRANTS credit where `literalTruth`'s wider folding
      // only withholds blindness. Do not unify the two folds. Takes precedence over the arm walk.
      if (
        ts.isIfStatement(statement) &&
        unwrap(statement.expression).kind === ts.SyntaxKind.TrueKeyword
      ) {
        const arm = statement.thenStatement;
        walk(ts.isBlock(arm) ? arm.statements : [arm], state);
        if (state.vetoReturns && containsLiveReturn(statement)) returns = true;
        if (containsLiveExit(statement)) state.exited = true;
        continue;
      }
      // Any other reachable statement that could return means throwing is not the only way out.
      // Read per statement rather than over the whole clause, so a `return` the walk has already cut
      // as dead does not count, and read LIVE rather than by containment, since vetoing on
      // `if (false) { return null; }` regressed a rethrow-only clause from not-applicable to fail on
      // 11 real routes (`still sets rethrows past a dead return in an if (false) arm`).
      if (state.vetoReturns && containsLiveReturn(statement)) returns = true;

      if (bindingName !== null && !shadowed && !state.exited) {
        if (
          (ts.isIfStatement(statement) || ts.isSwitchStatement(statement)) &&
          referencesBinding(statement.expression, bindingName) &&
          selectsADistinctPath(statement)
        ) {
          state.branches = true;
        } else if (ts.isReturnStatement(statement) && statement.expression !== undefined) {
          const value = unwrap(statement.expression);
          if (ts.isConditionalExpression(value) && selectsAnErrorPath(value, bindingName)) {
            state.branches = true;
          }
        }
      }

      // An `if` WITH an else: one arm always runs, so evidence in BOTH arms is unconditional and
      // evidence in one arm only earns nothing. The arms merge by INTERSECTION, because union is the
      // laundering direction (`dead-classifier-one-arm`, `does not credit a classifier that sits in
      // one arm only`). `returns` is never intersected, since narrowing a veto per arm is unsafe.
      if (ts.isIfStatement(statement) && statement.elseStatement !== undefined) {
        const armWalk = (arm: ts.Statement): ClauseState => {
          const armState: ClauseState = {
            rethrows: false,
            branches: false,
            exited: state.exited,
            vetoReturns: false,
          };
          walk(ts.isBlock(arm) ? arm.statements : [arm], armState);
          return armState;
        };
        const thenArm = armWalk(statement.thenStatement);
        const elseArm = armWalk(statement.elseStatement);
        state.rethrows ||= thenArm.rethrows && elseArm.rethrows;
        state.branches ||= thenArm.branches && elseArm.branches;
      }

      if (containsLiveExit(statement)) state.exited = true;
    }
  };
  walk(clause.block.statements, state);

  return {
    rethrows: state.rethrows && !returns,
    throws: state.rethrows,
    branches: state.branches,
  };
}

/**
 * Method names that invoke their callback once per element, never once as a whole. The structural
 * signal that separates a per-item boundary from a route's own body expressed through one more layer
 * of function nesting (`trace(async () => {...})` and friends, which run their callback exactly
 * once). A name list, because nothing in a syntactic scan can tell `users.map` from `Result.map`.
 */
const ITERATION_METHODS = new Set([
  "map",
  "forEach",
  "filter",
  "reduce",
  "reduceRight",
  "flatMap",
  "some",
  "every",
]);

/** Whether an expression is an array literal of fewer than two elements, the one receiver shape
 * that cannot be a per-item iteration however the method is named. */
function isAtMostSingletonArray(expr: ts.Expression): boolean {
  const target = unwrap(expr);
  return ts.isArrayLiteralExpression(target) && target.elements.length < 2;
}

/**
 * Whether the function-like `node` is the callback argument of a per-item iteration. Both directions
 * of being wrong, and what makes the name list survivable: INTERNALS.md, "The iteration-callback
 * boundary".
 *
 * The residual a reader here needs: a per-item callback under a callee this list does not know,
 * `pMap(items, cb)`, is attributed to the route, so a per-element catch that decides can carry it to
 * a pass. That is a wrong verdict waiting for a route to be written that way rather than a laundering
 * path, and it is why the list is worth extending when a new iteration helper shows up in the tree.
 */
function isIterationCallback(node: ts.Node): boolean {
  const parent = node.parent;
  if (!parent || !ts.isCallExpression(parent)) return false;
  if (!parent.arguments.includes(node as ts.Expression)) return false;
  const callee = unwrap(parent.expression);
  if (!ts.isPropertyAccessExpression(callee)) return false;
  if (!ITERATION_METHODS.has(callee.name.text)) return false;
  return !isAtMostSingletonArray(callee.expression);
}

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

function propertyName(property: ts.ObjectLiteralElementLike): string | null {
  if (!property.name) return null;
  if (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
    return property.name.text;
  return null;
}

/** `methods: { POST: { handler } }`, the per-method shape of `createMultiMethodApiRoute`. */
function collectMethodHandlers(methods: ts.ObjectLiteralExpression, out: EntryFunction[]): void {
  for (const method of methods.properties) {
    const name = propertyName(method);
    if (!name || !HTTP_METHODS.has(name)) continue;
    if (!ts.isPropertyAssignment(method)) continue;
    const config = unwrap(method.initializer);
    if (!ts.isObjectLiteralExpression(config)) continue;
    for (const property of config.properties) {
      if (!ts.isPropertyAssignment(property) || propertyName(property) !== "handler") continue;
      const value = unwrap(property.initializer);
      if (isEntryFunction(value)) out.push(value);
    }
  }
}

/**
 * The handler on an object argument, in the two shapes the route builders use: `handler` at the top
 * level of the config and `methods.POST.handler`. Matching by name at any depth would pick up the
 * sibling lambdas (`findResource`, `authorization.resource`) that are not the entry-point body.
 */
function collectNamedHandlers(object: ts.ObjectLiteralExpression, out: EntryFunction[]): void {
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const name = propertyName(property);
    const value = unwrap(property.initializer);
    if (name === "handler" && isEntryFunction(value)) out.push(value);
    if (name === "methods" && ts.isObjectLiteralExpression(value)) {
      collectMethodHandlers(value, out);
    }
  }
}

/** The innermost call of a chain: the `createLoaderApiRoute(...)` in `createLoaderApiRoute(...).withCors(...)`. */
function rootCall(call: ts.CallExpression): ts.CallExpression {
  let current = call;
  for (;;) {
    let next = unwrap(current.expression);
    while (ts.isPropertyAccessExpression(next) || ts.isElementAccessExpression(next)) {
      next = unwrap(next.expression);
    }
    if (ts.isCallExpression(next)) {
      current = next;
      continue;
    }
    return current;
  }
}

/**
 * The handler functions passed to a builder call. Only the root call of a chain is read: a
 * callback given to a decorator further along the chain (`.withCors(cb)`) is not the route body.
 */
function collectHandlerFunctions(call: ts.CallExpression, out: EntryFunction[]): void {
  for (const arg of rootCall(call).arguments) {
    const unwrapped = unwrap(arg);
    if (isEntryFunction(unwrapped)) out.push(unwrapped);
    else if (ts.isObjectLiteralExpression(unwrapped)) collectNamedHandlers(unwrapped, out);
  }
}

/** Literals a builder option can be given that mean it was not given: `apiBuilder.server.ts` gates
 * every option behind `if (option)`, and declaring one is what `auth-scope` credits. */
function isDeclaredValue(property: ts.ObjectLiteralElementLike): boolean {
  if (!ts.isPropertyAssignment(property)) return true;
  const value = unwrap(property.initializer);
  if (ts.isIdentifier(value) && value.text === "undefined") return false;
  return value.kind !== ts.SyntaxKind.NullKeyword && value.kind !== ts.SyntaxKind.FalseKeyword;
}

/**
 * Top-level property names of every object-literal argument to the root call. Only the top level,
 * because `authorization` on `createMultiMethodApiRoute` is declared once beside `methods` rather
 * than per method (`apiBuilder.server.ts`).
 */
function collectOptionKeys(call: ts.CallExpression): string[] {
  const keys: string[] = [];
  for (const arg of rootCall(call).arguments) {
    const target = unwrap(arg);
    if (!ts.isObjectLiteralExpression(target)) continue;
    for (const property of target.properties) {
      const name = propertyName(property);
      if (name && isDeclaredValue(property)) keys.push(name);
    }
  }
  return keys;
}

type Initializer = { callee: string | null; functions: EntryFunction[]; optionKeys: string[] };

const NO_INITIALIZER: Initializer = { callee: null, functions: [], optionKeys: [] };

/** Top-level `function x` / `const x = ...` declarations, keyed by binding name. */
type LocalDeclarations = Map<string, ts.Expression | ts.FunctionDeclaration>;

function analyzeInitializer(
  expr: ts.Expression | undefined,
  locals: LocalDeclarations,
  seen: Set<string>
): Initializer {
  if (!expr) return NO_INITIALIZER;
  const target = unwrap(expr);

  if (isEntryFunction(target)) return { callee: null, functions: [target], optionKeys: [] };

  if (ts.isCallExpression(target)) {
    const functions: EntryFunction[] = [];
    collectHandlerFunctions(target, functions);
    return {
      callee: rootCalleeName(target),
      functions,
      optionKeys: collectOptionKeys(target),
    };
  }

  // `export const action = route.action` where `const route = createActionApiRoute(...)`, and the
  // plain alias `export const loader = h`. Resolve back to the declaration the name came from.
  if (ts.isIdentifier(target)) return resolveLocal(target.text, locals, seen);
  if (ts.isPropertyAccessExpression(target)) {
    const root = unwrap(target.expression);
    if (ts.isIdentifier(root)) return resolveLocal(root.text, locals, seen);
  }

  return NO_INITIALIZER;
}

function resolveLocal(name: string, locals: LocalDeclarations, seen: Set<string>): Initializer {
  if (seen.has(name)) return NO_INITIALIZER;
  seen.add(name);
  const local = locals.get(name);
  if (!local) return NO_INITIALIZER;
  if (ts.isFunctionDeclaration(local)) return { callee: null, functions: [local], optionKeys: [] };
  return analyzeInitializer(local, locals, seen);
}

/**
 * How many operands a comma expression has, so `a(), b(), c()` is three and not one. Anything else
 * is one.
 */
function commaOperands(expr: ts.Expression): number {
  const target = unwrap(expr);
  if (ts.isBinaryExpression(target) && target.operatorToken.kind === ts.SyntaxKind.CommaToken) {
    return commaOperands(target.left) + commaOperands(target.right);
  }
  return 1;
}

/**
 * Statements in a statement, counting through block-bearing statements so a body wrapped in a
 * single `try` reports its real size. Does not descend into nested function bodies.
 *
 * Counts bindings and comma operands rather than semicolons, which is what makes the number mean
 * something. `const a = f(), b = g(), c = h();` is three initializers however it is punctuated, and
 * `a(), b(), c()` is three calls: scoring either as one let a seven-statement try be rewritten into
 * a two-statement one with no change to what it runs, which took `error-classification` from fail
 * to pass. `merge-declarations` and `merge-comma-expressions` in the mutation corpus are
 * the tree-scale versions.
 */
function countStatement(statement: ts.Statement): number {
  if (ts.isBlock(statement)) {
    return countStatements(statement.statements);
  }

  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.length;
  }

  if (ts.isExpressionStatement(statement)) {
    return commaOperands(statement.expression);
  }

  let count = 1;

  if (ts.isTryStatement(statement)) {
    count += countStatements(statement.tryBlock.statements);
    if (statement.catchClause) count += countStatements(statement.catchClause.block.statements);
    if (statement.finallyBlock) count += countStatements(statement.finallyBlock.statements);
    return count;
  }

  if (ts.isIfStatement(statement)) {
    count += countStatement(statement.thenStatement);
    if (statement.elseStatement) count += countStatement(statement.elseStatement);
    return count;
  }

  if (
    ts.isForStatement(statement) ||
    ts.isForInStatement(statement) ||
    ts.isForOfStatement(statement) ||
    ts.isWhileStatement(statement) ||
    ts.isDoStatement(statement) ||
    ts.isLabeledStatement(statement) ||
    ts.isWithStatement(statement)
  ) {
    count += countStatement(statement.statement);
    return count;
  }

  if (ts.isSwitchStatement(statement)) {
    for (const clause of statement.caseBlock.clauses) {
      count += countStatements(clause.statements);
    }
    return count;
  }

  return count;
}

function countStatements(statements: ts.NodeArray<ts.Statement>): number {
  let count = 0;
  for (const statement of statements) count += countStatement(statement);
  return count;
}

function countFunctionStatements(fn: EntryFunction): number {
  if (!fn.body) return 0;
  // A concise arrow body (`() => json({})`) is one expression, so one statement.
  if (!ts.isBlock(fn.body)) return 1;
  return countStatements(fn.body.statements);
}

type ExportName = "loader" | "action";

/**
 * The call-site facts a body walk accumulates, kept in one shape so the entry-point-wide totals and
 * each export's own totals are filled by the same code rather than by two similar loops.
 */
type BodyFacts = {
  calleeNames: string[];
  /**
   * The same calls as `calleeNames`, each as its whole dotted path. `calleeName` keeps only the
   * last segment, so `prisma.organization.findFirst` arrives in `calleeNames` as `findFirst` and
   * the receiver that says WHAT is being called is gone. The per-export triviality rule needs it
   * back: `prisma` in the path is how a short body is known to touch the datastore.
   */
  calleeTexts: string[];
  /** Locals initialised from a call, by local name. */
  declaredFrom: Map<string, string[]>;
  /** Every identifier read by an `if`, `while`, `switch` or conditional condition. */
  testedNames: Set<string>;
  statementCount: number;
  hasTryCatch: boolean;
};

function newBodyFacts(): BodyFacts {
  return {
    calleeNames: [],
    calleeTexts: [],
    declaredFrom: new Map(),
    testedNames: new Set(),
    statementCount: 0,
    hasTryCatch: false,
  };
}

/** Callees whose answer these bodies looked at: declared from a call AND read by a condition. */
function checkedCalleesOf(facts: BodyFacts): string[] {
  return [
    ...new Set(
      [...facts.declaredFrom]
        .filter(([local]) => facts.testedNames.has(local))
        .flatMap(([, callees]) => callees)
    ),
  ];
}

type EntryTarget = {
  hasLoader: boolean;
  hasAction: boolean;
  loaderInitializerCallee: string | null;
  actionInitializerCallee: string | null;
  loaderBuilderOptions: string[];
  actionBuilderOptions: string[];
  /** Handler functions per export, so a scope signal can be attributed to the half of the file it
   * was found in. `functions` is their union, which is what every entry-point-wide field reads. */
  loaderFunctions: Set<EntryFunction>;
  actionFunctions: Set<EntryFunction>;
  functions: Set<EntryFunction>;
};

/**
 * Top-level `function x` / `const x = ...` declarations by binding name, so a named export clause
 * (`export { action }`) can be resolved back to the initializer it came from.
 */
function collectLocalDeclarations(sf: ts.SourceFile): LocalDeclarations {
  const locals: LocalDeclarations = new Map();

  for (const statement of sf.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      locals.set(statement.name.text, statement);
      continue;
    }
    if (!ts.isVariableStatement(statement)) continue;

    for (const decl of statement.declarationList.declarations) {
      if (!decl.initializer) continue;
      if (ts.isIdentifier(decl.name)) {
        locals.set(decl.name.text, decl.initializer);
        continue;
      }
      if (ts.isObjectBindingPattern(decl.name)) {
        for (const element of decl.name.elements) {
          if (ts.isIdentifier(element.name)) locals.set(element.name.text, decl.initializer);
        }
      }
    }
  }

  return locals;
}

/**
 * Top-level functions by name, for resolving a body that delegates its work to a same-file helper
 * (`export async function loader({ request }) { return proxyToPostHog(request); }`).
 */
function collectLocalFunctions(sf: ts.SourceFile): Map<string, EntryFunction> {
  const functions = new Map<string, EntryFunction>();

  for (const statement of sf.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) {
      functions.set(statement.name.text, statement);
      continue;
    }
    if (!ts.isVariableStatement(statement)) continue;

    for (const decl of statement.declarationList.declarations) {
      if (!decl.initializer || !ts.isIdentifier(decl.name)) continue;
      const value = unwrap(decl.initializer);
      if (isEntryFunction(value)) functions.set(decl.name.text, value);
    }
  }

  return functions;
}

/** `noLib` and `noResolve` keep the throwaway program below off the disk: nothing here needs a type,
 * only the syntax the parser already produced. */
const SYNTAX_ONLY_OPTIONS: ts.CompilerOptions = { noLib: true, noResolve: true, allowJs: true };

/**
 * Syntactic diagnostics for an already-parsed source file, through `ts.Program` rather than off the
 * internal diagnostics array the parser hangs on the source file, which a compiler upgrade could
 * rename out from under us. The host hands the program the `sf` we already have, so nothing is parsed
 * twice. Costs and reasoning: INTERNALS.md, "Tests, timeouts and CI".
 */
function syntacticDiagnostics(sf: ts.SourceFile): readonly ts.Diagnostic[] {
  const host: ts.CompilerHost = {
    getSourceFile: (name) => (name === sf.fileName ? sf : undefined),
    getDefaultLibFileName: () => "lib.d.ts",
    writeFile: () => {},
    getCurrentDirectory: () => "",
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (name) => name === sf.fileName,
    readFile: () => undefined,
  };
  return ts.createProgram([sf.fileName], SYNTAX_ONLY_OPTIONS, host).getSyntacticDiagnostics(sf);
}

export function scanFile(fileName: string, source: string): EntryPoint | null {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);

  // `createSourceFile` recovers from malformed input instead of throwing, so the diagnostics are
  // the only signal that a file did not parse.
  const diagnostics = syntacticDiagnostics(sf);
  if (diagnostics.length > 0) {
    const first = diagnostics[0]!;
    throw new ParseFailureError(fileName, ts.flattenDiagnosticMessageText(first.messageText, " "));
  }

  const importedNames: string[] = [];
  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause) continue;
    const bindings = statement.importClause.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const el of bindings.elements) importedNames.push(el.name.text);
    }
    if (statement.importClause.name) importedNames.push(statement.importClause.name.text);
  }

  const target: EntryTarget = {
    hasLoader: false,
    hasAction: false,
    loaderInitializerCallee: null,
    actionInitializerCallee: null,
    loaderBuilderOptions: [],
    actionBuilderOptions: [],
    loaderFunctions: new Set(),
    actionFunctions: new Set(),
    functions: new Set(),
  };

  // The option keys travel with the callee they came from, so a second declaration cannot lend its
  // options to the first one's builder.
  const record = (name: string, initializer: Initializer) => {
    if (name === "loader") {
      target.hasLoader = true;
      if (target.loaderInitializerCallee === null) {
        target.loaderInitializerCallee = initializer.callee;
        target.loaderBuilderOptions = initializer.optionKeys;
      }
    } else {
      target.hasAction = true;
      if (target.actionInitializerCallee === null) {
        target.actionInitializerCallee = initializer.callee;
        target.actionBuilderOptions = initializer.optionKeys;
      }
    }
    const perExport = name === "loader" ? target.loaderFunctions : target.actionFunctions;
    for (const fn of initializer.functions) {
      target.functions.add(fn);
      perExport.add(fn);
    }
  };

  const isExported = (n: ts.Node) =>
    ts.canHaveModifiers(n) &&
    ts.getModifiers(n)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) === true;

  const locals = collectLocalDeclarations(sf);

  for (const statement of sf.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && isExported(statement)) {
      const name = statement.name.text;
      if (name === "loader" || name === "action") {
        record(name, { callee: null, functions: [statement], optionKeys: [] });
      }
      continue;
    }

    if (ts.isVariableStatement(statement) && isExported(statement)) {
      for (const decl of statement.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          const name = decl.name.text;
          if (name === "loader" || name === "action") {
            record(name, analyzeInitializer(decl.initializer, locals, new Set()));
          }
          continue;
        }
        // `export const { action, loader } = createActionApiRoute(...)`. Skipping a non-identifier
        // binding name here left this shape absent from the denominator entirely, neither a parse
        // failure nor unmeasured. The exported name is the ELEMENT name, so `{ loader: action }`
        // exports an action and `{ action: internal }` exports neither.
        if (!ts.isObjectBindingPattern(decl.name)) continue;
        for (const element of decl.name.elements) {
          if (!ts.isIdentifier(element.name)) continue;
          const name = element.name.text;
          if (name !== "loader" && name !== "action") continue;
          record(name, analyzeInitializer(decl.initializer, locals, new Set()));
        }
      }
      continue;
    }

    if (ts.isExportDeclaration(statement) && statement.exportClause) {
      // `export * from "./x"` has no clause and reaches nothing here; `export * as ns from "./x"`
      // is a namespace clause, which cannot name a loader or action either.
      if (!ts.isNamedExports(statement.exportClause)) continue;

      for (const element of statement.exportClause.elements) {
        const exportedName = element.name.text;
        if (exportedName !== "loader" && exportedName !== "action") continue;
        // A re-export (`export { loader } from "./x"`) has no local binding to resolve.
        if (statement.moduleSpecifier) {
          record(exportedName, NO_INITIALIZER);
          continue;
        }
        const localName = element.propertyName?.text ?? exportedName;
        record(exportedName, resolveLocal(localName, locals, new Set()));
      }
    }
  }

  if (!target.hasLoader && !target.hasAction) return null;

  const callbackCatches: CatchEvidence[] = [];
  const catches: CatchEvidence[] = [];
  const logCalls: LogCall[] = [];

  const wholeEntry = newBodyFacts();
  const byExport: Record<ExportName, BodyFacts> = {
    loader: newBodyFacts(),
    action: newBodyFacts(),
  };

  const localFunctions = collectLocalFunctions(sf);
  // One hop into a same-file helper, whose statements, try/catch and callees belong to the entry
  // point. `visited` stops a cycle and any double counting; `helperOwners` carries which EXPORTS
  // reach the helper, taking the union on a second discovery because `visited` has already queued it.
  const visited = new Set<EntryFunction>(target.functions);
  const helpers: EntryFunction[] = [];
  const helperOwners = new Map<EntryFunction, Set<ExportName>>();

  const walkBody = (fn: EntryFunction, followHelpers: boolean, owners: ReadonlySet<ExportName>) => {
    // One push site feeds the entry-point-wide list and each owning export's list, so they cannot
    // drift apart. See `EntryPoint.loaderCalleeNames`.
    const sinks: BodyFacts[] = [wholeEntry];
    for (const owner of owners) sinks.push(byExport[owner]);
    const collectTested = (node: ts.Node) => {
      if (ts.isIdentifier(node)) for (const s of sinks) s.testedNames.add(node.text);
      ts.forEachChild(node, collectTested);
    };

    const addStatements = (n: number) => {
      for (const sink of sinks) sink.statementCount += n;
    };
    addStatements(countFunctionStatements(fn));

    if (!fn.body) return;
    // `inCallback` is true once the walk has entered a per-item iteration callback and is never reset,
    // since nesting deeper inside one is still inside it. `calleeNames`, `logCalls` and the statement
    // count keep descending regardless; a catch does not, and is kept in `callbackCatches` with its
    // evidence rather than dropped. Only an iteration callback is a boundary, not every function-like
    // node. See INTERNALS.md, "The iteration-callback boundary".
    const visit = (node: ts.Node, inCatch: boolean, inCallback: boolean) => {
      if (ts.isFunctionLike(node)) {
        if (isEntryFunction(node)) addStatements(countFunctionStatements(node));
        const entersIterationCallback = inCallback || isIterationCallback(node);
        ts.forEachChild(node, (child) => visit(child, inCatch, entersIterationCallback));
        return;
      }
      if (ts.isTryStatement(node)) {
        for (const sink of sinks) sink.hasTryCatch = true;
        if (node.catchClause) {
          // Built the same way for a refused catch as for an own one, so the dead-code defence
          // applies to both. Which list it lands in is this walk's attribution decision alone.
          const tryStatementCount = countStatements(node.tryBlock.statements);
          const clause = catchClauseEvidence(node.catchClause);
          (inCallback ? callbackCatches : catches).push({
            rethrows: clause.rethrows,
            throws: clause.throws,
            branches: clause.branches,
            ...guardedWork(node.tryBlock),
            guardMayRaise: tryBlockMayThrow(node.tryBlock),
            tryStatementCount,
          });
        }
      }

      if (ts.isCatchClause(node)) {
        ts.forEachChild(node, (child) => visit(child, true, inCallback));
        return;
      }

      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const initializer = unwrap(node.initializer);
        if (ts.isCallExpression(initializer)) {
          const cn = calleeName(initializer.expression);
          if (cn) {
            for (const sink of sinks) {
              const existing = sink.declaredFrom.get(node.name.text);
              if (existing) existing.push(cn);
              else sink.declaredFrom.set(node.name.text, [cn]);
            }
          }
        }
      }

      if (ts.isIfStatement(node) || ts.isWhileStatement(node) || ts.isSwitchStatement(node)) {
        collectTested(node.expression);
      }
      if (ts.isConditionalExpression(node)) collectTested(node.condition);

      if (ts.isCallExpression(node)) {
        const cn = calleeName(node.expression);
        if (cn) {
          const text = calleeText(node.expression) ?? cn;
          for (const sink of sinks) {
            sink.calleeNames.push(cn);
            sink.calleeTexts.push(text);
          }

          if (LOGGER_CALLEE.test(text)) {
            logCalls.push({
              callee: text,
              fields: objectArgumentFields(node),
              inCatch,
            });
          }
        }

        if (followHelpers) {
          const callee = unwrap(node.expression);
          if (ts.isIdentifier(callee)) {
            const helper = localFunctions.get(callee.text);
            if (helper && !visited.has(helper)) {
              visited.add(helper);
              helpers.push(helper);
              helperOwners.set(helper, new Set(owners));
            } else if (helper) {
              const already = helperOwners.get(helper);
              if (already) for (const owner of owners) already.add(owner);
            }
          }
        }
      }
      ts.forEachChild(node, (child) => visit(child, inCatch, inCallback));
    };
    visit(fn.body, false, false);
  };

  // Every handler is walked exactly once, whichever exports own it, so the entry-point-wide
  // statement count and catch list stay single while the per-export lists see it from both sides.
  const ownersOf = (fn: EntryFunction): Set<ExportName> => {
    const owners = new Set<ExportName>();
    if (target.loaderFunctions.has(fn)) owners.add("loader");
    if (target.actionFunctions.has(fn)) owners.add("action");
    return owners;
  };
  for (const fn of target.functions) walkBody(fn, true, ownersOf(fn));
  for (const helper of helpers) walkBody(helper, false, helperOwners.get(helper) ?? new Set());

  return {
    fileName,
    source,
    hasLoader: target.hasLoader,
    hasAction: target.hasAction,
    loaderInitializerCallee: target.loaderInitializerCallee,
    actionInitializerCallee: target.actionInitializerCallee,
    loaderBuilderOptions: target.loaderBuilderOptions,
    actionBuilderOptions: target.actionBuilderOptions,
    // No handler function and no builder call: `export { action } from "./handler.server"` and
    // `export const action = handleWebhook`. See `EntryPoint.delegating`.
    delegating:
      target.functions.size === 0 &&
      target.loaderInitializerCallee === null &&
      target.actionInitializerCallee === null,
    loaderScopesByCaller: scopesByCallerIn(target.loaderFunctions),
    actionScopesByCaller: scopesByCallerIn(target.actionFunctions),
    loaderCheckedCallees: checkedCalleesOf(byExport.loader),
    actionCheckedCallees: checkedCalleesOf(byExport.action),
    importedNames,
    calleeNames: wholeEntry.calleeNames,
    loaderCalleeNames: byExport.loader.calleeNames,
    actionCalleeNames: byExport.action.calleeNames,
    loaderCalleeTexts: byExport.loader.calleeTexts,
    actionCalleeTexts: byExport.action.calleeTexts,
    hasTryCatch: wholeEntry.hasTryCatch,
    loaderHasTryCatch: byExport.loader.hasTryCatch,
    actionHasTryCatch: byExport.action.hasTryCatch,
    catches,
    callbackCatches,
    logCalls,
    statementCount: wholeEntry.statementCount,
    loaderStatementCount: byExport.loader.statementCount,
    actionStatementCount: byExport.action.statementCount,
  };
}

const SOURCE_FILE = /\.tsx?$/;

/**
 * Whether a file name is one the scanner reads at all. Exported because three test files ask the same
 * question and each had written its own copy, and a predicate that drifts makes the corpus's
 * anti-vacuity thresholds count files the scan never saw.
 */
export function isScannableFile(fileName: string): boolean {
  return SOURCE_FILE.test(fileName) && !fileName.endsWith(".d.ts");
}

/** One route module: where to read it, and the name the report and the scan record it under. */
export type RouteModuleFile = { absolutePath: string; relativeName: string };

/**
 * The route modules under `dir`: every scannable flat file, plus the `route.ts`/`route.tsx` of each
 * immediate subdirectory. Exported so `mutationCorpus.test.ts` materializes exactly this set rather
 * than re-deriving it, for the same reason as `isScannableFile` above.
 */
export function routeModuleFiles(dir: string): RouteModuleFile[] {
  const files: RouteModuleFile[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      // Flat-route directories hold the route module in `route.ts`/`route.tsx`.
      for (const child of readdirSync(join(dir, entry.name), { withFileTypes: true })) {
        if (!child.isFile() || (child.name !== "route.ts" && child.name !== "route.tsx")) continue;
        files.push({
          absolutePath: join(dir, entry.name, child.name),
          relativeName: `${entry.name}/${child.name}`,
        });
      }
      continue;
    }
    if (!entry.isFile() || !isScannableFile(entry.name)) continue;
    files.push({ absolutePath: join(dir, entry.name), relativeName: entry.name });
  }
  // `readdirSync` order is filesystem-defined, and it reaches the report: head and base are scanned
  // from two different directories, so an order difference alone would read as a delta and post a
  // comment claiming a change no score made.
  return files.sort((a, b) =>
    a.relativeName < b.relativeName ? -1 : a.relativeName > b.relativeName ? 1 : 0
  );
}

export function scanDirectory(dir: string): {
  entryPoints: EntryPoint[];
  parseFailures: string[];
} {
  const entryPoints: EntryPoint[] = [];
  const parseFailures: string[] = [];

  const scan = (absolutePath: string, relativeName: string) => {
    let ep: EntryPoint | null;
    try {
      ep = scanFile(relativeName, readFileSync(absolutePath, "utf8"));
    } catch (error) {
      // Only a genuinely malformed source is a parse failure. An unreadable file or a bug in the
      // scanner must not be laundered into the same bucket, or a non-zero count means nothing.
      if (error instanceof ParseFailureError) {
        parseFailures.push(`${relativeName}: ${error.diagnostic}`);
        return;
      }
      throw error;
    }
    if (ep) entryPoints.push(ep);
  };

  for (const file of routeModuleFiles(dir)) scan(file.absolutePath, file.relativeName);

  return { entryPoints, parseFailures };
}
