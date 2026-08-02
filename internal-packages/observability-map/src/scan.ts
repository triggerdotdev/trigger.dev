import ts from "typescript";
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
 * Expressions that are the caller's own id, in the spellings the route tree uses:
 * `userId: authentication.userId` under the API builders, `userId: user.id` under the dashboard
 * builders, and the `authenticationResult` and `sessionAuth` variants. Read by `auth-scope` as
 * evidence that the handler narrowed its query to whoever is asking.
 *
 * Anchored at both ends. The root has to be one of the auth bindings a builder hands the handler,
 * and the last segment has to be an identity field, so `user.name` is not a scope and neither is
 * `run.userId`, which is a resource's owner rather than the caller.
 */
const CALLER_ID_PATH =
  /^(authentication|authenticationResult|auth|sessionAuth|user)(\.[A-Za-z0-9_$]+)*\.(userId|id|actor)$/;

/**
 * Property names that mean the value is being used to say WHOSE, rather than merely carrying the
 * caller's id around. Read off the tree: of the ten names that take a caller-id value in
 * `apps/webapp/app/routes`, these are the tenant and identity fields, and `sub`, `value` and
 * `consumerId` are the three that are not. `anything: user.id` is what a mutation writes, and it
 * does not match.
 */
const CALLER_ID_FIELD =
  /^(id|userId|user|memberId|orgMemberId|createdBy|createdByUserId|environmentId|runtimeEnvironmentId|organizationId|orgId|projectId)$/;

/**
 * Whether the object literal holding this property is handed to a call, through any depth of
 * nesting: `findMany({ where: { members: { some: { userId } } } })` is, and
 * `const unused = { userId };` is not. Arrays count, so `{ OR: [{ userId }] }` still reaches its
 * call.
 *
 * What this refuses is a filter built and dropped. What it does NOT refuse is a filter built and
 * handed to a call that ignores it: `String({ userId: user.id });` reads as scoping, the same way
 * `try { String(0); }` reads as error handling, and for the same reason. Knowing whether the callee
 * uses the argument needs types the scanner does not have.
 */
function isHandedToACall(property: ts.PropertyAssignment): boolean {
  let node: ts.Node = property;
  for (let parent = node.parent; parent; node = parent, parent = node.parent) {
    if (ts.isCallExpression(parent) || ts.isNewExpression(parent)) {
      return parent.arguments?.some((a) => a === node) === true;
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
 * Whether any handler in `fns` assigns the caller's own id to an object-literal property, the
 * `where: { members: { some: { userId: authentication.userId } } }` and
 * `presenter.call({ userId: user.id })` shapes.
 *
 * Per export rather than per entry point, and that is the whole point of computing it here instead
 * of in the main body walk. A file whose loader narrows itself to the caller and whose action does
 * not is not a scoped route, and the entry-point-wide version said it was: it passed
 * `_app.orgs.$organizationSlug.settings.team/route.tsx`, whose loader calls
 * `TeamPresenter.call({ userId: user.id })` while its action resolves the target org from the URL
 * slug and gates only on `ability.can`.
 *
 * Nested functions are walked, since a filter built inside a callback still filters. Same-file
 * helpers are NOT followed, unlike the main walk: a route that computes its filter in a helper is
 * reported as unscoped. Nothing in the tree does.
 *
 * Three conditions, and the first version of this had only the middle one, which made the whole
 * check free to defeat. Prepending `const __unused = { anything: user.id };` to every body raised
 * `settings.sso` and `settings.team`, the only two findings `auth-scope` has ever produced and both
 * confirmed cross-org exposures, because any property at all taking a caller id counted wherever it
 * sat. `dead-caller-scope-object` and `dead-caller-scope-userid` in the mutation corpus are the two
 * halves of that shape.
 *
 * So the property NAME has to be an identity field, and the object it sits in has to be handed to a
 * call. See `isHandedToACall` for what that does and does not refuse.
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
      if (path !== null && CALLER_ID_PATH.test(path) && isHandedToACall(node)) {
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
 * constructor at all would mean `new BranchesPresenter()` or `new Set(...)` excuses a catch that
 * guards ordinary work, which was true of 77 try blocks in the route tree.
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
 * Body reads: the thing a parse guard waits for before it parses. `request.json()` is in
 * `PARSE_CALLEE` already because it reads and parses in one call, and these are the same operation
 * with the parse written separately, `const raw = await request.text(); new RegExp(raw);`.
 *
 * Only consulted for `awaitsOnlyParse`, never for `guardsParse`, which is what bounds it: a body
 * read on its own still does not make a try block a parse guard, so the widest this list can do is
 * let a block that already parses also read the thing it parses.
 */
const BODY_READ_METHODS = new Set(["text", "formData", "arrayBuffer", "blob", "bytes"]);

function isBodyRead(node: ts.Node): boolean {
  if (!ts.isCallExpression(node)) return false;
  const callee = unwrap(node.expression);
  return ts.isPropertyAccessExpression(callee) && BODY_READ_METHODS.has(callee.name.text);
}

/**
 * Syntax that can raise. Everything a try block might do that produces something for a catch clause
 * to catch: a call, a construction, a tagged template, an `await` or `yield` (the awaited promise
 * rejects), a member access (the base may be null or undefined), a `throw`, an iteration (the
 * iterator protocol raises on a non-iterable), and `instanceof`/`in` (a TypeError on a non-object
 * right side).
 *
 * See `guardedWork` for what is NOT on this list and why that is a disclosed residual rather than
 * an oversight.
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
 * What the guarded region does, in the three terms `error-classification` needs.
 *
 * `guardsParse` is whether anything in it parses at all. A `new URL(x)` counts and has to be read
 * as a `ts.isNewExpression` here, because the call-callee scan that builds `calleeNames` never sees
 * it.
 *
 * `awaitsOnlyParse` is whether everything the block waits for is a parse or a read of the body it
 * parses. Awaiting is the signal, not calling: the calls that prepare a parse's input are ordinary
 * synchronous string work (`matchPattern.startsWith("(?i)")`, `.slice(4)` before a `new RegExp`),
 * and refusing those refuses four of the tree's clearest guards, while the swallow this has to
 * catch reaches a service: `try { const body = await request.json(); return await
 * handleEverything(body); }`.
 *
 * `canRaise` is whether the block does anything at all that could reach the clause. A clause whose
 * try block cannot raise is not error handling, and reading one as classification paid 50 points a
 * route to anyone willing to prepend `try { 0; } catch (e) { if (e instanceof Error) { return
 * json(x, { status: 400 }); } throw e; }` to a body: on the real tree that took the global from 15
 * to 42 and raised 224 routes when it was measured, before round C moved the baseline to 19. More
 * than every other shape found on this branch put together, and still true at today's figures, which
 * `dead-classifying-try-with-call` shows live at 19 to 44. `dead-classifying-try` in the mutation
 * corpus is the refused version.
 *
 * What this refuses is `try { 0; }` and nothing cleverer. `canRaise` accepts ANY call, member
 * access or `in`, and none of those has to be able to throw, so one inert call defeats the rule:
 * `try { String(0); } catch (e) { if (e instanceof Error) { return json(x, { status: 400 }); } throw
 * e; }` reads as classification and takes the tree from 19 to 44, exactly as `try { 0; }` did.
 * `dead-classifying-try-with-call` in the mutation corpus is that shape, running as an expected
 * failure. Telling a call that can throw from one that cannot needs types the scanner does not have,
 * so the rule closes the shape found rather than the family it belongs to. Read the docstrings that
 * point here as "refuses `try { 0; }`", never as "an unreachable catch cannot be credited".
 *
 * The list also misses things that CAN raise, which is the safe direction, and the misses matter
 * because a real clause can be dropped by one: a destructuring declaration (`const { a } = undefined`
 * throws), a temporal-dead-zone read (`try { const x = later; }`), a coercion that raises
 * (`try { const x = 1 + someSymbol; }`) and a `delete` on a frozen object all read as unable to
 * raise.
 *
 * Nested function bodies are skipped throughout: a callback written inside the try is not work the
 * try is guarding on this pass through. A `throw` inside one is not either, which is deliberate.
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
 * Whether a binding name pattern declares `target`, recursively: a plain `error`, a destructured
 * `{ error }` (shorthand) or `{ code: error }` (renamed), an array pattern `[error]`, and any of
 * those nested inside another. A destructured parameter or declaration re-declares the name just as
 * completely as a plain one does, so a shadow check that only recognised `ts.isIdentifier` missed
 * every destructured shape, function parameters and variable declarations alike.
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
 * Whether `node` contains a genuine read of the given catch binding, e.g. `e` in `e instanceof X`
 * or `error.code`. An identifier only counts when it is a real reference. Two shapes share the
 * binding's text without reading it: the property side of a member expression (`fallback.error`)
 * and an object literal key (`{ error: true }`), both excluded by checking which side of the
 * parent node the identifier sits on. A name re-declared in a nested scope, as a function or catch
 * parameter (including a destructured one) or as a var/let/const/function/class in a block, refers
 * to that declaration instead, so the walk stops at the boundary that re-declares it rather than
 * crediting the outer binding.
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
 * Whether a conditional expression tests the error to pick what the clause does, rather than to
 * word what it says. The caller only offers it the whole value of a `return`/`throw`, so
 * `return e instanceof Response ? e : json({}, { status: 500 })` reaches here and
 * `return json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 })` does not.
 * The second is message formatting: every error leaves by the same path.
 *
 * Goes through `referencesBinding`, the same predicate the `if`/`switch` check uses, rather than
 * accepting any `instanceof` in the condition: an `instanceof` that never reads the caught binding
 * is not a decision made on the error, and a bindingless catch has nothing here to reference.
 *
 * The two arms also have to differ, which is the same requirement `selectsADistinctPath` makes of
 * an `if`. `return e instanceof Error ? (X) : (X)` is a test whose outcome is the same either way,
 * and it was worth 50 points a route; `same-arms-ternary` in the mutation corpus is the tree-scale
 * version, and `scan.test.ts` has the unit case. The throw path is held to the same rule by
 * `wrap-body-in-same-arms-throw-ternary`, which would take every route in the tree to a pass if it
 * were not. Parentheses and whitespace are stripped
 * before the comparison, so the shape has to differ in something a reader would call a difference.
 * The residual both branch tests share is stated once, on `selectsADistinctPath`.
 */
function selectsAnErrorPath(node: ts.ConditionalExpression, bindingName: string | null): boolean {
  if (bindingName === null) return false;
  if (!containsInstanceOf(node.condition)) return false;
  if (!referencesBinding(node.condition, bindingName)) return false;
  return normalizedText(unwrap(node.whenTrue)) !== normalizedText(unwrap(node.whenFalse));
}

/**
 * Which bare (unlabelled) jumps, at this point in the recursion, leave the statement list the
 * question is being asked about. A bare jump targets the nearest enclosing construct of its kind,
 * so descending past one of those targets changes the answer for the jumps it captures.
 */
type BareJumps = { break: boolean; continue: boolean };

/** A jump written directly in the list under question always leaves it: whatever it targets
 * encloses the list. */
const ESCAPES: BareJumps = { break: true, continue: true };

/** A `do` body, asked about from the list the `do` sits in. `break` ends the loop and `continue`
 * goes to the condition, and both of those reach the statement written after the `do`. */
const IN_DO_BODY: BareJumps = { break: false, continue: false };

/**
 * A statement that leaves the statement list it sits in on every path through itself, so anything
 * after it in the same list never runs.
 *
 * Recognises a nested construct, not only a bare `return`/`throw`/`break`/`continue`. Recognising
 * only the bare form is what let a dead `throw error;` count as a rethrow when the statement before
 * it was a block, a `do` body or an `if`/`else` that returned; `dead-throw-after-*` in the mutation
 * corpus is that family, and `scan.test.ts` has one case per construct.
 *
 * A bare `break` or `continue` only counts where it actually leaves the list, which is what `jumps`
 * carries. A `break` inside a switch clause targets the switch, so a switch whose clauses all break
 * falls through to the statement after it and does NOT exit; reading that break as an exit accused
 * `catch (e) { switch (e.code) { ... break; } throw e; }` of swallowing a rethrown error, which is
 * both a false verdict and a detail line that says the opposite of what the route does. A `continue`
 * inside a switch clause targets an enclosing loop instead, which the switch cannot be, so it is
 * inherited rather than dropped: dropping it would stop
 * `do { switch (x) { default: continue; } throw e; } while (c)` cutting a throw that really is dead.
 * `break and continue inside the construct they target` in `scan.test.ts` holds both halves.
 *
 * A labelled `break`/`continue` always counts. Its target has to enclose the statement list, since
 * nothing between the list and the jump can carry the label: `definitelyExits` answers false for a
 * labelled statement, so the recursion never descends through one.
 *
 * A sound under-approximation. `if` without an `else` (unless its guard is the literal `true`
 * keyword, the one condition this function folds), a labelled statement (a `break` to the label
 * escapes it) and every other loop form answer false, because none of them is guaranteed to run its
 * body. That extends to a `do` that never falls through, `do { continue; } while (true)`, which is
 * false for the same reason `while (true) { }` always was: separating it from
 * `do { continue; } while (c)` means folding a LOOP condition, which this function still does not
 * do. Saying false when the truth is true only leaves a later statement in the list, which
 * is the direction that withholds evidence rather than inventing it.
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
    // A guard that is exactly the `true` keyword always takes its then-arm, so the statement
    // definitely exits iff that arm does, with or without an else. Keyword-exact, same spelling
    // rule as the walk's `if (true)` entry and for the same reason: this GRANTS a reachability
    // cut, and a wrong grant pays. `cuts a dead trailing statement after an if true that exits`
    // is the pin; `dead-throw-after-if-true` and `dead-branch-after-if-true` in the mutation
    // corpus are the tree-scale versions.
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

/** Whether the tree rooted at `node` contains a `return` or a `throw` of its own, not counting one
 * inside a nested function. What separates an arm that takes the error somewhere from an arm that
 * runs and falls back into the clause's single common exit. */
function containsExit(node: ts.Node): boolean {
  if (ts.isFunctionLike(node)) return false;
  if (ts.isReturnStatement(node) || ts.isThrowStatement(node)) return true;
  return ts.forEachChild(node, containsExit) === true;
}

/**
 * Literal truthiness of a guard expression: true, false, or null when not decidable from the
 * token alone. Only literal tokens fold; an identifier, call, bigint, `&&`, `||` or a template
 * literal with substitutions is always null, so a live guard can never be read as dead. The
 * always-true side is pinned by `still refuses an error test after an always-true spelling that
 * throws` and the fall-through slice by `reads a switch fall-through onto a live return as live`.
 */
function literalTruth(expr: ts.Expression): boolean | null {
  const target = unwrap(expr);
  if (target.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (target.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (target.kind === ts.SyntaxKind.NullKeyword) return false;
  if (ts.isStringLiteral(target) || ts.isNoSubstitutionTemplateLiteral(target)) {
    return target.text !== "";
  }
  if (ts.isNumericLiteral(target)) return Number(target.text) !== 0;
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
 * `containsExit`, minus exits that sit in a provably-untaken branch. `if (false) { throw e; }`
 * contains an exit and can never run one; treating it as an exit is what let a dead statement
 * blind the walk to the real classification below it, prepending one to a deciding clause turned
 * its pass into a swallow verdict on 78 real routes. Folds literal guards only, so an unknown
 * condition keeps the containsExit answer, which is the direction that refuses credit rather than
 * inventing it. The mirror twins under `dead and deferred code prepended to a deciding catch does
 * not blind it` hold the recovered half; the `BRANCH_EXITED` family holds the refusing half.
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
 * throwing from inside it. `if (e instanceof Error) { }` and `if (e instanceof Error) { log(e); }`
 * both fail this: every error still leaves the clause by the same path afterwards, so the test
 * changed the wording and not the outcome. The empty-body form was the cheapest no-op in the tool,
 * worth 50 points a route; `empty-instanceof-if` in the mutation corpus is the tree-scale version.
 *
 * An `if`/`else` whose two arms are textually identical does not count, the same comparison
 * `selectsAnErrorPath` makes of a ternary's arms.
 *
 * The residual both branch tests share, stated here once for both: two arms that produce the same
 * outcome by different spellings still read as a real decision.
 * `if (e instanceof Error) { return json(x); } return Response.json(x);` counts and decides
 * nothing, and so does the `if` with no `else` whose arm returns what the statement after it
 * returns. Telling those apart needs the produced values compared for meaning rather than for text,
 * which is a different kind of analysis from anything else in this file. The textual comparison is
 * the cheapest thing that catches the copy-paste form, which is the one a mutation produces.
 */
function selectsADistinctPath(statement: ts.IfStatement | ts.SwitchStatement): boolean {
  if (ts.isIfStatement(statement)) {
    const otherwise = statement.elseStatement;
    if (otherwise !== undefined) {
      if (normalizedText(statement.thenStatement) === normalizedText(otherwise)) return false;
      return containsExit(statement.thenStatement) || containsExit(otherwise);
    }
    return containsExit(statement.thenStatement);
  }
  return statement.caseBlock.clauses.some((clause) => clause.statements.some(containsExit));
}

/**
 * What a catch clause does with the error, beyond the fact that it caught one.
 *
 * Both answers are read off the clause's own guaranteed path. The governing rule: the walk may
 * enter a construct exactly where the entered statements are guaranteed to execute whenever the
 * clause body runs, so no credit can ever come from code a semantics-preserving edit could have
 * added dead. Entered on those terms: a bare nested block, a `do` body, the tryBlock of a `try`
 * that has NO catch clause, the sole clause of a single-DefaultClause `switch`, the then-arm of an
 * `if` whose condition is exactly the literal `true` keyword, and both arms of an `if`/`else` with
 * per-arm states merged by intersection (evidence in both arms is unconditional; evidence in one
 * is not). Each entry is pinned by `reads a clause wrapped in a single-default switch as the bare
 * clause` and its sibling identity pairs.
 *
 * NOT entered, deliberately: a bare `if` without an else (except the literal-true case), loops
 * other than `do` (a body that may run zero times), labelled statements, function-like nodes (the
 * iteration-callback boundary is `walkBody`'s attribution rule and this walk never crosses any
 * function boundary), nested catch clauses, finally blocks, and the tryBlock of a `try` WITH a
 * catch clause, where a throw is intercepted by the nested catch rather than escaping the clause.
 * A `throw` or a test in any of those positions does not count.
 *
 * That is the whole dead-code defence, and it replaces the list of statically-false shapes an
 * earlier round kept extending. The list was losing: `if (false)` and `while (false)` were
 * recognised, and `for (;false;)`, `if (true) {} else`, `switch (1) { case 2: }`, `try {} catch`,
 * `for (const x of [])`, `for (const k in {})`, `if ("")`, `if (!true)` and `if (1 === 2)` were not,
 * each worth 50 points a route. Asking for the throw to be unconditional refuses all eleven without
 * naming any of them. `dead-*` in the mutation corpus is the tree-scale proof, one entry per shape.
 *
 * `rethrows` asks for one thing more: that the clause contains no `return` at all. The claim it
 * feeds is that the clause passes the error through unchanged, which is only true when throwing is
 * the ONLY way out. Without it a `throw error;` written after a statement that already exited read
 * as a rethrow, in seven spellings: after a bare block, a `do` body, an `if (true)`, an `if`/`else`
 * where both arms return, a `switch` with a returning default, and a `try`/`finally` that returns.
 * `definitelyExits` handles every one of those, including the `if (true)` spelling since it folds
 * the literal `true` keyword, and the no-return rule holds the rest of the line. `dead-throw-after-*`
 * in the mutation corpus covers them.
 *
 * The cost is real, in both rules. `catch (e) { if (transient) throw e; return null; }` no longer
 * reads as a rethrow, so it reads as a swallow and fails rather than sitting out, and neither does
 * `catch (e) { if (e instanceof Response) return e; throw e; }`, which passes on its branch instead.
 * That is the direction to be wrong in, since the reverse hands out points.
 */
function catchClauseEvidence(clause: ts.CatchClause): {
  rethrows: boolean;
  throws: boolean;
  branches: boolean;
} {
  // `rethrows`, `branches` and `exited` travel in a state record so a walk can be run against an
  // isolated copy (the if/else arm walks) as well as the shared root. `returns` stays a single
  // shared flag: it is a clause-wide veto, never per-arm evidence.
  //
  // On `exited`: set once a statement the walk has already passed could have left the clause. An
  // error test
  // after one of those is dead code, so it decides nothing. Raised at the END of each statement,
  // after that statement's own branch check: a deciding statement contains an exit by definition,
  // so raising it first makes every such statement refuse itself, which was measured at 78 routes
  // losing their pass and the tree dropping from 15 to 6, measured before round C moved the baseline
  // to 19. This ordering leaves the real-tree report
  // and all 240 clauses' evidence byte-identical. The tests are the cases in `dead throw written
  // after something that already exited`.
  //
  // Raised off `containsLiveExit`, never `containsExit`. The containment read is true of
  // `if (false) { throw e; }` itself, so a provably dead statement raised the flag and blinded the
  // walk to the real classification below it: prepending one to a deciding clause turned its pass
  // into a swallow verdict on 78 real routes, the same false accusation for all eleven dead
  // spellings. The liveness fold only ever withholds this blindness; where `literalTruth` cannot
  // decide, the containment answer stands and refusal is intact. The recovered half is `dead and
  // deferred code prepended to a deciding catch does not blind it`; the refusing half is the
  // `BRANCH_EXITED` list plus `still refuses an error test after an always-true spelling that
  // throws`.
  //
  // `vetoReturns` is whether this walk's statements may feed the `returns` veto. True everywhere
  // except the if/else arm walks: `returns` is read at the PARENT level, as a live containment
  // read over the whole statement, so an arm walk re-reading its own statements adds nothing for
  // a live guard and adds a false veto for a folded-dead arm (the walk enters both arms; the fold
  // has already excluded the dead one from the parent read). `dead-classifier-one-arm` in the
  // mutation corpus is the tree-scale shape this protects.
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
    // A block that re-declares the binding name means an `if` below it referencing that name is
    // referencing the shadowing declaration, not this clause's error. Nothing in such a block can
    // speak for the clause, so the whole list is skipped for branch purposes.
    const shadowed = bindingName !== null && declaresInScope(statements, bindingName);

    for (const statement of reachableStatements(statements)) {
      if (ts.isThrowStatement(statement)) {
        state.rethrows = true;
        // Read the branch check here, before the path is cut. A thrown ternary picks WHICH error
        // leaves, which is a classification, and reading it only at the shared check below meant
        // the throw arm of that condition was unreachable: this arm always continued first. So
        // `throw e instanceof Response ? e : new ServerError(e)` read as inert while the same
        // clause written with `return` passed. `selectsAnErrorPath` is the same predicate either
        // way, so the same-arms rule applies and `throw e instanceof Error ? e : e;` is refused.
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
      // whatever the condition says. The only loop form that is; `definitelyExits` agrees.
      if (ts.isDoStatement(statement)) {
        const body = statement.statement;
        walk(ts.isBlock(body) ? body.statements : [body], state);
        if (containsLiveExit(statement)) state.exited = true;
        continue;
      }
      // The three handlers below share one template: walk the inner list with the SAME shared
      // state, then read `returns` and `exited` off the whole statement and continue. The explicit
      // `containsLiveReturn` read is load-bearing: the `continue` skips the shared read below, and
      // `try { throw e; } finally { return null; }` genuinely swallows (the finally return eats
      // the throw), so the veto must still see the finally block the walk does not enter. `reads a
      // try whose finally returns as swallowing, not rethrowing` is the pin.
      //
      // A `try` WITHOUT a catch clause: its tryBlock always runs when the clause body does, and a
      // throw there escapes the clause, so rethrow credit is genuine. The finallyBlock is NOT
      // walked (classification living only in a finally block is under-credited; the tree has no
      // such clause). A `try` WITH a catch clause is not entered at all: a throw in that tryBlock
      // is intercepted by the nested catch, so crediting it would launder a returnless swallow
      // into not-applicable. `does not read the tryBlock of a caught try as this clause's rethrow`
      // is the pin, and the nested clause is judged separately as its own `ep.catches` entry.
      if (ts.isTryStatement(statement) && statement.catchClause === undefined) {
        walk(statement.tryBlock.statements, state);
        if (state.vetoReturns && containsLiveReturn(statement)) returns = true;
        if (containsLiveExit(statement)) state.exited = true;
        continue;
      }
      // A `switch` whose caseBlock is exactly one DefaultClause: that clause's statements always
      // run, as a bare list. A bare `break` in it neither rethrows, branches nor raises `exited`
      // (`containsLiveExit` does not count breaks), and `reachableStatements` cuts anything after
      // a top-level `break`, which is correct: after a break, nothing in the clause list runs.
      // Any other switch shape is not entered and falls through to the branch gate below exactly
      // as before, so a real `switch (e.code) { case ...: }` keeps its top-level credit. `reads a
      // clause wrapped in a single-default switch as the bare clause` is the pin.
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
      // An `if` whose condition (after `unwrap()`) is exactly the `true` keyword: the then-arm
      // always runs; the else-arm never does and is NEVER walked (`reads a dead else arm under if
      // true as contributing nothing` is the pin). Keyword-exact on purpose: `!!1`, `1` and
      // `!false` are deliberately not entry tickets, because entry GRANTS credit and a wrong grant
      // pays, where `literalTruth`'s wider folding only withholds blindness. This asymmetry is
      // deliberate; do not unify the two folds. Takes precedence over the if/else arm walk below.
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
      // Read here rather than over the whole clause so a `return` the walk has already cut as dead
      // does not count, which is what a `do { throw e; } while (false); return null;` produces.
      // The LIVE read, not the containment one: `if (false) { return null; }` holds a return that
      // can never run, and vetoing the rethrow on it regressed a rethrow-only clause from
      // not-applicable to fail on 11 real routes. `still sets rethrows past a dead return in an
      // if (false) arm` is the pin.
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

      // An `if` WITH an else (its condition not the literal `true` keyword, which the handler
      // above already took): one arm always runs, so evidence present in BOTH arms is
      // unconditional and evidence in one arm only is conditional and earns nothing. Each arm is
      // walked against an isolated state and the results merge into the parent by INTERSECTION.
      // Union is the laundering direction: `if (false) { <classifier> } else { 0; }` must earn
      // nothing, which `dead-classifier-one-arm` in the mutation corpus and `does not credit a
      // classifier that sits in one arm only` pin. `returns` is never intersected and never
      // per-arm: the shared read above already vetoed off the whole statement, over-approximate
      // across the live arms, because narrowing a veto per-arm is the unsafe direction.
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
 * signal that separates a per-item boundary (`items.map((item) => { try {...} })`, a fresh catch
 * for every element) from a route's own body expressed through one more layer of function nesting
 * (`trace(async () => {...})`, `mutateWithFallback({ pgMutation: async (t) => {...} })`,
 * `new ReadableStream({ start: async (c) => {...} })`), all of which invoke their callback exactly
 * once.
 *
 * A name list, because nothing in a syntactic scan can tell `users.map` from `Result.map`. The
 * consequence is written down where it matters, on `isIterationCallback`.
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
 * Whether the function-like `node` is the callback argument of a per-item iteration, e.g. the arrow
 * function in `items.map((item) => ...)`.
 *
 * Being wrong here is asymmetric. Calling a per-item callback the route's own continuation
 * mis-attributes a per-element catch to the route, which was the bug the boundary was added for.
 * Calling the route's own continuation a per-item callback hides the route's catch, and
 * `error-classification` used to read a route with no catch as not-applicable, which is 50 points
 * more than the swallow it was hiding. So the second direction paid, and `[0].map(async () => {
 * whole body })` collected it.
 *
 * Two things changed. A receiver that is an array literal of one element or none is refused here,
 * because it cannot iterate. And the direction that used to pay no longer pays: `walkBody` keeps
 * the catches it refuses, evidence and all, and `error-classification` fails a route with a
 * refused swallow when nothing the route owns decides, while a refused catch that decides caps at
 * not-applicable and never a pass. That is what makes the name list survivable, and it is why
 * `Result.map(...)`, which no name list can tell from `users.map(...)`, is a corpus entry that
 * passes rather than a hole: relocating a swallow behind the boundary still fails, and relocating
 * a decision earns at most the route's exit from the denominator.
 *
 * The other direction still costs points and the earlier version of this comment said otherwise.
 * A per-item callback under a callee the name list does not know, `pMap(items, cb)` or
 * `Array.prototype.map.call(items, cb)`, is attributed to the route, so a per-element catch that
 * decides can carry the route to `pass`. No mutation of a real route produces it: the reviewer
 * tried `Array.prototype.map.call` over the tree and it moved nothing, because a route has to
 * already be iterating for the shape to exist. It is a wrong verdict waiting for a route to be
 * written that way, not a laundering path, and it is why this list is worth extending when a new
 * iteration helper shows up in the tree.
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
 * The handler on an object argument, in the two shapes the route builders use: `handler` at the
 * top level of the config (`createSSELoader({ handler })`) and `methods.POST.handler`. Matching by
 * name at any depth would pick up an unrelated config callback that happens to be called
 * `handler`, as well as the sibling lambdas (`findResource`, `authorization.resource`) that are
 * not the entry-point body.
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
 * every one of these behind `if (option)`. Written out because `authorization: undefined` reads as
 * a declared gate to anything counting keys, and declaring one is what `auth-scope` credits. */
function isDeclaredValue(property: ts.ObjectLiteralElementLike): boolean {
  if (!ts.isPropertyAssignment(property)) return true;
  const value = unwrap(property.initializer);
  if (ts.isIdentifier(value) && value.text === "undefined") return false;
  return value.kind !== ts.SyntaxKind.NullKeyword && value.kind !== ts.SyntaxKind.FalseKeyword;
}

/**
 * Top-level property names of every object-literal argument to the root call, e.g. `params`,
 * `authorization`, `method`. Only the root call and only the top level: `authorization` on
 * `createMultiMethodApiRoute` is declared once beside `methods` rather than per method
 * (`apiBuilder.server.ts`), so nothing here needs to descend.
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

/**
 * Compiler options for the throwaway program below. `noLib` and `noResolve` keep it from going to
 * disk: nothing here needs a type, only the syntax the parser already produced.
 */
const SYNTAX_ONLY_OPTIONS: ts.CompilerOptions = { noLib: true, noResolve: true, allowJs: true };

/**
 * Syntactic diagnostics for an already-parsed source file, through `ts.Program` rather than off
 * the diagnostics array the parser hangs on the source file, which is internal and which the
 * compiler is free to rename. The whole parse-failure discipline rests on this, and an undetected
 * parse failure shrinks the denominator and inflates the score, so it must not be the kind of
 * thing a compiler upgrade can switch off silently.
 *
 * The host hands the program the `sf` we already have, so this does not parse the source a second
 * time. The cost is the program machinery around it, and it is not free: a full scan of the real
 * route tree went from about 850ms to about 1450ms, measured over five runs of each. A slower
 * scan of a tool that runs once a pull request is the cheaper of the two prices.
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
        // binding name here produced no entry point at all for this shape: not a parse failure and
        // not unmeasured, simply absent from the denominator. The two-step spelling
        // (`const { action } = builder(...); export { action };`) already resolved, because
        // `collectLocalDeclarations` reads the binding pattern and the export clause looks the name
        // up there, so only the direct form was missing. The exported name is the ELEMENT name, so
        // `{ loader: action }` exports an action and `{ action: internal }` exports neither.
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

  let statementCount = 0;
  let hasTryCatch = false;
  const callbackCatches: CatchEvidence[] = [];
  const catches: CatchEvidence[] = [];
  const calleeNames: string[] = [];
  const logCalls: LogCall[] = [];

  // Locals initialised from a call, and the names any condition in the body reads. Their
  // intersection is `checkedCallees`: callees whose answer the route demonstrably looked at.
  const declaredFrom = new Map<string, string[]>();
  const testedNames = new Set<string>();
  const collectTested = (node: ts.Node) => {
    if (ts.isIdentifier(node)) testedNames.add(node.text);
    ts.forEachChild(node, collectTested);
  };

  const localFunctions = collectLocalFunctions(sf);
  // A body that delegates to a same-file helper does the work in that helper, so the helper's
  // statements, try/catch and callees belong to the entry point. One hop only: a helper's own
  // helpers are not followed, and the visited set stops a cycle and any double counting.
  const visited = new Set<EntryFunction>(target.functions);
  const helpers: EntryFunction[] = [];

  const walkBody = (fn: EntryFunction, followHelpers: boolean) => {
    statementCount += countFunctionStatements(fn);

    if (!fn.body) return;
    // `inCallback` is true once the walk has entered a per-item iteration callback
    // (`items.map((item) => { ... })`), never reset back to false: nesting deeper inside one is
    // still inside it. `calleeNames` and `logCalls` keep descending regardless. A try/catch does
    // not: a per-item catch is not part of this body's own statement list, and `countStatement`
    // already stops at a nested function boundary, so counting it here let `tryStatementCount`
    // exceed the entry point's whole `statementCount` and judged a per-item error boundary as
    // though it were the route's own. What is refused is kept in `callbackCatches` with its
    // evidence instead of dropped, so `error-classification` can fail a refused swallow and sit
    // out a refused catch that decides, without ever crediting either as the route's own.
    //
    // Only an iteration callback is a boundary, not every function-like node: a route's own body
    // wrapped in `trace(async () => {...})`, `mutateWithFallback({ pgMutation: async (t) => {...} })`
    // or `new ReadableStream({ start: async (c) => {...} })` still runs exactly once, as the route's
    // own continuation one layer of nesting away, and its catch is the route's own error handling.
    //
    // A nested function's statements count towards `statementCount` too, whichever kind it is.
    // They are work the route does, and leaving them out let `trace("x", async () => { whole body
    // })` collapse a route to one statement, which is inside the triviality rule's limit: the route
    // then read as trivial and every check reported not-applicable for it. `wrap-body-in-trace` in
    // the mutation corpus is that shape.
    const visit = (node: ts.Node, inCatch: boolean, inCallback: boolean) => {
      if (ts.isFunctionLike(node)) {
        if (isEntryFunction(node)) statementCount += countFunctionStatements(node);
        const entersIterationCallback = inCallback || isIterationCallback(node);
        ts.forEachChild(node, (child) => visit(child, inCatch, entersIterationCallback));
        return;
      }
      if (ts.isTryStatement(node)) {
        hasTryCatch = true;
        if (node.catchClause) {
          // Built the same way for a refused catch as for an own one, so the dead-code defence
          // and the walk's guaranteed-execution rules apply to both. Which list it lands in is
          // walkBody's attribution decision alone.
          const tryStatementCount = countStatements(node.tryBlock.statements);
          const clause = catchClauseEvidence(node.catchClause);
          (inCallback ? callbackCatches : catches).push({
            rethrows: clause.rethrows,
            throws: clause.throws,
            branches: clause.branches,
            ...guardedWork(node.tryBlock),
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
            const existing = declaredFrom.get(node.name.text);
            if (existing) existing.push(cn);
            else declaredFrom.set(node.name.text, [cn]);
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
          calleeNames.push(cn);

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
            }
          }
        }
      }
      ts.forEachChild(node, (child) => visit(child, inCatch, inCallback));
    };
    visit(fn.body, false, false);
  };

  for (const fn of target.functions) walkBody(fn, true);
  for (const helper of helpers) walkBody(helper, false);

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
    checkedCallees: [
      ...new Set(
        [...declaredFrom]
          .filter(([local]) => testedNames.has(local))
          .flatMap(([, callees]) => callees)
      ),
    ],
    importedNames,
    calleeNames,
    hasTryCatch,
    catches,
    callbackCatches,
    logCalls,
    statementCount,
  };
}

const SOURCE_FILE = /\.tsx?$/;

/** Exported so `mutationCorpus.test.ts` materializes exactly the files `scanDirectory` reads. Its
 * anti-vacuity thresholds count files and sites the scanner never saw if the two predicates drift. */
export function isScannableFile(fileName: string): boolean {
  return SOURCE_FILE.test(fileName) && !fileName.endsWith(".d.ts");
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

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      // Flat-route directories hold the route module in `route.ts`/`route.tsx`.
      for (const child of readdirSync(join(dir, entry.name), { withFileTypes: true })) {
        if (!child.isFile() || (child.name !== "route.ts" && child.name !== "route.tsx")) continue;
        scan(join(dir, entry.name, child.name), `${entry.name}/${child.name}`);
      }
      continue;
    }
    if (!entry.isFile() || !isScannableFile(entry.name)) continue;
    scan(join(dir, entry.name), entry.name);
  }

  return { entryPoints, parseFailures };
}
